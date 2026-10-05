"""Run CAM on AWS Batch (PAISolver CAM job definition): programs from one job, or (--verify) their simulation from
another, separate job; the results come back re-hashed.

    PAI_PHYSICS_PYTHON cam_remote.py --step part.step --dfm dfm.json --output DIR --queue Q --job-definition J \
        --bucket B --region R --run RUN --name NAME [--timeout-seconds 3600]

Uploads part.step and dfm.json under jobs/<run>/<name>-cam/, submits one job (never resubmitted), waits, downloads
result.json and every file it lists, and re-hashes each against result.json and the inputs against what was sent.
Writes the same files as a local cam_part.py run (cam.json, setup*.nc) plus cam-job.json (job id, image, seconds).
Exit codes mirror cam_part.py: 0 programmed, 3 not machinable as designed, anything else a fault for reconciliation.
"""
import argparse, hashlib, json, re, sys, time
from pathlib import Path
import boto3

p = argparse.ArgumentParser()
for k in ("step", "dfm", "output", "queue", "job-definition", "bucket", "region", "run", "name"):
    p.add_argument(f"--{k}", required=True)
p.add_argument("--timeout-seconds", type=float, default=3600)
p.add_argument("--verify", action="store_true", help="simulate the programs in DIR (cam.json + setup*.nc) in a separate job")
a = p.parse_args()
sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", a.run) or not re.fullmatch(r"[a-z]{1,16}", a.name):
    raise SystemExit("run/name must be plain identifiers")
out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
s3, batch = boto3.client("s3", region_name=a.region), boto3.client("batch", region_name=a.region)
prefix = f"jobs/{a.run}/{a.name}-cam/"
def submit(mode, uploads):
    for n, path in uploads.items():
        s3.upload_file(str(path), a.bucket, prefix + n)
    job = batch.submit_job(jobName=f"pai-cam{'v' if mode == 'verify' else ''}-{a.run[:8]}-{a.name[:4]}", jobQueue=a.queue, jobDefinition=a.job_definition,
                           containerOverrides={"command": ["--bucket", a.bucket, "--prefix", prefix, "--mode", mode]}, tags={"pai-run": a.run})
    print("PAI_EVENT " + json.dumps({"type": "job", "mode": mode, "jobId": job["jobId"]}), flush=True)
    return job


if a.verify:
    cam = json.loads((out / "cam.json").read_text())
    uploads = {"part.step": Path(a.step), "cam.json": out / "cam.json", **{s["file"]: out / s["file"] for s in cam["setups"]}}
    sent = {"part.step": sha(a.step), "cam.json": sha(out / "cam.json")}
    job = submit("verify", uploads)
else:
    sent = {"part.step": sha(a.step), "dfm.json": sha(a.dfm)}
    job = submit("generate", {"part.step": Path(a.step), "dfm.json": Path(a.dfm)})
deadline = time.monotonic() + a.timeout_seconds
while True:
    j = batch.describe_jobs(jobs=[job["jobId"]])["jobs"][0]
    if j["status"] in ("SUCCEEDED", "FAILED"):
        break
    if time.monotonic() > deadline:
        print(f"batch job {job['jobId']} still {j['status']} at the deadline; not resubmitted", file=sys.stderr); sys.exit(2)
    time.sleep(10)
if j["status"] != "SUCCEEDED":
    print(f"batch job {job['jobId']}: {j.get('statusReason', 'failed')[:160]}", file=sys.stderr); sys.exit(2)
base = prefix + ("verify/" if a.verify else "")
s3.download_file(a.bucket, base + "result.json", str(out / "cam-job-result.json"))
result = json.loads((out / "cam-job-result.json").read_text())
schema, allowed = ("pai-cam-verify-job-1", r"cam-verify\.json|cam-sim\.png") if a.verify else ("pai-cam-job-1", r"cam\.json|cam\.log|setup[+-][XYZ]\.nc")
if result.get("schema") != schema or result.get("inputs") != sent:
    print("CAM job result does not match the inputs that were sent", file=sys.stderr); sys.exit(2)
for name, digest in result["files"].items():
    if not re.fullmatch(allowed, name):
        print(f"unexpected file {name} in the job result", file=sys.stderr); sys.exit(2)
    s3.download_file(a.bucket, base + name, str(out / name))
    if sha(out / name) != digest:
        print(f"{name} differs from the job's digest", file=sys.stderr); sys.exit(2)
(out / "cam-job-result.json").unlink()
record = out / "cam-job.json"
jobs = json.loads(record.read_text()) if a.verify and record.exists() else {}
jobs["verify" if a.verify else "generate"] = {"jobId": job["jobId"], "image": result.get("image"), "seconds": result.get("seconds"), "nproc": result.get("nproc"), "status": result["status"]}
record.write_text(json.dumps(jobs, indent=2) + "\n")
if a.verify:
    if result["status"] != "verified":
        print(f"CAM verification job failed: {result.get('error', '')}", file=sys.stderr); sys.exit(2)
    print(json.dumps({"jobId": job["jobId"], "seconds": result.get("seconds")})); sys.exit(0)
if result["status"] == "unmachinable":
    print(result.get("error", "not machinable as designed"), file=sys.stderr); sys.exit(3)
if result["status"] != "programmed":
    print(f"CAM job failed: {result.get('error', '')}", file=sys.stderr); sys.exit(2)
print(json.dumps({"jobId": job["jobId"], "seconds": result.get("seconds"), "programs": [n for n in result["files"] if n.endswith(".nc")]}))
