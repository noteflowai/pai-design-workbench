"""Build and measure one bounded parameter set of the trusted bracket recipe; export its STEP for FEA.

Used by the design optimiser (native/cad_optimize.py) so each optimiser point is the same native geometry and the
same B-Rep checks as a review with those parameters.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import cadquery as cq

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad_checks import measure, versions  # noqa: E402
from cad_recipe import build  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
_, part, zc, built = build(spec["parameters"])
checks, volume, mass, size = measure(part, zc, spec["requirements"])
cq.exporters.export(part, str(out / "part.step"))
(out / "point.json").write_text(json.dumps({**versions(), "parameters": built, "mass": round(mass, 3), "volume": round(volume, 3), "boundingBox": size,
    "checks": [{"id": c["id"], "passed": c["passed"], "observed": c["observed"], "required": c["required"]} for c in checks],
    "seconds": round(time.monotonic() - started, 2)}, indent=2) + "\n")
