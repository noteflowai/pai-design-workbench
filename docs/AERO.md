# Aerodynamics lane (OpenFOAM)

A body design is judged by a RANS solve, not by the model. The lane reuses established components:

| Part | Component |
|---|---|
| Geometry | CadQuery 2.8 / OCCT 7.9, parametric Ahmed-type body (`native/cfd_body.py`) |
| Solver | OpenFOAM v2512 (openfoam.com, latest stable; v2606 is still rc2) from the official OpenCFD image `opencfd/openfoam-default:2512`, pinned by digest in `PAI_OPENFOAM_IMAGE` |
| Mesh | `blockMesh` → `surfaceFeatureExtract` → `snappyHexMesh` |
| Flow | `simpleFoam`, k-ω SST, wall functions, 40 m/s, moving ground, half model with a symmetry plane |
| Comparison | EvalArc (JUnit of the four checks); same feedback / recheck / release path as the other lanes |

The Ahmed body is the standard automotive bluff-body benchmark (Ahmed, Ramm & Faltin 1984): 1.044 × 0.389 × 0.288 m,
a 0.1 m nose radius, a 0.222 m rear slant and a 50 mm ground clearance. The 25° body is the reference of every review.
The case files are written by `native/cfd_case.py` and run inside the image by `native/cfd_run.sh` (`--network none`,
the host user, the case directory as the only mount).

## Checks (`pai-cfd-checks-1`)

| Check | Definition |
|---|---|
| `drag-coefficient` | Fine-mesh (level 4) Cd, mean of the last 100 SIMPLE iterations, ≤ `maxDragCoefficient` |
| `grid-convergence` | \|Cd(level 4) − Cd(level 3)\| / Cd(level 4) ≤ `maxGridChange`. This is two-level mesh dependence, not a GCI. |
| `iterative-convergence` | (max − min) / mean of Cd over the last 100 iterations, worst of both meshes, ≤ `maxIterativeBand` |
| `mesh-quality` | `checkMesh` reports "Mesh OK" on both meshes |

The defaults are Cd ≤ 0.24, grid change ≤ 12 % and iterative band ≤ 1 %. The grid tolerance comes from the
measurements below. The lane runs without prism layers; layers and finer levels are the next step on AWS Batch.

## Measured (local, 6–8 cores)

| Slant | Level 2 | Level 3 (≈ 61 k cells) | Level 4 (≈ 220 k cells) | Ahmed 1984 (experiment) |
|---|---|---|---|---|
| 0° | | 0.274 | | 0.250 |
| 12.5° | | 0.254 | 0.230 | 0.230 |
| 25° | 0.328 | 0.258 | 0.234 | 0.285 |
| 30° | | 0.263 | | 0.378 |
| 35° | | 0.280 | 0.249 | 0.260 |

- **Iterative convergence.** The Cd band over the last 100 iterations is below 0.01 %.
- **Mesh dependence.** Cd changes by 9–10 % from level 3 to level 4, so a finer mesh is still needed for absolute
  values.
- **12.5° body.** It is the low-drag optimum both in the experiment and here; at level 4 it matches the measured 0.230.
- **25°–30° bodies.** Their drag is under-predicted. This is a known weakness of steady RANS with wall functions:
  the measured high-drag state at 30° depends on unsteady C-pillar vortices and partial separation on the slant.

The lane is therefore a design-comparison tool. It ranks slant angles correctly at the low-drag end, it states its
mesh dependence, and every record carries `physicalValidation: false`.

## Run

```bash
docker pull opencfd/openfoam-default:2512
echo "PAI_OPENFOAM_IMAGE=$(docker image inspect opencfd/openfoam-default:2512 --format '{{index .RepoDigests 0}}')" >> .state/demo.env
npm run test:aero   # 35° body vs the Cd target → feedback → 12.5° body re-solved on two meshes → feedback closed
```

API: `POST /api/projects/:id/aero` with `{ requestId, projectRevision, parameters: { slantAngleDeg, noseRadius,
length, height }, requirements? }`. The UI lane is "车身气动". The AI tool `aero-body` proposes typed parameters,
which still need confirmation.
