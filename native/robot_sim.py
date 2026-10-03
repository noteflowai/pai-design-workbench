"""MuJoCo verification of a robot workcell: reach, collision and cycle time over seeded pick-and-place trials.

Run with the pinned physics interpreter. The input is a bounded workcell parameter set (no user XML). The script
generates an MJCF model of a 6-axis arm (UR5e-class link lengths and joint limits, from the public datasheet
dimensions) on a pedestal, plus a conveyor pick station, a fixture place station and the guard panels. It then
runs the same seeded trial set as Robot Reel-style paired evaluation:

- Each trial jitters the pick pose (part position on the conveyor) by a seeded offset.
- Inverse kinematics is damped least squares on the MuJoCo Jacobian, inside the joint limits.
- The trajectory is joint-space quintic, through approach → pick → lift → transfer → place → retract.
- The arm is driven by position actuators and simulated with full rigid-body dynamics at 500 Hz.
- Collisions are MuJoCo contacts between arm links and the static scene (guards, conveyor frame, fixture body);
  the gripper's intended contact with the part is excluded.

Per seed it records: reached (both IK solutions within 2 mm), collisionFree, cycle time at the configured
joint-speed fraction, peak joint torque, and success = reached ∧ collisionFree ∧ cycle ≤ limit.
Outputs: robot.json, scene.xml (the exact MJCF) and a GLB of the arm at its pick pose for the viewport.
Scope: rigid-body simulation of a generic arm. Not the vendor's controller, not a safety assessment, and not a
grasp-physics model (the part is attached kinematically when the gripper closes).
"""
import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path

import mujoco
import numpy as np

# UR5e-class kinematics (public datasheet link lengths, metres) and joint limits.
D1, A2, A3, D4, D5, D6 = 0.1625, 0.425, 0.3922, 0.1333, 0.0997, 0.0996
LIMITS = [(-2 * math.pi, 2 * math.pi)] * 6
SPEED = [math.pi, math.pi, math.pi, 2 * math.pi, 2 * math.pi, 2 * math.pi]  # rad/s at 100 %
TORQUE = [150, 150, 150, 28, 28, 28]  # N·m rating classes

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
cell, req = spec["cell"], spec["requirements"]
BOUNDS = {"pickDistance": (0.25, 1.1), "placeDistance": (0.25, 1.1), "pickHeight": (0.6, 1.2), "placeHeight": (0.6, 1.2),
          "pedestalHeight": (0.3, 1.0), "guardClearance": (0.1, 1.5), "speedFraction": (0.1, 1.0), "jitter": (0.0, 0.08)}
for k, (lo, hi) in BOUNDS.items():
    if not lo <= float(cell[k]) <= hi:
        raise SystemExit(f"{k}={cell[k]} outside [{lo}, {hi}]")
seeds = [int(s) for s in spec["seeds"]]
if not 1 <= len(seeds) <= 32:
    raise SystemExit("1–32 seeds")


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True), flush=True)


def mjcf():
    ph, gc = cell["pedestalHeight"], cell["guardClearance"]
    pick = (cell["pickDistance"], 0.0, cell["pickHeight"])
    place = (0.0, cell["placeDistance"], cell["placeHeight"])
    # Guard panels stand guardClearance beyond the farther station, measured from the robot axis.
    g = max(cell["pickDistance"], cell["placeDistance"]) + gc
    links = f"""
      <body name="shoulder" pos="0 0 {D1}">
        <joint name="j1" axis="0 0 1" range="{LIMITS[0][0]} {LIMITS[0][1]}" armature="0.1" damping="2"/>
        <geom class="link" type="cylinder" size="0.06 0.07"/>
        <body name="upper" pos="0 0.138 0" euler="0 1.5708 0">
          <joint name="j2" axis="0 1 0" range="{LIMITS[1][0]} {LIMITS[1][1]}" armature="0.1" damping="2"/>
          <geom class="link" type="capsule" fromto="0 0 0 0 0 {A2}" size="0.055"/>
          <body name="fore" pos="0 -0.131 {A2}">
            <joint name="j3" axis="0 1 0" range="{-math.pi} {math.pi}" armature="0.05" damping="1"/>
            <geom class="link" type="capsule" fromto="0 0 0 0 0 {A3}" size="0.045"/>
            <body name="w1" pos="0 0 {A3}" euler="0 1.5708 0">
              <joint name="j4" axis="0 1 0" range="{LIMITS[3][0]} {LIMITS[3][1]}" armature="0.02" damping="0.5"/>
              <geom class="link" type="cylinder" pos="0 {D4/2} 0" euler="1.5708 0 0" size="0.04 {D4/2}"/>
              <body name="w2" pos="0 {D4} 0">
                <joint name="j5" axis="0 0 1" range="{LIMITS[4][0]} {LIMITS[4][1]}" armature="0.02" damping="0.5"/>
                <geom class="link" type="cylinder" pos="0 0 {D5/2}" size="0.04 {D5/2}"/>
                <body name="w3" pos="0 0 {D5}">
                  <joint name="j6" axis="0 1 0" range="{LIMITS[5][0]} {LIMITS[5][1]}" armature="0.01" damping="0.3"/>
                  <geom class="link" type="cylinder" pos="0 {D6/2} 0" euler="1.5708 0 0" size="0.035 {D6/2}"/>
                  <body name="gripper" pos="0 {D6 + 0.06} 0">
                    <geom name="gripper" class="tool" type="box" size="0.04 0.06 0.025"/>
                    <site name="tcp" pos="0 0.07 0" size="0.01"/>
                  </body>
                </body>
              </body>
            </body>
          </body>
        </body>
      </body>"""
    return f"""<mujoco model="pai-workcell">
  <compiler angle="radian"/>
  <option timestep="0.002" gravity="0 0 -9.81" integrator="implicitfast"/>
  <default>
    <default class="link"><geom contype="1" conaffinity="2" rgba="0.95 0.45 0.1 1" density="2700"/></default>
    <default class="tool"><geom contype="1" conaffinity="2" rgba="0.15 0.15 0.15 1" density="2700"/></default>
    <default class="static"><geom contype="2" conaffinity="1" rgba="0.6 0.62 0.6 1"/></default>
  </default>
  <worldbody>
    <light pos="0 0 3" dir="0 0 -1"/>
    <geom name="floor" type="plane" size="4 4 0.1" rgba="0.4 0.42 0.4 1" contype="0" conaffinity="0"/>
    <geom name="pedestal" class="static" type="box" pos="0 0 {ph/2 - 0.01}" size="0.18 0.18 {ph/2 - 0.012}" contype="0"/>
    <geom name="conveyor" class="static" type="box" pos="{pick[0]} 0 {pick[2] - 0.07}" size="0.2 0.5 0.04"/>
    <geom name="fixture" class="static" type="box" pos="0 {place[1]} {place[2] - 0.07}" size="0.15 0.15 0.04"/>
    <geom name="guard+x" class="static" type="box" pos="{g} 0 1" size="0.02 {g} 1"/>
    <geom name="guard-x" class="static" type="box" pos="{-g} 0 1" size="0.02 {g} 1"/>
    <geom name="guard+y" class="static" type="box" pos="0 {g} 1" size="{g} 0.02 1"/>
    <geom name="guard-y" class="static" type="box" pos="0 {-g} 1" size="{g} 0.02 1"/>
    <site name="pick" pos="{pick[0]} 0 {pick[2]}" size="0.015" rgba="0 1 0 1"/>
    <site name="place" pos="0 {place[1]} {place[2]}" size="0.015" rgba="0 0 1 1"/>
    <body name="base" pos="0 0 {ph}">{links}
    </body>
  </worldbody>
  <actuator>{''.join(f'<position name="a{i+1}" joint="j{i+1}" kp="{4000 if i < 3 else 600}" kv="{120 if i < 3 else 25}" forcerange="{-TORQUE[i]} {TORQUE[i]}"/>' for i in range(6))}</actuator>
</mujoco>"""


xml = mjcf()
(out / "scene.xml").write_text(xml)
model = mujoco.MjModel.from_xml_string(xml)
data = mujoco.MjData(model)
tcp = model.site("tcp").id
static_geoms = {model.geom(n).id for n in ("conveyor", "fixture", "guard+x", "guard-x", "guard+y", "guard-y")}
arm_bodies = {model.body(n).id for n in ("shoulder", "upper", "fore", "w1", "w2", "w3", "gripper")}
DOWN = np.array([0.0, 0.0, -1.0])  # tool approach direction (the gripper's +Y axis points down)


def ik(target, q0):
    """Damped least squares on position + approach axis, inside joint limits. Returns (q, position error m)."""
    q = q0.copy()
    for _ in range(400):
        data.qpos[:6] = q
        mujoco.mj_kinematics(model, data); mujoco.mj_comPos(model, data)
        pos = data.site_xpos[tcp]
        axis = data.site_xmat[tcp].reshape(3, 3)[:, 1]
        e = np.concatenate([target - pos, 0.3 * np.cross(axis, DOWN)])
        if np.linalg.norm(e[:3]) < 2e-4 and np.linalg.norm(e[3:]) < 3e-3:
            break
        jp, jr = np.zeros((3, model.nv)), np.zeros((3, model.nv))
        mujoco.mj_jacSite(model, data, jp, jr, tcp)
        J = np.vstack([jp[:, :6], 0.3 * jr[:, :6]])
        dq = J.T @ np.linalg.solve(J @ J.T + 1e-3 * np.eye(6), e)
        q = np.clip(q + np.clip(dq, -0.2, 0.2), [l for l, _ in LIMITS], [h for _, h in LIMITS])
    data.qpos[:6] = q
    mujoco.mj_kinematics(model, data)
    return q, float(np.linalg.norm(target - data.site_xpos[tcp]))


def segment(q_a, q_b):
    """Quintic duration from the slowest joint at the configured speed fraction (peak velocity 1.875 Δ/T)."""
    vmax = np.array(SPEED) * cell["speedFraction"]
    return max(0.25, float(np.max(1.875 * np.abs(q_b - q_a) / vmax)))


def run_trial(seed):
    rng = np.random.default_rng(seed)
    jitter = rng.uniform(-cell["jitter"], cell["jitter"], size=2)
    pick = model.site("pick").pos.copy(); pick[:2] += jitter
    place = model.site("place").pos.copy()
    up = np.array([0, 0, 0.12])
    home = np.array([0.0, -1.2, 1.4, -1.77, -1.5708, 0.0])
    waypoints, worst = [home], 0.0
    for target in (pick + up, pick, pick + up, place + up, place, place + up):
        q, err = ik(target, waypoints[-1])
        waypoints.append(q); worst = max(worst, err)
    waypoints.append(home)
    reached = worst <= 0.002
    mujoco.mj_resetData(model, data)
    data.qpos[:6] = home; data.ctrl[:6] = home
    mujoco.mj_forward(model, data)
    t, collisions, peak = 0.0, set(), np.zeros(6)
    for a, b in zip(waypoints, waypoints[1:]):
        T = segment(a, b)
        for k in range(int(T / model.opt.timestep)):
            s = (k + 1) * model.opt.timestep / T
            blend = 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5
            data.ctrl[:6] = a + (b - a) * blend
            mujoco.mj_step(model, data)
            peak = np.maximum(peak, np.abs(data.actuator_force[:6]))
            for c in data.contact[:data.ncon]:
                g1, g2 = c.geom1, c.geom2
                if (g1 in static_geoms and model.geom_bodyid[g2] in arm_bodies) or (g2 in static_geoms and model.geom_bodyid[g1] in arm_bodies):
                    collisions.add(model.geom(g1 if g1 in static_geoms else g2).name)
        t += T
    # Settle: time to track the final waypoint is part of the cycle.
    settle = 0.0
    while np.max(np.abs(data.qpos[:6] - home)) > 2e-3 and settle < 1.0:
        mujoco.mj_step(model, data); settle += model.opt.timestep
    cycle = t + settle
    ok = reached and not collisions and cycle <= req["maxCycleSeconds"]
    return {"seed": seed, "jitterMm": [round(float(v) * 1000, 1) for v in jitter], "reached": reached, "ikErrorMm": round(worst * 1000, 3),
            "collisionFree": not collisions, "collisions": sorted(collisions), "cycleSeconds": round(cycle, 3),
            "peakTorqueNm": [round(float(v), 1) for v in peak], "success": ok}, waypoints


started = time.monotonic()
trials, pose = [], None
for seed in seeds:
    trial, waypoints = run_trial(seed)
    trials.append(trial)
    pose = pose if pose is not None else waypoints[2]
    event({"type": "trial", "seed": seed, "success": trial["success"], "cycleSeconds": trial["cycleSeconds"], "collisions": trial["collisions"]})

successes = sum(t["success"] for t in trials)
rate = successes / len(trials)
cycles = [t["cycleSeconds"] for t in trials if t["reached"]]
checks = [
    {"id": "reach", "passed": all(t["reached"] for t in trials), "observed": sum(t["reached"] for t in trials), "required": len(trials), "unit": "seeds",
     "method": "Damped least-squares IK on the MuJoCo Jacobian within joint limits; TCP error ≤ 2 mm at pick and place"},
    {"id": "collision-free", "passed": all(t["collisionFree"] for t in trials), "observed": sum(t["collisionFree"] for t in trials), "required": len(trials), "unit": "seeds",
     "method": "MuJoCo contacts between arm links and guards / conveyor frame / fixture during the simulated motion"},
    {"id": "cycle-time", "passed": bool(cycles) and max(cycles) <= req["maxCycleSeconds"] + 1e-9, "observed": round(max(cycles), 3) if cycles else None,
     "required": req["maxCycleSeconds"], "unit": "s", "method": f"Quintic joint trajectories at {round(cell['speedFraction'] * 100)} % rated joint speed, PD position actuators, 500 Hz dynamics"},
    {"id": "success-rate", "passed": rate + 1e-12 >= req["minSuccessRate"], "observed": round(rate, 4), "required": req["minSuccessRate"], "unit": "fraction",
     "method": "Seeded pick-pose jitter; success = reached ∧ collision-free ∧ cycle within limit"},
]


def write_glb(path: Path, q):
    """Workcell at the pick pose: one named node per MuJoCo geom (oriented box hull), coloured by role."""
    data.qpos[:6] = q
    mujoco.mj_kinematics(model, data)
    MATS = [{"name": "Arm", "pbrMetallicRoughness": {"baseColorFactor": [0.95, 0.45, 0.1, 1], "metallicFactor": 0.3, "roughnessFactor": 0.4}},
            {"name": "Equipment", "pbrMetallicRoughness": {"baseColorFactor": [0.55, 0.58, 0.6, 1], "metallicFactor": 0.5, "roughnessFactor": 0.5}},
            {"name": "Guard", "alphaMode": "BLEND", "doubleSided": True, "pbrMetallicRoughness": {"baseColorFactor": [0.95, 0.8, 0.1, 0.22], "metallicFactor": 0, "roughnessFactor": 0.8}}]
    binary, views, accessors, meshes, nodes = b"", [], [], [], []
    for g in range(model.ngeom):
        if model.geom_type[g] == mujoco.mjtGeom.mjGEOM_PLANE:
            continue
        size, t = model.geom_size[g], model.geom_type[g]
        half = {mujoco.mjtGeom.mjGEOM_BOX: size, mujoco.mjtGeom.mjGEOM_CYLINDER: [size[0], size[0], size[1]],
                mujoco.mjtGeom.mjGEOM_CAPSULE: [size[0], size[0], size[1] + size[0]]}.get(t, [size[0]] * 3)
        R, c = data.geom_xmat[g].reshape(3, 3), data.geom_xpos[g]
        verts = []
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    p = c + R @ (np.array([sx, sy, sz]) * half)
                    verts += [float(p[0]), float(p[2]), float(-p[1])]
        idx = []
        for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            idx += [f[0], f[1], f[2], f[0], f[2], f[3]]
        vb, ib = struct.pack(f"<{len(verts)}f", *verts), struct.pack(f"<{len(idx)}H", *idx)
        v = np.array(verts).reshape(-1, 3)
        name = model.geom(g).name or model.body(model.geom_bodyid[g]).name
        role = 0 if model.geom_bodyid[g] in arm_bodies else 2 if name.startswith("guard") else 1
        views += [{"buffer": 0, "byteOffset": len(binary), "byteLength": len(vb)}, {"buffer": 0, "byteOffset": len(binary) + len(vb), "byteLength": len(ib)}]
        binary += vb + ib + b"\0" * (-(len(vb) + len(ib)) % 4)
        accessors += [{"bufferView": len(views) - 2, "componentType": 5126, "count": 8, "type": "VEC3", "min": v.min(0).tolist(), "max": v.max(0).tolist()},
                      {"bufferView": len(views) - 1, "componentType": 5123, "count": len(idx), "type": "SCALAR"}]
        meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": len(accessors) - 2}, "indices": len(accessors) - 1, "material": role}]})
        nodes.append({"mesh": len(meshes) - 1, "name": name})
    gltf = {"asset": {"version": "2.0", "generator": "pai-mujoco"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": meshes,
            "materials": MATS, "buffers": [{"byteLength": len(binary)}], "bufferViews": views, "accessors": accessors}
    js = json.dumps(gltf).encode(); js += b" " * (-len(js) % 4)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(binary)) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(binary), 0x004E4942) + binary)


write_glb(out / "robot.glb", pose)
(out / "stages").mkdir(exist_ok=True)
(out / "stages" / "01-cell.glb").write_bytes((out / "robot.glb").read_bytes())
event({"type": "stage", "index": 1, "id": "cell", "label": "MuJoCo 工作单元：机械臂取料位姿、输送线、工装与围栏",
       "file": "stages/01-cell.glb", "objects": [model.geom(g).name or model.body(model.geom_bodyid[g]).name for g in range(model.ngeom) if model.geom_type[g] != mujoco.mjtGeom.mjGEOM_PLANE][:32]})
result = {"schema": "pai-robot-sim-1", "engine": f"MuJoCo {mujoco.__version__}", "arm": "generic 6-axis, UR5e-class link lengths (public datasheet)", "cell": cell,
          "requirements": req, "seeds": seeds, "trials": trials, "successes": successes, "successRate": round(rate, 4), "checks": checks,
          "seconds": round(time.monotonic() - started, 1), "scope": "rigid-body-simulation", "physicalValidation": False,
          "limits": "Generic arm model and controller; kinematic part attachment; no vendor controller, safety rating or grasp physics"}
(out / "robot.json").write_text(json.dumps(result, indent=2) + "\n")
# Scene-review contract: the same checks, in the shape the workbench's scene lane validates and compares.
(out / "checks.json").write_text(json.dumps({"schema": "pai-robot-cell-checks-1", "engine": result["engine"], "variant": "robot-cell", "cell": cell,
    "checks": checks, "successRate": result["successRate"], "trials": [{k: t[k] for k in ("seed", "success", "reached", "collisionFree", "cycleSeconds")} for t in trials],
    "scope": "rigid-body-simulation", "physicalValidation": False}, indent=2) + "\n")
print(json.dumps({"rate": rate, "checks": [(c["id"], c["passed"], c["observed"]) for c in checks]}), file=sys.stderr)
