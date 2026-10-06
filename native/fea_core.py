"""Shared linear static FEA machinery for the part families: Gmsh C3D10 meshing, the CalculiX deck, the solve and its
parsed results, and the von Mises GLB. The family scripts (fea_bracket.py, fea_pillow.py) own only the load case,
the fixture and what is measured.

Scope: linear elastic, small deformation, nominal 6061-T6 (the same alloy as the B-Rep mass check). Not a certification.
"""
import json
import math
import struct
import subprocess
from pathlib import Path

import gmsh
import numpy as np

ALUMINIUM_6061_T6 = {"name": "6061-T6 aluminium (nominal)", "E": 68_900.0, "nu": 0.33, "yield": 276.0, "density": 2.70e-9}
CYLINDRICAL = ("Cylinder", "BSpline surface", "Surface of Revolution")
# CalculiX C3D10 faces by their corner nodes (1-based in the element): face k -> corners. Gmsh shares the corner order.
C3D10_FACES = {1: (0, 1, 2), 2: (0, 3, 1), 3: (1, 3, 2), 4: (2, 3, 0)}


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True), flush=True)


class Mesh:
    """A meshed STEP: nodes, quadratic tetrahedra, boundary triangles, and lookups of surfaces by geometry."""

    def __init__(self, step: Path, size: float, name: str):
        gmsh.initialize(["-nt", "1"])
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add(name)
        gmsh.model.occ.importShapes(str(step))
        gmsh.model.occ.synchronize()
        gmsh.option.setNumber("Mesh.MeshSizeMax", size)
        gmsh.option.setNumber("Mesh.MeshSizeMin", size / 3)
        gmsh.option.setNumber("Mesh.ElementOrder", 2)
        gmsh.option.setNumber("Mesh.HighOrderOptimize", 1)
        gmsh.option.setNumber("Mesh.Algorithm3D", 10)  # HXT
        gmsh.model.mesh.generate(3)
        tags, coords, _ = gmsh.model.mesh.getNodes()
        self.xyz = dict(zip((int(x) for x in tags), coords.reshape(-1, 3)))
        self.elements = []
        for et, tg, nd in zip(*gmsh.model.mesh.getElements(3)):
            if gmsh.model.mesh.getElementProperties(et)[0] == "Tetrahedron 10":
                self.elements += list(zip((int(x) for x in tg), nd.reshape(-1, 10).astype(int).tolist()))
        self.faces = []  # boundary triangles (corner nodes) for visualisation
        self._surfaces = []
        for dim, tag in gmsh.model.getEntities(2):
            tris = []
            for et, _, nd in zip(*gmsh.model.mesh.getElements(dim, tag)):
                props = gmsh.model.mesh.getElementProperties(et)
                if props[0].startswith("Triangle"):
                    tris += nd.reshape(-1, props[3])[:, :3].astype(int).tolist()
            self.faces += tris
            x0, y0, z0, x1, y1, z1 = gmsh.model.getBoundingBox(dim, tag)
            self._surfaces.append({"type": gmsh.model.getType(dim, tag), "centre": ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2),
                                   "size": (x1 - x0, y1 - y0, z1 - z0), "bounds": (x0, y0, z0, x1, y1, z1),
                                   "nodes": {int(n) for n in gmsh.model.mesh.getNodes(dim, tag, includeBoundary=True)[0]}, "tris": tris})
        gmsh.finalize()

    def surfaces(self, test, cylindrical=True):
        """Surfaces whose (centre, size, bounds) pass `test`; cylindrical-only by default (bores, seats)."""
        return [s for s in self._surfaces if (not cylindrical or s["type"] in CYLINDRICAL) and test(s["centre"], s["size"], s["bounds"])]

    def nodes(self, test, cylindrical=True):
        return set().union(*[s["nodes"] for s in self.surfaces(test, cylindrical)]) if self.surfaces(test, cylindrical) else set()

    def element_faces(self, tris):
        """(element, CalculiX face number, corner coordinates) for each boundary triangle."""
        index = {}
        for e, nd in self.elements:
            for k, (a, b, c) in C3D10_FACES.items():
                index[frozenset((nd[a], nd[b], nd[c]))] = (e, k)
        out = []
        for t in tris:
            hit = index.get(frozenset(t))
            if hit:
                out.append((hit[0], hit[1], [self.xyz[n] for n in t]))
        return out


def write_deck(path: Path, heading: str, m: Mesh, fixed, cloads=None, dloads=None, material=ALUMINIUM_6061_T6):
    """fixed: [(name, nodes, last_dof)]; cloads: {node: (fx, fy, fz)}; dloads: [(element, face, pressure MPa)]."""
    with path.open("w") as f:
        f.write(f"*HEADING\n{heading}\n*NODE, NSET=NALL\n")
        for tag, c in m.xyz.items():
            f.write(f"{tag},{c[0]:.6f},{c[1]:.6f},{c[2]:.6f}\n")
        f.write("*ELEMENT, TYPE=C3D10, ELSET=EALL\n")
        for tag, nd in m.elements:
            nd = nd[:8] + [nd[9], nd[8]]  # Gmsh and CalculiX differ only in nodes 9 and 10
            f.write(f"{tag}," + ",".join(map(str, nd)) + "\n")
        for name, nodes, _ in fixed:
            f.write(f"*NSET, NSET={name}\n" + "\n".join(f"{n}," for n in sorted(nodes)) + "\n")
        f.write(f"*MATERIAL, NAME=AL\n*ELASTIC\n{material['E']},{material['nu']}\n*DENSITY\n{material['density']}\n*SOLID SECTION, ELSET=EALL, MATERIAL=AL\n")
        f.write("*BOUNDARY\n" + "".join(f"{name},{first},{last}\n" for name, _, (first, last) in fixed) + "*STEP\n*STATIC\n")
        if cloads:
            f.write("*CLOAD\n")
            for node, (fx, fy, fz) in sorted(cloads.items()):
                for dof, v in ((1, fx), (2, fy), (3, fz)):
                    if v:
                        f.write(f"{node},{dof},{v:.9e}\n")
        if dloads:
            f.write("*DLOAD\n" + "".join(f"{e},P{k},{p:.9e}\n" for e, k, p in dloads))
        f.write("*NODE PRINT, NSET=NALL\nU\n*EL PRINT, ELSET=EALL\nS\n*NODE FILE\nU\n*EL FILE\nS\n*END STEP\n")


def solve(ccx: str, path: Path):
    """Run ccx on the deck; return nodal displacements and the peak integration-point von Mises per element."""
    run = subprocess.run([ccx, "-i", path.stem], cwd=path.parent, capture_output=True, text=True, timeout=1800)
    (path.parent / f"{path.stem}.ccx.log").write_text(run.stdout[-20000:] + run.stderr[-5000:])
    if run.returncode != 0 or "Job finished" not in run.stdout:
        raise SystemExit(f"CalculiX failed (exit {run.returncode}); see {path.stem}.ccx.log")
    disp, stress, section = {}, {}, None
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


def peak_stress(m: Mesh, stress, fixed_nodes):
    """Peak von Mises away from elements touching a fixed node (the clamp singularity), with its location."""
    touching = {e for e, nd in m.elements if fixed_nodes.intersection(nd)}
    e = max((e for e in stress if e not in touching), key=lambda e: stress[e])
    centroid = np.mean([m.xyz[n] for n in dict(m.elements)[e][:4]], axis=0)
    return stress[e], [round(float(v), 2) for v in centroid]


def write_glb(path: Path, m: Mesh, disp, stress, scale):
    """Surface mesh, deformed by `scale`, vertex-coloured by nodal (max adjacent element) von Mises; returns the colour scale max."""
    nodal = {}
    for e, nd in m.elements:
        for n in nd[:4]:
            nodal[n] = max(nodal.get(n, 0.0), stress.get(e, 0.0))
    used = sorted({n for f in m.faces for n in f})
    index = {n: i for i, n in enumerate(used)}
    hi = max(nodal.get(n, 0.0) for n in used) or 1.0
    pos, col = [], []
    for n in used:
        c = m.xyz[n] + scale * disp.get(n, np.zeros(3))
        pos += [float(c[0]), float(c[1]), float(c[2])]  # millimetres, Z-up like the CAD GLBs (node rotation makes it Y-up)
        v = min(1.0, nodal.get(n, 0.0) / hi)
        col += [min(1.0, 2 * v), min(1.0, 2 * (1 - abs(v - 0.5))), max(0.0, 1 - 2 * v), 1.0]  # blue -> green -> red
    idx = [index[n] for f in m.faces for n in f]
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


def two_meshes(out: Path, stem: str, coarse_size: float, single: bool, run):
    """Solve a coarse and a fine mesh (or the fine mesh only) and return (coarse, fine, field, convergence).

    `run(label, size)` returns (summary, field); summary must carry the keys named in `keys` for the ratio."""
    coarse = None if single else run("coarse", coarse_size)[0]
    if coarse:  # the coarse mesh exists for the convergence ratio; keep its deck and log, not its raw results
        for suffix in (".dat", ".frd"):
            (out / f"{stem}-coarse{suffix}").unlink(missing_ok=True)
    fine, field = run("fine", coarse_size / 1.6)
    return coarse, fine, field


def change(a, b):
    return round(abs(a - b) / max(abs(b), 1e-12), 4)
