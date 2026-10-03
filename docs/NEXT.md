# Domain expansion and pilot

Priority is one verified decision workflow, then one external task owner, then a second domain tool.

1. **Robot/Physical AI experiment design:** Blender static scene generation/checks and the recorded regression loop are implemented. Next accept newly produced native records with fixed task/seed/policy identities, compare actual candidate versions, preserve hard failures. Add controlled simulation production only after compute availability and native safety limits are explicit.
2. **Factory maintenance / energy decision review:** read-only review is implemented. Criteria are frozen before import; the byte-exact v0.18.0 `seeds.json`/`manifest.json` is consistency-checked and every seed is evaluated. Under default criteria the panel is rejected (seeds 3, 11 output; seed 10 EV service). Next: controlled parameter runs of the upstream twin in an isolated pinned tool directory, OpenUSD/Blender native delivery in the viewport once the public archive exists, and measured plant data before any real optimization claim. See [integration review](ROBOT_REEL_INTEGRATION.md).
3. **Mechanical CAD / DFM:** a CadQuery 2.8 / OCCT 7.9 lane is implemented for one controlled part family (NEMA 17 motor-mount bracket): editable STEP, B-Rep-measured interface, wall, edge distance, mass and assembly interference, STEP re-import. Next: FreeCAD native documents with sketch constraints, user-owned part families under review, tolerance stack-up and FEA through dedicated solvers, and a professional reviewer for manufacturing constraints.

**AI studio:** deterministic parsing, the model planner through the bounded executor (Kiro x3, locally also Codex/Claude), cited answers, a stdio MCP server, sandboxed generated CadQuery code and a native design-space sweep are implemented (0.4.0–0.6.0), locally and on Amazon Bedrock AgentCore (arm64). Next: OpenUSD streaming for multi-object animated scenes, user-owned part families beyond the bracket, and a remote (OAuth, HTTP) MCP endpoint for the hosted site.

**Desktop:** Electron packaging shares the existing server and React UI. CI checks staging on Linux x64, Windows x64 and macOS arm64; manual/tag builds additionally launch each packaged app, check isolation and stop its server. Native automatic installers currently target Linux x64. Next: independently verified Windows/macOS native-tool installers, code signing and macOS notarization before public distribution. Keep supported capabilities explicit; an installer build or startup smoke does not establish native-tool or physical validation on that platform.

Real factory optimization additionally requires measured cycle times, equipment parameters and uncertainty/sensitivity checks. Synthetic parameter examples remain labeled illustrations.

Professional context is in the workspace's portfolio research report (2026-09-30): EngiWorld, CADWorld, ReliCAD, DFM evaluation work and existing replay/visualization competitors. The product difference to test is requirement-bound decisions and reproducible feedback closure, not another generic viewer.

First pilot: an authorized robot experiment owner brings a permitted recording and one concrete decision. Record setup time, evidence reopening, whether the decision changed, unresolved questions, second use and existing preferred workflow. Maintainer trials stay separate. Capture actual observations; do not invent outreach, users or conversion.

Promotion starts with a draft that includes native artifacts and the rejected condition. User-authorized publishing may later connect Robot Reel pages, HF/GitHub and technical content channels. The workbench currently generates drafts and records feedback; it sends nothing.

Go/no-go after 3 independent tasks: at least 2 can be reproduced from supplied evidence; no critical missing artifacts; at least 1 owner uses it a second time. These are proposed pilot criteria, not observed results.

## AI-native design → physics verification (status 2026-10-03)

The model proposes and the native solvers decide. This layer table follows the external gap analysis; each row states only what has been run.

| Layer | Status | Evidence / next step |
|---|---|---|
| 0 Intent → typed requirement | Done | Zod plans, MCP, AgentForge governed gateway and client-credentials agent API |
| 2 Engineering geometry | Done (one part family + generated code) | Next: FreeCAD/build123d families and Fusion/Onshape MCP; tolerance stack-up; drawings with GD&T |
| 3 High-fidelity solve | Structural done: Gmsh C3D10 + CalculiX, two-mesh convergence, in reviews and in the release gate | Next: OpenFOAM for flow; scale-out of solves on AWS Batch / ParallelCluster |
| 4 Physics-AI surrogate | Partial: GP surrogate trained only on our own solver results, ranks candidates only, calibration and leave-one-out error reported | Next: PhysicsNeMo (Transolver / GeoTransolver) once a solver dataset exists (Batch-generated FEA; DrivAerML for aero) |
| 5 Optimisation | Done: Optuna NSGA-II on the surrogate, multi-fidelity B-Rep screen, explore/exploit, solver re-measurement, formal review of the pick | Next: BoTorch qNEHVI for expensive multi-objective; topology optimisation |
| 6 System / robot | Done: MuJoCo workcell (IK, dynamics, contacts, cycle time over paired seeds); accepted CAD parts mounted on the arm with exact-mesh mass/inertia cross-checked against the B-Rep; portable MJCF and OpenUSD (UsdPhysics bodies, joints, colliders; all 28 UsdValidation validators clean) | Next: Isaac Lab policy success on the exported USD; grasp physics instead of kinematic attachment |
| 7 Manufacturability | Geometry rules (wall, hole edge, envelope) | Next: CAM/slicer CLI checks and cost |
| 8 Evidence | Done: hash-bound bundles, EvalArc, release admission, KMS-signed release packages with in-UI and offline verification | Next: RFC 3161 trusted timestamps, S3 Object Lock retention of packages |

The model's physical reasoning is a measured quantity here, not a claim. Each AI seed in `cad-optimize` carries the model's first-principles estimate, and the solver's result scores it.

The next demo (A in the analysis) can now be built from existing lanes:

1. Faster cycle target.
2. MuJoCo detects the guard collision.
3. AI proposes the cell fix and the bracket redesign.
4. CalculiX rejects the geometry-only optimum; physics-aware optimisation finds the lightest stiff bracket.
5. Blender re-checks the plant layout.
6. Evidence bundle.

