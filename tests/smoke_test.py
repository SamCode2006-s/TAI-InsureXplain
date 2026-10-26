"""Run:  python tests/smoke_test.py   (from the project root)"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import app

c = app.app.test_client()
for url in ["/", "/api/health", "/api/meta", "/api/global", "/api/pdp/DrivAge", "/api/compliance", "/api/report.md"]:
    assert c.get(url).status_code == 200, url

r = c.post("/api/assess", json={"applicant": {"DrivAge": 19, "BonusMalus": 104, "Exposure": 1.0}, "threshold": 0.5}).json
# Shapley efficiency: baseline + contributions must equal the model output
total = r["base_value"] + sum(f["shap"] for f in r["features"])
assert abs(total - r["probability"]) < 1e-6, (total, r["probability"])
assert len(r["top_adverse"]) <= 3 and "text" in r["notice"]
assert c.post("/api/assess", json={"applicant": {"Region": "ZZ"}}).status_code == 400
assert c.post("/api/notice.txt", json={"applicant": {}}).status_code == 200
print("all checks passed; probability =", round(r["probability"], 3))
