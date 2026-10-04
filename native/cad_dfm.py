"""3-axis milling DFM of a measured part (CadQuery / OCCT B-Rep): accessibility, setups, holes and a cost estimate.

    PAI_CADQUERY_PYTHON cad_dfm.py --step part.step --shop native/dfm-shop.json --requirements '{"maxSetups":2,"maxUnitCostEur":40}' --output dfm.json

Measured on the B-Rep:
  - setups: the minimum set of the six principal tool directions such that every planar face is reachable (n·d ≥ 0:
    end or side milling) and every hole is reachable along its axis from a side whose drill corridor is free of
    material (exact set cover; occlusion of planar faces is not modelled);
  - hole access: a drill corridor (hole diameter, drillAccessMm long) beyond each end of a hole; a hole blocked on both
    ends cannot be drilled;
  - fastener access (DFA): a clearance hole that matches a fastener in dfm-shop.json (ISO 273 clearance, ISO 4762 head)
    needs the head and its hex key to fit on the seating side: a cylinder of head diameter + 1 mm, head height + key
    access long, free of material. The seating side is the end that does not lie on the part's bounding box (the
    datum/mating face, e.g. the base bottom on the machine or the plate face on the motor); if both or neither do,
    either side is accepted;
  - holes: diameter and depth from cylindrical faces; depth/diameter against the shop drill limit;
  - internal corners: a sharp concave edge is producible only from a chosen direction perpendicular to it that reaches
    both faces; otherwise it keeps the tool radius and is flagged (design radius ≥ tool radius, or EDM).
Estimate (shop assumptions in dfm-shop.json, reviewed data): stock = bounding box + allowance; removed volume / MRR,
finished area / finishing rate, setups × setup time / batch, drilling; material by stock mass. Not a quote.
"""
import argparse, json, math
from pathlib import Path
import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Surface, BRepAdaptor_Curve
from OCP.GeomAbs import GeomAbs_Plane, GeomAbs_Cylinder, GeomAbs_Line
from OCP.TopExp import TopExp
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
from OCP.BRep import BRep_Tool
from OCP.TopoDS import TopoDS
from OCP.BRepGProp import BRepGProp_Face
from OCP.gp import gp_Pnt, gp_Vec

p = argparse.ArgumentParser(); p.add_argument("--step", required=True); p.add_argument("--shop", required=True)
p.add_argument("--requirements", default="{}"); p.add_argument("--output", required=True); a = p.parse_args()
shop = json.loads(Path(a.shop).read_text()); req = json.loads(a.requirements)
solid = cq.importers.importStep(a.step).val()
AXES = {"+X": (1, 0, 0), "-X": (-1, 0, 0), "+Y": (0, 1, 0), "-Y": (0, -1, 0), "+Z": (0, 0, 1), "-Z": (0, 0, -1)}


def principal(v, tol=1e-3):
    n = math.sqrt(sum(c * c for c in v)) or 1
    v = [c / n for c in v]
    for name, ax in AXES.items():
        if sum(x * y for x, y in zip(v, ax)) > 1 - tol:
            return name
    return None


def normal(face):
    """Outward normal of a planar face at its centre (respecting face orientation)."""
    s = BRepAdaptor_Surface(face.wrapped)
    u, v = (s.FirstUParameter() + s.LastUParameter()) / 2, (s.FirstVParameter() + s.LastVParameter()) / 2
    pnt, vec = gp_Pnt(), gp_Vec()
    BRepGProp_Face(face.wrapped).Normal(u, v, pnt, vec)
    return (vec.X(), vec.Y(), vec.Z())


import itertools
faces_n, holes, area = [], [], 0.0
for f in solid.Faces():
    s = BRepAdaptor_Surface(f.wrapped)
    area += f.Area()
    if s.GetType() == GeomAbs_Plane:
        faces_n.append(normal(f))
    elif s.GetType() == GeomAbs_Cylinder and f.wrapped.Orientation().name == "TopAbs_REVERSED":  # concave cylinder = hole
        c = s.Cylinder(); ax = c.Axis().Direction(); r = c.Radius()
        axis = principal((ax.X(), ax.Y(), ax.Z())) or principal((-ax.X(), -ax.Y(), -ax.Z()))
        bb = f.BoundingBox()
        depth = {"X": bb.xlen, "Y": bb.ylen, "Z": bb.zlen}[axis[1]] if axis else None
        loc = c.Axis().Location()
        holes.append({"diameterMm": round(2 * r, 3), "depthMm": round(depth, 3) if depth else None, "axis": axis[1] if axis else "oblique",
                      "ratio": round(depth / (2 * r), 2) if depth else None, "_r": r, "_loc": (loc.X(), loc.Y(), loc.Z()), "_bb": bb})
dot = lambda u, v: sum(x * y for x, y in zip(u, v))
reach = lambda n, d: dot(n, AXES[d]) >= -1e-6  # end or side milling; tool occlusion by other features is not modelled

# Concave straight edges between two planar faces (internal corners).
emap = TopTools_IndexedDataMapOfShapeListOfShape()
TopExp.MapShapesAndAncestors_s(solid.wrapped, TopAbs_EDGE, TopAbs_FACE, emap)
corners = []
for i in range(1, emap.Extent() + 1):
    edge = TopoDS.Edge_s(emap.FindKey(i)); fl = emap.FindFromIndex(i)
    if fl.Size() != 2 or BRepAdaptor_Curve(edge).GetType() != GeomAbs_Line:
        continue
    f1, f2 = [cq.Face(TopoDS.Face_s(x)) for x in fl]
    if BRepAdaptor_Surface(f1.wrapped).GetType() != GeomAbs_Plane or BRepAdaptor_Surface(f2.wrapped).GetType() != GeomAbs_Plane:
        continue
    n1, n2 = normal(f1), normal(f2)
    if abs(dot(n1, n2)) > 0.999:
        continue
    if dot([b - a for a, b in zip(f1.Center().toTuple(), f2.Center().toTuple())], n1) > 1e-6:  # face 2 lies outside face 1: concave
        d = BRepAdaptor_Curve(edge).Line().Direction()
        corners.append(((d.X(), d.Y(), d.Z()), n1, n2))

# Access corridors along each principal hole axis, measured as material volume inside a probe cylinder.
sbb = solid.BoundingBox()
def blocked(centre, axis, start, radius, length):
    origin = list(centre); origin["XYZ".index(axis[1])] = start
    d = AXES[axis]
    probe = cq.Solid.makeCylinder(radius, length, cq.Vector(*[o + 1e-3 * x for o, x in zip(origin, d)]), cq.Vector(*d))
    return solid.intersect(probe).Volume() > 1e-3

fasteners = {float(k): v for k, v in shop.get("fasteners", {}).items()}
for h in holes:
    h["access"], h["fastener"] = [], None
    if h["axis"] == "oblique":
        continue
    i = "XYZ".index(h["axis"]); bb = h.pop("_bb"); lo, hi = (bb.xmin, bb.xmax) if i == 0 else (bb.ymin, bb.ymax) if i == 1 else (bb.zmin, bb.zmax)
    centre = h.pop("_loc"); r = h.pop("_r")
    ends = {f"+{h['axis']}": hi, f"-{h['axis']}": lo}
    h["access"] = [side for side, at in ends.items() if not blocked(centre, side, at, r * 0.98, shop.get("drillAccessMm", 30))]
    f = next((v for k, v in fasteners.items() if abs(k - 2 * r) < 0.05), None)
    if f:
        smin, smax = (sbb.xmin, sbb.xmax) if i == 0 else (sbb.ymin, sbb.ymax) if i == 1 else (sbb.zmin, sbb.zmax)
        datum = {side: abs(at - (smax if side[0] == "+" else smin)) < 1e-3 for side, at in ends.items()}
        seats = [s for s in ends if not datum[s]] if sum(datum.values()) == 1 else list(ends)
        free = [s for s in seats if not blocked(centre, s, ends[s], f["headDiameterMm"] / 2 + 0.5, f["headHeightMm"] + f["keyAccessMm"])]
        h["fastener"] = {"thread": f["thread"], "seating": seats, "clear": free}
for h in holes:
    h.pop("_r", None); h.pop("_loc", None); h.pop("_bb", None)

# Minimal set of principal tool directions (set cover; at most 6 candidates, so exhaustive search is exact).
def covers(dirs):
    return (all(any(reach(n, d) for d in dirs) for n in faces_n)
            and all(h["axis"] != "oblique" and any(d in h["access"] for d in dirs) for h in holes))
setups_dirs = next((list(c) for k in range(1, 7) for c in itertools.combinations(AXES, k) if covers(c)), list(AXES))
undercuts = [] if covers(setups_dirs) and all(h["axis"] != "oblique" for h in holes) else ["unreachable faces, blocked or oblique holes"]
undrillable = [h for h in holes if not h["access"]]
unfastenable = [h for h in holes if h["fastener"] and not h["fastener"]["clear"]]
# A sharp internal corner is producible only from a chosen direction perpendicular to its edge that reaches both faces;
# otherwise a milled corner keeps the tool radius (needs a design radius ≥ tool radius, or EDM).
sharp_internal = sum(1 for e, n1, n2 in corners if not any(abs(dot(e, AXES[d])) < 1e-3 and reach(n1, d) and reach(n2, d) for d in setups_dirs))
directions = set(setups_dirs)

bb = solid.BoundingBox(); al = shop["stockAllowanceMm"]
stock_cm3 = (bb.xlen + 2 * al) * (bb.ylen + 2 * al) * (bb.zlen + 2 * al) / 1000
part_cm3 = solid.Volume() / 1000
removed = stock_cm3 - part_cm3
setups = len({d for d in directions})
minutes = removed / shop["roughingCm3PerMin"] + (area / 100) / shop["finishingCm2PerMin"] + len(holes) * shop["drillSecondsPerHole"] / 60
setup_minutes = setups * shop["setupMinutes"]
material = stock_cm3 * shop["densityGPerCm3"] / 1000 * shop["materialEurPerKg"]
unit = material + (minutes + setup_minutes / shop["batch"]) / 60 * shop["machineEurPerHour"]
deep = [h for h in holes if h["ratio"] is None or h["ratio"] > shop["maxDrillDepthToDiameter"]]
checks = [
    {"id": "machining-setups", "passed": setups <= req.get("maxSetups", 3) and not undercuts, "observed": setups, "required": req.get("maxSetups", 3), "unit": "setups",
     "method": "Minimum set of principal tool directions reaching every planar face (n·d ≥ 0, end or side milling) and every hole along a free drill corridor"},
    {"id": "hole-drillability", "passed": not deep and not undrillable, "observed": max((h["ratio"] or 99 for h in holes), default=0), "required": shop["maxDrillDepthToDiameter"], "unit": "depth/d",
     "method": f"Depth / diameter of every cylindrical hole against the shop drill limit, and a free drill corridor at one end at least ({len(undrillable)} blocked)"},
    {"id": "fastener-access", "passed": not unfastenable, "observed": len(unfastenable), "required": 0, "unit": "holes",
     "method": "Fastener clearance holes (dfm-shop.json, ISO 273 / ISO 4762) whose head and hex key do not fit on the seating side (the end off the datum face); material measured in the clearance cylinder"},
    {"id": "unit-cost", "passed": unit <= req.get("maxUnitCostEur", 1e9), "observed": round(unit, 2), "required": req.get("maxUnitCostEur"), "unit": "EUR",
     "method": f"Estimate, batch {shop['batch']}: stock material + roughing/finishing/drilling time + setups at {shop['machineEurPerHour']} EUR/h (dfm-shop.json); not a quote"},
]
out = {"schema": "pai-dfm-1", "process": shop["process"], "checks": checks, "setups": sorted(directions), "undercutFaces": undercuts, "holes": holes,
       "sharpInternalEdges": sharp_internal, "internalEdges": len(corners), "stockCm3": round(stock_cm3, 2), "partCm3": round(part_cm3, 2), "buyToFly": round(stock_cm3 / part_cm3, 2),
       "machiningMinutes": round(minutes, 2), "setupMinutes": setup_minutes, "materialEur": round(material, 2), "unitCostEur": round(unit, 2),
       "notes": [f"{len(unfastenable)} fastener holes are covered on their seating side: {', '.join(sorted({h['fastener']['thread'] for h in unfastenable}))} head does not fit"] * bool(unfastenable)
                + [f"{len(undrillable)} holes have no free drill corridor"] * bool(undrillable)
                + [f"{sharp_internal} sharp internal edges along a tool axis: add a corner radius ≥ {shop['minToolDiameterMm'] / 2} mm or plan EDM/relief"] * bool(sharp_internal)}
Path(a.output).write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps({k: out[k] for k in ("setups", "unitCostEur", "machiningMinutes", "buyToFly", "sharpInternalEdges")}))
