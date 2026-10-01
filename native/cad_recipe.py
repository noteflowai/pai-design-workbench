"""Trusted parametric NEMA 17 bracket recipe shared by the preset/parametric review and the design-space sweep.

Inputs are bounded numbers only (validated by the workbench and again here). The construction order is
the one the preset recipe always used, so presets reproduce their earlier measurements exactly.
"""
import cadquery as cq

from cad_checks import AL, MOTOR, motor

NEMA_PITCH, M3_CLEAR, M5_CLEAR = 31.0, 3.4, 5.5
RIB, RIB_LEG, DEPTH, BASE_HOLE_X = 4.0, 20.0, 30.0, 20.0
# Bounds of the parametric space (mm). The motor (42.3 mm square) and the base holes must fit the plate.
BOUNDS = {"thickness": (2.0, 8.0), "width": (46.0, 80.0), "plateHeight": (40.0, 60.0), "pilotBore": (21.0, 24.0)}
PRESETS = {
    "reference": {"thickness": 4.0, "width": 60.0, "plateHeight": 46.0, "pilotBore": 22.5, "label": "基准设计"},
    "lightweight": {"thickness": 2.5, "width": 60.0, "plateHeight": 46.0, "pilotBore": 22.5, "label": "轻量化：板厚 2.5 mm"},
    "undersize-bore": {"thickness": 4.0, "width": 60.0, "plateHeight": 46.0, "pilotBore": 21.5, "label": "止口孔 Ø21.5 mm"},
    "compact": {"thickness": 4.0, "width": 50.0, "plateHeight": 43.5, "pilotBore": 22.5, "label": "紧凑化：降低安装板高度"},
}


def checked(p):
    out = {}
    for key, (lo, hi) in BOUNDS.items():
        value = float(p[key])
        if not lo <= value <= hi:
            raise ValueError(f"{key} {value} outside [{lo}, {hi}]")
        out[key] = value
    return out


def build(p, stage=None):
    """Return (body workplane, single solid, motor axis z, parameters) for bounded parameters."""
    p = checked(p)
    t, W, D, bore = p["thickness"], p["width"], DEPTH, p["pilotBore"]
    H = t + p["plateHeight"]
    zc = t + 24.0
    stage = stage or (lambda *_: None)
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
    body = body.cut(face.center(0, zc).circle(bore / 2).extrude(-t))
    for dx in (-NEMA_PITCH / 2, NEMA_PITCH / 2):
        for dz in (-NEMA_PITCH / 2, NEMA_PITCH / 2):
            body = body.cut(face.center(dx, zc + dz).circle(M3_CLEAR / 2).extrude(-t))
    stage("nema", "NEMA 17 止口与 4× M3 孔", [("Bracket", body, AL)])
    for x in (-BASE_HOLE_X, BASE_HOLE_X):
        body = body.cut(cq.Workplane("XY").center(x, t + (D - t) / 2).circle(M5_CLEAR / 2).extrude(t))
    solids = body.solids().vals()
    part = solids[0] if len(solids) == 1 else body.val()
    stage("mount", "2× M5 安装孔", [("Bracket", body, AL)])
    stage("motor", "装配检查：NEMA 17 电机", [("Bracket", body, AL), ("NEMA 17 motor", motor(zc), MOTOR)])
    return body, part, zc, {**p, "depth": D, "height": H, "motorAxisHeight": zc}
