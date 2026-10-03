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
import math
import struct
import subprocess
import sys
import time
from pathlib import Path

import gmsh
import numpy as np

ALUMINIUM_6061_T6 = {"name": "6061-T6 aluminium (nominal)", "E": 68_900.0, "nu": 0.33, "yield": 276.0, "density": 2.70e-9}
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


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True), flush=True)


def mesh(step: Path, size: float):
    gmsh.initialize(["-nt", "1"])
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.model.add("bracket")
    gmsh.model.occ.importShapes(str(step))
    gmsh.model.occ.synchronize()
    gmsh.option.setNumber("Mesh.MeshSizeMax", size)
    gmsh.option.setNumber("Mesh.MeshSizeMin", size / 3)
    gmsh.option.setNumber("Mesh.ElementOrder", 2)
    gmsh.option.setNumber("Mesh.HighOrderOptimize", 1)
    gmsh.option.setNumber("Mesh.Algorithm3D", 10)  # HXT
    gmsh.model.mesh.generate(3)

    def bore_nodes(test):
        tags = set()
        for dim, tag in gmsh.model.getEntities(2):
            if gmsh.model.getType(dim, tag) not in ("Cylinder", "BSpline surface", "Surface of Revolution"):
                continue
            x0, y0, z0, x1, y1, z1 = gmsh.model.getBoundingBox(dim, tag)
            if test(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0)):
                tags.update(int(n) for n in gmsh.model.mesh.getNodes(dim, tag, includeBoundary=True)[0])
        return tags

    # M5 base bores: vertical, centred at x = ±20, through the flange. M3 bores: along Y through the plate.
    # Bores are recognised by their diameter and axis, not by the recipe's thickness, so generated parts work too.
    fixed = bore_nodes(lambda c, s: abs(abs(c[0]) - M5_X) < 1.0 and abs(s[0] - 5.5) < 0.3 and abs(s[1] - 5.5) < 0.3)
    m3 = {}
    for sx in (-1, 1):
        for sz in (-1, 1):
            m3[(sx, sz)] = bore_nodes(lambda c, s, sx=sx, sz=sz: abs(c[0] - sx * NEMA_PITCH / 2) < 0.8
                                      and abs(c[2] - (zc + sz * NEMA_PITCH / 2)) < 0.8 and abs(s[0] - 3.4) < 0.3 and abs(s[2] - 3.4) < 0.3)
    tags, coords, _ = gmsh.model.mesh.getNodes()
    xyz = dict(zip((int(x) for x in tags), coords.reshape(-1, 3)))
    etypes, etags, enodes = gmsh.model.mesh.getElements(3)
    elements = []
    for et, tg, nd in zip(etypes, etags, enodes):
        if gmsh.model.mesh.getElementProperties(et)[0] != "Tetrahedron 10":
            continue
        elements += list(zip((int(x) for x in tg), nd.reshape(-1, 10).astype(int).tolist()))
    # Boundary triangles for visualisation (quadratic surface triangles → their corner nodes).
    faces = []
    for dim, tag in gmsh.model.getEntities(2):
        for et, _, nd in zip(*gmsh.model.mesh.getElements(dim, tag)):
            if gmsh.model.mesh.getElementProperties(et)[0].startswith("Triangle"):
                n = gmsh.model.mesh.getElementProperties(et)[3]
                faces += nd.reshape(-1, n)[:, :3].astype(int).tolist()
    gmsh.finalize()
    if not fixed or any(not v for v in m3.values()):
        raise SystemExit("could not identify the M5 or M3 bore surfaces on the meshed STEP")
    return xyz, elements, fixed, m3, faces


def deck(path: Path, xyz, elements, fixed, m3):
    # Gmsh and CalculiX order the 10-node tetrahedron identically except for nodes 9 and 10.
    loads = {}
    per_bore = F / 4
    couple = F * lever / (2 * NEMA_PITCH)  # per-bore Y force: upper pair pulled toward the motor, lower pushed
    for (sx, sz), nodes in m3.items():
        n = len(nodes)
        for node in nodes:
            fz = -per_bore / n
            fy = (-couple if sz > 0 else couple) / n
            loads[node] = (0.0, fy, fz)
    with path.open("w") as f:
        f.write("*HEADING\nPAI NEMA 17 bracket, linear static\n*NODE, NSET=NALL\n")
        for tag, c in xyz.items():
            f.write(f"{tag},{c[0]:.6f},{c[1]:.6f},{c[2]:.6f}\n")
        f.write("*ELEMENT, TYPE=C3D10, ELSET=EALL\n")
        for tag, nd in elements:
            nd = nd[:8] + [nd[9], nd[8]]
            f.write(f"{tag}," + ",".join(map(str, nd)) + "\n")
        f.write("*NSET, NSET=FIXED\n" + "\n".join(f"{n}," for n in sorted(fixed)) + "\n")
        m = ALUMINIUM_6061_T6
        f.write(f"*MATERIAL, NAME=AL\n*ELASTIC\n{m['E']},{m['nu']}\n*DENSITY\n{m['density']}\n*SOLID SECTION, ELSET=EALL, MATERIAL=AL\n")
        f.write("*BOUNDARY\nFIXED,1,3\n*STEP\n*STATIC\n*CLOAD\n")
        for node, (fx, fy, fz) in sorted(loads.items()):
            for dof, v in ((1, fx), (2, fy), (3, fz)):
                if v:
                    f.write(f"{node},{dof},{v:.9e}\n")
        f.write("*NODE PRINT, NSET=NALL\nU\n*EL PRINT, ELSET=EALL\nS\n*NODE FILE\nU\n*EL FILE\nS\n*END STEP\n")


def solve(path: Path):
    run = subprocess.run([ccx, "-i", path.stem], cwd=path.parent, capture_output=True, text=True, timeout=1800)
    (path.parent / f"{path.stem}.ccx.log").write_text(run.stdout[-20000:] + run.stderr[-5000:])
    if run.returncode != 0 or "Job finished" not in run.stdout:
        raise SystemExit(f"CalculiX failed (exit {run.returncode}); see {path.stem}.ccx.log")
    disp, stress = {}, {}
    section = None
    for line in (path.parent / f"{path.stem}.dat").read_text().splitlines():
        if line.strip().startswith("displacements"):
            section = "u"; continue
        if line.strip().startswith("stresses"):
            section = "s"; continue
        parts = line.split()
        if not parts:
            continue
        try:
            if section == "u" and len(parts) == 4:
                disp[int(parts[0])] = np.array(list(map(float, parts[1:4])))
            elif section == "s" and len(parts) == 8:
                sxx, syy, szz, sxy, sxz, syz = map(float, parts[2:8])
                vm = math.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy ** 2 + sxz ** 2 + syz ** 2))
                e = int(parts[0])
                stress[e] = max(stress.get(e, 0.0), vm)
        except ValueError:
            continue
    return disp, stress


def run_mesh(label: str, size: float):
    t0 = time.time()
    xyz, elements, fixed, m3, faces = mesh(Path(spec["step"]), size)
    event({"type": "fea", "phase": "meshed", "mesh": label, "nodes": len(xyz), "elements": len(elements)})
    inp = out / f"bracket-{label}.inp"
    deck(inp, xyz, elements, fixed, m3)
    disp, stress = solve(inp)
    if label == "coarse":  # the coarse mesh exists for the convergence ratio; keep its deck and log, not its raw results
        for suffix in (".dat", ".frd"):
            (out / f"bracket-{label}{suffix}").unlink(missing_ok=True)
    touching = {e for e, nd in elements if fixed.intersection(nd)}
    peak_e = max((e for e in stress if e not in touching), key=lambda e: stress[e])
    axis = float(np.mean([np.linalg.norm(np.mean([disp[n] for n in nodes], axis=0)) for nodes in m3.values()]))
    max_u = max(float(np.linalg.norm(u)) for u in disp.values())
    centroid = np.mean([xyz[n] for n in dict(elements)[peak_e][:4]], axis=0)
    event({"type": "fea", "phase": "solved", "mesh": label, "seconds": round(time.time() - t0, 1)})
    return {"size": size, "nodes": len(xyz), "elements": len(elements), "fixedNodes": len(fixed), "seconds": round(time.time() - t0, 1),
            "axisDisplacementMm": axis, "maxDisplacementMm": max_u, "peakVonMisesMPa": stress[peak_e],
            "peakAt": [round(float(v), 2) for v in centroid]}, (xyz, elements, faces, disp, stress)


coarse_size = max(1.2, t * 0.9)
# Formal reviews solve two meshes for a convergence ratio; the optimiser screens with the fine mesh only.
single = spec.get("meshes") == "fine-only"
coarse = None if single else run_mesh("coarse", coarse_size)[0]
fine, field = run_mesh("fine", coarse_size / 1.6)
change = lambda a, b: abs(a - b) / max(abs(b), 1e-12)
convergence = None if single else {"axisDisplacement": round(change(coarse["axisDisplacementMm"], fine["axisDisplacementMm"]), 4),
                                   "peakVonMises": round(change(coarse["peakVonMisesMPa"], fine["peakVonMisesMPa"]), 4)}
allowable = ALUMINIUM_6061_T6["yield"] / float(req["safetyFactor"])
checks = [
    {"id": "max-deflection", "passed": fine["axisDisplacementMm"] <= float(req["maxDeflectionMm"]) + 1e-12,
     "observed": round(fine["axisDisplacementMm"], 4), "required": float(req["maxDeflectionMm"]), "unit": "mm",
     "method": "Displacement of the motor axis (mean of the four M3 bore centroids), fine mesh"},
    {"id": "max-stress", "passed": fine["peakVonMisesMPa"] <= allowable + 1e-9,
     "observed": round(fine["peakVonMisesMPa"], 1), "required": round(allowable, 1), "unit": "MPa",
     "method": f"Peak integration-point von Mises away from fixed nodes, fine mesh; allowable = yield {ALUMINIUM_6061_T6['yield']} MPa / SF {req['safetyFactor']}"},
]


def write_glb(path: Path, xyz, faces, disp, stress, elements, scale):
    """Surface mesh, deformed by `scale`, vertex-coloured by nodal (max adjacent element) von Mises; also writes the colour scale."""
    nodal = {}
    for e, nd in elements:
        for n in nd[:4]:
            nodal[n] = max(nodal.get(n, 0.0), stress.get(e, 0.0))
    used = sorted({n for f in faces for n in f})
    index = {n: i for i, n in enumerate(used)}
    hi = max(nodal.get(n, 0.0) for n in used) or 1.0
    pos, col = [], []
    for n in used:
        c = xyz[n] + scale * disp.get(n, np.zeros(3))
        pos += [float(c[0]), float(c[1]), float(c[2])]  # millimetres, Z-up like the CAD GLBs (node rotation makes it Y-up)
        v = min(1.0, nodal.get(n, 0.0) / hi)
        col += [min(1.0, 2 * v), min(1.0, 2 * (1 - abs(v - 0.5))), max(0.0, 1 - 2 * v), 1.0]  # blue → green → red
    idx = [index[n] for f in faces for n in f]
    pos_b, col_b, idx_b = struct.pack(f"<{len(pos)}f", *pos), struct.pack(f"<{len(col)}f", *col), struct.pack(f"<{len(idx)}I", *idx)
    p = np.array(pos).reshape(-1, 3)
    gltf = {"asset": {"version": "2.0", "generator": "pai-fea"}, "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "name": "FEA von Mises", "rotation": [-0.7071067811865475, 0.0, 0.0, 0.7071067811865475]}],
            "meshes": [{"name": "FEA von Mises", "primitives": [{"attributes": {"POSITION": 0, "COLOR_0": 1}, "indices": 2, "material": 0}]}],
            "materials": [{"name": "Von Mises", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.1, "roughnessFactor": 0.6}, "doubleSided": True}],
            "buffers": [{"byteLength": len(pos_b) + len(col_b) + len(idx_b)}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos_b)}, {"buffer": 0, "byteOffset": len(pos_b), "byteLength": len(col_b)},
                            {"buffer": 0, "byteOffset": len(pos_b) + len(col_b), "byteLength": len(idx_b)}],
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(used), "type": "VEC3", "min": p.min(0).tolist(), "max": p.max(0).tolist()},
                          {"bufferView": 1, "componentType": 5126, "count": len(used), "type": "VEC4"},
                          {"bufferView": 2, "componentType": 5125, "count": len(idx), "type": "SCALAR"}]}
    js = json.dumps(gltf).encode()
    js += b" " * (-len(js) % 4)
    binary = pos_b + col_b + idx_b
    binary += b"\0" * (-len(binary) % 4)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)) + struct.pack("<II", len(js), 0x4E4F534A) + js
                     + struct.pack("<II", len(binary), 0x004E4942) + binary)
    return hi


xyz, elements, faces, disp, stress = field
if single:  # screening run: keep the measured numbers, not the field
    (out / "bracket-fine.frd").unlink(missing_ok=True)
scale = 2.0 / max(fine["maxDisplacementMm"], 1e-9)  # make the largest displacement 2 mm on screen
color_max = write_glb(out / "fea.glb", xyz, faces, disp, stress, elements, scale)
result = {"schema": "pai-fea-1", "solver": "CalculiX ccx 2.21", "mesher": f"Gmsh {gmsh.__version__}", "element": "C3D10 (quadratic tetrahedron)",
          "material": ALUMINIUM_6061_T6, "load": {"forceN": F, "leverMm": lever, "description": load.get("description", "")},
          "meshes": {"fine": fine} if single else {"coarse": coarse, "fine": fine}, "convergence": convergence, "displayScale": round(scale, 1), "colorScaleMaxMPa": round(color_max, 1),
          "checks": checks, "scope": "linear-static-nominal", "physicalValidation": False}
(out / "fea.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"checks": [(c["id"], c["passed"], c["observed"]) for c in checks], "convergence": convergence}), file=sys.stderr)
