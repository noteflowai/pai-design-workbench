"""Native design-space sweep of a part family: build and measure every grid point with the family's own checks.

Input: {"family": "nema17-bracket" | "pillow-block", "requirements": {...}, "grid": {axis: [...]}, "fixed": {...}}.
- nema17-bracket: axes thickness, width, plateHeight, pilotBore (native/cad_recipe.py).
- pillow-block: axes width, depth, baseThickness, boltPitch; the other recipe parameters are `fixed` (native/cad_bearing.py).
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
import cad_bearing  # noqa: E402
import cad_recipe  # noqa: E402

PILLOW_AXES = ["width", "depth", "baseThickness", "boltPitch"]

MAX_POINTS = 36
parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
req, grid, out = spec["requirements"], spec["grid"], Path(args.output)
family = spec.get("family", "nema17-bracket")
fixed = spec.get("fixed") or {}
axes = PILLOW_AXES if family == "pillow-block" else list(cad_recipe.BOUNDS)
if set(grid) != set(axes) or (family != "pillow-block" and fixed):
    raise SystemExit(f"grid axes for {family} must be {axes}")


def build_and_measure(params):
    if family == "pillow-block":
        _, part, p = cad_bearing.build(params, lambda *a, **k: None)
        return cad_bearing.measure(part, p["axisHeight"], req)
    _, part, zc, _ = cad_recipe.build(params)
    return measure(part, zc, req)


values = [sorted({float(v) for v in grid[k]}) for k in axes]
combos = list(itertools.product(*values))
if not 1 <= len(combos) <= MAX_POINTS:
    raise SystemExit(f"grid must have 1–{MAX_POINTS} points")
points = []
for index, combo in enumerate(combos, 1):
    # Pillow points carry their complete recipe parameters (fixed + axes), so a chosen point is a normal review.
    params = {**fixed, **dict(zip(axes, combo))}
    started = time.monotonic()
    try:
        checks, volume, mass, size = build_and_measure(params)
        point = {"index": index, "parameters": params, "mass": round(mass, 3), "volume": round(volume, 3), "boundingBox": size,
                 "checks": [{"id": c["id"], "passed": c["passed"], "observed": c["observed"], "required": c["required"]} for c in checks],
                 "failed": [c["id"] for c in checks if not c["passed"]], "seconds": round(time.monotonic() - started, 2)}
    except Exception as e:  # noqa: BLE001 — a degenerate point is a result, not a sweep failure
        point = {"index": index, "parameters": params, "error": f"{type(e).__name__}: {str(e)[:200]}", "failed": ["build"], "seconds": round(time.monotonic() - started, 2)}
    point["feasible"] = not point["failed"]
    points.append(point)
    event({"type": "point", "index": index, "total": len(combos), "parameters": params, "mass": point.get("mass"), "failed": point["failed"]})

feasible = sorted((p for p in points if p["feasible"]), key=lambda p: (p["mass"], p["index"]))
result = {"schema": "pai-cad-sweep-1", **versions(), "family": family, **({"fixed": fixed} if fixed else {}), "units": "mm", "material": "6061 aluminium (2.70 g/cm³, nominal)", "axes": axes,
          "grid": dict(zip(axes, values)), "requirements": req, "points": points, "feasibleCount": len(feasible),
          "lightestFeasible": feasible[0]["index"] if feasible else None,
          "scope": "parametric-part-geometry", "physicalValidation": False,
          "limits": "Measured grid points only; nominal geometry and DFM rules of thumb; no FEA, optimisation guarantee or physical test"}
(out / "sweep.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"points": len(points), "feasible": len(feasible), "lightest": result["lightestFeasible"]}), file=sys.stderr)
