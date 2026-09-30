"""Independently reopen generated .blend and inspect native saved geometry."""
import json
import sys
from pathlib import Path
import bpy
from mathutils import Vector

scene = bpy.context.scene
target = bpy.data.objects["Target"]
floor = bpy.data.objects["Workcell footprint"]
camera = bpy.data.objects["Inspection camera"]
bpy.context.view_layer.update()
hit = scene.ray_cast(bpy.context.evaluated_depsgraph_get(), camera.location,
                     (target.location - camera.location).normalized())
data = {
    "schema": "pai-blender-reopen-1", "version": bpy.app.version_string,
    "objectCount": len(scene.objects), "unitSystem": scene.unit_settings.system,
    "footprintArea": float(floor.dimensions.x * floor.dimensions.y),
    "rayFirstHit": hit[4].name if hit[0] and hit[4] else None,
    "storedScope": scene.get("pai_scope"),
}
Path(sys.argv[sys.argv.index("--") + 1]).write_text(json.dumps(data, indent=2) + "\n")
