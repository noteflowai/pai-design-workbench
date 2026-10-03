"""Parametric Ahmed-type body (CadQuery) for the aerodynamics lane: one closed solid, exported as STL in metres.

    PAI_CADQUERY_PYTHON cfd_body.py --input body-input.json --output DIR

Parameters (bounded): slantAngleDeg 0–40 (rear slant), noseRadius 0.05–0.15 m, length 0.8–1.3 m, height 0.24–0.34 m.
Fixed: width 0.389 m, slant length 0.222 m, ground clearance 0.050 m (the reference Ahmed body is 25°, R 0.1, L 1.044,
H 0.288). Writes body.stl, body.step and body.json (frontal area from the B-Rep section, volume, bounding box).
"""
import argparse, json, math
from pathlib import Path
import cadquery as cq

BOUNDS = {"slantAngleDeg": (0.0, 40.0), "noseRadius": (0.05, 0.15), "length": (0.8, 1.3), "height": (0.24, 0.34)}
WIDTH, SLANT_LENGTH, GAP = 0.389, 0.222, 0.050
p = argparse.ArgumentParser(); p.add_argument("--input", required=True); p.add_argument("--output", required=True); a = p.parse_args()
spec = json.loads(Path(a.input).read_text())
v = {k: float(spec["parameters"][k]) for k in BOUNDS}
for k, (lo, hi) in BOUNDS.items():
    if not lo <= v[k] <= hi:
        raise SystemExit(f"{k}={v[k]} outside [{lo}, {hi}]")
L, H, R, phi = v["length"], v["height"], v["noseRadius"], math.radians(v["slantAngleDeg"])
body = cq.Workplane("XY").box(L, WIDTH, H, centered=(False, True, False)).translate((0, 0, GAP))
# Ahmed nose: the four edges of the front face are rounded with radius R; the long edges stay sharp.
body = body.faces("<X").edges().fillet(R)
if phi > 0:
    drop = SLANT_LENGTH * math.tan(phi)
    cutter = cq.Workplane("XZ").polyline([(L - SLANT_LENGTH, GAP + H), (L + 0.01, GAP + H - drop - 0.01 * math.tan(phi)), (L + 0.01, GAP + H + 0.2),
                                          (L - SLANT_LENGTH, GAP + H + 0.2)]).close().extrude(WIDTH, both=True)
    body = body.cut(cutter)
solid = body.val()
if not solid.isValid():
    raise SystemExit("invalid solid")
out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
cq.exporters.export(body, str(out / "body.stl"), tolerance=0.0005, angularTolerance=0.1)
cq.exporters.export(body, str(out / "body.step"))
# Frontal area: the section of the solid at its widest x-station, measured on the B-Rep (not the nominal W·H).
xs = [L * f for f in (0.3, 0.5, 0.7)]
area = max(solid.intersect(cq.Solid.makeBox(1e-4, 2, 2, cq.Vector(x, -1, 0))).Volume() / 1e-4 for x in xs)
bb = solid.BoundingBox()
(out / "body.json").write_text(json.dumps({"parameters": v, "frontalAreaM2": round(area, 6), "volumeM3": round(solid.Volume(), 6),
    "bbox": [round(x, 5) for x in (bb.xmin, bb.xmax, bb.ymin, bb.ymax, bb.zmin, bb.zmax)], "cadquery": cq.__version__}, indent=2) + "\n")
print(json.dumps({"frontalAreaM2": round(area, 6)}))
