"""Calibration gate for the DoMINO aerodynamic prescreen: pair its Cd with native OpenFOAM Cd on the same bodies.

    python3 tools/prescreen_calibrate.py --solves DIR [DIR ...] --output docs/evidence/prescreen-calibration.json

Each solve directory holds a native aero result (body.json, body.stl, cfd.json from native/cfd_review.py). The prescreen
runs on that exact STL (digest recorded). The gate admits the prescreen as a *ranking* signal only when, over at least
MIN_POINTS distinct bodies, Spearman's rank correlation with the fine-mesh OpenFOAM Cd is >= MIN_SPEARMAN. Absolute Cd
is reported but never gated on: the surrogate is out of distribution and its numbers are never results.
"""
import argparse, hashlib, json, os, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

MIN_POINTS, MIN_SPEARMAN = 6, 0.8
ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument("--solves", nargs="+", required=True); p.add_argument("--output", required=True)
p.add_argument("--tools", default=str(ROOT / ".state/tools/physicsnemo-cfd"))
p.add_argument("--scale", type=float, default=4.4)
a = p.parse_args()
tools = Path(a.tools)
py, workflow = tools / "venv/bin/python", tools / "src/workflows/domino_design_sensitivities"
checkpoint = tools / "domino_drivaerml/domino_drivaerml_surface_checkpoint/DoMINO.0.501.mdlus"


def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i]); r = [0.0] * len(xs); i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(x, y):
    rx, ry = ranks(x), ranks(y); n = len(x); mx, my = sum(rx) / n, sum(ry) / n
    num = sum((u - mx) * (v - my) for u, v in zip(rx, ry))
    den = (sum((u - mx) ** 2 for u in rx) * sum((v - my) ** 2 for v in ry)) ** 0.5
    return num / den if den else None


points, seen = [], set()
for d in (Path(x).resolve() for x in a.solves):
    body, cfd = json.loads((d / "body.json").read_text()), json.loads((d / "cfd.json").read_text())
    key = json.dumps(body["parameters"], sort_keys=True)
    if key in seen:
        continue
    seen.add(key)
    digest = hashlib.sha256((d / "body.stl").read_bytes()).hexdigest()
    # Cache next to the tools, keyed by the STL digest; recorded solve directories are never written to.
    out = tools / "prescreen-cache" / f"{digest}-s{a.scale}.json"; out.parent.mkdir(exist_ok=True)
    if not out.exists():
        r = subprocess.run([str(py), str(ROOT / "native/cfd_prescreen.py"), "--stl", str(d / "body.stl"), "--output", str(out), "--workflow", str(workflow),
                            "--checkpoint", str(checkpoint), "--frontal-area", str(body["frontalAreaM2"]), "--scale", str(a.scale)],
                           capture_output=True, text=True, cwd=workflow, env={**os.environ, "PYTHONWARNINGS": "ignore"})
        if r.returncode != 0:
            sys.exit(f"prescreen failed on {d}: {r.stderr[-800:]}")
    ps = json.loads(out.read_text())
    fine = max(cfd["levels"], key=lambda l: l["level"])
    points.append({"parameters": body["parameters"], "stlSha256": digest,
                   "openfoamCd": fine["cd"], "openfoamLevel": fine["level"], "prescreenCd": ps["cd"], "prescreenSeconds": ps["seconds"],
                   "openfoamSeconds": cfd.get("seconds")})
points.sort(key=lambda x: json.dumps(x["parameters"], sort_keys=True))
rho = spearman([x["openfoamCd"] for x in points], [x["prescreenCd"] for x in points]) if len(points) >= 2 else None
admitted = len(points) >= MIN_POINTS and rho is not None and rho >= MIN_SPEARMAN
model = ps["model"] if points else None
report = {
    "schema": "pai-prescreen-calibration-1", "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "model": model, "scale": a.scale, "points": points, "n": len(points),
    "spearman": None if rho is None else round(rho, 3),
    "meanRatio": round(sum(x["prescreenCd"] / x["openfoamCd"] for x in points) / len(points), 3) if points else None,
    "gate": {"minPoints": MIN_POINTS, "minSpearman": MIN_SPEARMAN, "admittedForRanking": admitted},
    "rule": "admitted only as a ranking signal; the prescreen Cd is never a result, and every ranked body is still solved natively",
    "physicalValidation": False,
}
Path(a.output).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"n": report["n"], "spearman": report["spearman"], "meanRatio": report["meanRatio"], "admitted": admitted}))
