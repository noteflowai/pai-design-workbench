"""Cross-check the robot cell's arm against the official model that Strands Robots loads (simulation only).

Strands Robots (strands-labs/robots, Apache-2.0) resolves the robot by name from its registry and loads the upstream
MuJoCo Menagerie model from a pinned, offline cache; this script exports the exact MJCF it loaded and compares it with
the MJCF the workbench simulated: joint count and limits, forward kinematics of the wrist flange over seeded random
configurations, reach, and link mass. It is a conformance record (like the Newton check), never a design verdict.

Safety: `mode="real"`, the Zenoh mesh and remote code are refused; the cache must be the pinned commit and the process
runs with network access to the asset hosts disabled by configuration (no clone, no fetch).

Usage: robots_crosscheck.py --mjcf scene.xml --robot ur5e --assets <cache> --commit <sha> --output robots.json
"""
from __future__ import annotations
import argparse, hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path

JOINTS_OURS = [f"j{i}" for i in range(1, 7)]
JOINTS_UR = ["shoulder_pan_joint", "shoulder_lift_joint", "elbow_joint", "wrist_1_joint", "wrist_2_joint", "wrist_3_joint"]
TOL_FK_M, TOL_REACH_M, TOL_MASS_REL = 0.010, 0.010, 0.15


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mjcf", required=True); ap.add_argument("--robot", default="ur5e"); ap.add_argument("--assets", required=True)
    ap.add_argument("--commit", required=True); ap.add_argument("--output", required=True); ap.add_argument("--configurations", type=int, default=200)
    a = ap.parse_args()
    assets = Path(a.assets).resolve()
    def head() -> str:
        r = subprocess.run(["git", "-C", str(assets / "mujoco_menagerie"), "rev-parse", "HEAD"], capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else ""
    if head() != a.commit:
        raise SystemExit("Menagerie cache is not at the pinned commit")
    os.environ["ROBOT_DESCRIPTIONS_CACHE"] = str(assets)
    os.environ.setdefault("MUJOCO_GL", "egl")
    # Never join the Zenoh mesh, whatever the caller's environment says.
    os.environ["STRANDS_MESH"] = "false"
    os.environ.pop("STRANDS_MESH_LOCAL_DEV", None)
    import mujoco, numpy as np
    import strands_robots
    from strands_robots import Robot
    from strands_robots.registry.robots import get_robot

    entry = get_robot(a.robot)
    if not entry or entry.get("category") != "arm":
        raise SystemExit(f"{a.robot} is not an arm in the Strands Robots registry")
    engine = Robot(a.robot, mode="sim", mesh=False)
    with tempfile.TemporaryDirectory() as tmp:
        exported = Path(tmp) / "official.xml"
        engine.export_xml(output_path=str(exported))
        xml = exported.read_text()
        official = mujoco.MjModel.from_xml_string(xml)
    if head() != a.commit:  # loading must not have moved the cache to another revision
        raise SystemExit("Menagerie cache moved while loading the official model")
    ours = mujoco.MjModel.from_xml_path(a.mjcf)
    prefix = next((official.joint(j).name.split("/")[0] + "/" for j in range(official.njnt) if "/" in official.joint(j).name), "")
    ur = [prefix + n for n in JOINTS_UR]
    od, md = mujoco.MjData(ours), mujoco.MjData(official)
    oq = [ours.jnt_qposadr[ours.joint(n).id] for n in JOINTS_OURS]
    mq = [official.jnt_qposadr[official.joint(n).id] for n in ur]

    def flange(m, d, base, tip):
        r = d.xmat[m.body(base).id].reshape(3, 3)
        return r.T @ (d.xpos[m.body(tip).id] - d.xpos[m.body(base).id])

    rng = np.random.default_rng(20261010)
    P, Q = [], []
    for _ in range(a.configurations):
        q = rng.uniform(-np.pi, np.pi, 6)
        od.qpos[:] = 0; md.qpos[:] = 0; od.qpos[oq] = q; md.qpos[mq] = q
        mujoco.mj_kinematics(ours, od); mujoco.mj_kinematics(official, md)
        P.append(flange(ours, od, "base", "w3")); Q.append(flange(official, md, prefix + "base", prefix + "wrist_3_link"))
    P, Q = np.array(P), np.array(Q)
    fk = float(np.linalg.norm(P - Q, axis=1).max())
    reach = (float(np.linalg.norm(P, axis=1).max()), float(np.linalg.norm(Q, axis=1).max()))
    link = lambda m, names: float(sum(m.body_mass[m.body(n).id] for n in names))
    mass = (link(ours, ["shoulder", "upper", "fore", "w1", "w2", "w3"]),
            link(official, [prefix + n for n in ["shoulder_link", "upper_arm_link", "forearm_link", "wrist_1_link", "wrist_2_link", "wrist_3_link"]]))
    lim = lambda m, names: np.round(m.jnt_range[[m.joint(n).id for n in names]], 4).tolist()
    checks = [
        {"id": "joints", "observed": [len(JOINTS_OURS), sum(1 for j in range(official.njnt) if official.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE)], "passed": True},
        {"id": "joint-limits", "observed": {"cell": lim(ours, JOINTS_OURS), "official": lim(official, ur)}, "limit": 1e-3, "unit": "rad",
         "passed": bool(np.abs(np.array(lim(ours, JOINTS_OURS)) - np.array(lim(official, ur))).max() <= 1e-3)},
        {"id": "fk-flange", "observed": round(fk, 5), "limit": TOL_FK_M, "unit": "m", "passed": fk <= TOL_FK_M},
        {"id": "reach", "observed": [round(reach[0], 4), round(reach[1], 4)], "limit": TOL_REACH_M, "unit": "m", "passed": abs(reach[0] - reach[1]) <= TOL_REACH_M},
        {"id": "link-mass", "observed": [round(mass[0], 2), round(mass[1], 2)], "limit": TOL_MASS_REL, "unit": "kg", "passed": abs(mass[0] - mass[1]) <= TOL_MASS_REL * mass[1]},
    ]
    checks[0]["passed"] = checks[0]["observed"][0] == checks[0]["observed"][1]
    report = {"schema": "pai-robots-crosscheck-1", "robot": a.robot, "registry": entry.get("description"), "strandsRobots": strands_robots.__version__ if hasattr(strands_robots, "__version__") else None,
              "mujoco": mujoco.__version__, "menagerieCommit": a.commit, "officialSha256": hashlib.sha256(xml.encode()).hexdigest(),
              "configurations": a.configurations, "mode": "sim", "checks": checks, "passed": all(c["passed"] for c in checks),
              "scope": "conformance of the simulated arm with the official model; not a design check, not hardware"}
    Path(a.output).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("robot", "passed", "menagerieCommit")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
