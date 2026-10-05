"""CAM program generation as a container job (AWS Batch on Fargate): runs native/cam_part.py from this image.

    python cam_job.py --bucket B --prefix jobs/<run>/<name>-cam/     # S3 mode
    python cam_job.py --local DIR                                     # DIR contains part.step and dfm.json (tests)

Input  <prefix>part.step, <prefix>dfm.json. The shop table and the scripts come from the image, never from the input.
Output <prefix>cam.json, setup<±X|Y|Z>.nc, cam.log and result.json (sha256 of each, image tag, exit code). Exit 3 of
cam_part.py (not machinable as designed) is reported as status "unmachinable"; the job itself still succeeds.
Verification is not done here: the workbench host simulates the returned G-code itself (native/cam_verify.py).
"""
import argparse, base64, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
p = argparse.ArgumentParser(); p.add_argument("--bucket"); p.add_argument("--prefix"); p.add_argument("--local"); a = p.parse_args()
work = Path(a.local) if a.local else Path("/tmp/job")
work.mkdir(parents=True, exist_ok=True)
s3 = None
if not a.local:
    import boto3
    if not a.bucket or not a.prefix or not a.prefix.startswith("jobs/") or ".." in a.prefix:
        raise SystemExit("bucket and a jobs/ prefix are required")
    s3 = boto3.client("s3")
    for n in ("part.step", "dfm.json"):
        s3.download_file(a.bucket, a.prefix + n, str(work / n))
out = work / "out"; out.mkdir(exist_ok=True)
started = time.monotonic()
r = subprocess.run([sys.executable, "-I", str(HERE / "cam_part.py"), "--step", str(work / "part.step"), "--dfm", str(work / "dfm.json"),
                    "--shop", str(HERE / "dfm-shop.json"), "--output", str(out)], capture_output=True, text=True, cwd="/tmp")
(out / "cam.log").write_text(r.stdout + "\n" + r.stderr)
status = {0: "programmed", 3: "unmachinable"}.get(r.returncode, "failed")
files = {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(out.iterdir()) if re.fullmatch(r"cam\.json|cam\.log|setup[+-][XYZ]\.nc", f.name)}
result = {"schema": "pai-cam-job-1", "image": os.environ.get("PAI_IMAGE_VERSION", "dev"), "status": status, "exitCode": r.returncode,
          "seconds": round(time.monotonic() - started, 1), "nproc": os.cpu_count(), "files": files,
          "inputs": {n: hashlib.sha256((work / n).read_bytes()).hexdigest() for n in ("part.step", "dfm.json")},
          **({"error": (r.stderr.strip().splitlines() or [""])[-1][:240]} if r.returncode not in (0,) else {})}
(out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
if s3:
    for n in [*files, "result.json"]:
        body = (out / n).read_bytes()
        s3.put_object(Bucket=a.bucket, Key=a.prefix + n, Body=body, ChecksumSHA256=base64.b64encode(hashlib.sha256(body).digest()).decode())
print(json.dumps({k: result[k] for k in ("status", "seconds", "nproc")}))
