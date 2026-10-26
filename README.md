# InsureXplain — Interpretable Underwriting Engine

Flask API + single-page UI around your trained Random-Forest pipeline.
Author: SAMBHAV SINGH CHAUDHARY, TY-AIDS.

## Run locally
```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py                                          # http://localhost:8000
python tests/smoke_test.py                             # optional self-check
```
`scikit-learn==1.6.1` is pinned because your `.joblib` was saved with that version.
(The engine also runs on newer versions: it re-implements the preprocessing in NumPy and only uses the forest itself.)

## What maps to your three deliverables
| Deliverable | Where |
|---|---|
| Training pipeline + automated explanations | `artifacts/insurexplain_model_pipeline.joblib` (yours) + `engine.py` (exact Shapley over 10 factors, LIME surrogate) |
| Adverse Action Notice generator | `Engine.notice()` in `engine.py`; **Adverse notice** tab; `POST /api/notice.txt` |
| Global compliance report | `Engine.compliance()` / `report_markdown()`; **Global view** and **Compliance** tabs; `GET /api/report.md` |

## API
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/meta` | feature schema, presets, baseline |
| POST | `/api/assess` | `{applicant:{…}, threshold:0.5}` → score, SHAP, LIME, notice, reviewer flags |
| POST | `/api/notice.txt` | same input → downloadable notice |
| GET | `/api/global` | aggregated global SHAP + model comparison |
| GET | `/api/pdp/<feature>` | partial dependence |
| GET | `/api/compliance` | fairness tables, signals, interaction matrix |
| GET | `/api/report.md` | full regulatory report |

## Deploy
The model file is ~164 MB and the process uses ~500 MB RAM, so choose a host with at least 1 GB.

* **Hugging Face Spaces (free, 16 GB RAM)**: create a *Docker* Space, add `app_port: 7860` to the Space README header, set variable `PORT=7860`, push this folder (large files go through Git LFS/Xet automatically).
* **Render / Railway / Fly.io**: use the included `Dockerfile` (or `render.yaml`, `Procfile`). Use a plan with ≥1 GB RAM.
* **Docker anywhere**: `docker build -t insurexplain . && docker run -p 8000:8000 insurexplain`
* **GitHub**: files over 100 MB need Git LFS: `git lfs track "*.joblib"`.

## Notes on method (worth stating in your viva)
* Shapley values are exact (all 1,024 coalitions of the 10 raw factors) against 24 background policies; contributions sum to *score − baseline*.
* The dataset is not bundled, so the reference portfolio is synthesised from the fitted preprocessor statistics and your exported group sizes. The interaction matrix is therefore a *model* interaction analysis, not a data-correlation study; rerun `Engine.compute_interactions` with real rows for the latter.
* The model uses balanced class weights, so scores rank risk but are not calibrated probabilities.
* Target is claim occurrence, not an approval decision; the notice is labelled simulated throughout.
