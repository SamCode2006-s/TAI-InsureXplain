"""InsureXplain — Flask API + static front-end.

Run locally:   python app.py            (http://localhost:8000)
Production:    gunicorn app:app -c gunicorn.conf.py
"""
import json
import os
import time

from flask import Flask, Response, jsonify, request, send_from_directory

import engine as ex

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["JSON_SORT_KEYS"] = False

_t0 = time.time()
ENGINE = ex.Engine()
PRESETS = json.loads((ex.ART / "presets.json").read_text())
LOAD_SECONDS = round(time.time() - _t0, 2)


def err(msg, code=400):
    return jsonify(error=msg), code


@app.after_request
def headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/health")
def health():
    return jsonify(status="ok", model="Random Forest", trees=int(ENGINE.rf.n_estimators), load_seconds=LOAD_SECONDS)


@app.get("/api/meta")
def meta():
    m = ex.meta(ENGINE)
    m["presets"] = PRESETS
    return jsonify(m)


@app.post("/api/assess")
def assess():
    body = request.get_json(silent=True) or {}
    try:
        thr = float(body.get("threshold", 0.5))
        return jsonify(ENGINE.assess(body.get("applicant", {}), thr))
    except ValueError as e:
        return err(str(e))


@app.post("/api/notice.txt")
def notice_txt():
    body = request.get_json(silent=True) or {}
    try:
        res = ENGINE.assess(body.get("applicant", {}), float(body.get("threshold", 0.5)))
    except ValueError as e:
        return err(str(e))
    n = res["notice"]
    return Response(n["text"], mimetype="text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{n["reference"]}.txt"'})


@app.get("/api/global")
def global_view():
    return jsonify(ENGINE.global_view())


@app.get("/api/pdp/<feature>")
def pdp(feature):
    try:
        return jsonify(ENGINE.pdp(feature))
    except ValueError as e:
        return err(str(e), 404)


@app.get("/api/compliance")
def compliance():
    c = ENGINE.compliance()
    c["interactions"] = ENGINE.interactions()
    return jsonify(c)


@app.get("/api/report.md")
def report():
    return Response(ENGINE.report_markdown(), mimetype="text/markdown",
                    headers={"Content-Disposition": 'attachment; filename="insurexplain_regulatory_report.md"'})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
