"""AgentCore Runtime entrypoint for PAI (HTTP contract: GET /ping, POST /invocations on 0.0.0.0:8080).

One image role per runtime (PAI_ROLE):

  sandbox  Untrusted CadQuery code and native CAD jobs. No credentials, no network route (isolated VPC subnet).
           Each job must use a fresh runtimeSessionId, i.e. a fresh microVM; a session that has run code refuses
           further jobs. Inside the VM the AST policy and process lockdown always apply; bubblewrap is added when
           the kernel allows user namespaces. Every response states which layers were actually active.
  agent    The bounded NoteFlow executor with Kiro (primary -> backup -> backup2). Keys come from Secrets
           Manager per invocation; the attempt-only ledger and run receipts live on a shared EFS volume, so a
           new session or a runtime version update never resets accounting. Text proposals only.

Standard library only. Never logs request bodies, prompts, answers or credentials.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROLE = os.environ.get("PAI_ROLE", "")
NATIVE = Path(os.environ.get("PAI_NATIVE", "/opt/pai/native"))
PYTHON = os.environ.get("PAI_CADQUERY_PYTHON", "/opt/cadquery/bin/python")
LEDGER_DIR = Path(os.environ.get("PAI_LEDGER_DIR", "/mnt/ledger"))
# Resolved: /opt/ai/executor is a stable link to the versioned install, and the executor's entry-point guard compares
# its real module path with argv[1] (a link path would make it exit 0 without running).
EXECUTOR = Path(os.environ.get("PAI_CONTROL_ROOT", "/opt/ai/executor")).resolve()
POLICY = Path(os.environ.get("PAI_LEDGER_POLICY", "/opt/pai/agentcore-ledger-policy.json"))
PROFILES = [p for p in os.environ.get("PAI_AI_PROFILES", "kiro-primary,kiro-backup,kiro-backup2").split(",") if p]
VERSION = os.environ.get("PAI_IMAGE_VERSION", "dev")
# Set only by the AgentCore runtime definition (infra/agentcore.ts); local runs never claim a VM boundary.
IN_AGENTCORE = os.environ.get("PAI_AGENTCORE") == "1"
CAD_FILES = ("part.step", "part.stl", "part.glb", "assembly.glb", "drawing.svg", "checks.json")
REQ_KEYS = {"maxMassG", "minWallMm", "edgeDistanceFactor", "requireNoInterference", "maxEnvelopeMm"}
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

state = {"busy": False, "changed": int(time.time()), "jobs": 0}
lock = threading.Lock()


class Refused(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(argv, timeout, env=None, cwd=None):
    started = time.time()
    try:
        r = subprocess.run(argv, capture_output=True, timeout=timeout, env=env, cwd=cwd)
        return {"exit": r.returncode, "stdout": r.stdout.decode(errors="replace"), "stderr": r.stderr.decode(errors="replace")[-4000:],
                "seconds": round(time.time() - started, 2), "timedOut": False}
    except subprocess.TimeoutExpired:
        return {"exit": None, "stdout": "", "stderr": "", "seconds": round(time.time() - started, 2), "timedOut": True}


def requirements(value):
    if not isinstance(value, dict) or set(value) != REQ_KEYS:
        raise Refused(400, "INVALID_INPUT", "requirements must have exactly " + ", ".join(sorted(REQ_KEYS)))
    return value


# ---------------------------------------------------------------- sandbox role

def can_connect(host, port, timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


_bwrap = None


def bwrap_works():
    """Real probe: start the pinned interpreter in the full bubblewrap profile and require an isolated result."""
    global _bwrap
    if _bwrap is None:
        if not shutil.which("bwrap"):
            _bwrap = (False, "bubblewrap not installed")
        else:
            script = "import socket\ntry:\n socket.create_connection(('1.1.1.1',53),timeout=2); print('net')\nexcept OSError: print('isolated')"
            r = run(bwrap_argv([], [], [PYTHON, "-I", "-c", script]), 30)
            ok = r["exit"] == 0 and r["stdout"].strip() == "isolated"
            _bwrap = (ok, None if ok else (r["stderr"].strip().splitlines() or [f"exit {r['exit']}"])[-1][:200])
    return _bwrap


def bwrap_argv(read_only, writable, argv):
    venv = os.path.dirname(os.path.dirname(os.path.abspath(PYTHON)))  # venv python is a symlink; do not resolve
    hide = [p for p in ("/tmp", "/var/tmp", "/home", "/root", "/run", "/mnt", "/srv", "/var/lib", "/opt/pai/agentcore") if os.path.isdir(p)]
    args = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
            "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8",
            "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev"]
    for p in hide:
        args += ["--tmpfs", p]
    for p in [venv, str(NATIVE), *read_only]:
        args += ["--ro-bind", p, p]
    for p in writable:
        args += ["--bind", p, p]
    return args + ["--", *argv]


def isolation_report():
    ok, reason = bwrap_works()
    return {
        "microvm": IN_AGENTCORE,
        "network": {"internet": can_connect("1.1.1.1", 443), "dns": _resolves("amazon.com"),
                    "note": "isolated VPC subnet: no NAT, no internet gateway; only ECR/logs endpoints"},
        "bubblewrap": {"active": ok, "reason": reason},
        "astPolicy": True, "processLockdown": True, "credentials": "none in this runtime",
        "uid": os.getuid(), "arch": os.uname().machine, "kernel": os.uname().release,
    }


def _resolves(host):
    try:
        socket.getaddrinfo(host, 443)
        return True
    except OSError:
        return False


def sandboxed(argv, read_only, writable, timeout):
    """Run a native CAD process with bubblewrap when it works; otherwise directly (VM + policy + lockdown still apply)."""
    ok, _ = bwrap_works()
    if ok:
        return run(bwrap_argv(read_only, writable, argv), timeout), "bubblewrap"
    env = {"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
    return run(argv, timeout, env=env), "direct"


def collect(directory, names):
    out = {}
    for name in names:
        p = directory / name
        if p.exists():
            data = p.read_bytes()
            out[name] = {"sha256": sha(data), "bytes": len(data), "base64": base64.b64encode(data).decode()}
    return out


def one_job_per_session():
    with lock:
        if state["jobs"] >= 1:
            raise Refused(409, "SESSION_ALREADY_USED", "This sandbox session already ran a job; invoke with a new runtimeSessionId (fresh microVM)")
        state["jobs"] += 1


def op_cad_code(body):
    code = body.get("code")
    if not isinstance(code, str) or not 40 <= len(code) <= 20_000:
        raise Refused(400, "INVALID_INPUT", "code must be a CadQuery program of 40–20000 characters")
    req = requirements(body.get("requirements"))
    one_job_per_session()
    work = Path(tempfile.mkdtemp(prefix="pai-job-"))
    try:
        src, out = work / "src", work / "out"
        src.mkdir(); out.mkdir()
        (work / "code.py").write_text(code)
        policy = run([PYTHON, "-I", str(NATIVE / "cad_code_policy.py"), str(work / "code.py")], 15)
        verdict = json.loads(policy["stdout"].strip().splitlines()[-1]) if policy["exit"] == 0 else {"ok": False, "violations": ["policy checker failed"]}
        layers = {"astPolicy": True, "processLockdown": True, "bubblewrap": False, "microvm": IN_AGENTCORE}
        if not verdict["ok"]:
            return {"status": "policy", "violations": verdict["violations"], "layers": layers, "codeSha256": sha(code.encode())}
        r, mode = sandboxed([PYTHON, "-I", "-W", "ignore", str(NATIVE / "cad_sandbox.py"), "--code", str(work / "code.py"), "--output", str(src), "--cpu-seconds", "60"],
                            [str(work / "code.py")], [str(src)], 120)
        layers["bubblewrap"] = mode == "bubblewrap"
        outcome = json.loads((src / "result.json").read_text()) if (src / "result.json").exists() else {"status": "limit", "message": "stopped before reporting"}
        if r["exit"] != 0 or outcome.get("status") != "ok":
            return {"status": outcome.get("status", "error"), "error": outcome.get("message") or ";".join(outcome.get("violations", [])), "type": outcome.get("type"),
                    "layers": layers, "codeSha256": sha(code.encode()), "seconds": r["seconds"]}
        (work / "in.json").write_text(json.dumps({"requirements": req, "codeSha256": sha(code.encode())}))
        m, _ = sandboxed([PYTHON, "-I", "-W", "ignore", str(NATIVE / "cad_generated.py"), "--input", str(work / "in.json"), "--source", str(src), "--output", str(out)],
                         [str(work / "in.json"), str(src)], [str(out)], 300)
        if m["exit"] != 0:
            return {"status": "error", "error": "measurement failed", "layers": layers, "codeSha256": sha(code.encode())}
        files = collect(out, CAD_FILES)
        files.update({f"stages/{p.name}": v for p in sorted((out / "stages").glob("*.glb")) for v in [collect(out / "stages", [p.name])[p.name]]})
        brep = (src / "generated.brep").read_bytes()
        return {"status": "ok", "layers": layers, "codeSha256": sha(code.encode()), "motorAxisZ": outcome["motorAxisZ"], "brepSha256": sha(brep),
                "checks": json.loads((out / "checks.json").read_text()), "files": files, "seconds": {"build": r["seconds"], "measure": m["seconds"]}}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def op_cad_recipe(body):
    """Trusted recipe (preset or bounded parameters), e.g. the reference baseline. Same scripts as the workbench."""
    req = requirements(body.get("requirements"))
    spec = {"variant": body.get("variant"), "requirements": req}
    if spec["variant"] == "parametric":
        spec["parameters"] = body.get("parameters")
    elif spec["variant"] not in ("reference", "lightweight", "undersize-bore", "compact"):
        raise Refused(400, "INVALID_INPUT", "unknown variant")
    one_job_per_session()
    work = Path(tempfile.mkdtemp(prefix="pai-job-"))
    try:
        (work / "in.json").write_text(json.dumps(spec)); (work / "out").mkdir()
        r = run([PYTHON, "-I", "-W", "ignore", str(NATIVE / "cad_bracket.py"), "--input", str(work / "in.json"), "--output", str(work / "out")], 300)
        if r["exit"] != 0:
            return {"status": "error", "error": r["stderr"][-400:]}
        return {"status": "ok", "checks": json.loads((work / "out/checks.json").read_text()), "files": collect(work / "out", CAD_FILES), "seconds": r["seconds"]}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def op_cad_sweep(body):
    req, grid = requirements(body.get("requirements")), body.get("grid")
    if not isinstance(grid, dict):
        raise Refused(400, "INVALID_INPUT", "grid required")
    one_job_per_session()
    work = Path(tempfile.mkdtemp(prefix="pai-job-"))
    try:
        (work / "in.json").write_text(json.dumps({"requirements": req, "grid": grid}))
        r = run([PYTHON, "-I", "-W", "ignore", str(NATIVE / "cad_sweep.py"), "--input", str(work / "in.json"), "--output", str(work)], 840)
        if r["exit"] != 0:
            return {"status": "error", "error": r["stderr"][-400:] or ("timed out" if r["timedOut"] else "failed")}
        text = (work / "sweep.json").read_bytes()
        return {"status": "ok", "sweep": json.loads(text), "sha256": sha(text), "seconds": r["seconds"]}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------- agent role

def ledger_path():
    return LEDGER_DIR / "ledger.sqlite3"


def executor_python(code):
    return run(["python3", "-B", "-c", code], 60, cwd=str(EXECUTOR))


def ledger_status():
    if not LEDGER_DIR.is_dir():
        raise Refused(503, "LEDGER_VOLUME_MISSING", "shared ledger volume is not mounted")
    if not ledger_path().exists():
        return {"exists": False}
    r = run(["python3", "-B", "-m", "agent_control", "budget-status", "--database", str(ledger_path())], 30, cwd=str(EXECUTOR))
    try:
        s = json.loads(r["stdout"])
    except ValueError:
        raise Refused(503, "LEDGER_UNREADABLE", "ledger status could not be read")
    return {"exists": True, "state": s.get("state"), "frozenReason": s.get("frozen_reason"), "attempts": s.get("attempts"),
            "dayAdmissionsUsed": s.get("day_admissions_used"), "dayAttemptLimit": s.get("day_attempt_limit"), "day": s.get("day")}


def op_init_ledger(_body):
    """Create the dedicated AgentCore ledger once with the reviewed policy. An existing ledger is never replaced or reset."""
    status = ledger_status()
    if status["exists"]:
        return {"created": False, "ledger": status}
    (LEDGER_DIR / "runs").mkdir(mode=0o700, exist_ok=True)
    policy = json.loads(POLICY.read_text())
    code = ("import json,sys\nfrom pathlib import Path\nfrom agent_control.budget import BudgetLedger\n"
            f"BudgetLedger.create(Path({str(ledger_path())!r}), json.loads({json.dumps(json.dumps(policy))}))\nprint('created')")
    r = executor_python(code)
    if r["exit"] != 0:
        raise Refused(500, "LEDGER_CREATE_FAILED", (r["stderr"].strip().splitlines() or ["failed"])[-1][:200])
    return {"created": True, "ledger": ledger_status(), "policy": policy}


def install_keys():
    """Fetch the three Kiro keys and write them exactly where the executor reads them (0600 files, 0700 dirs)."""
    arn = os.environ.get("PAI_AI_KEYS_ARN")
    if not arn:
        raise Refused(503, "KEYS_NOT_CONFIGURED", "PAI_AI_KEYS_ARN is not set for this runtime")
    region = arn.split(":")[3]
    keys = json.loads(aws_call("secretsmanager", region, "secretsmanager.GetSecretValue", {"SecretId": arn})["SecretString"])
    if set(keys) != {"primary", "backup", "backup2"} or not all(re.fullmatch(r"ksk_[A-Za-z0-9_-]{20,}", v) for v in keys.values()):
        raise Refused(503, "KEYS_INVALID", "Kiro key secret has an unexpected shape")
    home = Path(os.environ.get("HOME", "/home/pai"))
    for d in (home / ".config", home / ".config/agent-cli", home / ".config/kiro-failover"):
        d.mkdir(mode=0o700, exist_ok=True); os.chmod(d, 0o700)
    for path, text in ((home / ".config/agent-cli/env", f"KIRO_API_KEY={keys['primary']}\n"),
                       (home / ".config/kiro-failover/backup.key", keys["backup"] + "\n"),
                       (home / ".config/kiro-failover/backup2.key", keys["backup2"] + "\n")):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.chmod(path, 0o600)


def aws_call(service, region, target, payload):
    """Minimal SigV4 JSON-1.1 call with the runtime's role credentials (container credentials endpoint or env)."""
    import datetime
    import hmac
    import urllib.request
    creds = credentials()
    host = f"{service}.{region}.amazonaws.com"
    body = json.dumps(payload).encode()
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    headers = {"content-type": "application/x-amz-json-1.1", "host": host, "x-amz-date": amz, "x-amz-target": target}
    if creds.get("token"):
        headers["x-amz-security-token"] = creds["token"]
    signed = ";".join(sorted(headers))
    canonical = "\n".join(["POST", "/", "", "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, sha(body)])
    scope = f"{day}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, sha(canonical.encode())])
    k = ("AWS4" + creds["secret"]).encode()
    for part in (day, region, service, "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={creds['key']}/{scope}, SignedHeaders={signed}, Signature={signature}"
    req = urllib.request.Request(f"https://{host}/", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def credentials():
    import urllib.request
    if os.environ.get("AWS_ACCESS_KEY_ID"):
        return {"key": os.environ["AWS_ACCESS_KEY_ID"], "secret": os.environ["AWS_SECRET_ACCESS_KEY"], "token": os.environ.get("AWS_SESSION_TOKEN")}
    full, rel = os.environ.get("AWS_CONTAINER_CREDENTIALS_FULL_URI"), os.environ.get("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
    if full or rel:
        req = urllib.request.Request(full or f"http://169.254.170.2{rel}")
        tok = os.environ.get("AWS_CONTAINER_AUTHORIZATION_TOKEN")
        tok_file = os.environ.get("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")
        if tok_file:
            tok = Path(tok_file).read_text().strip()
        if tok:
            req.add_header("Authorization", tok)
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.loads(r.read())
        return {"key": d["AccessKeyId"], "secret": d["SecretAccessKey"], "token": d.get("Token")}
    # IMDSv2 fallback
    t = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT",
                                                      headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}), timeout=3).read().decode()
    h = {"X-aws-ec2-metadata-token": t}
    role = urllib.request.urlopen(urllib.request.Request("http://169.254.169.254/latest/meta-data/iam/security-credentials/", headers=h), timeout=3).read().decode().split()[0]
    d = json.loads(urllib.request.urlopen(urllib.request.Request(f"http://169.254.169.254/latest/meta-data/iam/security-credentials/{role}", headers=h), timeout=3).read())
    return {"key": d["AccessKeyId"], "secret": d["SecretAccessKey"], "token": d.get("Token")}


def op_text_proposal(body):
    run_id, prompt = body.get("run_id"), body.get("prompt")
    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        raise Refused(400, "INVALID_INPUT", "run_id must match the executor identity pattern")
    if not isinstance(prompt, str) or not 1 <= len(prompt.encode()) <= 120_000:
        raise Refused(400, "INVALID_INPUT", "prompt must be 1–120000 bytes")
    profiles = body.get("profiles") or PROFILES
    if not isinstance(profiles, list) or any(p not in PROFILES for p in profiles):
        raise Refused(422, "AI_PROFILE_NOT_ENABLED", "this runtime enables only " + ",".join(PROFILES))
    timeout = int(body.get("timeout_seconds", 60))
    if not 1 <= timeout <= 60:
        raise Refused(400, "INVALID_INPUT", "timeout_seconds must be 1–60")
    status = ledger_status()
    if not status["exists"]:
        raise Refused(503, "LEDGER_NOT_INITIALISED", "the dedicated AgentCore ledger has not been created (op init-ledger)")
    install_keys()
    # Run directories live on the shared volume: the same run_id resumes or reports its saved answer, never re-dispatches.
    run_dir = LEDGER_DIR / "runs" / hashlib.sha256(run_id.encode()).hexdigest()[:32]
    run_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    prompt_file, request_file = run_dir / "prompt.txt", run_dir / "request.json"
    if not request_file.exists():
        prompt_file.write_text(prompt); os.chmod(prompt_file, 0o600)
        request = {"schema_version": 1, "kind": "text-proposal", "run_id": run_id, "prompt_file": str(prompt_file), "profiles": profiles,
                   "timeout_seconds": timeout, "max_attempts": len(profiles), "cost_bounds_microusd": None}
        request_file.write_text(json.dumps(request)); os.chmod(request_file, 0o600)
    elif sha(prompt_file.read_bytes()) != sha(prompt.encode()):
        raise Refused(409, "RUN_ID_REUSED", "run_id already used with a different prompt")
    entry = EXECUTOR / ".runtime/compiled/flows/execute.js"
    r = run(["node", str(entry.resolve()), "--state", str(run_dir / "state"), "--database", str(ledger_path()), "--request", str(request_file)], 470, cwd=str(EXECUTOR))
    lines = [l for l in r["stdout"].strip().splitlines() if l.strip()]
    if r["exit"] == 0 and not lines:
        # Never a silent success: an empty report is surfaced as an executor fault for reconciliation.
        raise Refused(502, "EXECUTOR_NO_REPORT", "executor exited 0 without a report; nothing was dispatched")
    attempts = []
    for f in sorted((run_dir / "state/runs").glob("*/*.json")) if (run_dir / "state/runs").exists() else []:
        if f.name.endswith((".credential.json", "request.json", "mcp.json", "prompt.acp.json")):
            continue
        try:
            d = json.loads(f.read_text())
        except ValueError:
            continue
        if isinstance(d, dict) and "requested" in d:
            attempts.append({"profile": d["requested"].get("profile"), "status": d.get("status"), "errorKind": (d.get("error") or {}).get("kind"),
                             "model": (d.get("observed") or {}).get("model"), "engineVersion": (d.get("observed") or {}).get("engine_version"),
                             "effects": d.get("effects"), "workStarted": (d.get("protocol") or {}).get("work_started")})
    return {"exitCode": r["exit"], "timedOut": r["timedOut"], "seconds": r["seconds"], "report": lines[-1] if lines else "",
            "attempts": attempts, "ledger": ledger_status()}


def op_agent_probe(_body):
    kiro = run(["kiro-cli-chat", "--version"], 10)
    commit = (EXECUTOR / ".pai-installed").read_text().strip() if (EXECUTOR / ".pai-installed").exists() else None
    try:
        ledger = ledger_status()
    except Refused as e:
        ledger = {"error": e.code}
    return {"kiro": kiro["stdout"].strip(), "executorCommit": commit, "profiles": PROFILES, "ledger": ledger,
            "egress": {"kiroEndpoint": can_connect("prod.download.cli.kiro.dev", 443)}, "keysConfigured": bool(os.environ.get("PAI_AI_KEYS_ARN")),
            "uid": os.getuid(), "arch": os.uname().machine}


OPS = {
    "sandbox": {"probe": lambda b: isolation_report(), "cad-code": op_cad_code, "cad-recipe": op_cad_recipe, "cad-sweep": op_cad_sweep},
    "agent": {"probe": op_agent_probe, "init-ledger": op_init_ledger, "text-proposal": op_text_proposal},
}


class Handler(BaseHTTPRequestHandler):
    server_version = "pai-agentcore"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # metadata only; never bodies. Health checks are not logged.
        if self.path == "/ping":
            return
        sys.stderr.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "path": self.path, "status": args[1] if len(args) > 1 else None}) + "\n")

    def send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/ping":
            return self.send(404, {"error": "NOT_FOUND"})
        self.send(200, {"status": "HealthyBusy" if state["busy"] else "Healthy", "time_of_last_update": state["changed"]})

    def do_POST(self):
        if self.path != "/invocations":
            return self.send(404, {"error": "NOT_FOUND"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 2_000_000:
                raise Refused(413, "TOO_LARGE", "request body over 2 MB")
            body = json.loads(self.rfile.read(length) or b"{}")
            op = OPS.get(ROLE, {}).get(body.get("op"))
            if not op:
                raise Refused(400, "UNKNOWN_OP", f"role {ROLE or 'unset'} supports: {', '.join(OPS.get(ROLE, {}))}")
            with lock:
                if state["busy"]:
                    raise Refused(409, "BUSY", "another invocation is running in this session")
                state["busy"], state["changed"] = True, int(time.time())
            try:
                result = op(body)
            finally:
                with lock:
                    state["busy"], state["changed"] = False, int(time.time())
            self.send(200, {"role": ROLE, "op": body.get("op"), "version": VERSION, **result})
        except Refused as e:
            self.send(e.status, {"error": e.code, "message": str(e)})
        except (ValueError, KeyError) as e:
            self.send(400, {"error": "INVALID_INPUT", "message": type(e).__name__})
        except Exception as e:  # noqa: BLE001
            self.send(500, {"error": "INTERNAL", "message": type(e).__name__})


if __name__ == "__main__":
    if ROLE not in OPS:
        raise SystemExit("PAI_ROLE must be sandbox or agent")
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
