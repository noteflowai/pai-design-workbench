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
| `drag-coefficient` | Fine-mesh (level 4) Cd, mean of the last 400 of 1200 SIMPLE iterations, ≤ `maxDragCoefficient` |
| `grid-convergence` | \|Cd(level 4) − Cd(level 3)\| / Cd(level 4) ≤ `maxGridChange`. This is two-level mesh dependence, not a GCI. |
| `iterative-convergence` | Stationarity of the averaged Cd: \|mean of the last 400 − mean of the last 200\| / mean, worst of both meshes, ≤ `maxIterativeBand`. The raw oscillation band is kept in `cfd.json`. |
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

- **Iterative convergence.** At level 3 the solution is steady: the Cd band is below 0.01 %. At level 4, steady RANS
  of the 12.5° body oscillates quasi-periodically: Cd 0.2255–0.2313, period about 300 iterations, a 2.6 % band over
  100 iterations. The first end-to-end run used that band as its check and correctly rejected the body. The check now
  averages over 400 iterations and judges whether that average is stationary, which is the usual practice.
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

## On AWS Batch

When `PAI_SOLVER_CFD_JOB_DEFINITION` is configured, as on the hosted site, each case runs as its own Batch job.

- **Image.** `Dockerfile.cfd` is built FROM the same pinned OpenCFD digest and adds Python and boto3 only.
- **Resources.** Each job gets 16 vCPU and 32 GiB. Jobs are not retried.
- **Job I/O.** The host prepares the case (dictionaries and `body.stl`) and uploads it as `case.tar`. The job runs the
  image's own `cfd_run.sh`.
- **Checks.** The host re-hashes `coefficient.dat`, `run.json` and `log.checkMesh` against `result.json` and requires
  OpenFOAM v2512.

The 12.5° review on pai.oneai.host took 9 minutes in 4 jobs; locally on 8 cores it took 94 minutes. The drag
coefficients equal the local ones: reference 0.23406, candidate 0.22926 against 0.22945 locally. See
[aero-batch.json](evidence/aero-batch.json).

## Boundary-layer experiment (not used by reviews)

`cfd_case.py --layers N` adds snappyHexMesh prism layers. On the 12.5° body:

| Variant | Level 3 Cd | Level 4 Cd | Two-level change |
|---|---|---|---|
| No layers (the review setting) | 0.2537 | 0.2295 | 10.6 % |
| 3 relative layers (expansion 1.2, final 0.5; 80 % thickness coverage) | 0.3059 | 0.2454 | 24.7 % |
| 3 absolute layers (first cell for y+ ≈ 50) | 0.2547 (28 % coverage) | diverged (floating-point exception, iteration 9) | — |

Prism layers alone increase the mesh dependence. A layered setup that converges needs four things together:
- a y+ study per level;
- a `potentialFoam` initialisation and a first-order start;
- finer surface refinement so the layers can grow;
- the 16-vCPU Batch runner, because each case costs 10–30 minutes.

Until that study is done, reviews keep the verified no-layer setup and state its 10 % mesh dependence.
