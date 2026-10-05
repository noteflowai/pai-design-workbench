# CAM lane (FreeCAD CAM + OpenCAMLib, independently simulated)

A CAD review with `requirements.dfm.cam = { maxCycleMinutes }` programs the part for a 3-axis mill and checks the
programs before anyone cuts metal. Opt-in like FEA and DFM. Install with `npm run setup:cam`. That fetches the official
FreeCAD 1.1.4 AppImage, checks it against the pinned SHA-256 in `tools/runtime-pins.json` and adds the hash-locked
`native/cam-requirements.txt` (ocp-freecad-cam 2.0.2, CadQuery 2.8). FreeCAD (LGPL) runs as a separate process.

## Programs (`native/cam_part.py`)

Toolpaths are reused, not written here:
- **Setups** come from DFM. +Z shapes the part. Every hole is drilled from a side whose drill corridor is free
  (`dfm.json` `access`), preferring setups already in use. Each setup rotates the part so the tool axis is +Z.
- **Roughing:** FreeCAD Adaptive per Z level. Each level's region is the stock outline minus the silhouette of all
  material above it, so a hole across the tool axis never becomes a path under material. The layers are 6 mm
  everywhere except over the sloped faces (2 mm). 0.2 mm is left on the walls.
- **Finishing:**
  - FreeCAD Profile around the walls.
  - Z-level contours every 0.25 mm over the slopes.
  - A ball-nose raster over the sloped faces, from OpenCAMLib `AdaptivePathDropCutter`. FreeCAD's 3D Surface op with
    selected faces fails on 1.1.4, so its engine is used directly. The step-over is corrected for the face tilt.
- **Holes:** FreeCAD Drill (peck) and Helix for the bores.
- **Post-processor:** grbl. A rapid that would travel below the part top is turned into a feed move.

The tool library, feeds and tolerances live in `native/dfm-shop.json` (`cam`), reviewed data and conservative for
6061-T6 on a small VMC.

## Check (`native/cam_verify.py`)

The check reads only the G-code (G0–G3, G17 G21 G90; anything else is refused) and the tool table, never FreeCAD
state. For each setup it simulates material removal on a 0.1 mm dexel height map, starting from bar stock or from the
earlier setups. Holes made by later setups are filled.

| Check | Rule |
|---|---|
| `no-gouge` | No cell is cut more than 0.02 mm below the part |
| `no-residual` | No material is left above what the library tools can reach: flat faces ≤ 0.1 mm, sloped faces ≤ 0.4 mm |
| `tool-engagement` | No plunge or slot loads the tool end deeper than its axial limit |
| `no-rapid-collision` | No G0 passes through material that is still there |

"What the library tools can reach" is the grey closing of the part height map with each tool's end profile. The part
minus that closing is reported as `toolLimited` (internal corner fillets), not blamed on the program. Cells within
0.3 mm of a vertical wall are not judged. Cycle time counts feed moves at the programmed feeds and rapids at the shop
rate; it leaves out acceleration, tool changes and loading.

In the review these become two checks, `cam-toolpath` and `cycle-time`, and go through EvalArc like every other
check. `setup±?.nc`, `cam.json` and `cam-verify.json` are recorded by digest and served from the record. A part that
cannot be programmed as designed (a hole without a free drill corridor) fails `cam-toolpath`; it is not a tool error.

## Measured

`npm run test:cam` (reference bracket, both as baseline and candidate; 607 s):
- Two programs, `setup+Z.nc` and `setup+Y.nc`.
- All four simulation checks pass. Cycle time is 94.3 min (91.6 + 2.8).
- Tool-limited material: 17.5 mm², the R 3 corners where the ribs meet the plate.
- Receipts: [cam-e2e.json](evidence/cam-e2e.json).

The negative controls run on the same programs with one fault injected and the digest recomputed. Each fails:

| Injected fault | Result |
|---|---|
| Outer profile 0.5 mm deeper | `no-gouge` fails (18 mm into the base) |
| Raster and z-level finishing removed | `no-residual` fails (4 mm stairs) |
| The Ø22.5 bore's helix removed | `no-residual` fails in setup +Y |
| Edited G-code with the old digest | refused before simulation |

Developing the programs against the checker found six real program faults: roughing that ran under the plate through
the bore silhouette, open edges left uncut, plunges into deep stock, rapids at cutting depth, wrong setup rotation for
the +Y holes, and a raster too coarse on the 45° slopes. Each was fixed in `cam_part.py`, not by loosening a check.

## Where it runs

- **Locally and in CI:** `npm run setup:cam` installs the FreeCAD venv; `cam_part.py` runs on the host.
- **Hosted, on AWS Batch:** when `PAI_SOLVER_CAM_JOB_DEFINITION` is configured, program generation runs as one
  PAISolver job per part (`Dockerfile.cam`, 4 vCPU / 16 GiB, 1 h, one attempt).
  - The image installs FreeCAD with the same `tools/setup_cam.py` and the same pins as the local lane.
  - `native/cam_remote.py` uploads `part.step` and `dfm.json`, submits the job without ever resubmitting it, and
    re-hashes every returned file against the job's `result.json` and the inputs it sent.
  - The **verification still runs on the workbench host** (`cam_verify.py` in the CadQuery venv), so the program
    generator and its checker never share a container.
  - Locally the image produced the same `setup+Y.nc` as the local lane. Its `setup+Z.nc` differs; two local runs also
    differ from each other, because FreeCAD Adaptive output depends on thread timing. The container's programs pass
    the same simulation (94.3 min).
- **Not on the small host:** the hosted host itself has 2 vCPU and 3 GB RAM, so the local FreeCAD lane
  (`PAI_ENABLE_CAM=1`) stays off there.

## Limits

This is simulation, not a machine test. There is no work holding, no tabs, no tool-length offsets, no machine
kinematics and no acceleration. The 94 min cycle time is long for this part: the roughing feeds and the 0.25 mm z-level
finish are conservative. A CAM engineer reviews the program before cutting, and only measured parts can set
`physicalValidation`.
