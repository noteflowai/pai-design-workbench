"""Native design-space sweep of the NEMA 17 bracket: build and measure every grid point with the shared checks.

Input: {"requirements": {...}, "grid": {"thickness": [...], "width": [...], "plateHeight": [...], "pilotBore": [...]}}.
Each point is built by the trusted recipe and measured on its own B-Rep (no interpolation, no surrogate).
Emits one PAI_EVENT per point; writes sweep.json. A point that fails to build is recorded with its error.
The sweep is exploration: it ranks measured points but accepts nothing; a chosen point becomes a normal review.
"""
import argparse
import itertools
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad_checks import event, measure, versions  # noqa: E402
from cad_recipe import BOUNDS, build  # noqa: E402

MAX_POINTS = 36
parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
req, grid, out = spec["requirements"], spec["grid"], Path(args.output)
axes = [k for k in BOUNDS]
values = [sorted({float(v) for v in grid[k]}) for k in axes]
combos = list(itertools.product(*values))
if not 1 <= len(combos) <= MAX_POINTS:
    raise SystemExit(f"grid must have 1–{MAX_POINTS} points")
points = []
for index, combo in enumerate(combos, 1):
    params = dict(zip(axes, combo))
    started = time.monotonic()
    try:
        _, part, zc, built = build(params)
        checks, volume, mass, size = measure(part, zc, req)
        point = {"index": index, "parameters": params, "mass": round(mass, 3), "volume": round(volume, 3), "boundingBox": size,
                 "checks": [{"id": c["id"], "passed": c["passed"], "observed": c["observed"], "required": c["required"]} for c in checks],
                 "failed": [c["id"] for c in checks if not c["passed"]], "seconds": round(time.monotonic() - started, 2)}
    except Exception as e:  # noqa: BLE001 — a degenerate point is a result, not a sweep failure
        point = {"index": index, "parameters": params, "error": f"{type(e).__name__}: {str(e)[:200]}", "failed": ["build"], "seconds": round(time.monotonic() - started, 2)}
    point["feasible"] = not point["failed"]
    points.append(point)
    event({"type": "point", "index": index, "total": len(combos), "parameters": params, "mass": point.get("mass"), "failed": point["failed"]})

feasible = sorted((p for p in points if p["feasible"]), key=lambda p: (p["mass"], p["index"]))
result = {"schema": "pai-cad-sweep-1", **versions(), "units": "mm", "material": "6061 aluminium (2.70 g/cm³, nominal)", "axes": axes,
          "grid": dict(zip(axes, values)), "requirements": req, "points": points, "feasibleCount": len(feasible),
          "lightestFeasible": feasible[0]["index"] if feasible else None,
          "scope": "parametric-part-geometry", "physicalValidation": False,
          "limits": "Measured grid points only; nominal geometry and DFM rules of thumb; no FEA, optimisation guarantee or physical test"}
(out / "sweep.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"points": len(points), "feasible": len(feasible), "lightest": result["lightestFeasible"]}), file=sys.stderr)
