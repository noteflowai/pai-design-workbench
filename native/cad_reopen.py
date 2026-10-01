"""Independently re-import a saved STEP file and report native B-Rep properties."""
import json
import sys
from pathlib import Path

import cadquery as cq

source, target = sys.argv[1], sys.argv[2]
shape = cq.importers.importStep(source).val()
bb = shape.BoundingBox()
cylinders = [f for f in shape.Faces() if f.geomType() == "CYLINDER"]
Path(target).write_text(json.dumps({
    "schema": "pai-cad-reopen-1", "cadquery": cq.__version__, "valid": shape.isValid(), "solids": len(shape.Solids()),
    "volume": round(shape.Volume(), 3), "boundingBox": [round(bb.xlen, 3), round(bb.ylen, 3), round(bb.zlen, 3)],
    "cylindricalFaces": len(cylinders), "holeDiameters": sorted({round(2 * f._geomAdaptor().Cylinder().Radius(), 3) for f in cylinders}),
}, indent=2) + "\n")
