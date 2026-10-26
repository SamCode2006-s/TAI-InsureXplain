(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
const pts = v => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TAGS = { age: "age", geography: "geo" };
const GROUP_COLOR = { "Claims history": "#ff8ea1", Policy: "#8e93b3", Vehicle: "#98a2ff", Age: "#ffc66d", Geography: "#f2a35e" };

const state = { meta: null, applicant: {}, threshold: 0.5, result: null, req: 0, loaded: {}, rows: {} };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, bad) {
  const t = $("#toast"); t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
function fmtVal(f, v) {
  if (typeof v === "string") return v;
  if (f === "Exposure") return v.toFixed(2);
  if (f === "Density") return Math.round(v).toLocaleString("en-IN");
  return String(Math.round(v));
}
function countUp(el, to, dur = 1000, dec = 0) {
  const from = parseFloat(el.dataset.v || "0"); el.dataset.v = to;
  if (reduce) { el.textContent = to.toFixed(dec); return; }
  const t0 = performance.now(); cancelAnimationFrame(el._raf);
  const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = (from + (to - from) * e).toFixed(dec); if (k < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
}
const raf2 = fn => requestAnimationFrame(() => requestAnimationFrame(fn));

/* ===================================================== navigation ===================================================== */
const views = ["underwrite", "notice", "global", "compliance", "pipeline"];
function movePill() {
  const t = $(".tab[aria-selected=true]"), p = $("#pill"); if (!t) return;
  p.style.width = t.offsetWidth + "px"; p.style.transform = `translateX(${t.offsetLeft}px)`;
  t.scrollIntoView({ block: "nearest", inline: "center", behavior: reduce ? "auto" : "smooth" });
}
function show(name, push = true) {
  if (!views.includes(name)) name = "underwrite";
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "v-" + name));
  $$(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.view === name));
  movePill(); if (push) history.replaceState(null, "", "#" + name);
  scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  document.title = `${$("#v-" + name).dataset.title} · InsureXplain`;
  if (name === "global") loadGlobal();
  if (name === "compliance") loadCompliance();
  if (name === "pipeline") loadPipeline();
  if (name === "notice" && state.result) renderNotice(state.result);
}
$("#tabs").addEventListener("click", e => { const b = e.target.closest(".tab"); if (b) show(b.dataset.view); });
addEventListener("hashchange", () => show(location.hash.slice(1), false));
addEventListener("resize", movePill);

/* ===================================================== hero ===================================================== */
(() => {
  const h = $("#heroTitle"); const words = h.textContent.trim().split(/\s+/);
  h.setAttribute("aria-label", h.textContent.trim());
  h.innerHTML = words.map((w, i) => `<span class="w" aria-hidden="true" style="animation-delay:${0.12 + i * 0.16}s">${esc(w)}</span>`).join("");
})();

/* ===================================================== form ===================================================== */
const sliderFns = f => f.scale === "log"
  ? { toPos: v => (Math.log(v) - Math.log(f.min)) / (Math.log(f.max) - Math.log(f.min)) * 1000, toVal: p => Math.round(Math.exp(Math.log(f.min) + p / 1000 * (Math.log(f.max) - Math.log(f.min)))), min: 0, max: 1000, step: 1 }
  : { toPos: v => v, toVal: p => +p, min: f.min, max: f.max, step: f.step };

function buildForm() {
  const box = $("#fields"); box.innerHTML = "";
  const frag = (f) => {
    const tag = f.sensitive ? `<span class="tag" title="Sensitive or proxy variable (${esc(f.sensitive)})">${TAGS[f.sensitive]}</span>` : "";
    if (f.type === "num") {
      const S = sliderFns(f);
      return `<div class="field"><div class="row"><label for="f-${f.key}">${esc(f.label)}${tag}</label><output id="o-${f.key}"></output></div>
        <input type="range" id="f-${f.key}" min="${S.min}" max="${S.max}" step="${S.step}" value="${S.toPos(f.default)}"></div>`;
    }
    if (f.key === "VehGas") {
      return `<div class="field"><div class="row"><label>${esc(f.label)}</label></div><div class="seg full" id="f-${f.key}" role="group">${f.options.map(o => `<button data-v="${o}" aria-pressed="false">${o}</button>`).join("")}</div></div>`;
    }
    return `<div class="field"><div class="row"><label for="f-${f.key}">${esc(f.label)}${tag}</label></div><select id="f-${f.key}">${f.options.map(o => `<option>${o}</option>`).join("")}</select></div>`;
  };
  const m = state.meta.features, byKey = Object.fromEntries(m.map(f => [f.key, f]));
  const order = ["DrivAge", "BonusMalus", "Exposure", "VehAge", "VehPower", "Density"];
  box.insertAdjacentHTML("beforeend", order.map(k => frag(byKey[k])).join(""));
  box.insertAdjacentHTML("beforeend", `<div class="pair">${["Area", "Region"].map(k => frag(byKey[k])).join("")}</div>`);
  box.insertAdjacentHTML("beforeend", `<div class="pair">${["VehBrand"].map(k => frag(byKey[k])).join("")}${frag(byKey.VehGas)}</div>`);

  for (const f of m) {
    const el = $("#f-" + f.key);
    if (f.type === "num") {
      const S = sliderFns(f);
      el.addEventListener("input", () => { state.applicant[f.key] = S.toVal(el.value); syncField(f); queue(); });
    } else if (f.key === "VehGas") {
      el.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; state.applicant[f.key] = b.dataset.v; syncField(f); queue(); });
    } else el.addEventListener("change", () => { state.applicant[f.key] = el.value; queue(); });
  }
}
function syncField(f) {
  const el = $("#f-" + f.key), v = state.applicant[f.key];
  if (f.type === "num") {
    const S = sliderFns(f); el.value = S.toPos(v);
    el.style.setProperty("--fill", ((el.value - S.min) / (S.max - S.min) * 100) + "%");
    $("#o-" + f.key).textContent = fmtVal(f.key, v) + (f.unit ? " " + f.unit : "");
  } else if (f.key === "VehGas") $$("button", el).forEach(b => b.setAttribute("aria-pressed", b.dataset.v === v));
  else el.value = v;
}
function applyPreset(p, btn) {
  Object.assign(state.applicant, p.values);
  state.meta.features.forEach(syncField);
  $$("#presets .chip").forEach(c => c.classList.toggle("on", c === btn));
  queue(true);
}
function buildPresets() {
  const box = $("#presets");
  box.innerHTML = state.meta.presets.map((p, i) => `<button class="chip" data-i="${i}">${esc(p.name)}</button>`).join("");
  box.addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) applyPreset(state.meta.presets[b.dataset.i], b); });
}

/* ===================================================== assess ===================================================== */
let timer;
function queue(now) { $$("#presets .chip").forEach(c => { if (!now) c.classList.remove("on"); }); clearTimeout(timer); timer = setTimeout(assess, now ? 0 : 280); }
async function assess() {
  const id = ++state.req;
  try {
    const r = await api("/api/assess", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicant: state.applicant, threshold: state.threshold }) });
    if (id !== state.req) return;
    state.result = r; render(r);
  } catch (e) { toast(e.message, true); }
}

$("#thr").addEventListener("input", e => {
  state.threshold = +e.target.value; $("#thrOut").textContent = state.threshold.toFixed(2);
  e.target.style.setProperty("--fill", ((e.target.value - e.target.min) / (e.target.max - e.target.min) * 100) + "%");
  const r = state.result; if (r) { r.flagged = r.probability >= state.threshold; paintVerdict(r); }
  queue();
});
$$("#mode button").forEach(b => b.addEventListener("click", () => {
  $$("#mode button").forEach(x => x.setAttribute("aria-pressed", x === b));
  const c = $("#crows"); c.classList.toggle("only-shap", b.dataset.m === "shap"); c.classList.toggle("only-lime", b.dataset.m === "lime");
}));

/* ---------- render ---------- */
const C = 2 * Math.PI * 96;
function paintVerdict(r) {
  const arc = $("#arc"), col = r.flagged ? "var(--adverse)" : "var(--protect)";
  arc.style.strokeDasharray = C; arc.style.strokeDashoffset = C * (1 - Math.min(1, r.probability));
  arc.setAttribute("stroke", col); arc.style.color = col;
  $("#tick").style.transform = `rotate(${state.threshold * 360}deg)`;
  const s = $("#state"); s.className = "state " + (r.flagged ? "flag" : "ok");
  $("#stateText").textContent = r.flagged ? "Flagged for adverse action" : "No adverse flag";
  $("#verdictHead").textContent = r.flagged ? "Score meets the threshold" : "Score is below the threshold";
  const diff = (r.probability - r.reference_mean) * 100;
  $("#verdictSub").textContent = `${Math.abs(diff).toFixed(1)} points ${diff >= 0 ? "above" : "below"} the reference portfolio average of ${pct(r.reference_mean)}. ` +
    (r.flagged && r.top_adverse.length ? `Principal reasons: ${r.top_adverse.map(k => labelOf(k).toLowerCase()).join(", ")}.` : "");
}
const labelOf = k => state.meta.features.find(f => f.key === k).label;

function render(r) {
  paintVerdict(r); countUp($("#pctNum"), r.probability * 100, 1200, 1);
  renderForce(r); renderRows(r); renderAgree(r); renderFlags(r);
  if ($("#v-notice").classList.contains("active")) renderNotice(r);
}

function renderForce(r) {
  const pos = r.features.filter(f => f.shap > 0.0004).sort((a, b) => b.shap - a.shap), neg = r.features.filter(f => f.shap < -0.0004).sort((a, b) => a.shap - b.shap);
  const sp = pos.reduce((s, f) => s + f.shap, 0), sn = -neg.reduce((s, f) => s + f.shap, 0), out = r.probability;
  const lo0 = out - sp, hi0 = out + sn, pad = Math.max(0.01, (hi0 - lo0) * 0.12), lo = lo0 - pad, hi = hi0 + pad, span = hi - lo;
  const X = v => (v - lo) / span * 100;
  const box = $("#force"); let cur = out - sp;
  const segs = [...pos.map(f => ({ f, t: "pos" })), ...neg.map(f => ({ f, t: "neg" }))];
  const next = new Map();
  for (const s of segs) { const w = Math.abs(s.f.shap); const left = s.t === "pos" ? cur : out + (next.get("negcur") || 0); next.set(s.f.key, { left: X(left), w: w / span * 100, t: s.t, f: s.f }); if (s.t === "pos") cur += w; else next.set("negcur", (next.get("negcur") || 0) + w); }
  next.delete("negcur");
  $$(".seg-f", box).forEach(e => { if (!next.has(e.dataset.k)) e.remove(); });
  for (const [k, s] of next) {
    let e = $(`.seg-f[data-k="${k}"]`, box);
    if (!e) { e = document.createElement("div"); e.dataset.k = k; e.style.left = X(out) + "%"; e.style.width = "0%"; box.appendChild(e); }
    e.className = "seg-f " + s.t; e.title = `${s.f.label}: ${pts(s.f.shap)} pts`;
    e.innerHTML = s.w > 12 ? `<span>${esc(s.f.label)}</span>` : ""; e.style.width = s.w + "%"; e.style.left = s.left + "%";
    if (!e._init) { e._init = 1; raf2(() => { e.style.left = s.left + "%"; e.style.width = s.w + "%"; }); }
  }
  const ax = $("#forceAxis");
  if (!ax.firstChild) ax.innerHTML = `<div class="fmark base" id="mBase"></div><div class="fmark out" id="mOut"></div>`;
  const mb = $("#mBase"), mo = $("#mOut"), baseX = X(r.base_value), outX = X(out);
  mb.style.left = baseX + "%"; mo.style.left = outX + "%";
  mb.innerHTML = `base value<br><b>${pct(r.base_value)}</b>`; mo.innerHTML = `this applicant<br><b>${pct(out)}</b>`;
  mb.style.marginTop = Math.abs(baseX - outX) < 16 ? "26px" : "0"; ax.style.height = Math.abs(baseX - outX) < 16 ? "62px" : "38px";
}

const ROW_H = 44;
function renderRows(r) {
  const box = $("#crows"); box.style.height = r.features.length * ROW_H + "px";
  const maxv = Math.max(0.02, ...r.features.map(f => Math.max(Math.abs(f.shap), Math.abs(f.lime))));
  r.features.forEach((f, i) => {
    let row = state.rows[f.key];
    if (!row) {
      const el = document.createElement("div"); el.className = "crow";
      el.innerHTML = `<div class="cl"><span class="cn"></span><span class="cv"></span></div><div class="cc"><div class="bar"></div><div class="lm"></div></div><div class="cp"></div>`;
      el.style.transform = `translateY(${i * ROW_H}px)`; box.appendChild(el);
      row = state.rows[f.key] = { el, bar: $(".bar", el), lm: $(".lm", el), cp: $(".cp", el), cv: $(".cv", el), cn: $(".cn", el) };
      row.cn.textContent = f.label;
    }
    row.cv.innerHTML = `${esc(fmtVal(f.key, f.value))}${f.sensitive ? `<span class="tag">${TAGS[f.sensitive]}</span>` : ""}`;
    const w = Math.abs(f.shap) / maxv * 50, pos = f.shap >= 0;
    row.bar.className = "bar " + (pos ? "pos" : "neg"); row.bar.style.width = w + "%"; row.bar.style.left = (pos ? 50 : 50 - w) + "%";
    row.lm.style.left = (50 + f.lime / maxv * 50) + "%";
    row.cp.className = "cp " + (pos ? "pos" : "neg"); row.cp.textContent = pts(f.shap);
    row.el.title = `${f.label}: SHAP ${pts(f.shap)} pts, LIME ${pts(f.lime)} pts`;
    row.el.style.transform = `translateY(${i * ROW_H}px)`;
  });
}
function renderAgree(r) {
  const a = r.agreement;
  $("#agree").innerHTML = `<span>Top-3 reasons shared by SHAP and LIME <b>${a.top3_overlap} of 3</b></span><span>Direction agreement <b>${a.sign_agreement} of ${a.of}</b></span><span>Rank correlation <b>${a.rank_correlation.toFixed(2)}</b></span><span>Surrogate fit R² <b>${r.lime.r2.toFixed(2)}</b></span>`;
}
function flagsHTML(r) { return r.review_flags.map(f => `<div class="flag ${f.level}"><i></i><div>${esc(f.text)}</div></div>`).join(""); }
function renderFlags(r) { $("#flags").innerHTML = flagsHTML(r); }

/* ===================================================== notice ===================================================== */
function renderNotice(r) {
  const n = r.notice, L = $("#letter");
  const reasons = n.reasons.map(x => `<div class="reason"><div class="n">${x.rank}</div><div>
      <h4>${esc(x.label)}<em>${esc(x.value)}${x.sensitive ? ` &nbsp;<span class="tag">${TAGS[x.sensitive]}</span>` : ""}</em></h4>
      <p>${esc(x.text)}</p><p class="hint">${esc(x.hint)}</p>
      <div class="share" title="Share of the top-three adverse push"><span data-w="${(x.share * 100).toFixed(0)}"></span></div></div></div>`).join("");
  const mit = n.mitigating.map(m => `<li><span>${esc(m.label)} <span class="muted">(${esc(m.value)})</span></span><b>${pts(m.points / 100)} pts</b></li>`).join("");
  L.innerHTML = `
    <div class="ref"><span>Reference ${esc(n.reference)}</span><span>${esc(n.date)}</span></div>
    <span class="stamp">${r.flagged ? "Simulated adverse action" : "Simulated explanation"}</span>
    <h2>${r.flagged ? "Why this application was flagged" : "How this score was reached"}</h2>
    <p class="muted">This educational notice explains a model prediction about recorded claim occurrence. It is not an actual underwriting decision, rejection, premium quote or legal adverse-action notice.</p>
    <p>The model's predicted likelihood of at least one recorded claim is <b>${pct(r.probability)}</b> against a decision threshold of <b>${r.threshold.toFixed(2)}</b>. ${esc(n.intro)}</p>
    <h3>${n.reasons.length ? "Principal reasons" : "Reasons"}</h3>
    ${reasons || `<p class="muted">No factor pushed the score above the portfolio baseline.</p>`}
    <h3>Factors that lowered the score</h3><ul class="mit">${mit}</ul>
    <h3>Important limitations</h3><ul class="limits">${n.limitations.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    <h3>Next step</h3><p>${esc(n.next_step)}</p>`;
  raf2(() => $$(".share span", L).forEach(s => s.style.width = s.dataset.w + "%"));
  $("#flags2").innerHTML = flagsHTML(r);
}
$("#dlTxt").addEventListener("click", async () => {
  try {
    const r = await fetch("/api/notice.txt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicant: state.applicant, threshold: state.threshold }) });
    const b = await r.blob(), a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${state.result.notice.reference}.txt`; a.click(); URL.revokeObjectURL(a.href); toast("Notice downloaded");
  } catch { toast("Download failed", true); }
});
$("#prt").addEventListener("click", () => print());
$("#cpy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(state.result.notice.text); toast("Notice copied"); } catch { toast("Copy blocked by browser", true); } });

/* ===================================================== global ===================================================== */
async function loadGlobal() {
  if (state.loaded.global) return; state.loaded.global = 1;
  try {
    const g = await api("/api/global"); state.global = g;
    const max = g.features[0].value;
    $("#gPanel").innerHTML = `<header><div><h3>Mean absolute SHAP value</h3><p>Average pull on the score, summed across each factor's encoded columns</p></div></header>` +
      g.features.map(f => `<button class="gbar ${f.sensitive ? "sens" : ""}" data-k="${f.key}" aria-pressed="false" style="--c:${GROUP_COLOR[f.group]}">
        <span class="nm">${esc(f.label)}${f.sensitive ? `<span class="tag">${TAGS[f.sensitive]}</span>` : ""}</span><span class="t"><span data-w="${(f.value / max * 100).toFixed(1)}"></span></span><span class="v">${(f.value * 100).toFixed(1)}</span></button>`).join("") +
      `<details><summary>Show the 20 strongest one-hot columns</summary><div class="tbl-scroll"><table><tr><th>Encoded column</th><th>Mean |SHAP|</th></tr>${g.encoded.map(e => `<tr><td>${esc(e.name.replace("num__", "").replace("cat__", ""))}</td><td>${(e.value * 100).toFixed(2)}</td></tr>`).join("")}</table></div></details>`;
    raf2(() => $$("#gPanel .t span").forEach((s, i) => setTimeout(() => s.style.width = s.dataset.w + "%", reduce ? 0 : i * 70)));
    $("#gPanel").addEventListener("click", e => { const b = e.target.closest(".gbar"); if (b) loadPDP(b.dataset.k); });
    const order = ["Claims history", "Vehicle", "Policy", "Age", "Geography"];
    $("#catPanel").innerHTML = `<header><div><h3>Where the importance sits</h3><p>Share of total by rating category</p></div></header>
      <div class="cats">${order.map(k => `<span data-g="${(g.by_group[k] || 0).toFixed(4)}" style="background:${GROUP_COLOR[k]}"></span>`).join("")}</div>
      <div class="catleg">${order.map(k => `<span><i style="background:${GROUP_COLOR[k]}"></i>${k} ${((g.by_group[k] || 0) * 100).toFixed(0)}%</span>`).join("")}</div>
      <p class="note">Hatched bars mark sensitive or proxy factors. Together they carry ${(g.sensitive_share * 100).toFixed(0)}% of the model's attributed importance.</p>`;
    raf2(() => $$("#catPanel .cats span").forEach(s => s.style.flexGrow = s.dataset.g));
    loadPDP(g.features[0].key);
  } catch (e) { toast(e.message, true); state.loaded.global = 0; }
}
async function loadPDP(key) {
  $$("#gPanel .gbar").forEach(b => b.setAttribute("aria-pressed", b.dataset.k === key));
  try {
    const d = await api("/api/pdp/" + key), P = d.points, W = 560, H = 260, m = { l: 46, r: 14, t: 16, b: 34 };
    const ys = P.map(p => p.y).concat(d.baseline), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = (y1 - y0) * 0.2 || 0.01;
    const Y = v => m.t + (1 - (v - (y0 - pad)) / (y1 - y0 + 2 * pad)) * (H - m.t - m.b);
    let X, ticks;
    if (d.numeric) {
      const xs = P.map(p => p.x), log = key === "Density", f = v => log ? Math.log(v) : v, a = f(Math.min(...xs)), b = f(Math.max(...xs));
      X = v => m.l + (f(v) - a) / (b - a || 1) * (W - m.l - m.r); ticks = [0, 1, 2, 3, 4].map(i => { const v = log ? Math.exp(a + (b - a) * i / 4) : a + (b - a) * i / 4; return { x: X(v), t: fmtVal(key, v) }; });
    } else { X = (v, i) => m.l + (i + 0.5) / P.length * (W - m.l - m.r); ticks = P.length <= 8 ? P.map((p, i) => ({ x: X(0, i), t: p.x })) : P.filter((_, i) => i % 3 === 0).map(p => ({ x: X(0, P.indexOf(p)), t: p.x })); }
    const yt = [0, 1, 2, 3].map(i => y0 - pad + (y1 - y0 + 2 * pad) * i / 3);
    const pts_ = P.map((p, i) => [X(p.x, i), Y(p.y)]);
    const path = pts_.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const body = d.numeric
      ? `<path class="area" d="${path} L${pts_.at(-1)[0]} ${H - m.b} L${pts_[0][0]} ${H - m.b} Z" opacity=".5"/><path class="line" id="pdpLine" d="${path}"/>`
      : P.map((p, i) => { const [x, y] = pts_[i]; return `<line x1="${x}" x2="${x}" y1="${H - m.b}" y2="${y}" stroke="var(--accent)" stroke-opacity=".5" stroke-width="2"/><circle class="pt" cx="${x}" cy="${y}" r="4"><title>${p.x}: ${pct(p.y)}</title></circle>`; }).join("");
    $("#pdpPanel").innerHTML = `<header><div><h3>${esc(d.label)}</h3><p>Average predicted risk across 300 reference policies as this factor varies</p></div></header>
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Partial dependence of ${esc(d.label)}"><defs><linearGradient id="pdpg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#98a2ff" stop-opacity=".35"/><stop offset="1" stop-color="#98a2ff" stop-opacity="0"/></linearGradient></defs>
      ${yt.map(v => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${pct(v)}</text>`).join("")}
      <line class="base" x1="${m.l}" x2="${W - m.r}" y1="${Y(d.baseline)}" y2="${Y(d.baseline)}"/><text x="${W - m.r}" y="${Y(d.baseline) - 6}" text-anchor="end" style="fill:var(--amber)">portfolio average</text>
      ${ticks.map(t => `<text x="${t.x}" y="${H - 10}" text-anchor="middle">${esc(t.t)}</text>`).join("")}${body}</svg>`;
    const ln = $("#pdpLine"); if (ln && !reduce) { const L = ln.getTotalLength(); ln.style.strokeDasharray = L; ln.style.strokeDashoffset = L; ln.getBoundingClientRect(); ln.style.transition = "stroke-dashoffset 1.6s cubic-bezier(.22,.8,.2,1)"; raf2(() => ln.style.strokeDashoffset = 0); }
  } catch (e) { toast(e.message, true); }
}

/* ===================================================== compliance ===================================================== */
const lvlText = { review: "Needs review", watch: "Watch", info: "Context", ok: "Clear" };
async function loadCompliance() {
  if (state.loaded.comp) return; state.loaded.comp = 1;
  try {
    const c = await api("/api/compliance"); state.comp = c;
    $("#signals").innerHTML = c.signals.map((s, i) => `<div class="flag ${s.level === "info" ? "" : s.level} panel" style="animation-delay:${i * 90}ms"><i></i><div><b>${esc(s.title)}</b><span class="muted small">${lvlText[s.level]}</span><div style="margin-top:6px">${esc(s.text)}</div></div></div>`).join("");
    $("#groupPanel").innerHTML = `<header><div><h3>Group diagnostics</h3><p>Bars show how often the model flags each group. Amber ticks mark the observed claim rate, the dashed line marks the overall flag rate.</p></div>
      <div class="seg" id="attrSeg">${Object.entries(c.attributes).map(([k, a], i) => `<button data-k="${k}" aria-pressed="${i === 0}">${esc(a.title)}</button>`).join("")}</div></header><div id="grpBody"></div>`;
    $("#attrSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; $$("#attrSeg button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderGroups(b.dataset.k); });
    renderGroups("age"); renderHeat(c.interactions); loadReport();
  } catch (e) { toast(e.message, true); state.loaded.comp = 0; }
}
function renderGroups(k) {
  const a = state.comp.attributes[k], max = Math.max(...a.groups.map(g => Math.max(g.flag_rate, g.claim_rate))) * 1.18, s = a.summary;
  $("#grpBody").innerHTML = `<div class="grp head"><span>Group</span><span>Flag rate and claim rate</span><span class="num">Recall</span><span class="num">FPR</span></div>` +
    a.groups.map(g => `<div class="grp ${g.small ? "small-g" : ""}"><span class="g">${esc(g.group)}<small>${g.n.toLocaleString("en-IN")}${g.small ? " · small" : ""}</small></span>
      <span class="gtrack" title="Flag ${pct(g.flag_rate)} · claims ${pct(g.claim_rate)}"><span class="f" data-w="${(g.flag_rate / max * 100).toFixed(1)}"></span><span class="c" style="left:${(g.claim_rate / max * 100).toFixed(1)}%"></span><span class="o" style="left:${(a.overall_flag_rate / max * 100).toFixed(1)}%"></span></span>
      <span class="num">${pct(g.tpr, 0)}</span><span class="num">${pct(g.fpr, 1)}</span></div>`).join("") +
    `<div class="summary-line"><span>Flag-rate spread <b>${s.ratio.toFixed(1)}×</b> (${esc(s.highest)} vs ${esc(s.lowest)})</span><span>Claim-rate spread <b>${s.claim_ratio.toFixed(1)}×</b></span><span>Recall gap <b>${(s.tpr_gap * 100).toFixed(0)} pts</b></span><span>FPR gap <b>${(s.fpr_gap * 100).toFixed(1)} pts</b></span></div>`;
  raf2(() => $$("#grpBody .f").forEach((e, i) => setTimeout(() => e.style.width = e.dataset.w + "%", reduce ? 0 : i * 45)));
}
function renderHeat(h) {
  const n = h.features.length, M = h.matrix, mx = Math.max(...M.flat()), sens = new Set(["DrivAge", "Region", "Area", "Density"]);
  let html = `<header><div><h3>Feature interactions</h3><p>Pairwise Shapley interaction strength. Hover a cell. Amber labels are sensitive or proxy factors.</p></div></header><div class="heat"><span></span>`;
  html += h.features.map((f, j) => `<span class="hh ${sens.has(f) ? "s" : ""}">${esc(h.labels[j])}</span>`).join("");
  for (let i = 0; i < n; i++) {
    html += `<span class="hr ${sens.has(h.features[i]) ? "s" : ""}">${esc(h.labels[i])}</span>`;
    for (let j = 0; j < n; j++) html += `<span class="cell ${i === j ? "diag" : ""}" data-i="${i}" data-j="${j}" style="--a:0"  data-a="${(M[i][j] / mx * 0.85).toFixed(3)}"></span>`;
  }
  html += `</div><div class="heat-info" id="heatInfo">Strongest pair: <b>${esc(labelOf(h.top_pairs[0].a))} × ${esc(labelOf(h.top_pairs[0].b))}</b> at ${(h.top_pairs[0].value * 100).toFixed(2)} points.</div><p class="note">${esc(h.note)} Run on the real dataset to test true proxy correlations.</p>`;
  const p = $("#heatPanel"); p.innerHTML = html;
  raf2(() => $$(".cell", p).forEach(c => setTimeout(() => c.style.setProperty("--a", c.dataset.a), reduce ? 0 : (+c.dataset.i + +c.dataset.j) * 60)));
  p.addEventListener("mouseover", e => { const c = e.target.closest(".cell"); if (!c || c.classList.contains("diag")) return; const i = +c.dataset.i, j = +c.dataset.j; $("#heatInfo").innerHTML = `<b>${esc(h.labels[i])} × ${esc(h.labels[j])}</b>: ${(M[i][j] * 100).toFixed(2)} points of average interaction`; });
}
function md(src) {
  const lines = src.split("\n"), out = []; let list = false, tbl = [];
  const inl = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/_(.+?)_/g, "<i>$1</i>").replace(/`(.+?)`/g, "<code>$1</code>");
  const flushT = () => { if (!tbl.length) return; const rows = tbl.filter(r => !/^\|[-:| ]+\|$/.test(r)).map(r => r.slice(1, -1).split("|").map(x => x.trim())); out.push("<div class='tbl-scroll'><table>" + rows.map((r, i) => "<tr>" + r.map(c => i ? `<td>${inl(c)}</td>` : `<th>${inl(c)}</th>`).join("") + "</tr>").join("") + "</table></div>"); tbl = []; };
  for (const l of lines) {
    if (l.startsWith("|")) { tbl.push(l.trim()); continue; } flushT();
    if (/^\s*[-*] /.test(l)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inl(l.replace(/^\s*[-*] /, ""))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    const h = l.match(/^(#{1,3}) (.*)/); if (h) out.push(`<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`);
    else if (/^\d+\. /.test(l)) out.push(`<p>${inl(l)}</p>`); else if (l.trim() && l.trim() !== "---") out.push(`<p>${inl(l)}</p>`);
  }
  flushT(); if (list) out.push("</ul>"); return out.join("");
}
async function loadReport() {
  try {
    const t = await (await fetch("/api/report.md")).text();
    $("#reportPanel").innerHTML = `<header><div><h3>Full report</h3><p>Model review, fairness diagnostics and recommendations</p></div></header>
      <a class="btn primary" href="/api/report.md" download style="margin-bottom:16px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg>Download report (.md)</a>
      <div class="mdview">${md(t)}</div>`;
  } catch { $("#reportPanel").innerHTML = `<div class="skeleton">Report unavailable</div>`; }
}

/* ===================================================== pipeline ===================================================== */
async function loadPipeline() {
  if (state.loaded.pipe) return; state.loaded.pipe = 1;
  try {
    const g = state.global || await api("/api/global"); state.global = g;
    const cols = [["Accuracy", "Accuracy"], ["Balanced accuracy", "Bal. acc."], ["Precision", "Precision"], ["Recall", "Recall"], ["F1", "F1"], ["ROC-AUC", "ROC-AUC"]];
    const best = Object.fromEntries(cols.map(([k]) => [k, Math.max(...g.models.map(m => m[k]))]));
    $("#modelTable").innerHTML = `<table><tr><th>Model</th>${cols.map(c => `<th>${c[1]}</th>`).join("")}</tr>${g.models.map(m => `<tr><td>${esc(m.Model)}</td>${cols.map(([k]) => `<td class="${m[k] === best[k] ? "best" : ""}">${m[k].toFixed(3)}</td>`).join("")}</tr>`).join("")}</table>`;
  } catch (e) { state.loaded.pipe = 0; }
}

/* ===================================================== boot ===================================================== */
(async function boot() {
  show(location.hash.slice(1) || "underwrite", false);
  setTimeout(movePill, 60); if (document.fonts) document.fonts.ready.then(movePill);
  try {
    const h = await api("/api/health"); $("#dot").classList.add("on"); $("#statusText").textContent = `Model online · ${h.trees} trees`;
    state.meta = await api("/api/meta");
    state.meta.features.forEach(f => state.applicant[f.key] = f.default);
    state.threshold = state.meta.threshold;
    buildPresets(); buildForm(); state.meta.features.forEach(syncField);
    const t = $("#thr"); t.style.setProperty("--fill", ((t.value - t.min) / (t.max - t.min) * 100) + "%");
    await assess();
    if (location.hash === "#global") loadGlobal();
  } catch (e) { $("#statusText").textContent = "API unreachable"; toast("Could not reach the model API", true); }
})();
})();
