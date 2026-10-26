"""
InsureXplain engine
-------------------
Loads the trained Random-Forest pipeline and provides:

  * exact marginal-contribution (interventional Shapley) explanations over the 10 raw rating factors
  * a LIME-style local surrogate (weighted ridge on a binary interpretable representation)
  * plain-language Adverse Action Notice generation
  * global SHAP summaries, partial dependence and pairwise Shapley interactions
  * group-fairness diagnostics for the compliance report

Pre-processing is re-implemented in NumPy from the fitted statistics inside the pickled pipeline
(median imputation -> standardisation, most-frequent imputation -> one-hot). This keeps inference
independent of scikit-learn's internal transformer code, which changes between versions.
"""
from __future__ import annotations

import csv
import hashlib
import itertools
import json
import math
import os
import threading
from datetime import date
from functools import lru_cache
from pathlib import Path

import joblib
import numpy as np

BASE = Path(__file__).resolve().parent
ART = BASE / "artifacts"

# --------------------------------------------------------------------------------------
# Feature catalogue (labels, ranges and sensitivity tags used by the UI and the notice)
# --------------------------------------------------------------------------------------
NUM = ["Exposure", "VehPower", "VehAge", "DrivAge", "BonusMalus", "Density"]
CAT = ["Area", "VehBrand", "VehGas", "Region"]
ALL = NUM + CAT

LABELS = {
    "Exposure": "Policy period observed",
    "VehPower": "Vehicle power",
    "VehAge": "Vehicle age",
    "DrivAge": "Driver age",
    "BonusMalus": "Bonus-malus rating",
    "Density": "Population density",
    "Area": "Area class",
    "VehBrand": "Vehicle brand",
    "VehGas": "Fuel type",
    "Region": "Region",
}
PLAIN = {
    "Exposure": "the length of the policy period observed",
    "VehPower": "the power rating of the vehicle",
    "VehAge": "the age of the vehicle",
    "DrivAge": "the driver's age",
    "BonusMalus": "the bonus-malus (claims-history) rating",
    "Density": "the population density of the home area",
    "Area": "the area classification",
    "VehBrand": "the vehicle brand group",
    "VehGas": "the fuel type",
    "Region": "the region",
}
# category used for compliance roll-ups
GROUP = {
    "Exposure": "Policy", "VehPower": "Vehicle", "VehAge": "Vehicle", "VehBrand": "Vehicle", "VehGas": "Vehicle",
    "DrivAge": "Age", "BonusMalus": "Claims history", "Density": "Geography", "Area": "Geography", "Region": "Geography",
}
# features that may be restricted or act as proxies for protected characteristics
SENSITIVE = {"DrivAge": "age", "Region": "geography", "Area": "geography", "Density": "geography"}
# features a customer cannot reasonably change in order to get a different outcome
NON_ACTIONABLE = {"Exposure", "DrivAge", "Region", "Area", "Density"}

RANGES = {  # min, max, step
    "Exposure": (0.01, 1.0, 0.01),
    "VehPower": (4, 15, 1),
    "VehAge": (0, 30, 1),
    "DrivAge": (18, 90, 1),
    "BonusMalus": (50, 230, 1),
    "Density": (1, 30000, 1),
}
UNITS = {"Exposure": "yr", "VehAge": "yr", "DrivAge": "yr", "Density": "per km²"}

ACTION_HINT = {
    "BonusMalus": "A longer claim-free record gradually improves this rating.",
    "VehAge": "A different vehicle (age) may be rated differently.",
    "VehPower": "A vehicle with a different power rating may be rated differently.",
    "VehBrand": "A different vehicle make may be rated differently.",
    "VehGas": "A vehicle with a different fuel type may be rated differently.",
}

# --------------------------------------------------------------------------------------
# Model loading
# --------------------------------------------------------------------------------------
def _load_pipeline():
    import sklearn.compose._column_transformer as ct

    if not hasattr(ct, "_RemainderColsList"):  # pickle written by scikit-learn 1.6, loaded on a newer one
        class _RemainderColsList(list):
            pass
        ct._RemainderColsList = _RemainderColsList
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return joblib.load(ART / "insurexplain_model_pipeline.joblib")


class Engine:
    def __init__(self):
        pipe = _load_pipeline()
        pre = pipe.named_steps["preprocessor"]
        self.rf = pipe.named_steps["model"]
        self.rf.n_jobs = max(1, min(4, os.cpu_count() or 1))
        num_t = pre.named_transformers_["num"]
        cat_t = pre.named_transformers_["cat"]
        self.mean = num_t.named_steps["scaler"].mean_.astype(float)
        self.scale = num_t.named_steps["scaler"].scale_.astype(float)
        self.median = num_t.named_steps["imputer"].statistics_.astype(float)
        self.cats = [list(c) for c in cat_t.named_steps["onehot"].categories_]
        self.cat_mode = list(cat_t.named_steps["imputer"].statistics_)
        self.n_enc = len(NUM) + sum(len(c) for c in self.cats)

        # column slice in the encoded matrix for each raw feature
        self.slices, pos = {}, 0
        for f in NUM:
            self.slices[f] = (pos, pos + 1); pos += 1
        for f, c in zip(CAT, self.cats):
            self.slices[f] = (pos, pos + len(c)); pos += len(c)
        self.enc_names = [f"num__{f}" for f in NUM] + [f"cat__{f}_{v}" for f, c in zip(CAT, self.cats) for v in c]

        self.typical = {f: float(m) for f, m in zip(NUM, self.median)}
        self.typical.update({f: m for f, m in zip(CAT, self.cat_mode)})

        self._build_reference()
        self._build_coalitions()
        self._lock = threading.Lock()
        self.global_shap = self._read_csv(ART / "global_shap_importance.csv")

    # ---------------------------------------------------------------- encoding helpers
    def encode(self, rows):
        """rows: list of dict raw -> (n, n_enc) float32 matrix"""
        n = len(rows)
        out = np.zeros((n, self.n_enc), dtype=np.float32)
        for r, row in enumerate(rows):
            for j, f in enumerate(NUM):
                v = row.get(f)
                v = self.median[j] if v is None else float(v)
                out[r, j] = (v - self.mean[j]) / self.scale[j]
            for f, cats in zip(CAT, self.cats):
                a, _ = self.slices[f]
                v = row.get(f)
                if v is None:
                    v = self.typical[f]
                if v in cats:  # unknown categories -> all zeros (handle_unknown='ignore')
                    out[r, a + cats.index(v)] = 1.0
        return out

    def predict_raw(self, rows):
        return self.rf.predict_proba(self.encode(rows))[:, 1]

    # ---------------------------------------------------------------- reference population
    def _build_reference(self, n=2000, seed=7):
        """Synthetic reference portfolio rebuilt from the fitted preprocessor statistics and the
        exported group sizes (the original dataset is not shipped with the app)."""
        rng = np.random.default_rng(seed)
        def shares(path, key="group"):
            rows = self._read_csv(path)
            d = {r[key]: float(r["n"]) for r in rows}
            tot = sum(d.values())
            return {k: v / tot for k, v in d.items()}
        area_p = shares(ART / "fairness_by_area.csv")
        reg_p = shares(ART / "fairness_by_region.csv")
        brand_p = {"B1": .24, "B2": .23, "B12": .24, "B3": .09, "B4": .04, "B5": .07, "B6": .05, "B10": .03, "B11": .02, "B13": .02, "B14": .01}

        def pick(options, probs):
            p = np.array([probs.get(o, 0.002) for o in options], float); p /= p.sum()
            return rng.choice(options, n, p=p)

        expo = np.where(rng.random(n) < 0.18, 1.0, rng.beta(1.1, 1.7, n)).clip(0.01, 1.0).round(2)
        vpow = np.round(rng.normal(self.mean[1], self.scale[1], n)).clip(4, 15)
        vage = np.round(rng.gamma(2.4, self.mean[2] / 2.4, n)).clip(0, 30)
        dage = np.round(rng.normal(self.mean[3], self.scale[3], n)).clip(18, 90)
        bm = np.where(rng.random(n) < 0.6, 50.0, 50 + rng.exponential(25, n)).round().clip(50, 230)
        dens = np.exp(rng.normal(math.log(self.median[5]), 1.74, n)).round().clip(1, 30000)
        area = pick(self.cats[0], area_p); brand = pick(self.cats[1], brand_p)
        gas = rng.choice(self.cats[2], n); reg = pick(self.cats[3], reg_p)
        self.ref_rows = [
            dict(Exposure=float(expo[i]), VehPower=float(vpow[i]), VehAge=float(vage[i]), DrivAge=float(dage[i]),
                 BonusMalus=float(bm[i]), Density=float(dens[i]), Area=str(area[i]), VehBrand=str(brand[i]),
                 VehGas=str(gas[i]), Region=str(reg[i])) for i in range(n)
        ]
        self.ref_enc = self.encode(self.ref_rows)
        self.ref_pred = self.rf.predict_proba(self.ref_enc)[:, 1]
        # background for Shapley: evenly spaced ranks of the predicted-risk distribution
        order = np.argsort(self.ref_pred)
        self.bg_idx = order[np.linspace(0, n - 1, 24).astype(int)]
        self.bg_enc = self.ref_enc[self.bg_idx]
        self.bg_rows = [self.ref_rows[i] for i in self.bg_idx]
        self.base_value = float(self.rf.predict_proba(self.bg_enc)[:, 1].mean())
        self.pop_mean = float(self.ref_pred.mean())

    # ---------------------------------------------------------------- Shapley machinery
    def _build_coalitions(self):
        n = len(ALL)
        self.n = n
        masks = np.array(list(itertools.product([0, 1], repeat=n)), dtype=bool)[:, ::-1]  # bit i = feature i
        ints = (masks * (1 << np.arange(n))).sum(1)
        order = np.argsort(ints)
        self.masks = masks[order]
        self.colmask = np.zeros((1 << n, self.n_enc), dtype=bool)
        for i, f in enumerate(ALL):
            a, b = self.slices[f]
            self.colmask[:, a:b] = self.masks[:, [i]]
        self.popcount = self.masks.sum(1)
        fact = [math.factorial(k) for k in range(n + 1)]
        self.w1 = np.array([fact[k] * fact[n - k - 1] / fact[n] for k in range(n)])
        self.w2 = np.array([fact[k] * fact[n - k - 2] / (2 * fact[n - 1]) for k in range(n - 1)])

    def _value_function(self, xenc, bg_enc=None):
        bg = self.bg_enc if bg_enc is None else bg_enc
        grid = np.where(self.colmask[:, None, :], xenc[None, None, :], bg[None, :, :]).astype(np.float32)
        p = self.rf.predict_proba(grid.reshape(-1, self.n_enc))[:, 1]
        return p.reshape(len(self.colmask), len(bg)).mean(1)

    def _shapley_from_v(self, v):
        phi = np.zeros(self.n)
        for i in range(self.n):
            bit = 1 << i
            idx0 = np.array([m for m in range(1 << self.n) if not m & bit])
            phi[i] = (self.w1[self.popcount[idx0]] * (v[idx0 | bit] - v[idx0])).sum()
        return phi

    @lru_cache(maxsize=256)
    def _shap_cached(self, key):
        row = dict(zip(ALL, key))
        x = self.encode([row])[0]
        v = self._value_function(x)
        phi = self._shapley_from_v(v)
        return tuple(phi), float(v[-1]), float(v[0])

    def shap(self, row):
        key = tuple(row[f] for f in ALL)
        with self._lock:
            phi, fx, base = self._shap_cached(key)
        return np.array(phi), fx, base

    # ---------------------------------------------------------------- LIME-style surrogate
    def lime(self, row, n_samples=700, seed=11):
        rng = np.random.default_rng(seed)
        d = len(ALL)
        bg = self.ref_rows
        # quartile bins for numeric features (from the reference population)
        edges = {f: np.unique(np.quantile([r[f] for r in bg], [0.25, 0.5, 0.75])) for f in NUM}
        def bin_of(f, v):
            return int(np.searchsorted(edges[f], v, side="right"))
        keep = rng.random((n_samples, d)) < 0.5
        keep[0, :] = True
        draws = rng.integers(0, len(bg), (n_samples, d))
        samples, Z = [], np.zeros((n_samples, d))
        for s in range(n_samples):
            r = {}
            for j, f in enumerate(ALL):
                r[f] = row[f] if keep[s, j] else bg[draws[s, j]][f]
                if f in NUM:
                    Z[s, j] = 1.0 if bin_of(f, r[f]) == bin_of(f, row[f]) else 0.0
                else:
                    Z[s, j] = 1.0 if r[f] == row[f] else 0.0
            samples.append(r)
        y = self.predict_raw(samples)
        dist = np.sqrt(((1 - Z) ** 2).sum(1))
        width = 0.75 * math.sqrt(d)
        w = np.exp(-(dist ** 2) / width ** 2)
        A = np.hstack([Z, np.ones((n_samples, 1))])
        W = np.diag(w)
        reg = np.eye(d + 1); reg[-1, -1] = 0; reg *= 1.0
        coef = np.linalg.solve(A.T @ W @ A + reg, A.T @ W @ y)
        pred = A @ coef
        r2 = 1 - (w * (y - pred) ** 2).sum() / max(1e-12, (w * (y - np.average(y, weights=w)) ** 2).sum())
        return coef[:d], float(coef[-1]), float(r2)

    # ---------------------------------------------------------------- public: assess
    def validate(self, payload):
        row, errs = {}, []
        for f in NUM:
            lo, hi, _ = RANGES[f]
            try:
                v = float(payload.get(f, self.typical[f]))
                if not math.isfinite(v):
                    raise ValueError
            except (TypeError, ValueError):
                errs.append(f"{f} must be a number"); continue
            row[f] = float(min(max(v, lo), hi))
        for f, cats in zip(CAT, self.cats):
            v = payload.get(f, self.typical[f])
            if v not in cats:
                errs.append(f"{f} must be one of {cats}")
            row[f] = v
        if errs:
            raise ValueError("; ".join(errs))
        return row

    def assess(self, payload, threshold=0.5):
        row = self.validate(payload)
        threshold = float(min(max(threshold, 0.05), 0.95))
        phi, fx, base = self.shap(row)
        lime_w, lime_b, lime_r2 = self.lime(row)
        order = np.argsort(-np.abs(phi))
        feats = []
        for i in order:
            f = ALL[i]
            feats.append(dict(
                key=f, label=LABELS[f], value=row[f], shap=float(phi[i]), lime=float(lime_w[i]),
                sensitive=SENSITIVE.get(f), actionable=f not in NON_ACTIONABLE, group=GROUP[f],
            ))
        adverse = [x for x in sorted(feats, key=lambda z: -z["shap"]) if x["shap"] > 0][:3]
        protective = [x for x in sorted(feats, key=lambda z: z["shap"]) if x["shap"] < 0][:3]
        lime_adv = [ALL[i] for i in np.argsort(-lime_w) if lime_w[i] > 0][:3]
        shap_adv = [a["key"] for a in adverse]
        overlap = len(set(lime_adv) & set(shap_adv))
        rho = float(_spearman(phi, lime_w))
        sign_agree = int(((phi > 0) == (lime_w > 0)).sum())
        flagged = fx >= threshold
        notice = self.notice(row, fx, threshold, flagged, adverse, protective)
        flags = self.review_flags(adverse, fx, threshold, overlap)
        return dict(
            probability=fx, base_value=base, threshold=threshold, flagged=flagged,
            reference_mean=self.pop_mean, features=feats,
            top_adverse=[a["key"] for a in adverse], top_protective=[p["key"] for p in protective],
            lime=dict(intercept=lime_b, r2=lime_r2, top_adverse=lime_adv),
            agreement=dict(top3_overlap=overlap, rank_correlation=rho, sign_agreement=sign_agree, of=len(ALL)),
            notice=notice, review_flags=flags,
        )

    # ---------------------------------------------------------------- notice generation
    def _fmt(self, f, v):
        if f == "Exposure": return f"{v:.2f} of a year"
        if f == "Density": return f"{v:,.0f} people per km²"
        if f in ("VehAge", "DrivAge"): return f"{v:.0f} years"
        if f in ("VehPower", "BonusMalus"): return f"{v:.0f}"
        return str(v)

    def _compare(self, f, v):
        if f in NUM:
            t = self.typical[f]
            rel = "close to" if abs(v - t) <= 0.05 * max(abs(t), 1) else ("above" if v > t else "below")
            return rel, self._fmt(f, t)
        return ("the same as" if v == self.typical[f] else "different from"), str(self.typical[f])

    def reason_text(self, f, v, adverse=True):
        rel, typ = self._compare(f, v)
        sense = "a higher" if adverse else "a lower"
        what = PLAIN[f]
        verb = "raised" if adverse else "lowered"
        if f in NUM:
            base = (f"For {what}, your value ({self._fmt(f, v)}) is {rel} the typical reference value ({typ}). "
                    f"The model associates this with {sense} likelihood of a recorded claim.")
        else:
            base = (f"For {what}, your value ({v}) is {rel} the most common value in the reference portfolio ({typ}). "
                    f"The model associates this with {sense} likelihood of a recorded claim.")
        if f == "Exposure":
            base += " This reflects how long a policy was observed in the data, not something about your driving."
        return base

    def notice(self, row, p, thr, flagged, adverse, protective):
        ref = "IXP-" + date.today().strftime("%Y%m%d") + "-" + hashlib.sha1(json.dumps(row, sort_keys=True).encode()).hexdigest()[:6].upper()
        title = "ADVERSE ACTION NOTICE (SIMULATED)" if flagged else "RISK EXPLANATION STATEMENT (SIMULATED)"
        total_adv = sum(a["shap"] for a in adverse) or 1.0
        reasons = []
        for rank, a in enumerate(adverse, 1):
            f = a["key"]
            reasons.append(dict(
                rank=rank, key=f, label=LABELS[f], value=self._fmt(f, row[f]),
                text=self.reason_text(f, row[f], True), points=a["shap"] * 100, share=a["shap"] / total_adv,
                sensitive=SENSITIVE.get(f), hint=ACTION_HINT.get(f, "This is not something that can reasonably be changed."),
            ))
        mitig = [dict(key=q["key"], label=LABELS[q["key"]], value=self._fmt(q["key"], row[q["key"]]),
                      text=self.reason_text(q["key"], row[q["key"]], False), points=q["shap"] * 100) for q in protective]
        intro = ("The simulated model flagged this application for adverse action because its predicted claim likelihood met or exceeded the decision threshold."
                 if flagged else
                 "The simulated model did not flag this application: its predicted claim likelihood is below the decision threshold. The factors below still explain the score.")
        limits = [
            "These are model associations, not proof that a feature caused a claim.",
            "The underlying dataset records claims; it does not contain actual approval or denial decisions.",
            "This output must not be used by itself to deny coverage or set a real premium.",
            "Any real deployment would need actuarial validation, calibration, human review, fairness testing and jurisdiction-specific legal review.",
        ]
        nxt = "Request a human review of the underlying information and the model limitations. This sample workflow does not assert a legal right or replace applicable complaint or appeal procedures."
        L = ["INSUREXPLAIN — " + title, "=" * 62,
             f"Generated: {date.today().isoformat()}", f"Reference: {ref} (fictional demonstration reference)", "",
             "Purpose",
             "This educational notice explains a model prediction about recorded claim occurrence.",
             "It is NOT an actual underwriting decision, rejection, premium quote, or legal adverse-action notice.", "",
             f"Model output: predicted probability of at least one recorded claim = {p*100:.1f}%",
             f"Decision threshold: {thr:.2f}  ->  {'Flagged for adverse action' if flagged else 'Not flagged'}", "",
             intro, "", "Principal reasons (top three factors raising the predicted likelihood):"]
        for r in reasons:
            L += [f"{r['rank']}. {r['label']} — {r['value']} (adds {r['points']:+.1f} percentage points)", f"   {r['text']}", f"   {r['hint']}"]
        if not reasons:
            L.append("- No factor raised the predicted likelihood above the reference portfolio average.")
        L += ["", "Factors that lowered the predicted likelihood:"]
        for m in mitig:
            L.append(f"- {m['label']} — {m['value']} ({m['points']:+.1f} percentage points)")
        L += ["", "Important limitations"] + [f"- {x}" for x in limits] + ["", "Next step", nxt]
        return dict(reference=ref, title=title, date=date.today().isoformat(), intro=intro, reasons=reasons,
                    mitigating=mitig, limitations=limits, next_step=nxt, text="\n".join(L))

    def review_flags(self, adverse, p, thr, overlap):
        out = []
        for a in adverse:
            if a["key"] in SENSITIVE:
                kind = SENSITIVE[a["key"]]
                out.append(dict(level="review", text=f"{LABELS[a['key']]} ({kind}) is among the top three adverse reasons. Confirm that using it is permitted for this product and jurisdiction, and that it is not a proxy for a protected class."))
            if a["key"] == "Exposure":
                out.append(dict(level="watch", text="Policy exposure is a data-recording artefact, not customer behaviour. Consider using it as an actuarial offset instead of a rating factor, and keep it out of customer-facing reasons."))
        if overlap < 2:
            out.append(dict(level="watch", text="SHAP and LIME disagree on the top reasons for this applicant. Treat the explanation as less stable and prefer human review."))
        if abs(p - thr) < 0.03:
            out.append(dict(level="watch", text="The score sits within three points of the threshold; small input changes could flip the outcome."))
        if not out:
            out.append(dict(level="ok", text="No sensitive or proxy variable appears among the top three reasons, and both explainers broadly agree."))
        return out

    # ---------------------------------------------------------------- global views
    @staticmethod
    def _read_csv(path):
        with open(path, newline="", encoding="utf-8") as fh:
            return list(csv.DictReader(fh))

    def global_view(self):
        enc = [dict(name=r["feature"], value=float(r["mean_abs_shap"])) for r in self.global_shap]
        agg = {}
        for e in enc:
            body = e["name"].split("__", 1)[1]
            f = body if e["name"].startswith("num__") else next(c for c in CAT if body.startswith(c + "_"))
            agg[f] = agg.get(f, 0) + e["value"]
        tot = sum(agg.values())
        feats = sorted(({"key": f, "label": LABELS[f], "value": v, "share": v / tot, "group": GROUP[f],
                         "sensitive": SENSITIVE.get(f)} for f, v in agg.items()), key=lambda d: -d["value"])
        by_group = {}
        for d in feats:
            by_group[d["group"]] = by_group.get(d["group"], 0) + d["share"]
        return dict(features=feats, encoded=enc[:20], by_group=by_group,
                    sensitive_share=sum(d["share"] for d in feats if d["sensitive"]),
                    models=[{k: (float(v) if k != "Model" else v) for k, v in r.items()} for r in self._read_csv(ART / "model_comparison.csv")])

    @lru_cache(maxsize=32)
    def pdp(self, feature, points=24):
        if feature not in ALL:
            raise ValueError("unknown feature")
        sub = self.ref_rows[:300]
        if feature in NUM:
            lo, hi, _ = RANGES[feature]
            vals = list(np.unique(np.round(np.quantile([r[feature] for r in self.ref_rows], np.linspace(0.01, 0.99, points)), 2)))
            if feature == "Density":
                vals = list(np.unique(np.round(np.exp(np.linspace(math.log(max(lo, 5)), math.log(9000), points)))))
        else:
            vals = list(self.cats[CAT.index(feature)])
        out = []
        for v in vals:
            rows = [{**r, feature: (float(v) if feature in NUM else v)} for r in sub]
            out.append(dict(x=float(v) if feature in NUM else v, y=float(self.predict_raw(rows).mean())))
        return dict(feature=feature, label=LABELS[feature], numeric=feature in NUM, points=out, baseline=self.pop_mean)

    def interactions(self):
        path = ART / "interaction_matrix.json"
        if path.exists():
            return json.loads(path.read_text())
        data = self.compute_interactions(n_people=10, n_bg=10)
        try:
            path.write_text(json.dumps(data))
        except OSError:
            pass
        return data

    def compute_interactions(self, n_people=30, n_bg=16):
        rng = np.random.default_rng(3)
        people = rng.choice(len(self.ref_rows), n_people, replace=False)
        bg = self.bg_enc[np.linspace(0, len(self.bg_enc) - 1, n_bg).astype(int)]
        n = self.n
        M = np.zeros((n, n))
        for pi in people:
            v = self._value_function(self.ref_enc[pi], bg)
            for i in range(n):
                for j in range(i + 1, n):
                    bi, bj = 1 << i, 1 << j
                    idx = np.array([m for m in range(1 << n) if not (m & bi or m & bj)])
                    delta = v[idx | bi | bj] - v[idx | bi] - v[idx | bj] + v[idx]
                    val = (self.w2[self.popcount[idx]] * delta).sum() * 2  # full pairwise index
                    M[i, j] += abs(val); M[j, i] += abs(val)
        M /= n_people
        pairs = sorted(({"a": ALL[i], "b": ALL[j], "value": float(M[i, j])} for i in range(n) for j in range(i + 1, n)), key=lambda d: -d["value"])
        return dict(features=ALL, labels=[LABELS[f] for f in ALL], matrix=M.tolist(), top_pairs=pairs[:8],
                    n_people=int(n_people), note="Mean absolute pairwise Shapley interaction on a synthetic reference portfolio (probability scale).")

    # ---------------------------------------------------------------- compliance
    def compliance(self):
        spec = [("age", "Driver age band", "fairness_by_driver_age.csv"), ("area", "Area class", "fairness_by_area.csv"), ("region", "Region", "fairness_by_region.csv")]
        out, signals = {}, []
        for key, title, fn in spec:
            rows = self._read_csv(ART / fn)
            tot = sum(float(r["n"]) for r in rows)
            overall_ppr = sum(float(r["n"]) * float(r["predicted_positive_rate"]) for r in rows) / tot
            overall_claim = sum(float(r["n"]) * float(r["actual_claim_rate"]) for r in rows) / tot
            groups = []
            for r in rows:
                n_ = int(float(r["n"])); ppr = float(r["predicted_positive_rate"]); cr = float(r["actual_claim_rate"])
                groups.append(dict(group=r["group"], n=n_, claim_rate=cr, flag_rate=ppr, tpr=float(r["recall/TPR"]), fpr=float(r["FPR"]),
                                   fnr=float(r["FNR"]), precision=float(r["precision"]), bal_acc=float(r["balanced_accuracy"]),
                                   ratio_overall=ppr / overall_ppr, calibration=ppr / cr if cr else None, small=n_ < 1000))
            if key == "age":
                order = ["<=24", "25-34", "35-44", "45-54", "55-64", "65+"]
                groups.sort(key=lambda g: order.index(g["group"]) if g["group"] in order else 99)
            elif key == "area":
                groups.sort(key=lambda g: g["group"])
            else:
                groups.sort(key=lambda g: -g["n"])
            ok = [g for g in groups if not g["small"]]
            hi, lo = max(ok, key=lambda g: g["flag_rate"]), min(ok, key=lambda g: g["flag_rate"])
            ratio = hi["flag_rate"] / lo["flag_rate"]
            tpr_gap = max(g["tpr"] for g in ok) - min(g["tpr"] for g in ok)
            fpr_gap = max(g["fpr"] for g in ok) - min(g["fpr"] for g in ok)
            claim_ratio = max(g["claim_rate"] for g in ok) / min(g["claim_rate"] for g in ok)
            level = "review" if ratio >= 2 else "watch" if ratio >= 1.5 else "ok"
            out[key] = dict(title=title, overall_flag_rate=overall_ppr, overall_claim_rate=overall_claim, groups=groups,
                            summary=dict(ratio=ratio, highest=hi["group"], lowest=lo["group"], tpr_gap=tpr_gap, fpr_gap=fpr_gap,
                                         claim_ratio=claim_ratio, level=level, small_groups=[g["group"] for g in groups if g["small"]]))
            signals.append(dict(level=level, title=f"{title}: flag-rate spread {ratio:.1f}×",
                                text=f"{hi['group']} is flagged {hi['flag_rate']*100:.1f}% of the time versus {lo['flag_rate']*100:.1f}% for {lo['group']}. "
                                     f"Observed claim rates differ by {claim_ratio:.1f}× across the same groups, so part of the gap tracks genuine claim experience; the rest needs review."))
            if tpr_gap > 0.10:
                signals.append(dict(level="watch", title=f"{title}: detection gap of {tpr_gap*100:.0f} points",
                                    text="Recall (true-positive rate) differs notably between groups, so the model finds claims more reliably for some groups than others."))
            if out[key]["summary"]["small_groups"]:
                signals.append(dict(level="info", title=f"{title}: {len(out[key]['summary']['small_groups'])} small group(s)",
                                    text="Groups under 1,000 policies (" + ", ".join(out[key]["summary"]["small_groups"][:6]) + ") are excluded from the spread statistics because the estimates are unstable."))
        g = self.global_view()
        top = g["features"][0]
        if top["key"] == "Exposure":
            signals.append(dict(level="watch", title="Exposure is the strongest driver",
                                text=f"Policy exposure carries {top['share']*100:.0f}% of global importance. Exposure measures observation time rather than risk behaviour; in actuarial practice it is normally an offset, so this may be a modelling artefact."))
        signals.append(dict(level="review" if g["sensitive_share"] > 0.4 else "watch",
                            title=f"Age and geography carry {g['sensitive_share']*100:.0f}% of importance",
                            text="Driver age, region, area and density can be restricted or act as proxies for protected characteristics. Their influence is documented here but not judged unlawful."))
        m = g["models"][0]
        signals.append(dict(level="info", title=f"Discrimination power is modest (AUC {m['ROC-AUC']:.2f})",
                            text=f"Balanced accuracy {m['Balanced accuracy']:.2f} and recall {m['Recall']:.2f} mean the model should support, not replace, human underwriting."))
        order = {"review": 0, "watch": 1, "info": 2, "ok": 3}
        signals.sort(key=lambda s: order[s["level"]])
        return dict(attributes=out, signals=signals, global_groups=g["by_group"], sensitive_share=g["sensitive_share"])

    def report_markdown(self):
        base = (ART / "global_compliance_report.md").read_text(encoding="utf-8").rstrip()
        c = self.compliance()
        inter = self.interactions()
        L = [base, "", "---", "", "## Automated review signals (InsureXplain app)", ""]
        for s in c["signals"]:
            L.append(f"- **[{s['level'].upper()}] {s['title']}** — {s['text']}")
        L += ["", "## Flag-rate disparity by group", "",]
        for k, a in c["attributes"].items():
            L += [f"### {a['title']}", "", "| Group | Policies | Claim rate | Flag rate | Recall | FPR |", "|---|---:|---:|---:|---:|---:|"]
            for g in a["groups"]:
                L.append(f"| {g['group']}{' *' if g['small'] else ''} | {g['n']:,} | {g['claim_rate']*100:.1f}% | {g['flag_rate']*100:.1f}% | {g['tpr']*100:.1f}% | {g['fpr']*100:.1f}% |")
            L += ["", "\\* fewer than 1,000 policies.", ""]
        L += ["## Strongest pairwise feature interactions", "", f"_{inter['note']}_", ""]
        for p in inter["top_pairs"][:6]:
            L.append(f"- {LABELS[p['a']]} × {LABELS[p['b']]}: {p['value']*100:.2f} points")
        L += ["", "_Generated by InsureXplain. Diagnostic signals only; not a legal compliance determination._", ""]
        return "\n".join(L)


def _spearman(a, b):
    ra = np.argsort(np.argsort(a)).astype(float); rb = np.argsort(np.argsort(b)).astype(float)
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


def meta(engine: Engine):
    feats = []
    for f in ALL:
        d = dict(key=f, label=LABELS[f], type="num" if f in NUM else "cat", sensitive=SENSITIVE.get(f), group=GROUP[f], unit=UNITS.get(f))
        if f in NUM:
            lo, hi, st = RANGES[f]
            d.update(min=lo, max=hi, step=st, default=engine.typical[f], scale="log" if f == "Density" else "linear")
        else:
            d.update(options=engine.cats[CAT.index(f)], default=engine.typical[f])
        feats.append(d)
    return dict(features=feats, base_value=engine.base_value, reference_mean=engine.pop_mean, threshold=0.5,
                model=dict(name="Random Forest", trees=int(engine.rf.n_estimators), inputs=len(ALL), encoded=engine.n_enc),
                presets=PRESETS)


PRESETS = []  # filled by app startup (see presets.json)
