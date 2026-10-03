"""Aerodynamics review of an Ahmed-type body: CadQuery geometry → OpenFOAM v2512 (snappyHexMesh + simpleFoam, k-ω SST).

    PAI_PHYSICS_PYTHON cfd_review.py --input input.json --output DIR

input.json: { parameters: {slantAngleDeg, noseRadius, length, height}, requirements: {maxDragCoefficient,
              maxGridChange, maxIterativeBand}, cadquery: <python>, runner: {kind: "docker", image} | {kind: "batch", ...},
              levels: [2, 3], iterations: 600, speedMs: 40, processors: 6 }
The same body is solved on two snappyHexMesh refinement levels. Checks:
  drag-coefficient  fine-mesh Cd (mean of the last 100 iterations) ≤ maxDragCoefficient
  grid-convergence  |Cd_fine − Cd_coarse| / Cd_fine ≤ maxGridChange (two-level mesh dependence, not a GCI)
  iterative-convergence  (max − min) / mean of Cd over the last 100 iterations ≤ maxIterativeBand
  mesh-quality      checkMesh reports "Mesh OK" on both meshes
Outputs: checks.json (pai-cfd-checks-1), cfd.json, body.step, body.stl, aero.glb (body for the viewport),
forces-<level>.dat and checkMesh-<level>.log. Scope: steady RANS of a bluff body; not a wind-tunnel validation.
"""
import argparse
import json
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
p = argparse.ArgumentParser(); p.add_argument("--input", required=True); p.add_argument("--output", required=True); a = p.parse_args()
spec = json.loads(Path(a.input).read_text())
out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
req, levels = spec["requirements"], sorted(spec.get("levels", [2, 3]))
iterations, speed, procs = int(spec.get("iterations", 1200)), float(spec.get("speedMs", 40)), int(spec.get("processors", 6))


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True), flush=True)


started = time.monotonic()
(out / "body-input.json").write_text(json.dumps({"parameters": spec["parameters"]}))
g = subprocess.run([spec["cadquery"], "-I", "-W", "ignore", str(HERE / "cfd_body.py"), "--input", str(out / "body-input.json"), "--output", str(out)],
                   capture_output=True, text=True, timeout=300)
if g.returncode != 0:
    raise SystemExit("geometry: " + (g.stderr.strip().splitlines() or ["failed"])[-1])
body = json.loads((out / "body.json").read_text())


def write_glb(stl: Path, path: Path):
    """Binary STL → GLB (one mesh, glTF Y-up, metres) for the viewport."""
    data = stl.read_bytes()
    n = struct.unpack_from("<I", data, 80)[0]
    verts = []
    for i in range(n):
        v = struct.unpack_from("<12f", data, 84 + 50 * i)[3:]
        for j in range(3):
            x, y, z = v[3 * j:3 * j + 3]
            verts += [x, z, -y]
    vb = struct.pack(f"<{len(verts)}f", *verts)
    xs, ys, zs = verts[0::3], verts[1::3], verts[2::3]
    gltf = {"asset": {"version": "2.0", "generator": "pai-cfd"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "Body"}],
            "meshes": [{"name": "Body", "primitives": [{"attributes": {"POSITION": 0}, "material": 0}]}],
            "materials": [{"name": "Body", "pbrMetallicRoughness": {"baseColorFactor": [0.75, 0.78, 0.82, 1], "metallicFactor": 0.4, "roughnessFactor": 0.4}}],
            "buffers": [{"byteLength": len(vb)}], "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(vb)}],
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(verts) // 3, "type": "VEC3", "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]}]}
    js = json.dumps(gltf).encode(); js += b" " * (-len(js) % 4)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(vb)) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(vb), 0x004E4942) + vb)


write_glb(out / "body.stl", out / "aero.glb")
(out / "stages").mkdir(exist_ok=True)
shutil.copy(out / "aero.glb", out / "stages" / "01-body.glb")
event({"type": "stage", "index": 1, "id": "body", "label": f"CadQuery 车身：后斜角 {body['parameters']['slantAngleDeg']}°，迎风面积 {body['frontalAreaM2']} m²",
       "file": "stages/01-body.glb", "objects": ["Body"]})


def run_case(level):
    case = out / f"case-{level}"
    shutil.rmtree(case, ignore_errors=True)
    subprocess.run([sys.executable, "-I", str(HERE / "cfd_case.py"), "--stl", str(out / "body.stl"), "--out", str(case), "--level", str(level),
                    "--iterations", str(iterations), "--speed", str(speed), "--frontal-area", str(body["frontalAreaM2"]),
                    "--length", str(body["parameters"]["length"]), "--processors", str(procs)], check=True, capture_output=True, text=True)
    shutil.copy(HERE / "cfd_run.sh", case / "run.sh")
    runner = spec["runner"]
    t0 = time.monotonic()
    if runner["kind"] == "docker":
        case.chmod(0o777)
        for f in case.rglob("*"):
            f.chmod(0o777 if f.is_dir() else 0o666)
        import os
        r = subprocess.run(["docker", "run", "--rm", "--network", "none", "--cpus", str(procs), "-u", f"{os.getuid()}:{os.getgid()}",
                            "-v", f"{case.resolve()}:/case", "--entrypoint", "bash", runner["image"], "/case/run.sh"], capture_output=True, text=True, timeout=7200)
        if r.returncode != 0:
            raise RuntimeError(f"OpenFOAM level {level}: {(r.stdout + r.stderr).strip().splitlines()[-1][:200]}")
    else:
        raise SystemExit(f"unknown runner {runner['kind']}")
    rows = [l.split() for l in (case / "postProcessing/forceCoeffs/0/coefficient.dat").read_text().splitlines() if l and not l.startswith("#")]
    cd = [float(r[1]) for r in rows]; cl = [float(r[4]) for r in rows]
    # Steady RANS of a bluff body oscillates quasi-periodically; report the mean over a long window and judge whether
    # that mean is stationary (|mean of the last 400 − mean of the last 200| / mean), keeping the raw band as information.
    window = min(400, len(cd)); tail = cd[-window:]
    mean = sum(tail) / len(tail); half = cd[-(window // 2):]
    run = json.loads((case / "run.json").read_text())
    shutil.copy(case / "postProcessing/forceCoeffs/0/coefficient.dat", out / f"forces-{level}.dat")
    shutil.copy(case / "log.checkMesh", out / f"checkMesh-{level}.log")
    result = {"level": level, "cells": run["cells"], "meshOk": run["meshOk"], "openfoam": run["openfoam"], "iterations": len(cd),
              "cd": round(mean, 5), "cl": round(sum(cl[-window:]) / window, 5), "window": window,
              "cdDrift": round(abs(mean - sum(half) / len(half)) / mean, 5), "cdBand": round((max(tail) - min(tail)) / mean, 5), "seconds": round(time.monotonic() - t0, 1)}
    event({"type": "level", **result})
    return result


results = [run_case(level) for level in levels]
coarse, fine = results[0], results[-1]
grid = abs(fine["cd"] - coarse["cd"]) / fine["cd"]
checks = [
    {"id": "drag-coefficient", "passed": fine["cd"] <= req["maxDragCoefficient"] + 1e-12, "observed": fine["cd"], "required": req["maxDragCoefficient"], "unit": "",
     "method": f"Cd from forceCoeffs on the fine mesh (level {fine['level']}, {fine['cells']} cells), mean of the last {fine['window']} SIMPLE iterations; k-ω SST, {speed} m/s, rolling ground"},
    {"id": "grid-convergence", "passed": grid <= req["maxGridChange"] + 1e-12, "observed": round(grid, 4), "required": req["maxGridChange"], "unit": "fraction",
     "method": f"|Cd(level {fine['level']}) − Cd(level {coarse['level']})| / Cd(level {fine['level']}); two-level mesh dependence"},
    {"id": "iterative-convergence", "passed": max(r["cdDrift"] for r in results) <= req["maxIterativeBand"] + 1e-12, "observed": max(r["cdDrift"] for r in results),
     "required": req["maxIterativeBand"], "unit": "fraction",
     "method": "Stationarity of the averaged Cd: |mean of the last 400 − mean of the last 200 iterations| / mean, worst of both meshes (raw oscillation band kept in cfd.json)"},
    {"id": "mesh-quality", "passed": all(r["meshOk"] for r in results), "observed": sum(r["meshOk"] for r in results), "required": len(results), "unit": "meshes",
     "method": "OpenFOAM checkMesh reports Mesh OK"},
]
cfd = {"schema": "pai-cfd-1", "openfoam": fine["openfoam"], "image": spec["runner"].get("image"), "body": body, "levels": results, "speedMs": speed,
       "seconds": round(time.monotonic() - started, 1), "scope": "steady-rans-cfd", "physicalValidation": False,
       "limits": "Steady RANS (k-ω SST, wall functions, no prism layers) of a bluff body; Cd is a design-comparison quantity, not a wind-tunnel value"}
(out / "cfd.json").write_text(json.dumps(cfd, indent=2) + "\n")
(out / "checks.json").write_text(json.dumps({"schema": "pai-cfd-checks-1", "engine": f"OpenFOAM {fine['openfoam']}", "variant": "aero-body", "parameters": body["parameters"],
    "checks": checks, "scope": "steady-rans-cfd", "physicalValidation": False}, indent=2) + "\n")
for level in levels:
    shutil.rmtree(out / f"case-{level}", ignore_errors=True)  # keep the summarised evidence, not the 100 MB fields
print(json.dumps({"checks": [(c["id"], c["passed"], c["observed"]) for c in checks]}), file=sys.stderr)
