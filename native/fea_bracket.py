"""Linear static FEA of the NEMA 17 bracket: Gmsh (quadratic tetrahedra) → CalculiX ccx → measured checks.

Run with the pinned physics interpreter (PAI_PHYSICS_PYTHON); ccx comes from PAI_CCX.

Load case (belt-driven stepper, the use the bracket is designed for), in the bracket frame of native/cad_recipe.py
(mounting face at y = 0, motor on y < 0, shaft along Y through x = 0, z = motorAxisHeight):
- A radial force F (belt pull plus motor weight times a dynamic factor) acts downward at the pulley, `leverMm`
  in front of the mounting face.
- It reaches the plate as statically equivalent loads on the four M3 bolt bores. Each bore carries -F/4 in Z.
  The moment F·lever is a couple in Y between the upper and lower bore pairs.
- The two M5 bores in the base flange are fixed. Contact, bolt preload and the table under the flange are
  ignored, which is conservative for deflection.

Measured quantities:
- Displacement of the motor axis point (the mean of the four bore centres' nodal displacement magnitudes).
- Peak von Mises stress from element integration points, excluding elements that touch a fixed node. Stress at
  the sharp, unfilleted corners is mesh-dependent, so the value is reported with a two-mesh convergence ratio.

Outputs: fea.json, fea.glb (surface coloured by von Mises; deformed shape scaled for display), the ccx deck and
its .dat/.frd results. Scope: linear elastic, small deformation, nominal 6061-T6. Not a certification.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import gmsh
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fea_core import ALUMINIUM_6061_T6, Mesh, change, event, peak_stress, solve, two_meshes, write_deck, write_glb  # noqa: E402

NEMA_PITCH, M5_X = 31.0, 20.0

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
p, load, req = spec["parameters"], spec["load"], spec["requirements"]
zc = float(p["motorAxisHeight"])
# Mesh size follows the plate thickness when known (presets, parametric); generated parts use a fixed size.
t = float(p.get("thickness") or 4.0)
F, lever = float(load["forceN"]), float(load["leverMm"])
ccx = spec["ccx"]


def mesh(step: Path, size: float):
    m = Mesh(step, size, "bracket")
    # M5 base bores: vertical, centred at x = +-20, through the flange. M3 bores: along Y through the plate.
    # Bores are recognised by their diameter and axis, not by the recipe's thickness, so generated parts work too.
    fixed = m.nodes(lambda c, s, b: abs(abs(c[0]) - M5_X) < 1.0 and abs(s[0] - 5.5) < 0.3 and abs(s[1] - 5.5) < 0.3)
    m3 = {(sx, sz): m.nodes(lambda c, s, b, sx=sx, sz=sz: abs(c[0] - sx * NEMA_PITCH / 2) < 0.8
                            and abs(c[2] - (zc + sz * NEMA_PITCH / 2)) < 0.8 and abs(s[0] - 3.4) < 0.3 and abs(s[2] - 3.4) < 0.3)
          for sx in (-1, 1) for sz in (-1, 1)}
    if not fixed or any(not v for v in m3.values()):
        raise SystemExit("could not identify the M5 or M3 bore surfaces on the meshed STEP")
    return m, fixed, m3


def loads(m3):
    out_ = {}
    per_bore = F / 4
    couple = F * lever / (2 * NEMA_PITCH)  # per-bore Y force: upper pair pulled toward the motor, lower pushed
    for (sx, sz), nodes in m3.items():
        n = len(nodes)
        for node in nodes:
            out_[node] = (0.0, (-couple if sz > 0 else couple) / n, -per_bore / n)
    return out_


def run_mesh(label: str, size: float):
    t0 = time.time()
    m, fixed, m3 = mesh(Path(spec["step"]), size)
    event({"type": "fea", "phase": "meshed", "mesh": label, "nodes": len(m.xyz), "elements": len(m.elements)})
    inp = out / f"bracket-{label}.inp"
    write_deck(inp, "PAI NEMA 17 bracket, linear static", m, [("FIXED", fixed, (1, 3))], cloads=loads(m3))
    disp, stress = solve(ccx, inp)
    peak, at = peak_stress(m, stress, fixed)
    axis = float(np.mean([np.linalg.norm(np.mean([disp[n] for n in nodes], axis=0)) for nodes in m3.values()]))
    max_u = max(float(np.linalg.norm(u)) for u in disp.values())
    event({"type": "fea", "phase": "solved", "mesh": label, "seconds": round(time.time() - t0, 1)})
    return {"size": size, "nodes": len(m.xyz), "elements": len(m.elements), "fixedNodes": len(fixed), "seconds": round(time.time() - t0, 1),
            "axisDisplacementMm": axis, "maxDisplacementMm": max_u, "peakVonMisesMPa": peak, "peakAt": at}, (m, disp, stress)


coarse_size = max(1.2, t * 0.9)
# Formal reviews solve two meshes for a convergence ratio; the optimiser screens with the fine mesh only.
single = spec.get("meshes") == "fine-only"
coarse, fine, field = two_meshes(out, "bracket", coarse_size, single, run_mesh)
convergence = None if single else {"axisDisplacement": change(coarse["axisDisplacementMm"], fine["axisDisplacementMm"]),
                                   "peakVonMises": change(coarse["peakVonMisesMPa"], fine["peakVonMisesMPa"])}
allowable = ALUMINIUM_6061_T6["yield"] / float(req["safetyFactor"])
checks = [
    {"id": "max-deflection", "passed": fine["axisDisplacementMm"] <= float(req["maxDeflectionMm"]) + 1e-12,
     "observed": round(fine["axisDisplacementMm"], 4), "required": float(req["maxDeflectionMm"]), "unit": "mm",
     "method": "Displacement of the motor axis (mean of the four M3 bore centroids), fine mesh"},
    {"id": "max-stress", "passed": fine["peakVonMisesMPa"] <= allowable + 1e-9,
     "observed": round(fine["peakVonMisesMPa"], 1), "required": round(allowable, 1), "unit": "MPa",
     "method": f"Peak integration-point von Mises away from fixed nodes, fine mesh; allowable = yield {ALUMINIUM_6061_T6['yield']} MPa / SF {req['safetyFactor']}"},
]
m, disp, stress = field
if single:  # screening run: keep the measured numbers, not the field
    (out / "bracket-fine.frd").unlink(missing_ok=True)
scale = 2.0 / max(fine["maxDisplacementMm"], 1e-9)  # make the largest displacement 2 mm on screen
color_max = write_glb(out / "fea.glb", m, disp, stress, scale)
result = {"schema": "pai-fea-1", "solver": "CalculiX ccx 2.21", "mesher": f"Gmsh {gmsh.__version__}", "element": "C3D10 (quadratic tetrahedron)",
          "material": ALUMINIUM_6061_T6, "load": {"forceN": F, "leverMm": lever, "description": load.get("description", "")},
          "meshes": {"fine": fine} if single else {"coarse": coarse, "fine": fine}, "convergence": convergence, "displayScale": round(scale, 1), "colorScaleMaxMPa": round(color_max, 1),
          "checks": checks, "scope": "linear-static-nominal", "physicalValidation": False}
(out / "fea.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"checks": [(c["id"], c["passed"], c["observed"]) for c in checks], "convergence": convergence}), file=sys.stderr)
