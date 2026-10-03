"""One FEA point as a container job (AWS Batch on Fargate, linux/amd64).

    python3 solver_job.py --bucket B --prefix jobs/<run>/<index>/     # S3 mode (Batch)
    python3 solver_job.py --local DIR                                 # same work on a local directory (tests)

Input  <prefix>input.json: { parameters, requirements, structural }; nothing else is accepted (no paths, no code).
Work:  native/cad_point.py (CadQuery B-Rep, checks) then native/fea_bracket.py (Gmsh C3D10 fine mesh + CalculiX),
       exactly the scripts and versions the local optimiser uses.
Output <prefix>point.json, fea.json, part.step and result.json (sha256 of each file, tool versions, image tag).
The caller re-hashes every downloaded file against result.json and checks the tool versions against its own pins.
Exit 0 also for a measured failure (a degenerate geometry is a result); non-zero only if the job itself broke.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CADQUERY = os.environ.get("PAI_CADQUERY_PYTHON", "/opt/cadquery/bin/python")
CCX = os.environ.get("PAI_CCX", "/usr/bin/ccx")
OUTPUTS = ("point.json", "fea.json", "part.step")
ALLOWED_INPUT = {"parameters", "requirements", "structural"}

parser = argparse.ArgumentParser()
parser.add_argument("--bucket")
parser.add_argument("--prefix")
parser.add_argument("--local")
args = parser.parse_args()
work = Path(args.local) if args.local else Path("/tmp/job")
work.mkdir(parents=True, exist_ok=True)
s3 = None
if not args.local:
    import boto3
    if not args.bucket or not args.prefix or not args.prefix.startswith("jobs/") or ".." in args.prefix:
        raise SystemExit("bucket and a jobs/ prefix are required")
    s3 = boto3.client("s3")
    s3.download_file(args.bucket, args.prefix + "input.json", str(work / "input.json"))
spec = json.loads((work / "input.json").read_text())
if set(spec) - ALLOWED_INPUT:
    raise SystemExit(f"unexpected input fields: {sorted(set(spec) - ALLOWED_INPUT)}")
params = {k: float(v) for k, v in spec["parameters"].items() if k in ("thickness", "width", "plateHeight", "pilotBore")}

started = time.monotonic()
result = {"schema": "pai-solver-job-1", "image": os.environ.get("PAI_IMAGE_VERSION", "dev"), "parameters": params}
try:
    (work / "geometry-input.json").write_text(json.dumps({"parameters": params, "requirements": spec["requirements"]}))
    g = subprocess.run([CADQUERY, "-I", "-W", "ignore", str(HERE / "cad_point.py"), "--input", str(work / "geometry-input.json"), "--output", str(work)],
                       capture_output=True, text=True, timeout=600)
    if g.returncode != 0:
        raise RuntimeError("geometry: " + (g.stderr.strip().splitlines() or [str(g.returncode)])[-1][:200])
    geo = json.loads((work / "point.json").read_text())
    s = spec["structural"]
    (work / "fea-input.json").write_text(json.dumps({"step": str(work / "part.step"), "parameters": geo["parameters"], "ccx": CCX, "meshes": "fine-only",
                                                     "requirements": s, "load": {"forceN": s["forceN"], "leverMm": s["leverMm"]}}))
    f = subprocess.run([sys.executable, "-I", str(HERE / "fea_bracket.py"), "--input", str(work / "fea-input.json"), "--output", str(work)],
                       capture_output=True, text=True, timeout=1500)
    if f.returncode != 0:
        raise RuntimeError("fea: " + (f.stderr.strip().splitlines() or [str(f.returncode)])[-1][:200])
    result["status"] = "measured"
except Exception as e:  # noqa: BLE001 — recorded as a measured failure of this point
    result.update({"status": "failed", "error": f"{type(e).__name__}: {str(e)[:240]}"})
import gmsh  # noqa: E402 — versions of exactly what ran
banner = subprocess.run([CCX, "-v"], capture_output=True, text=True, timeout=30)
result["versions"] = {"gmsh": gmsh.__version__, "ccx": next((l.strip() for l in (banner.stdout + banner.stderr).splitlines() if "Version" in l), "unknown"),
                      "cadquery": subprocess.run([CADQUERY, "-I", "-W", "ignore", "-c", "import cadquery; print(cadquery.__version__)"], capture_output=True, text=True).stdout.strip(),
                      "python": sys.version.split()[0]}
result["files"] = {n: hashlib.sha256((work / n).read_bytes()).hexdigest() for n in OUTPUTS if (work / n).exists()}
result["seconds"] = round(time.monotonic() - started, 1)
(work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
if s3:
    for n in [*result["files"], "result.json"]:
        body = (work / n).read_bytes()
        s3.put_object(Bucket=args.bucket, Key=args.prefix + n, Body=body, ChecksumSHA256=__import__("base64").b64encode(hashlib.sha256(body).digest()).decode())
print(json.dumps({k: result[k] for k in ("status", "seconds", "versions")}))
