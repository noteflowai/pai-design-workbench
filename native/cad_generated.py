"""Measure a sandbox-produced solid with the same native checks as the preset recipe.

Also runs inside the sandbox (it parses data written by untrusted code). Reads generated.brep and the
declared motor axis; writes part.step/stl/glb, assembly.glb, drawing.svg, staged GLBs and checks.json.
"""
import argparse
import json
import sys
from pathlib import Path

import cadquery as cq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad_checks import AL, MOTOR, Stages, export, measure, motor, versions  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--source", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
req, out, source = spec["requirements"], Path(args.output), Path(args.source)
produced = json.loads((source / "result.json").read_text())
zc = float(produced["motorAxisZ"])
part = cq.Shape.importBrep(str(source / "generated.brep"))
stage = Stages(out)
stage("generated", "生成代码的实体", [("Bracket", part, AL)])
stage("motor", "装配检查：NEMA 17 电机", [("Bracket", part, AL), ("NEMA 17 motor", motor(zc), MOTOR)])
checks, volume, mass, size = measure(part, zc, req)
export(part, zc, out)
result = {
    "schema": "pai-cad-checks-1", "variant": "generated", "variantLabel": "生成代码（沙箱）", "units": "mm", **versions(),
    "material": "6061 aluminium (2.70 g/cm³, nominal)", "parameters": {"motorAxisHeight": zc, "codeSha256": spec["codeSha256"]},
    "volume": round(volume, 3), "mass": round(mass, 3), "boundingBox": size, "checks": checks,
    "scope": "parametric-part-geometry", "physicalValidation": False,
    "limits": "Nominal geometry and DFM rules of thumb; no FEA, tolerance stack-up, process simulation or physical test",
}
(out / "checks.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"variant": "generated", "failed": [c["id"] for c in checks if not c["passed"]]}), file=sys.stderr)
