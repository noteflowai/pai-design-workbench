"""3-axis CAM for a measured part: FreeCAD CAM (via ocp-freecad-cam) plus OpenCAMLib, one G-code program per setup.

    <freecad venv>/bin/python cam_part.py --step part.step --dfm dfm.json --shop dfm-shop.json --output DIR

Reuses, does not re-implement, toolpath generation:
- FreeCAD 1.1 CAM operations through ocp-freecad-cam: Adaptive clearing of the floors, Profile of the outer contour,
  Drill (holes up to the largest shop drill) and Helix (larger bores), grbl post-processor;
- OpenCAMLib BatchDropCutter (the engine behind FreeCAD's 3D Surface op) for a ball-nose raster over sloped faces,
  because the Surface op with selected faces fails on FreeCAD 1.1.4. Drop-cutter points are gouge-free by
  construction; native/cam_verify.py checks that independently anyway.

Setups: +Z shapes the part (floors, slopes, outer profile); every hole is drilled from a direction in its free drill
corridor (dfm.json `access`), preferring setups already in use. Each setup rotates the part so the tool axis is +Z;
G-code zero is the part top at the part's X/Y origin. Writes setup-<dir>.nc and cam.json (frames, tools, operations).
Not a machine-specific program: no work holding, tabs or tool-length offsets; a CAM engineer reviews before cutting.
"""
import argparse, hashlib, json, math, re, sys, time
from pathlib import Path
import cadquery as cq
from ocp_freecad_cam import Job, Endmill, Drill
from ocp_freecad_cam.fc_impl import Stock
import opencamlib as ocl

p = argparse.ArgumentParser()
for k in ("step", "dfm", "shop", "output"):
    p.add_argument(f"--{k}", required=True)
a = p.parse_args()
t0 = time.time()
shop, dfm = json.loads(Path(a.shop).read_text()), json.loads(Path(a.dfm).read_text())
cam = shop["cam"]
out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
part = cq.importers.importStep(a.step).val()
# Rotation taking each setup's tool direction to +Z (about X for ±Y/±Z, about Y for ±X).
ROT = {"+Z": ((1, 0, 0), 0), "-Z": ((1, 0, 0), 180), "+Y": ((1, 0, 0), 90), "-Y": ((1, 0, 0), -90), "+X": ((0, 1, 0), -90), "-X": ((0, 1, 0), 90)}


def rotated(shape, setup):
    """The part in the setup frame: the setup's tool approach direction (from outside towards the part) becomes -Z,
    i.e. the side named by the setup faces +Z, up to the spindle."""
    axis, deg = ROT[setup]
    return shape.rotate(cq.Vector(0, 0, 0), cq.Vector(*axis), deg) if deg else shape


def em(spec):
    return Endmill(diameter=spec["diameterMm"], h_feed=spec["feedMmMin"], v_feed=spec["plungeMmMin"], speed=spec["rpm"])


# Assign holes to setups: +Z always (shaping); each hole from a free side, preferring setups already chosen.
holes = [h for h in dfm["holes"] if h["axis"] != "oblique"]
setups = ["+Z"]
for h in sorted(holes, key=lambda h: len(h["access"])):
    if not h["access"]:
        print(f"hole Ø{h['diameterMm']} has no free drill corridor; no program can make it", file=sys.stderr)
        raise SystemExit(3)  # not machinable as designed (a finding, not a tool fault)
    if not any(s in setups for s in h["access"]):
        setups.append(h["access"][0])
for h in holes:
    h["setup"] = next(s for s in setups if s in h["access"])

report = {"schema": "pai-cam-1", "post": "grbl", "units": "mm", "setups": [], "tools": cam, "physicalValidation": False}
for setup in setups:
    body = rotated(part, setup)
    bb = body.BoundingBox(); ztop = bb.zmax
    wp, top = cq.Workplane().add(body), cq.Workplane().workplane(offset=ztop)
    al = shop["stockAllowanceMm"]
    job = Job(top, wp, "grbl", stock=Stock(xn=al, xp=al, yn=al, yp=al, zn=0, zp=al), clearance_height_offset="5 mm", safe_height_offset="3 mm")
    ops, raster = [], None
    if setup == "+Z":
        floors = [f for f in body.Faces() if f.geomType() == "PLANE" and f.normalAt().z > 0.999 and f.Center().z < ztop - 1e-3]
        bottom = [f for f in body.Faces() if f.geomType() == "PLANE" and f.normalAt().z < -0.999 and abs(f.Center().z - bb.zmin) < 1e-3]
        slopes = [f for f in body.Faces() if f.geomType() == "PLANE" and 0.01 < f.normalAt().z < 0.999]
        e = cam["endmill"]
        # Z-level roughing: one FreeCAD Adaptive clearing per step-down layer. Each layer's region is the stock outline
        # minus the part's cross-section just above that layer, so open edges are cleared to the stock boundary and
        # slopes are left as stairs no higher than one step for the ball-nose finish.
        al, step, rough = shop["stockAllowanceMm"], e["stepDownMm"], e["roughStepDownMm"]
        floor_z = min(f.Center().z for f in floors) if floors else bb.zmin
        # High-efficiency roughing (axial roughStepDownMm, small step-over, adaptiveFeedMmMin); fine layers only over the
        # height of the sloped faces, so the ball-nose finish never meets a stair higher than one fine step.
        sz = [v for f in slopes for v in (f.BoundingBox().zmin, f.BoundingBox().zmax)]
        levels, zk = [], ztop
        while zk > floor_z + 1e-6:
            levels.append(zk)
            zk -= step if sz and min(sz) - 1e-6 <= zk - step <= max(sz) + step else rough
        levels.append(floor_z)
        rect = (bb.xmin - al, bb.xmax + al, bb.ymin - al, bb.ymax + al)
        previous = ztop + al
        # Silhouette of all material above the layer (not just the cross-section): a hole across the tool axis, like the
        # pilot bore seen from +Z, must not open a gap that the tool would drive through under the material above it.
        def section(h):
            """Cross-section of the part in a 0.02 mm slab starting at height h, flattened to z = 0."""
            slab = cq.Solid.makeBox(rect[1] - rect[0] + 2, rect[3] - rect[2] + 2, 0.02, cq.Vector(rect[0] - 1, rect[2] - 1, h))
            sec = body.intersect(slab)
            return [f.translate(cq.Vector(0, 0, -f.Center().z)) for f in sec.Faces() if f.geomType() == "PLANE" and f.normalAt().z < -0.999] if sec.Volume() > 1e-9 else []
        planes = sorted({round(f.Center().z, 6) for f in body.Faces() if f.geomType() == "PLANE" and abs(f.normalAt().z) > 0.999})
        above, upper = [], ztop + al
        for zk in levels:
            # sample every planar level in (zk, upper] just below it, and the layer itself just above it
            for h in [c - 0.03 for c in planes if zk + 0.04 < c <= upper + 1e-9] + [zk + 0.01]:
                above += section(h)
            upper = zk
            islands = above
            region = cq.Workplane().center((rect[0] + rect[1]) / 2, (rect[2] + rect[3]) / 2).rect(rect[1] - rect[0], rect[3] - rect[2]).extrude(-0.01).faces(">Z").val()
            for isl in islands:
                region = region.cut(isl)
            region = region.translate(cq.Vector(0, 0, zk))
            faces = region.Faces() if hasattr(region, "Faces") else [region]
            faces = [f for f in faces if f.Area() > 1.0]
            if faces and previous - zk > 1e-6:
                job = job.adaptive(faces, tool=Endmill(diameter=e["diameterMm"], h_feed=e["adaptiveFeedMmMin"], v_feed=e["plungeMmMin"], speed=e["rpm"]),
                                   step_over=e["adaptiveStepOverPercent"], start_depth=previous - ztop, final_depth=zk - ztop, step_down=previous - zk, keep_tool_down_ratio=f"{e['diameterMm']} mm", stock_to_leave=f"{e['roughStockMm']} mm",
                                   tolerance=0.02, finishing_profile=False)
                ops.append({"op": "AdaptiveOp", "tool": "endmill", "what": f"layer {zk - ztop:.2f} mm ({len(islands)} islands)"})
            previous = zk
        # Finish the walls left by roughing: a profile around the part's cross-section just above the floor, top to floor.
        slab = cq.Solid.makeBox(rect[1] - rect[0] + 2, rect[3] - rect[2] + 2, 0.02, cq.Vector(rect[0] - 1, rect[2] - 1, floor_z + 0.01))
        walls = [f for f in body.intersect(slab).Faces() if f.geomType() == "PLANE" and f.normalAt().z < -0.999]
        if walls:
            job = job.profile([w.translate(cq.Vector(0, 0, -0.01)) for w in walls], tool=em(e), side="out", holes=False, step_down=step,
                              start_depth=al, final_depth=floor_z - ztop)
            ops.append({"op": "ProfileOp", "tool": "endmill", "what": f"finish walls of {len(walls)} raised regions"})
        # Z-level wall finishing over the height of the slopes: the floor footprint is wider than the part higher up,
        # so a contour of each level's own cross-section (every finishStepMm) lets the end mill follow the walls where the
        # sloped features narrow; the ball nose cannot reach those wall corners.
        if sz:
            zf = max(sz) - e["finishStepMm"]
            def silhouette(z):
                """Union of the part's cross-sections at z and at every planar level above it, flattened to z = 0."""
                faces = [f for h in [c - 0.03 for c in planes if c > z + 0.04] + [z + 0.01] for f in section(h)]
                if not faces:
                    return []
                solid = cq.Workplane().add(cq.Solid.extrudeLinear(faces[0], cq.Vector(0, 0, 0.01)))
                for f in faces[1:]:
                    solid = solid.union(cq.Workplane().add(cq.Solid.extrudeLinear(f, cq.Vector(0, 0, 0.01))))
                return [f for f in solid.val().Faces() if f.geomType() == "PLANE" and f.normalAt().z < -0.999]
            while zf > min(sz) + 1e-6:
                sec = silhouette(zf)
                if sec:
                    job = job.profile([f.translate(cq.Vector(0, 0, zf)) for f in sec], tool=em(e), side="out", holes=False,
                                      start_depth=zf - ztop + 0.001, final_depth=zf - ztop, step_down=1)
                zf -= e["finishStepMm"]
            ops.append({"op": "ProfileOp", "tool": "endmill", "what": f"z-level wall finish every {e['finishStepMm']} mm over the slopes"})
        if slopes:
            ops.append({"op": "Raster3D", "tool": "ballnose", "what": f"finish {len(slopes)} sloped faces (OpenCAMLib drop-cutter)"})
            raster = slopes
        job = job.profile(bottom, tool=em(e), step_down=e["stepDownMm"])
        ops.append({"op": "ProfileOp", "tool": "endmill", "what": "outer contour through"})
    # Holes along this setup's tool axis: drills by diameter, larger bores by helix.
    drills = sorted({h["diameterMm"] for h in holes if h["setup"] == setup and h["diameterMm"] <= cam["maxDrillMm"]})
    bores = [h for h in holes if h["setup"] == setup and h["diameterMm"] > cam["maxDrillMm"]]
    def circles(diameter):
        """Circular hole edges on the entry (top) side in this frame, for holes of that diameter along the tool axis."""
        found = []
        for e in body.Edges():
            if e.geomType() != "CIRCLE" or abs(2 * e.radius() - diameter) > 0.05:
                continue
            n = e.normal()
            if abs(abs(n.z) - 1) > 1e-3:
                continue
            c = e.Center()
            # keep the lower edge of each hole (FreeCAD drills/helixes to the edge's depth), one per axis position
            if not any(abs(c.x - q.Center().x) < 1e-3 and abs(c.y - q.Center().y) < 1e-3 for q in found):
                found.append(min((x for x in body.Edges() if x.geomType() == "CIRCLE" and abs(2 * x.radius() - diameter) < 0.05
                                  and abs(x.Center().x - c.x) < 1e-3 and abs(x.Center().y - c.y) < 1e-3), key=lambda x: x.Center().z))
        return found
    for d in drills:
        edges = circles(d)
        spec = next(x for x in cam["drills"] if abs(x["diameterMm"] - d) < 0.05)
        job = job.drill(edges, Drill(diameter=f"{d} mm", v_feed=spec["feedMmMin"], speed=spec["rpm"]), peck_depth=spec["peckMm"], extra_offset="1x")
        ops.append({"op": "DrillOp", "tool": f"drill-{d}", "what": f"{len(edges)} × Ø{d}"})
    if bores:
        for d in sorted({h["diameterMm"] for h in bores}):
            edges = circles(d)
            job = job.helix(edges, tool=em(cam["endmill"]), step_over=40)
            ops.append({"op": "HelixOp", "tool": "endmill", "what": f"{len(edges)} × Ø{d} bore"})
    gcode = job.to_gcode()
    if raster:
        # Ball-nose raster over the slopes' footprint (X lines, step from the shop's scallop target), inserted before the
        # outer profile so the part is still held by its stock.
        b = cam["ballnose"]; r = b["diameterMm"] / 2
        stl = out / f"setup{setup}.stl"
        cq.exporters.export(cq.Workplane().add(body.translate(cq.Vector(0, 0, -ztop))), str(stl), tolerance=0.005, angularTolerance=0.05)
        surf = ocl.STLSurf(); ocl.STLReader(str(stl), surf); stl.unlink()
        # One raster per sloped face, over its footprint plus the tool radius. AdaptivePathDropCutter subdivides each
        # row where the surface turns, so a straight G1 between two samples never cuts through a wall or an edge.
        # Step-over measured along the surface: rows advance in Y, so on a face tilted by its normal's Y component the
        # surface spacing grows by 1/|n_z|; shrink the Y step accordingly (steepest sloped face).
        nz = min(abs(f.normalAt().z) for f in raster)
        step = 2 * math.sqrt(r * r - (r - b["scallopMm"]) ** 2) * nz
        cutter = ocl.BallCutter(b["diameterMm"], b["lengthMm"])
        rows = []
        for f in raster:
            fb = f.BoundingBox(); y = fb.ymin - r
            while y <= fb.ymax + r + 1e-9:
                apdc = ocl.AdaptivePathDropCutter(); apdc.setSTL(surf); apdc.setCutter(cutter)
                apdc.setSampling(b["sampleMm"]); apdc.setMinSampling(0.01)
                path = ocl.Path(); path.append(ocl.Line(ocl.Point(fb.xmin - r, y, -1000), ocl.Point(fb.xmax + r, y, -1000)))
                apdc.setPath(path); apdc.run()
                rows.append(list(apdc.getCLPoints())); y += step
        safe = shop["stockAllowanceMm"] + 5
        lines = ["(Begin operation: Raster3D)", f"(Ball-nose raster, OpenCAMLib {ocl.version() if hasattr(ocl, 'version') else ''}; step {step:.3f} mm)",
                 f"S{b['rpm']} M3", f"G0 Z{safe:.3f}"]
        for k, row in enumerate(rows):
            if k % 2:
                row = row[::-1]
            lines.append(f"G0 X{row[0].x:.3f} Y{row[0].y:.3f}")
            lines.append(f"G1 Z{row[0].z:.3f} F{b['plungeMmMin']:.1f}")
            lines += [f"G1 X{q.x:.3f} Y{q.y:.3f} Z{q.z:.3f} F{b['feedMmMin']:.1f}" for q in row[1:]]
            lines.append(f"G0 Z{safe:.3f}")
        lines.append("(Finish operation: Raster3D)")
        at = gcode.find("(Begin operation: ProfileOp")
        gcode = gcode[:at] + "\n".join(lines) + "\n" + gcode[at:]
    # Safety post-process: a rapid with XY travel below the stock top (part top + allowance in this frame) becomes a
    # feed move at the current operation's feed, so a short "keep tool down" link can never rapid through stock that
    # is left. The guard is the stock top, not the part top: the first Adaptive layer (z = 0) faces the allowance and
    # its links at z = 0 cross uncut stock depending on path order, which floating point varies between CPUs (seen in
    # CI as a rapid collision that did not reproduce locally).
    guard = shop["stockAllowanceMm"]
    fixed, z, feed, converted = [], None, None, 0
    for line in gcode.splitlines():
        words = dict(re.findall(r"([XYZF])(-?\d*\.?\d+)", line))
        if line.startswith("G1") and "F" in words:
            feed = words["F"]
        if line.startswith("G0 ") and ("X" in words or "Y" in words):
            zn = float(words.get("Z", z if z is not None else 1e9))
            if z is not None and min(z, zn) < guard - 1e-6 and feed:
                line = "G1" + line[2:] + f" F{feed}"; converted += 1
        if "Z" in words and line[:2] in ("G0", "G1", "G2", "G3"):
            z = float(words["Z"])
        fixed.append(line)
    gcode = "\n".join(fixed) + "\n"
    nc = out / f"setup{setup}.nc"
    nc.write_text(gcode)
    report["setups"].append({"setup": setup, "rotation": {"axis": ROT[setup][0], "degrees": ROT[setup][1]}, "zTop": round(ztop, 6),
                             "file": nc.name, "rapidsBelowTopConverted": converted, "sha256": hashlib.sha256(gcode.encode()).hexdigest(), "operations": ops, "lines": len(gcode.splitlines())})
report["holes"] = [{"diameterMm": h["diameterMm"], "axis": h["axis"], "setup": h["setup"]} for h in holes]
report["seconds"] = round(time.time() - t0, 1)
(out / "cam.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"setups": [s["setup"] for s in report["setups"]], "lines": [s["lines"] for s in report["setups"]], "seconds": report["seconds"]}))
