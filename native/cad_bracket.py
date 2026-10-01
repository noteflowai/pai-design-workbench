"""Controlled parametric NEMA 17 motor-mount bracket recipe with native OCCT checks.

Run with a pinned CadQuery interpreter. No user-supplied Python, STEP or geometry is accepted:
the input is a closed variant name plus numeric requirements. Emits one `PAI_EVENT {json}`
line per construction stage (staged GLB snapshots for live display). Authoritative artifacts
are part.step, part.stl, part.glb, assembly.glb, drawing.svg and checks.json.

Scope: nominal design geometry. Checks are geometric/DFM rules of thumb; no FEA, tolerance
stack-up, manufacturing process simulation or physical test.
"""
import argparse
import importlib.metadata
import json
import math
import sys
from pathlib import Path

import cadquery as cq
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepTools import BRepTools
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_IN

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
req = spec["requirements"]
out = Path(args.output)
(out / "stages").mkdir(parents=True, exist_ok=True)

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
NEMA_PITCH, M3_CLEAR, M5_CLEAR = 31.0, 3.4, 5.5   # NEMA 17 bolt square; ISO 273 medium clearance
RIB, RIB_LEG = 4.0, 20.0
DENSITY = 2.70e-3                  # 6061 aluminium, g/mm³
AL, MOTOR, RIB_C = (0.62, 0.67, 0.72), (0.34, 0.37, 0.4), (0.45, 0.62, 0.7)
index = [0]


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True, ensure_ascii=False), flush=True)


def stage(stage_id, label, items):
    index[0] += 1
    name = f"{index[0]:02d}-{stage_id}.glb"
    assy = cq.Assembly()
    for n, shape, color in items:
        assy.add(shape, name=n, color=cq.Color(*color))
    assy.export(str(out / "stages" / name))
    event({"type": "stage", "index": index[0], "id": stage_id, "label": label, "file": "stages/" + name, "objects": [n for n, _, _ in items]})


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

# NEMA 17 envelope: 42.3 mm body, Ø22 × 2 mm pilot boss and Ø5 shaft on the mounting face (y = 0).
motor = (cq.Workplane("XZ").center(0, ZC).rect(42.3, 42.3).extrude(40.0)
         .union(cq.Workplane("XZ").center(0, ZC).circle(11.0).extrude(-2.0))
         .union(cq.Workplane("XZ").center(0, ZC).circle(2.5).extrude(-24.0)))
stage("motor", "装配检查：NEMA 17 电机", [("Bracket", body, AL), ("NEMA 17 motor", motor, MOTOR)])


def distance(a, b):
    d = BRepExtrema_DistShapeShape(a, b)
    d.Perform()
    return d.Value(), d.PointOnShape1(1), d.PointOnShape2(1)


def solutions(a, b):
    d = BRepExtrema_DistShapeShape(a, b)
    d.Perform()
    return d.Value(), [(d.PointOnShape1(k), d.PointOnShape2(k)) for k in range(1, d.NbSolution() + 1)]


def inside(p):
    return BRepClass3d_SolidClassifier(part.wrapped, p, 1e-6).State() == TopAbs_IN


def material_between(p1, p2):
    """Closest points often lie on edges, so the midpoint can be ON a boundary; probe 0.05 mm around it."""
    mid = gp_Pnt((p1.X() + p2.X()) / 2, (p1.Y() + p2.Y()) / 2, (p1.Z() + p2.Z()) / 2)
    if inside(mid):
        return True
    offsets = [(0.05, 0, 0), (-0.05, 0, 0), (0, 0.05, 0), (0, -0.05, 0), (0, 0, 0.05), (0, 0, -0.05)]
    return any(inside(gp_Pnt(mid.X() + a, mid.Y() + b, mid.Z() + c)) for a, b, c in offsets)


# Holes: cylindrical faces grouped by axis and centre (seam-split faces merge).
holes = {}
for f in part.Faces():
    if f.geomType() != "CYLINDER":
        continue
    cyl = f._geomAdaptor().Cylinder()
    loc, direction = cyl.Axis().Location(), cyl.Axis().Direction()
    axis = "y" if abs(direction.Y()) > 0.99 else "z" if abs(direction.Z()) > 0.99 else "other"
    key = (axis, round(loc.X(), 3), round(loc.Z(), 3) if axis == "y" else round(loc.Y(), 3))
    holes.setdefault(key, {"axis": axis, "d": round(2 * cyl.Radius(), 4), "centre": [key[1], key[2]], "faces": []})["faces"].append(f)
plate_holes = [h for h in holes.values() if h["axis"] == "y"]
base_holes = [h for h in holes.values() if h["axis"] == "z"]
bore = max(plate_holes, key=lambda h: h["d"])
bolts = [h for h in plate_holes if h is not bore]
pitches = sorted({round(abs(b["centre"][0] - bore["centre"][0]) * 2, 3) for b in bolts} | {round(abs(b["centre"][1] - bore["centre"][1]) * 2, 3) for b in bolts})
interface_ok = (bore["d"] >= 22.2 and len(bolts) == 4 and all(abs(b["d"] - M3_CLEAR) <= 0.1 for b in bolts)
                and all(abs(p - NEMA_PITCH) <= 0.1 for p in pitches))

# Edge distance: hole centre to the outer boundary of its planar mounting face.
planar = [f for f in part.Faces() if f.geomType() == "PLANE"]
front = max((f for f in planar if f.normalAt().y < -0.999), key=lambda f: f.Area())
bottom = max((f for f in planar if f.normalAt().z < -0.999), key=lambda f: f.Area())
edge_rows = []
# Fastener clearance holes only; the pilot bore is covered by the interface and wall checks.
for h, face_ in [(h, front) for h in bolts] + [(h, bottom) for h in base_holes]:
    x, second = h["centre"]
    point = gp_Pnt(x, 0.0, second) if h["axis"] == "y" else gp_Pnt(x, second, 0.0)
    e, _, _ = distance(BRepBuilderAPI_MakeVertex(point).Vertex(), BRepTools.OuterWire_s(face_.wrapped))
    edge_rows.append({"d": h["d"], "centre": h["centre"], "edgeDistance": round(e, 3), "required": round(req["edgeDistanceFactor"] * h["d"], 3)})
edge_ok = all(r["edgeDistance"] + 1e-6 >= r["required"] for r in edge_rows)
worst_edge = min(edge_rows, key=lambda r: r["edgeDistance"] - r["required"])

# Wall thickness: opposite-normal planar pairs and hole-to-hole ligaments with material between them.
walls = []
for i, a in enumerate(planar):
    na = a.normalAt()
    for b in planar[i + 1:]:
        if na.dot(b.normalAt()) > -0.999:
            continue
        value, pairs = solutions(a.wrapped, b.wrapped)
        if value > 1e-6 and any(material_between(p1, p2) for p1, p2 in pairs):
            walls.append(("plate", value))
cylinders = [f for h in holes.values() for f in h["faces"]]
for i, a in enumerate(cylinders):
    for b in cylinders[i + 1:]:
        value, pairs = solutions(a.wrapped, b.wrapped)
        if value > 1e-6 and any(material_between(p1, p2) for p1, p2 in pairs):
            walls.append(("ligament", value))
min_wall = min(walls, key=lambda w: w[1])

common = cq.Shape.cast(BRepAlgoAPI_Common(part.wrapped, motor.val().wrapped).Shape())
interference = max(0.0, common.Volume())
volume = part.Volume()
mass = volume * DENSITY
bb = part.BoundingBox()
size = [round(bb.xlen, 3), round(bb.ylen, 3), round(bb.zlen, 3)]
valid = BRepCheck_Analyzer(part.wrapped).IsValid() and len(part.Solids()) == 1
event({"type": "measure", "mass": round(mass, 2), "minWall": round(min_wall[1], 3), "interference": round(interference, 3)})

checks = [
    {"id": "solid-valid", "passed": bool(valid), "observed": len(part.Solids()), "required": 1, "unit": "solid", "method": "OCCT BRepCheck_Analyzer; single closed solid"},
    {"id": "nema17-interface", "passed": bool(interface_ok), "observed": {"pilotBore": bore["d"], "boltHoles": [b["d"] for b in bolts], "pitch": pitches},
     "required": {"pilotBoreMin": 22.2, "boltHole": M3_CLEAR, "pitch": NEMA_PITCH}, "unit": "mm", "method": "Cylindrical faces measured from the B-Rep"},
    {"id": "motor-interference", "passed": interference <= 1e-6 or not req["requireNoInterference"], "observed": round(interference, 3), "required": 0, "unit": "mm3",
     "method": "Boolean common with NEMA 17 body, Ø22 pilot boss and Ø5 shaft"},
    {"id": "min-wall", "passed": min_wall[1] + 1e-6 >= req["minWallMm"], "observed": round(min_wall[1], 3), "required": req["minWallMm"], "unit": "mm",
     "method": f"Minimum over opposite planar faces and hole ligaments with material between; governing: {min_wall[0]}"},
    {"id": "hole-edge-distance", "passed": bool(edge_ok), "observed": worst_edge["edgeDistance"], "required": worst_edge["required"], "unit": "mm",
     "method": f"Hole centre to outer boundary of its mounting face ≥ {req['edgeDistanceFactor']} × d (DFM rule of thumb)", "holes": edge_rows},
    {"id": "mass", "passed": mass <= req["maxMassG"] + 1e-9, "observed": round(mass, 2), "required": req["maxMassG"], "unit": "g", "method": "B-Rep volume × 6061 aluminium 2.70 g/cm³"},
    {"id": "envelope", "passed": all(s <= m + 1e-6 for s, m in zip(size, req["maxEnvelopeMm"])), "observed": size, "required": req["maxEnvelopeMm"], "unit": "mm", "method": "Axis-aligned bounding box"},
]
cq.exporters.export(body, str(out / "part.step"))
cq.exporters.export(body, str(out / "part.stl"), tolerance=0.02, angularTolerance=0.1)
cq.Assembly().add(body, name="Bracket", color=cq.Color(*AL)).export(str(out / "part.glb"))
(cq.Assembly().add(body, name="Bracket", color=cq.Color(*AL)).add(motor, name="NEMA 17 motor", color=cq.Color(*MOTOR))
 .export(str(out / "assembly.glb")))
cq.exporters.export(body, str(out / "drawing.svg"), opt={"projectionDir": (1.2, -1.0, 0.9), "showHidden": True, "strokeWidth": 0.25,
                                                        "strokeColor": (30, 60, 70), "hiddenColor": (150, 170, 175), "width": 640, "height": 400})
result = {
    "schema": "pai-cad-checks-1", "variant": spec["variant"], "variantLabel": v["label"], "units": "mm",
    "cadquery": cq.__version__, "ocp": importlib.metadata.version("cadquery-ocp"), "material": "6061 aluminium (2.70 g/cm³, nominal)",
    "parameters": {"thickness": t, "width": W, "depth": D, "height": H, "pilotBore": BORE, "motorAxisHeight": ZC},
    "volume": round(volume, 3), "mass": round(mass, 3), "boundingBox": size, "checks": checks,
    "scope": "parametric-part-geometry", "physicalValidation": False,
    "limits": "Nominal geometry and DFM rules of thumb; no FEA, tolerance stack-up, process simulation or physical test",
}
(out / "checks.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"variant": spec["variant"], "passed": [c["id"] for c in checks if c["passed"]], "failed": [c["id"] for c in checks if not c["passed"]]}), file=sys.stderr)
