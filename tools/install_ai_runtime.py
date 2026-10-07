"""Install the pinned AI runtime: the NoteFlow bounded text executor and the Kiro CLI it enforces.

Used by the container image builds and by the hosted release update, so all of them run the same components.

Single sources of truth (no versions are repeated here or in the Dockerfiles):
- tools/runtime-pins.json pins only the executor: its commit and the SHA-256 of its `git archive`.
- The executor's own config/engine-pins.json pins the Kiro CLI version and the official archive digests.
- The executor's own package.json and lockfile pin the npm adapters (acpx, Codex ACP, Claude ACP).

Kiro archives are checked against the digest pinned by the executor; the executor archive against runtime-pins.json.
Stable links `<prefix>/executor` and `<prefix>/kiro` point at the installed versions, so image and service
definitions never name a version. Installs nothing global except the optional --link-dir symlinks; never reads,
writes or prints credentials.

  python3 tools/install_ai_runtime.py --prefix DIR --executor-tar FILE [--link-dir /usr/local/bin]
"""
import argparse
import hashlib
import io
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

KIRO_DOWNLOAD = "https://prod.download.cli.kiro.dev/stable/{version}/kirocli-{arch}-linux.zip"
pins = json.loads((Path(__file__).resolve().parent / "runtime-pins.json").read_text())
parser = argparse.ArgumentParser()
parser.add_argument("--prefix", type=Path, required=True)
parser.add_argument("--executor-tar", type=Path, required=True)
parser.add_argument("--link-dir", type=Path)
args = parser.parse_args()
prefix = args.prefix.resolve()
prefix.mkdir(parents=True, exist_ok=True)
sha = lambda data: hashlib.sha256(data).hexdigest()


def relink(link: Path, target: Path):
    tmp = link.with_name(link.name + ".next")
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    tmp.symlink_to(target)
    tmp.replace(link)


# ---------------------------------------------------------------- executor (pinned by commit and archive digest)
ex = pins["executor"]
archive = args.executor_tar.read_bytes()
if sha(archive) != ex["archiveSha256"]:
    raise SystemExit("Executor archive digest differs from the pinned commit; not installing")
with tarfile.open(fileobj=io.BytesIO(archive)) as t:
    engine_pins = json.load(t.extractfile("config/engine-pins.json"))
    npm_pins = json.load(t.extractfile("package.json"))["dependencies"]
ex_dir = prefix / f"noteflow-text-executor-{ex['commit'][:12]}"
if not (ex_dir / ".pai-installed").exists():
    tmp = ex_dir.with_suffix(".partial")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(mode=0o755)
    with tarfile.open(fileobj=io.BytesIO(archive)) as t:
        t.extractall(tmp, filter="data")
    # Tool output goes to stderr so stdout stays a single JSON summary for callers.
    subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=tmp, check=True, stdout=sys.stderr)
    subprocess.run(["npm", "run", "build"], cwd=tmp, check=True, stdout=sys.stderr)
    for name, version in npm_pins.items():
        installed = json.loads((tmp / "node_modules" / name / "package.json").read_text())["version"]
        if installed != version:
            raise SystemExit(f"{name} {installed} differs from the executor's pin {version}")
    (tmp / ".pai-installed").write_text(ex["commit"] + "\n")
    shutil.rmtree(ex_dir, ignore_errors=True)
    tmp.rename(ex_dir)
# The executor's own commit for its pre-exec launch evidence: an archive install has no .git (and must never let git
# walk up into a surrounding repository). Written outside the install marker so existing installs gain it too.
source = ex_dir / ".source-commit"
if not source.exists() or source.read_text().strip() != ex["commit"]:
    source.write_text(ex["commit"] + "\n")
entry = ex_dir / ".runtime/compiled/flows/execute.js"
if not entry.exists():
    raise SystemExit("Executor build output missing")

# ---------------------------------------------------------------- Kiro CLI (version and digests pinned by the executor)
arch = {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}[platform.machine().lower()]
kiro = engine_pins["kiro"]
kiro_dir = prefix / f"kiro-{kiro['version']}"
chat = kiro_dir / "kirocli/bin/kiro-cli-chat"
if not chat.exists():
    zip_path = prefix / f"kiro-{kiro['version']}-{arch}.zip"
    with urllib.request.urlopen(KIRO_DOWNLOAD.format(version=kiro["version"], arch=arch), timeout=120) as response, zip_path.open("wb") as out:
        shutil.copyfileobj(response, out)
    if sha(zip_path.read_bytes()) != kiro["linuxZipSha256"][arch]:
        zip_path.unlink()
        raise SystemExit("Kiro archive checksum mismatch; not installing")
    tmp = kiro_dir.with_suffix(".partial")
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as z:
        for member in z.infolist():
            path = Path(member.filename)
            if path.is_absolute() or ".." in path.parts:
                raise SystemExit("Unsafe path in Kiro archive")
            z.extract(member, tmp)
            mode = member.external_attr >> 16
            if mode:
                os.chmod(tmp / member.filename, mode & 0o755)
    tmp.rename(kiro_dir)
    zip_path.unlink()
version = subprocess.run([str(chat), "--version"], capture_output=True, text=True, check=True, timeout=20).stdout
if kiro["version"] not in version:
    raise SystemExit(f"Unexpected Kiro version: {version.strip()}")

relink(prefix / "executor", ex_dir)
relink(prefix / "kiro", kiro_dir)
if args.link_dir:
    args.link_dir.mkdir(parents=True, exist_ok=True)
    for name in ("kiro-cli", "kiro-cli-chat"):
        relink(args.link_dir / name, prefix / "kiro/kirocli/bin" / name)
print(json.dumps({"kiro": kiro["version"], "kiroChat": str(chat), "executorRoot": str(ex_dir), "executorEntrypoint": str(entry),
                  "executorCommit": ex["commit"], "adapters": npm_pins}))
