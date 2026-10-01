"""Controlled parametric NEMA 17 motor-mount bracket recipe with native OCCT checks.

Run with a pinned CadQuery interpreter. No user-supplied Python, STEP or geometry is accepted:
the input is a closed variant name plus numeric requirements. Emits one `PAI_EVENT {json}`
line per construction stage (staged GLB snapshots for live display). Authoritative artifacts
are part.step, part.stl, part.glb, assembly.glb, drawing.svg and checks.json.

Scope: nominal design geometry. Checks are geometric/DFM rules of thumb; no FEA, tolerance
stack-up, manufacturing process simulation or physical test.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad_checks import Stages, export, measure, versions  # noqa: E402
from cad_recipe import PRESETS, build  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
req = spec["requirements"]
out = Path(args.output)
# Closed preset parameter sets, or bounded explicit parameters (variant "parametric", e.g. a chosen sweep point).
if spec["variant"] == "parametric":
    params, label = spec["parameters"], "参数化候选"
else:
    params, label = PRESETS[spec["variant"]], PRESETS[spec["variant"]]["label"]
body, part, zc, parameters = build(params, Stages(out))
checks, volume, mass, size = measure(part, zc, req)
export(body, zc, out)
result = {
    "schema": "pai-cad-checks-1", "variant": spec["variant"], "variantLabel": label, "units": "mm", **versions(),
    "material": "6061 aluminium (2.70 g/cm³, nominal)",
    "parameters": {"thickness": parameters["thickness"], "width": parameters["width"], "depth": parameters["depth"], "height": parameters["height"],
                   "pilotBore": parameters["pilotBore"], "motorAxisHeight": zc, "plateHeight": parameters["plateHeight"]},
    "volume": round(volume, 3), "mass": round(mass, 3), "boundingBox": size, "checks": checks,
    "scope": "parametric-part-geometry", "physicalValidation": False,
    "limits": "Nominal geometry and DFM rules of thumb; no FEA, tolerance stack-up, process simulation or physical test",
}
(out / "checks.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"variant": spec["variant"], "passed": [c["id"] for c in checks if c["passed"]], "failed": [c["id"] for c in checks if not c["passed"]]}), file=sys.stderr)
