"""Install the pinned AI runtime: Kiro CLI and the NoteFlow bounded text executor.

Used by the container image build and by the hosted release update, so both run identical pinned
components (tools/runtime-pins.json). Every download is checked against its pinned SHA-256; the
executor comes from a `git archive` tarball whose digest is pinned. Installs nothing global except
the optional --link-dir symlinks. Never reads, writes or prints credentials.

  python3 tools/install_ai_runtime.py --prefix DIR --executor-tar FILE [--link-dir /usr/local/bin]
"""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile
from pathlib import Path

pins = json.loads((Path(__file__).resolve().parent / "runtime-pins.json").read_text())
parser = argparse.ArgumentParser()
parser.add_argument("--prefix", type=Path, required=True)
parser.add_argument("--executor-tar", type=Path, required=True)
parser.add_argument("--link-dir", type=Path)
args = parser.parse_args()
prefix = args.prefix.resolve()
prefix.mkdir(parents=True, exist_ok=True)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

# Kiro CLI, pinned to the version the executor enforces.
arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}[platform.machine().lower()]
kiro = pins["kiro"]
kiro_dir = prefix / f"kiro-{kiro['version']}"
chat = kiro_dir / "kirocli/bin/kiro-cli-chat"
if not chat.exists():
    archive = prefix / f"kiro-{kiro['version']}-{arch}.zip"
    with urllib.request.urlopen(kiro["url"].format(arch=arch), timeout=120) as response, archive.open("wb") as out:
        shutil.copyfileobj(response, out)
    if sha(archive) != kiro["sha256"][arch]:
        archive.unlink()
        raise SystemExit("Kiro archive checksum mismatch; not installing")
    tmp = kiro_dir.with_suffix(".partial")
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            path = Path(member.filename)
            if path.is_absolute() or ".." in path.parts:
                raise SystemExit("Unsafe path in Kiro archive")
            z.extract(member, tmp)
            mode = member.external_attr >> 16
            if mode:
                os.chmod(tmp / member.filename, mode & 0o755)
    tmp.rename(kiro_dir)
    archive.unlink()
version = subprocess.run([str(chat), "--version"], capture_output=True, text=True, check=True, timeout=20).stdout
if kiro["version"] not in version:
    raise SystemExit(f"Unexpected Kiro version: {version.strip()}")

# Executor at the pinned commit.
ex = pins["executor"]
if sha(args.executor_tar) != ex["archiveSha256"]:
    raise SystemExit("Executor archive digest differs from the pinned commit; not installing")
ex_dir = prefix / f"noteflow-text-executor-{ex['commit'][:12]}"
marker = ex_dir / ".pai-installed"
if not marker.exists():
    tmp = ex_dir.with_suffix(".partial")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(mode=0o755)
    with tarfile.open(args.executor_tar) as t:
        t.extractall(tmp, filter="data")
    subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=tmp, check=True)
    subprocess.run(["npm", "run", "build"], cwd=tmp, check=True)
    for name, key in (("acpx", "acpx"), ("@agentclientprotocol/codex-acp", "codexAcp"), ("@agentclientprotocol/claude-agent-acp", "claudeAgentAcp")):
        installed = json.loads((tmp / "node_modules" / name / "package.json").read_text())["version"]
        if installed != ex[key]:
            raise SystemExit(f"{name} {installed} differs from pin {ex[key]}")
    (tmp / ".pai-installed").write_text(ex["commit"] + "\n")
    shutil.rmtree(ex_dir, ignore_errors=True)
    tmp.rename(ex_dir)
entry = ex_dir / ".runtime/compiled/flows/execute.js"
if not entry.exists():
    raise SystemExit("Executor build output missing")
if args.link_dir:
    args.link_dir.mkdir(parents=True, exist_ok=True)
    for name in ("kiro-cli", "kiro-cli-chat"):
        link = args.link_dir / name
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(kiro_dir / "kirocli/bin" / name)
print(json.dumps({"kiro": kiro["version"], "kiroChat": str(chat), "executorRoot": str(ex_dir), "executorEntrypoint": str(entry), "executorCommit": ex["commit"]}))
