"""One OpenFOAM case as a container job (AWS Batch on Fargate). Runs native/cfd_run.sh on a case prepared by cfd_case.py.

    python3 cfd_job.py --bucket B --prefix jobs/<run>/<name>-l<level>/    # S3 mode
    python3 cfd_job.py --local DIR                                       # DIR contains case.tar (tests)

Input  <prefix>case.tar: a case directory written by native/cfd_case.py (dictionaries + body.stl; no scripts are taken
       from the input: run.sh comes from this image).
Output <prefix>coefficient.dat, run.json, log.checkMesh and result.json (sha256 of each, OpenFOAM version, image tag).
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tarfile, time
from pathlib import Path

OUTPUTS = {"coefficient.dat": "postProcessing/forceCoeffs/0/coefficient.dat", "run.json": "run.json", "log.checkMesh": "log.checkMesh"}
p = argparse.ArgumentParser(); p.add_argument("--bucket"); p.add_argument("--prefix"); p.add_argument("--local"); a = p.parse_args()
work = Path(a.local) if a.local else Path("/tmp/job")
work.mkdir(parents=True, exist_ok=True)
s3 = None
if not a.local:
    import boto3
    if not a.bucket or not a.prefix or not a.prefix.startswith("jobs/") or ".." in a.prefix:
        raise SystemExit("bucket and a jobs/ prefix are required")
    s3 = boto3.client("s3")
    s3.download_file(a.bucket, a.prefix + "case.tar", str(work / "case.tar"))
case = work / "case"
shutil.rmtree(case, ignore_errors=True)
with tarfile.open(work / "case.tar") as t:
    for m in t.getmembers():  # only plain files and directories under case/, no links or absolute paths
        if not (m.isfile() or m.isdir()) or m.name.startswith("/") or ".." in Path(m.name).parts:
            raise SystemExit(f"refused tar member {m.name}")
    t.extractall(work, filter="data")
if not (case / "system/controlDict").exists():
    raise SystemExit("case.tar must contain case/system/controlDict")
shutil.copy("/opt/pai/native/cfd_run.sh" if not a.local else Path(__file__).with_name("cfd_run.sh"), case / "run.sh")
started = time.monotonic()
r = subprocess.run(["bash", str(case / "run.sh")], cwd=case, capture_output=True, text=True, env={**os.environ, "PAI_CASE": str(case)})
result = {"schema": "pai-cfd-job-1", "image": os.environ.get("PAI_IMAGE_VERSION", "dev"), "status": "measured" if r.returncode == 0 else "failed",
          "seconds": round(time.monotonic() - started, 1), "nproc": os.cpu_count()}
if r.returncode != 0:
    result["error"] = (r.stdout + r.stderr).strip().splitlines()[-1][:240] if (r.stdout + r.stderr).strip() else str(r.returncode)
files = {}
for name, rel in OUTPUTS.items():
    src = case / rel
    if src.exists():
        shutil.copy(src, work / name); files[name] = hashlib.sha256((work / name).read_bytes()).hexdigest()
result["files"] = files
if (work / "run.json").exists():
    result["openfoam"] = json.loads((work / "run.json").read_text()).get("openfoam")
(work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
if s3:
    import base64
    for n in [*files, "result.json"]:
        body = (work / n).read_bytes()
        s3.put_object(Bucket=a.bucket, Key=a.prefix + n, Body=body, ChecksumSHA256=base64.b64encode(hashlib.sha256(body).digest()).decode())
print(json.dumps({k: result.get(k) for k in ("status", "seconds", "openfoam", "nproc")}))
