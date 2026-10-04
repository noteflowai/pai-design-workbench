"""AI aerodynamic prescreen: NVIDIA DoMINO (PhysicsNeMo-CFD, DrivAerML surface checkpoint) on a body STL.

    <physicsnemo venv>/bin/python cfd_prescreen.py --stl body.stl --output prescreen.json --workflow DIR --checkpoint FILE.mdlus
        [--frontal-area A] [--scale S] [--speed U] [--ground-z Z]

Reuses the upstream `DoMINOInference` pipeline of `workflows/domino_design_sensitivities` unchanged (checkpoint-described
architecture, restricted unpickler for the scaling factors, area-weighted surface integration). This adapter only
places the geometry in the training frame and writes a digest-bound record:

- Flat CAD facets are refined (subdivision only, geometry unchanged) to about the DrivAerML surface density.
- Geometry is scaled by S (dynamic similarity: Cd is compared, not forces) and translated so its ground plane sits on the
  DrivAerML ground (z = -0.3176) and its nose near the DrivAerML nose station; the surface must stay inside the
  checkpoint's surface bounding box or the run refuses.
- Cd = Fx / (0.5 rho U^2 A S^2). A is the frontal area of the unscaled body (from the B-Rep), S^2 scales it.
- Out of distribution by construction for anything that is not a DrivAer-like car (the Ahmed body has no wheels or
  cabin). The number is an advisory ranking signal, never a result; the native OpenFOAM solve decides.
"""
import argparse, hashlib, json, sys, time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--stl", required=True); p.add_argument("--output", required=True)
p.add_argument("--workflow", required=True, help="physicsnemo-cfd workflows/domino_design_sensitivities")
p.add_argument("--checkpoint", required=True, help="DoMINO .mdlus with scaling_factors.pkl next to it")
p.add_argument("--frontal-area", type=float, help="unscaled frontal area [m^2]; default: projected area of the STL")
p.add_argument("--scale", type=float, default=1.0); p.add_argument("--speed", type=float, default=38.889)
p.add_argument("--density", type=float, default=1.205)
p.add_argument("--ground-z", type=float, default=0.0, help="ground plane of the input frame [m]")
p.add_argument("--nose-x", type=float, default=-0.765, help="nose station in the DrivAerML frame [m] (run_1 nose)")
p.add_argument("--max-edge", type=float, default=0.024, help="refine triangles to this edge length in the training frame [m]; "
               "DoMINO samples face centres; 0.024 gives about the 0.75 M faces of a DrivAerML surface")
p.add_argument("--keep-frame", action="store_true", help="input is already in the DrivAerML frame (sanity check)")
a = p.parse_args()

sys.path.insert(0, a.workflow)
import numpy as np, pyvista as pv, torch, hydra  # noqa: E402
from physicsnemo.distributed import DistributedManager  # noqa: E402
from main import DoMINOInference  # noqa: E402  (upstream workflow module)

DRIVAERML_GROUND = -0.3176
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
t0 = time.time()
mesh = pv.read(a.stl).triangulate().clean()
if not a.keep_frame:
    mesh.points = (mesh.points - np.array([mesh.bounds[0], 0.0, a.ground_z])) * a.scale + np.array([a.nose_x, 0.0, DRIVAERML_GROUND])
if a.max_edge > 0:
    # CAD STLs have a few large facets on flat faces; refine to the training surface density (geometry unchanged).
    mesh = mesh.subdivide_adaptive(max_edge_len=a.max_edge, max_n_passes=20).clean()
mesh = mesh.compute_normals(cell_normals=True, point_normals=True, auto_orient_normals=True)
with hydra.initialize_config_dir(version_base="1.3", config_dir=str(Path(a.workflow, "conf").resolve())):
    cfg = hydra.compose(config_name="config")
lo, hi = np.array(cfg.data.bounding_box_surface.min), np.array(cfg.data.bounding_box_surface.max)
b = np.array(mesh.bounds).reshape(3, 2)
if (b[:, 0] < lo - 1e-6).any() or (b[:, 1] > hi + 1e-6).any():
    raise SystemExit(f"geometry {b.tolist()} outside the checkpoint's surface box {lo.tolist()}..{hi.tolist()}")
if a.frontal_area is None:
    # Projected area on the y-z plane, from the surface itself (sanity runs on foreign STLs).
    n = mesh.cell_normals; areas = mesh.compute_cell_sizes(length=False, volume=False).cell_data["Area"]
    area_scaled = float(0.5 * np.sum(np.abs(n[:, 0]) * areas))
else:
    area_scaled = a.frontal_area * a.scale ** 2
torch.cuda.set_per_process_memory_fraction(0.9)
DistributedManager.initialize()
domino = DoMINOInference(cfg=cfg, model_checkpoint_path=Path(a.checkpoint), dist=DistributedManager())
r = domino(mesh=mesh, stream_velocity=a.speed, stencil_size=7, air_density=a.density, verbose=False)
force = [float(x) for x in r["aerodynamic_force"]]
q = 0.5 * a.density * a.speed ** 2
out = {
    "schema": "pai-cfd-prescreen-1",
    "model": {"name": "DoMINO DrivAerML surface", "checkpoint": Path(a.checkpoint).name, "checkpointSha256": sha(a.checkpoint),
              "scalingFactorsSha256": sha(Path(a.checkpoint).with_name("scaling_factors.pkl")), "torch": torch.__version__,
              "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"},
    "input": {"stlSha256": sha(a.stl), "scale": a.scale, "speedMs": a.speed, "density": a.density, "frontalAreaM2": round(area_scaled, 6),
              "faces": int(mesh.n_cells), "boundsInTrainingFrame": [[round(x, 4) for x in row] for row in b.tolist()]},
    "forceN": [round(x, 4) for x in force],
    "cd": round(force[0] / (q * area_scaled), 5),
    "meanPressurePa": round(float(np.mean(r["pred_surf_pressure"])), 3),
    "seconds": round(time.time() - t0, 1),
    "scope": "ml-surrogate-prescreen", "advisory": True, "physicalValidation": False,
    "limits": "DrivAerML-trained surrogate; out of distribution for non-car bodies; ranking signal only, calibrated against native OpenFOAM solves",
}
Path(a.output).write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps({k: out[k] for k in ("cd", "forceN", "seconds")}))
