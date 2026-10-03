# Physics lane: FEA, physics-aware optimisation and robot simulation

The geometry checks of the CAD lane answer "does it fit and can it be made". This lane answers "does it hold up under load". Every number reported is produced by a native solver from the stored geometry. A surrogate model may only *rank* candidates, and never decides anything.

## Toolchain (`npm run setup:physics`)

| Component | Pin | Source |
|---|---|---|
| Gmsh | 4.15.2 | PyPI wheel, hash-locked (`native/physics-requirements.txt`) |
| CalculiX ccx | 2.21 | Ubuntu 24.04 archive. `apt-get download` checks each package against the signed archive indices; the packages are unpacked into `.state/tools`, with no root and no system change |
| Optuna | 5.0.0 | PyPI, hash-locked |
| scikit-learn | 1.9.1 | PyPI, hash-locked |
| MuJoCo | 3.14.0 | PyPI, hash-locked |

The receipt (`.state/tools/physics-install-receipt.json`) records every .deb digest and the lock hash.

On Ubuntu 24.04, Gmsh's wheel also requires GLU, X11 and OpenMP runtime libraries
(`libglu1-mesa`, `libxcursor1`, `libxinerama1`, `libxft2`, `libgomp1`).
The CI native dependency step installs them before the physics
probe. Missing shared libraries remain setup failures with the importer's
stderr retained; they never become skipped or passing simulation evidence.

## Structural FEA in the CAD review

Freezing `requirements.structural` adds two checks to the ordinary CAD review. Both baseline and candidate are solved, compared by EvalArc, and included in the release gate.

| Check | Method |
|---|---|
| `max-deflection` | Displacement of the motor axis, taken as the mean of the four M3 bore centroids |
| `max-stress` | Peak integration-point von Mises stress away from fixed nodes, at most yield / SF |

The model in detail:

- **Load case:** a belt-driven stepper. The radial pulley force `forceN` acts at `leverMm` from the mounting face. It is applied as statically equivalent loads on the four M3 bores: −F/4 each in Z, plus a Y couple between the upper and lower pairs.
- **Supports and material:** the M5 base bores are fixed. Material is 6061-T6 (nominal E = 68.9 GPa, ν = 0.33, yield 276 MPa).
- **Mesh:** Gmsh quadratic tetrahedra (C3D10), solved twice at two mesh sizes. Both are recorded, and the convergence ratio is shown next to the result.
- **Mesh dependence:** deflection converges to about 2 %. Peak stress at the sharp, unfilleted corners is mesh-dependent (about 20 %); this is stated wherever it appears.
- **Artefacts:** `fea.json`, a von Mises coloured and deformation-scaled `fea.glb` (the viewport's stress view), and the CalculiX deck and `.frd` (open them in cgx or ParaView). All carry digests.
- **Fails closed:** structural requirements without the toolchain return `FEA_NOT_CONFIGURED`. The checks are never skipped.

Measured with the default load (60 N, 50 mm, SF 2, deflection ≤ 0.06 mm):

| Bracket | Mass | Geometry checks | Motor-axis deflection | Peak stress |
|---|---|---|---|---|
| Reference t 4, W 60, H 46 | 48.4 g | pass | 0.048 mm | 49 MPa |
| Grid-sweep "lightest feasible" t 3 | 37.4 g | pass | **0.095 mm (fails)** | 92 MPa |
| Lightweight t 2.5 | 31.9 g | min-wall fails | 0.148 mm | 136 MPa |

Physics changes the decision: the geometry-only optimum is too flexible. Widening the plate also makes it *more* flexible (W 80 at t 3: 0.126 mm), because the ribs sit at the plate edges and move away from the bores.

## Physics-aware optimisation (`cad-optimize`)

`native/cad_optimize.py` works in rounds, using the standard practice "surrogate ranks, solver decides":

1. **Initial design.** Measure the reference part, up to four AI-proposed seeds, and scrambled Sobol points. Each one is a CadQuery build with B-Rep checks plus a fine-mesh CalculiX solve.
2. **Fit surrogates.** Fit Gaussian-process surrogates (Matérn 5/2 + noise) for log-deflection, log-stress, mass, minimum wall and hole-edge distance. The leave-one-out error of each round is reported.
3. **Search.** Run Optuna NSGA-II on the surrogate. Constraints are taken at mean ± 1σ, so the search is conservative.
4. **Screen, then solve.** Candidates first get a cheap B-Rep screen (multi-fidelity). Only geometry-feasible ones are solved. Each round adds the lightest feasible candidates (exploit) and the most uncertain near-feasible one (explore). The surrogate's prediction is stored *before* the solve, so its calibration is reported honestly.
5. **Recommend.** The recommendation is the lightest *measured* feasible point. Choosing it creates an ordinary parametric review with `fromOptimize` provenance. That review solves two meshes, re-runs the baseline and EvalArc, and goes through the release gate. The provenance is verified: the point must have been solved, with identical parameters and requirements.

**AI physical reasoning, scored.** An AI planner can propose `cad-optimize` seeds together with its own first-principles estimate (`expectedDeflectionMm`, `expectedMassG`). The tool description gives the scaling laws and the recipe's edge-distance rules. The solver's result scores each estimate, and the score is shown in the panel and stored in the record. In the native test, a model seed at t 3.8, W 57, H 45 was predicted at 0.055 mm and measured at 0.052 mm, a 6 % error. At 43.2 g it is 11 % lighter than the reference and passes all 9 checks.

## Robot workcell simulation (MuJoCo, scene variant `robot-cell`)

`native/robot_sim.py` generates an MJCF model from eight bounded parameters (no user XML):

- a generic 6-axis arm with UR5e-class link lengths from the public datasheet, on a pedestal;
- a conveyor pick station and a fixture place station;
- four guard panels.

The arm runs 10 fixed seeds, each with a seeded jitter on the pick pose. For each seed:

1. Damped least-squares IK on the MuJoCo Jacobian, within joint limits.
2. A joint-space quintic trajectory at the configured fraction of rated joint speed: approach → pick → lift → transfer → place → retract.
3. Position actuators driven with full rigid-body dynamics at 500 Hz, with contact detection between arm links and the static scene.

| Check | Measured |
|---|---|
| `reach` | TCP error ≤ 2 mm at pick and place, every seed |
| `collision-free` | No arm-link contact with guards, conveyor frame or fixture during the motion |
| `cycle-time` | Slowest seed's cycle including settling, ≤ `maxCycleSeconds` |
| `success-rate` | Share of seeds that reach, stay collision-free and meet the cycle, ≥ `minSuccessRate` |

The baseline is the reference cell. Both cells run the same seeds, and the validate view shows the paired seed table (Robot Reel style: a lost baseline success is flagged). EvalArc compares the four checks. Artefacts: `scene.xml` (the exact MJCF, which opens in MuJoCo viewer or can be converted for Isaac), `robot.json` (per-seed results) and `robot.glb`.

Measured (`npm run test:robot`), with the target raised to a 5 s cycle:

| Cell | Result |
|---|---|
| Reference at 50 % speed | 5.90 s, fails the new target |
| Faster cell (75 %) with guards pulled in to 0.12 m | 4.60 s, but the elbow hits the guard on every seed: rejected |
| Same speed with guards at 0.30 m | 4.60 s, 10/10 seeds: accepted (22 % faster than the reference) |

Feedback is closed by that recheck. Scope: a rigid-body simulation of a generic arm and controller; the part is attached kinematically. It is not the vendor's controller, a safety assessment, or a grasp-physics model.

## Scope

Linear static, small deformation, nominal material. Not included: contact, bolt preload, fatigue, thermal effects, tolerances, or test data. Results are simulation evidence, not certification.
