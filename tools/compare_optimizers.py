"""Benchmark the optimisation strategies on the same budget and seeds (native solver results only).

Usage: python3 tools/compare_optimizers.py <out-dir> [seeds=3,7,11] [strategies=gp-nsga2,botorch-qlognehvi]
Runs native/cad_optimize.py with the pinned physics interpreter for each (strategy, seed) pair. There are no AI seeds,
so only the search strategy differs. Writes compare.json with, per run: solver calls, feasible points, lightest
feasible mass and the hypervolume of the measured feasible front (mass ↓, deflection ↓), using the requirement
limits as reference point. Strategies are compared on the same seeds (paired).
"""
import json, os, subprocess, sys, time
from pathlib import Path

root = Path(__file__).resolve().parents[1]
env = dict(line.split("=", 1) for line in (root / ".state/demo.env").read_text().splitlines() if "=" in line and not line.startswith("#"))
py, cq, ccx = env["PAI_PHYSICS_PYTHON"], env["PAI_CADQUERY_PYTHON"], env["PAI_CCX"]
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
seeds = [int(s) for s in (sys.argv[2] if len(sys.argv) > 2 else "3,7,11").split(",")]
strategies = (sys.argv[3] if len(sys.argv) > 3 else "gp-nsga2,botorch-qlognehvi").split(",")
# Optional warm start: solved points of earlier runs (optimize.json files under this directory) train the surrogate.
warm_dir = Path(sys.argv[4]) if len(sys.argv) > 4 else None
prior = []
if warm_dir:
    for f in sorted(warm_dir.glob("*/optimize.json")):
        for q in json.loads(f.read_text())["points"]:
            if q.get("fidelity") == "fea" and "deflectionMm" in q and "stressMPa" in q:
                prior.append({"parameters": {k: q["parameters"][k] for k in ("thickness", "width", "plateHeight")}, "deflectionMm": q["deflectionMm"],
                              "stressMPa": q["stressMPa"], "mass": q["mass"], "minWallMm": q["minWallMm"], "holeEdgeMm": q["holeEdgeMm"]})
req = {"maxMassG": 80, "minWallMm": 3, "edgeDistanceFactor": 1.5, "requireNoInterference": True, "maxEnvelopeMm": [80, 40, 60],
       "structural": {"forceN": 60, "leverMm": 50, "safetyFactor": 2, "maxDeflectionMm": 0.06}}
budget = {"initial": 8, "rounds": 3, "perRound": 3}


def hypervolume(front, ref):
    """2-D hypervolume (minimisation) of points [(mass, deflection)] dominated region up to ref."""
    pts = sorted(p for p in front if p[0] < ref[0] and p[1] < ref[1])
    hv, best_d = 0.0, ref[1]
    for m, d in pts:
        if d < best_d:
            hv += (ref[0] - m) * (best_d - d); best_d = d
    return hv


runs = []
for seed in seeds:
    for strategy in strategies:
        d = out / f"{strategy}-s{seed}"
        if not (d / "optimize.json").exists():
            d.mkdir(parents=True, exist_ok=True)
            (d / "input.json").write_text(json.dumps({"cadquery": cq, "ccx": ccx, "requirements": req, "budget": budget, "seeds": [], "strategy": strategy,
                                                      "seed": seed, "parallel": 2, "prior": prior}))
            t0 = time.monotonic()
            r = subprocess.run([py, "-I", str(root / "native/cad_optimize.py"), "--input", str(d / "input.json"), "--output", str(d)], capture_output=True, text=True)
            (d / "stderr.log").write_text(r.stderr[-20000:])
            (d / "seconds").write_text(str(round(time.monotonic() - t0)))
            if r.returncode != 0:
                runs.append({"strategy": strategy, "seed": seed, "error": r.stderr.strip().splitlines()[-1][:300] if r.stderr.strip() else r.returncode}); continue
        res = json.loads((d / "optimize.json").read_text())
        feas = [p for p in res["points"] if p["feasible"]]
        solved = [p for p in res["points"] if p["fidelity"] == "fea"]
        best = min(feas, key=lambda p: p["mass"]) if feas else None
        runs.append({"strategy": strategy, "seed": seed, "seconds": int((d / "seconds").read_text()) if (d / "seconds").exists() else None,
                     "solverCalls": len(solved), "screens": sum(1 for p in res["points"] if p["fidelity"] == "geometry"), "feasible": len(feas),
                     "lightestMassG": best and best["mass"], "lightestDeflectionMm": best and best["deflectionMm"],
                     "hypervolume": round(hypervolume([(p["mass"], p["deflectionMm"]) for p in feas], (req["maxMassG"], req["structural"]["maxDeflectionMm"])), 4),
                     "calibrationMedian": (sorted(c["relativeError"] for c in res["calibration"])[len(res["calibration"]) // 2] if res["calibration"] else None)})
        print(json.dumps(runs[-1]), flush=True)
summary = {}
for s in strategies:
    rs = [r for r in runs if r["strategy"] == s and "error" not in r]
    summary[s] = {"runs": len(rs), "meanLightestMassG": round(sum(r["lightestMassG"] or 0 for r in rs) / max(1, len(rs)), 2),
                  "meanHypervolume": round(sum(r["hypervolume"] for r in rs) / max(1, len(rs)), 4),
                  "meanSolverCalls": round(sum(r["solverCalls"] for r in rs) / max(1, len(rs)), 1)}
pairs = [(a, b) for a in runs for b in runs if a["seed"] == b["seed"] and a["strategy"] == strategies[0] and b["strategy"] == strategies[-1] and "error" not in a and "error" not in b]
report = {"schema": "pai-optimizer-compare-1", "warmStartPoints": len(prior), "budget": budget, "requirements": req, "seeds": seeds, "runs": runs, "summary": summary,
          "paired": [{"seed": a["seed"], "lighterBy": strategies[-1] if (b["lightestMassG"] or 1e9) < (a["lightestMassG"] or 1e9) else strategies[0],
                      "massDeltaG": round((b["lightestMassG"] or 0) - (a["lightestMassG"] or 0), 2), "hypervolumeDelta": round(b["hypervolume"] - a["hypervolume"], 4)} for a, b in pairs],
          "note": "Native measurements only (CadQuery B-Rep + CalculiX fine mesh). A small paired panel; not a statistical claim beyond these seeds."}
(out / "compare.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(summary))
