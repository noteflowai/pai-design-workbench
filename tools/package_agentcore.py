"""Stage the build context for the AgentCore images (Dockerfile.agentcore) under .state/deploy/agentcore-context.

Only the files the two images need are copied, so the CodeBuild source asset (and its hash = image tag) changes
only when image inputs change. The private executor archive is included from .state/deploy (never from Git).
"""
import hashlib
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = root / ".state/deploy/agentcore-context"
files = ["Dockerfile.agentcore", "agentcore/server.py", "native/cadquery-runtime-requirements.txt", "tools/runtime-pins.json",
         "tools/install_ai_runtime.py", "tools/agentcore-ledger-policy.json",
         *[f"native/{n}" for n in ("cad_bracket.py", "cad_recipe.py", "cad_checks.py", "cad_sweep.py", "cad_code_policy.py",
                                   "cad_lockdown.py", "cad_sandbox.py", "cad_generated.py", "cad_template.py", "cad_template_pillow.py", "cad_bearing.py", "cad_reopen.py")]]
executor = root / ".state/deploy/executor.tar"
pins = json.loads((root / "tools/runtime-pins.json").read_text())
if hashlib.sha256(executor.read_bytes()).hexdigest() != pins["executor"]["archiveSha256"]:
    raise SystemExit("executor archive missing or not the pinned commit; run python3 tools/package_executor.py")
shutil.rmtree(out, ignore_errors=True)
for f in files:
    (out / f).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / f, out / f)
(out / "vendor").mkdir()
shutil.copy2(executor, out / "vendor" / executor.name)
digest = hashlib.sha256()
for p in sorted(out.rglob("*")):
    if p.is_file():
        digest.update(str(p.relative_to(out)).encode()); digest.update(hashlib.sha256(p.read_bytes()).digest())
print(json.dumps({"context": str(out.relative_to(root)), "files": len(files) + 1, "contentSha256": digest.hexdigest()}))
