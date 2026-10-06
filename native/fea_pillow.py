"""Linear static FEA of the 6202 pillow-block housing: Gmsh (C3D10) -> CalculiX ccx -> measured checks.

Run with the pinned physics interpreter (PAI_PHYSICS_PYTHON); ccx comes from the input spec.

Frame (native/cad_bearing.py and generated pillow-block code): base bottom at z = 0, shaft axis parallel to Y, bearing
seat open on +Y, two vertical M8 bolt bores in the base. Every surface is recognised from the mesh by a cylinder fit
(axis, centre, radius), never from recipe parameters, so generated parts are analysed the same way.

Load case (a shaft load carried by the bearing into the housing):
- A radial force F along Z, `away-from-base` (lifting: the bolts carry it, the column and base bend) or
  `toward-base` (pressing: carried by the base on its support).
- The bearing outer ring transfers it to the seat as a cosine pressure over the loaded half, p(theta) = p0 cos(theta), the
  usual model of a radially loaded ball bearing in its housing (contact and fit pressure are ignored). p0 is set so
  the discrete resultant on the meshed seat equals F exactly; the transverse residual is reported.
- Fixture: the M8 bore surfaces are fixed (bolts, preload ignored: conservative for lift). For `toward-base` the base
  bottom is also supported in Z.

Measured (fine mesh; the coarse mesh gives the convergence ratio):
- max-deflection: magnitude of the mean displacement of the seat surface (the bearing centre moving).
- bore-distortion: out-of-roundness the load causes in the seat, the range of radial displacement after removing the
  mean translation. A distorted seat pinches the outer ring and shortens bearing life; ISO 492 / housing practice
  keeps seat form errors to a few micrometres (IT5/2 for Ø35 is 5.5 um).
- max-stress: peak integration-point von Mises away from fixed nodes, against yield / safety factor.
Scope: linear elastic, small deformation, nominal 6061-T6. Not a certification, not bearing life.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import gmsh
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fea_core import ALUMINIUM_6061_T6, Mesh, change, event, peak_stress, solve, two_meshes, write_deck, write_glb  # noqa: E402

SEAT_D, BOLT_D = (34.9, 35.2), (8.6, 9.6)   # bearing seat (6202 OD, H7 band and recipe bounds); M8 clearance bores

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
load, req = spec["load"], spec["requirements"]
F = float(load["forceN"])
direction = load.get("direction", "away-from-base")
if direction not in ("away-from-base", "toward-base"):
    raise SystemExit(f"unknown load direction {direction}")
up = 1.0 if direction == "away-from-base" else -1.0
ccx = spec["ccx"]


def fit(points, axis):
    """Least-squares circle in the plane normal to `axis` ('y' or 'z'): (centre (a, b), radius, rms residual)."""
    i, j = (0, 2) if axis == "y" else (0, 1)
    u, v = points[:, i], points[:, j]
    A = np.c_[2 * u, 2 * v, np.ones(len(u))]
    (a, b, c), *_ = np.linalg.lstsq(A, u ** 2 + v ** 2, rcond=None)
    r = math.sqrt(max(c + a * a + b * b, 0.0))
    return (a, b), r, float(np.sqrt(np.mean((np.hypot(u - a, v - b) - r) ** 2)))


def recognise(m: Mesh):
    seat, bolts, bottom = [], [], set()
    for s in m.surfaces(lambda c, s_, b: True):
        pts = np.array([m.xyz[n] for n in s["nodes"]])
        if len(pts) < 6:
            continue
        for axis in ("y", "z"):
            centre, r, rms = fit(pts, axis)
            if rms > 0.01:
                continue
            if axis == "y" and SEAT_D[0] - 0.05 <= 2 * r <= SEAT_D[1] + 0.05:
                seat.append((s, centre, r))
            elif axis == "z" and BOLT_D[0] <= 2 * r <= BOLT_D[1]:
                bolts.append((s, centre, r))
    for s in m.surfaces(lambda c, s_, b: abs(b[2]) < 1e-6 and abs(b[5]) < 1e-6, cylindrical=False):
        bottom |= s["nodes"]
    if not seat or len({(round(c[0], 1), round(c[1], 1)) for _, c, _ in bolts}) < 2:
        raise SystemExit("could not identify the bearing seat and two bolt bores on the meshed STEP")
    return seat, bolts, bottom


def mesh(size: float):
    m = Mesh(Path(spec["step"]), size, "pillow-block")
    seat, bolts, bottom = recognise(m)
    xc, zc = float(np.mean([c[0] for _, c, _ in seat])), float(np.mean([c[1] for _, c, _ in seat]))
    R = float(np.mean([r for _, _, r in seat]))
    seat_nodes = set().union(*[s["nodes"] for s, _, _ in seat])
    ys = [m.xyz[n][1] for n in seat_nodes]
    # Cosine pressure on the loaded half of the seat, per element face (CalculiX P-face loads, pressure into the solid).
    faces = m.element_faces([t for s, _, _ in seat for t in s["tris"]])
    w = up * np.array([0.0, 0.0, 1.0])
    rows = []
    for e, k, corners in faces:
        c = np.mean(corners, axis=0)
        radial = np.array([c[0] - xc, 0.0, c[2] - zc]); radial /= np.linalg.norm(radial)
        cos = float(radial @ w)
        if cos > 0:
            area = 0.5 * float(np.linalg.norm(np.cross(corners[1] - corners[0], corners[2] - corners[0])))
            rows.append((e, k, cos, area, radial))
    resultant_per_p0 = sum(cos * area * radial for _, _, cos, area, radial in rows)
    p0 = F / float(resultant_per_p0 @ w)
    dloads = [(e, k, p0 * cos) for e, k, cos, _, _ in rows]
    residual = float(np.linalg.norm(p0 * resultant_per_p0 - F * w)) / F
    fixed_nodes = set().union(*[s["nodes"] for s, _, _ in bolts])
    fixed = [("BOLTS", fixed_nodes, (1, 3))] + ([("BOTTOM", bottom - fixed_nodes, (3, 3))] if direction == "toward-base" and bottom else [])
    info = {"seatRadiusMm": round(R, 4), "axisAt": [round(xc, 3), round(zc, 3)], "seatLengthMm": round(max(ys) - min(ys), 3),
            "boltBores": len(bolts), "loadedFaces": len(rows), "peakPressureMPa": round(p0, 3), "transverseResidual": round(residual, 6)}
    return m, fixed, fixed_nodes, seat_nodes, (xc, zc), dloads, info


def run_mesh(label: str, size: float):
    t0 = time.time()
    m, fixed, fixed_nodes, seat_nodes, (xc, zc), dloads, info = mesh(size)
    event({"type": "fea", "phase": "meshed", "mesh": label, "nodes": len(m.xyz), "elements": len(m.elements)})
    inp = out / f"pillow-{label}.inp"
    write_deck(inp, f"PAI 6202 pillow block, {F} N {direction}, linear static", m, fixed, dloads=dloads)
    disp, stress = solve(ccx, inp)
    peak, at = peak_stress(m, stress, fixed_nodes)
    u = np.array([disp[n] for n in seat_nodes]); mean = u.mean(axis=0)
    pts = np.array([m.xyz[n] for n in seat_nodes])
    radial = np.c_[pts[:, 0] - xc, np.zeros(len(pts)), pts[:, 2] - zc]; radial /= np.linalg.norm(radial, axis=1)[:, None]
    ur = np.einsum("ij,ij->i", u - mean, radial)
    max_u = max(float(np.linalg.norm(v)) for v in disp.values())
    event({"type": "fea", "phase": "solved", "mesh": label, "seconds": round(time.time() - t0, 1)})
    return {"size": size, "nodes": len(m.xyz), "elements": len(m.elements), "fixedNodes": len(fixed_nodes), "seconds": round(time.time() - t0, 1),
            "axisDisplacementMm": float(np.linalg.norm(mean)), "boreDistortionMm": float(ur.max() - ur.min()),
            "maxDisplacementMm": max_u, "peakVonMisesMPa": peak, "peakAt": at, "load": info}, (m, disp, stress)


single = spec.get("meshes") == "fine-only"
coarse, fine, field = two_meshes(out, "pillow", 3.5, single, run_mesh)
convergence = None if single else {"axisDisplacement": change(coarse["axisDisplacementMm"], fine["axisDisplacementMm"]),
                                   "peakVonMises": change(coarse["peakVonMisesMPa"], fine["peakVonMisesMPa"]),
                                   "boreDistortion": change(coarse["boreDistortionMm"], fine["boreDistortionMm"])}
allowable = ALUMINIUM_6061_T6["yield"] / float(req["safetyFactor"])
checks = [
    {"id": "max-deflection", "passed": fine["axisDisplacementMm"] <= float(req["maxDeflectionMm"]) + 1e-12,
     "observed": round(fine["axisDisplacementMm"], 4), "required": float(req["maxDeflectionMm"]), "unit": "mm",
     "method": "Displacement of the bearing centre (mean displacement of the seat surface), fine mesh"},
    {"id": "max-stress", "passed": fine["peakVonMisesMPa"] <= allowable + 1e-9,
     "observed": round(fine["peakVonMisesMPa"], 1), "required": round(allowable, 1), "unit": "MPa",
     "method": f"Peak integration-point von Mises away from fixed nodes, fine mesh; allowable = yield {ALUMINIUM_6061_T6['yield']} MPa / SF {req['safetyFactor']}"},
    {"id": "bore-distortion", "passed": fine["boreDistortionMm"] <= float(req["maxBoreDistortionMm"]) + 1e-12,
     "observed": round(fine["boreDistortionMm"], 5), "required": float(req["maxBoreDistortionMm"]), "unit": "mm",
     "method": "Out-of-roundness of the loaded seat: range of radial displacement after removing the mean translation, fine mesh"},
]
m, disp, stress = field
if single:
    (out / "pillow-fine.frd").unlink(missing_ok=True)
scale = 2.0 / max(fine["maxDisplacementMm"], 1e-9)
color_max = write_glb(out / "fea.glb", m, disp, stress, scale)
result = {"schema": "pai-fea-1", "solver": "CalculiX ccx 2.21", "mesher": f"Gmsh {gmsh.__version__}", "element": "C3D10 (quadratic tetrahedron)",
          "material": ALUMINIUM_6061_T6, "load": {"forceN": F, "leverMm": float(load.get("leverMm", 0.0)), "direction": direction,
                                                  "description": load.get("description", "")},
          "meshes": {"fine": fine} if single else {"coarse": coarse, "fine": fine}, "convergence": convergence, "displayScale": round(scale, 1),
          "colorScaleMaxMPa": round(color_max, 1), "checks": checks, "scope": "linear-static-nominal", "physicalValidation": False}
(out / "fea.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"checks": [(c["id"], c["passed"], c["observed"]) for c in checks], "convergence": convergence, "load": fine["load"]}), file=sys.stderr)
