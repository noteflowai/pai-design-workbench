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

import cadquery as cq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad_checks import AL, MOTOR, Stages, export, measure, motor, versions  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
req = spec["requirements"]
out = Path(args.output)
stage = Stages(out)

# Closed parameter sets. The reference satisfies all rules; each candidate trades one property.
VARIANTS = {
    "reference": {"t": 4.0, "bore": 22.5, "W": 60.0, "H_extra": 46.0, "label": "基准设计"},
    "lightweight": {"t": 2.5, "bore": 22.5, "W": 60.0, "H_extra": 46.0, "label": "轻量化：板厚 2.5 mm"},
    "undersize-bore": {"t": 4.0, "bore": 21.5, "W": 60.0, "H_extra": 46.0, "label": "止口孔 Ø21.5 mm"},
    "compact": {"t": 4.0, "bore": 22.5, "W": 50.0, "H_extra": 43.5, "label": "紧凑化：降低安装板高度"},
}
v = VARIANTS[spec["variant"]]
t, W, D, BORE = v["t"], v["W"], 30.0, v["bore"]
H = t + v["H_extra"]
ZC = t + 24.0                      # motor axis height
NEMA_PITCH, M3_CLEAR, M5_CLEAR = 31.0, 3.4, 5.5
RIB, RIB_LEG = 4.0, 20.0

base = cq.Workplane("XY").box(W, D, t, centered=(True, False, False))
stage("base", "底座法兰", [("Base flange", base, AL)])
plate = cq.Workplane("XY").box(W, t, H, centered=(True, False, False))
body = base.union(plate)
stage("plate", "电机安装板", [("Bracket", body, AL)])
for x in (-W / 2, W / 2 - RIB):
    rib = cq.Workplane("YZ").polyline([(t, t), (t + RIB_LEG, t), (t, t + RIB_LEG)]).close().extrude(RIB)
    body = body.union(rib.translate((x, 0, 0)))
stage("ribs", "两侧加强筋", [("Bracket", body, AL)])
face = cq.Workplane("XZ").workplane(offset=0)
body = body.cut(face.center(0, ZC).circle(BORE / 2).extrude(-t))
for dx in (-NEMA_PITCH / 2, NEMA_PITCH / 2):
    for dz in (-NEMA_PITCH / 2, NEMA_PITCH / 2):
        body = body.cut(face.center(dx, ZC + dz).circle(M3_CLEAR / 2).extrude(-t))
stage("nema", "NEMA 17 止口与 4× M3 孔", [("Bracket", body, AL)])
for x in (-20.0, 20.0):
    body = body.cut(cq.Workplane("XY").center(x, t + (D - t) / 2).circle(M5_CLEAR / 2).extrude(t))
solids = body.solids().vals()
part = solids[0] if len(solids) == 1 else body.val()
stage("mount", "2× M5 安装孔", [("Bracket", body, AL)])
stage("motor", "装配检查：NEMA 17 电机", [("Bracket", body, AL), ("NEMA 17 motor", motor(ZC), MOTOR)])

checks, volume, mass, size = measure(part, ZC, req)
export(body, ZC, out)
result = {
    "schema": "pai-cad-checks-1", "variant": spec["variant"], "variantLabel": v["label"], "units": "mm", **versions(),
    "material": "6061 aluminium (2.70 g/cm³, nominal)",
    "parameters": {"thickness": t, "width": W, "depth": D, "height": H, "pilotBore": BORE, "motorAxisHeight": ZC},
    "volume": round(volume, 3), "mass": round(mass, 3), "boundingBox": size, "checks": checks,
    "scope": "parametric-part-geometry", "physicalValidation": False,
    "limits": "Nominal geometry and DFM rules of thumb; no FEA, tolerance stack-up, process simulation or physical test",
}
(out / "checks.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"variant": spec["variant"], "passed": [c["id"] for c in checks if c["passed"]], "failed": [c["id"] for c in checks if not c["passed"]]}), file=sys.stderr)
