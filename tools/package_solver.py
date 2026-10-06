"""Stage the build context of the FEA solver image (Dockerfile.solver) under .state/deploy/solver-context.

Only the image's inputs are copied, so the CodeBuild source asset hash (and therefore the immutable image tag)
changes only when they change.
"""
import hashlib
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = root / ".state/deploy/solver-context"
files = ["Dockerfile.solver", "Dockerfile.cfd", "Dockerfile.cam", "tools/setup_cam.py", "tools/runtime-pins.json", "native/cam-requirements.txt",
         "native/cam_part.py", "native/cam_verify.py", "native/cam_job.py", "native/dfm-shop.json", "native/cadquery-runtime-requirements.txt", "native/solver-requirements.txt", "native/cfd-job-requirements.txt",
         "native/cfd_job.py", "native/cfd_run.sh",
         *[f"native/{n}" for n in ("cad_point.py", "cad_recipe.py", "cad_checks.py", "fea_core.py", "fea_bracket.py", "solver_job.py")]]
shutil.rmtree(out, ignore_errors=True)
digest = hashlib.sha256()
for f in files:
    (out / f).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / f, out / f)
    (out / f).chmod(0o644)
    digest.update(f.encode()); digest.update(hashlib.sha256((root / f).read_bytes()).digest())
print(json.dumps({"context": str(out.relative_to(root)), "files": len(files), "contentSha256": digest.hexdigest()}))
