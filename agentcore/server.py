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
CLAUDE_BEDROCK_REGION = os.environ.get("PAI_CLAUDE_BEDROCK_REGION", "")
# Codex is routed to Bedrock by the image's ~/.codex/config.toml (tools/bedrock_engines.py); Claude by this environment,
# passed to the executor process only. Both authenticate with the execution role through the container credentials.
ENGINE_ENV = {"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": CLAUDE_BEDROCK_REGION} if re.fullmatch(r"[a-z]{2}(-[a-z]+)+-\d", CLAUDE_BEDROCK_REGION) else {}


def ledger_profiles():
    """Profiles the runtime's ledger was created for (its policy is immutable). An engine is offered only if both this
    runtime's PAI_AI_PROFILES and the ledger configure it, so adding an engine never changes an existing ledger."""
    try:
        code = ("import json\nfrom pathlib import Path\nfrom agent_control.budget import BudgetLedger\n"
                f"print(json.dumps(sorted(BudgetLedger(Path({str(ledger_path())!r})).policy()['profiles'])))")
        r = run(["python3", "-B", "-c", code], 30, cwd=str(EXECUTOR))
        return json.loads(r["stdout"]) if r["exit"] == 0 else []
    except (ValueError, OSError):
        return []


def enabled_profiles():
    configured = set(ledger_profiles()) if ledger_path().exists() else set()
    return [p for p in PROFILES if p in configured]
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
        family = body.get("family", "nema17-bracket")
        if family not in ("nema17-bracket", "pillow-block"):
            raise Refused(400, "INVALID_INPUT", "family must be nema17-bracket or pillow-block")
        (work / "in.json").write_text(json.dumps({"requirements": req, "codeSha256": sha(code.encode()), "family": family}))
        m, _ = sandboxed([PYTHON, "-I", "-W", "ignore", str(NATIVE / "cad_generated.py"), "--input", str(work / "in.json"), "--source", str(src), "--output", str(out)],
                         [str(work / "in.json"), str(src)], [str(out)], 300)
        if m["exit"] != 0:
            # The measurer is trusted code (no user text in its traceback), so its last line is safe to report.
            tail = [l for l in m["stderr"].strip().splitlines() if l.strip()][-1:] if not m.get("timedOut") else ["timed out"]
            return {"status": "error", "error": f"measurement failed: {tail[0][:240] if tail else m['exit']}", "layers": layers, "codeSha256": sha(code.encode())}
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


IMAGE_MAGIC = {"image/png": b"\x89PNG\r\n\x1a\n", "image/jpeg": b"\xff\xd8\xff"}


def images_of(body):
    """Optional digest-bound images (executor accepts.images): at most 3, each <= 1.5 MB, PNG/JPEG by magic bytes."""
    raw = body.get("images") or []
    if not isinstance(raw, list) or len(raw) > 3:
        raise Refused(400, "INVALID_INPUT", "images: at most 3")
    out = []
    for i in raw:
        if not isinstance(i, dict) or set(i) != {"media_type", "sha256", "data"} or i["media_type"] not in IMAGE_MAGIC:
            raise Refused(400, "INVALID_INPUT", "images[]: {media_type: image/png|image/jpeg, sha256, data (base64)}")
        try:
            data = base64.b64decode(i["data"], validate=True)
        except (ValueError, TypeError):
            raise Refused(400, "INVALID_INPUT", "images[].data is not base64")
        if len(data) > 1_500_000 or not data.startswith(IMAGE_MAGIC[i["media_type"]]) or sha(data) != i["sha256"]:
            raise Refused(400, "INVALID_INPUT", "image exceeds 1.5 MB, is not the declared type or differs from its digest")
        out.append((i["media_type"], i["sha256"], data))
    return out


def op_text_proposal(body):
    run_id, prompt = body.get("run_id"), body.get("prompt")
    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        raise Refused(400, "INVALID_INPUT", "run_id must match the executor identity pattern")
    if not isinstance(prompt, str) or not 1 <= len(prompt.encode()) <= 120_000:
        raise Refused(400, "INVALID_INPUT", "prompt must be 1–120000 bytes")
    enabled = enabled_profiles()
    profiles = body.get("profiles") or enabled
    if not isinstance(profiles, list) or not profiles or any(p not in enabled for p in profiles):
        raise Refused(422, "AI_PROFILE_NOT_ENABLED", "this runtime enables only " + ",".join(enabled))
    images = images_of(body)
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
        attached = []
        for k, (media, digest, data) in enumerate(images):
            path = run_dir / f"attach-{k}.{'png' if media == 'image/png' else 'jpg'}"
            path.write_bytes(data); os.chmod(path, 0o600)
            attached.append({"path": str(path), "media_type": media, "sha256": digest})
        request = {"schema_version": 1, "kind": "text-proposal", "run_id": run_id, "prompt_file": str(prompt_file), "profiles": profiles,
                   "timeout_seconds": timeout, "max_attempts": len(profiles), "cost_bounds_microusd": None, **({"images": attached} if attached else {})}
        request_file.write_text(json.dumps(request)); os.chmod(request_file, 0o600)
    elif sha(prompt_file.read_bytes()) != sha(prompt.encode()) or \
            [x["sha256"] for x in json.loads(request_file.read_text()).get("images", [])] != [d for _, d, _ in images]:
        raise Refused(409, "RUN_ID_REUSED", "run_id already used with a different prompt or images")
    entry = EXECUTOR / ".runtime/compiled/flows/execute.js"
    r = run(["node", str(entry.resolve()), "--state", str(run_dir / "state"), "--database", str(ledger_path()), "--request", str(request_file)], 470,
            env={**os.environ, **ENGINE_ENV}, cwd=str(EXECUTOR))
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


ADAPTER_PROBE = r"""
const { spawn } = require("node:child_process");
const [bin, mode] = process.argv.slice(2);
const env = { ...process.env, INITIAL_AGENT_MODE: "read-only", NO_BROWSER: "1" };
if (mode === "codex") env.CODEX_CONFIG = process.env.PAI_PROBE_CODEX_CONFIG;
const p = spawn(bin, [], { env, stdio: ["pipe", "pipe", "ignore"] });
let buf = ""; const send = m => p.stdin.write(JSON.stringify(m) + "\n");
const done = o => { console.log(JSON.stringify(o)); p.kill(); process.exit(0); };
p.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  try { const m = JSON.parse(line);
    if (m.id === 1) send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
    if (m.id === 2) done({ session: !m.error, error: m.error ? String(m.error.message).slice(0, 160) : null,
      model: ((m.result || {}).configOptions || []).find(x => x.id === "model")?.currentValue ?? (m.result || {}).models?.currentModelId ?? null });
  } catch {} } });
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
setTimeout(() => done({ session: false, error: "timeout" }), 40000);
"""


def adapter_probe():
    """Start each Bedrock engine adapter and open a session (no prompt, no model call, no ledger use): proves the
    adapter binary runs on this image and its provider configuration loads with the execution role available."""
    pins = json.loads((EXECUTOR / "config/engine-pins.json").read_text())
    try:  # the execution role's short-lived credentials, as the adapters' default AWS chains will find them (never returned)
        role = bool(credentials().get("key"))
    except Exception:  # noqa: BLE001
        role = False
    out = {"roleCredentials": role, "claudeBedrock": bool(ENGINE_ENV),
           "codexProvider": (Path.home() / ".codex/config.toml").exists()}
    script = Path("/tmp/pai-adapter-probe.js"); script.write_text(ADAPTER_PROBE)
    for name, package in (("codex", "codex-acp"), ("claude", "claude-agent-acp")):
        binary = EXECUTOR / "node_modules/.bin" / package
        if not binary.exists():
            out[name] = {"session": False, "error": "adapter not installed"}; continue
        env = {**os.environ, **ENGINE_ENV, "PAI_PROBE_CODEX_CONFIG": json.dumps({"model": pins["codex"]["model"], "model_reasoning_effort": pins["codex"]["effort"]})}
        r = run(["node", str(script), str(binary), name], 60, env=env, cwd="/tmp")
        try:
            out[name] = json.loads(r["stdout"].strip().splitlines()[-1])
        except (ValueError, IndexError):
            out[name] = {"session": False, "error": (r["stderr"] or "no output")[-160:]}
    return out


def op_agent_probe(_body):
    kiro = run(["kiro-cli-chat", "--version"], 10)
    commit = (EXECUTOR / ".pai-installed").read_text().strip() if (EXECUTOR / ".pai-installed").exists() else None
    try:
        ledger = ledger_status()
    except Refused as e:
        ledger = {"error": e.code}
    try:
        enabled = enabled_profiles()
    except Refused:
        enabled = []
    return {"kiro": kiro["stdout"].strip(), "executorCommit": commit, "profiles": PROFILES, "enabledProfiles": enabled, "ledger": ledger,
            "bedrockEngines": adapter_probe(),
            "egress": {"kiroEndpoint": can_connect("prod.download.cli.kiro.dev", 443)}, "keysConfigured": bool(os.environ.get("PAI_AI_KEYS_ARN")),
            "uid": os.getuid(), "arch": os.uname().machine}


def op_reconcile(body):
    """Settle the unknown-effect attempts of one run after the maintainer recorded why they are safe. The executor checks
    each receipt (tool-free, text-only, terminal), writes its immutable overlay and settles this runtime's ledger."""
    run_id, actor, reason = body.get("run_id"), body.get("actor"), body.get("reason")
    if not isinstance(run_id, str) or not RUN_ID.match(run_id):
        raise Refused(400, "INVALID_INPUT", "run_id must match the executor identity pattern")
    if not isinstance(actor, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@:-]{0,79}", actor):
        raise Refused(400, "INVALID_INPUT", "actor must be an operator identity")
    if not isinstance(reason, str) or not 10 <= len(reason.strip()) <= 1000:
        raise Refused(400, "INVALID_INPUT", "reason must be 10-1000 characters")
    run_dir = LEDGER_DIR / "runs" / hashlib.sha256(run_id.encode()).hexdigest()[:32]
    receipts = run_dir / "state/runs" / run_id
    if not receipts.is_dir():
        raise Refused(404, "NOT_FOUND", "no executor run with this run_id on this runtime")
    settled = []
    for f in sorted(receipts.glob("*.json")):
        if not re.fullmatch(r"[a-f0-9]{64}\.json", f.name):
            continue
        d = json.loads(f.read_text())
        if d.get("effects") != "unknown" or not d.get("attempt_id"):
            continue
        r = run(["python3", "-B", "-m", "agent_control.executor", "reconcile", "--state", str(run_dir / "state"), "--database", str(ledger_path()),
                 "--request", str(run_dir / "request.json"), "--attempt-id", d["attempt_id"], "--actor", actor, "--reason", reason], 60, cwd=str(EXECUTOR))
        try:
            out = json.loads(r["stdout"].strip().splitlines()[-1])
        except (ValueError, IndexError):
            out = {}
        state = out.get("state") if out.get("state") in {"reconciled", "already-reconciled", "refused"} else "failed"
        settled.append({"attemptId": d["attempt_id"], "profile": (d.get("requested") or {}).get("profile", "unknown"), "state": state,
                        **({"blockers": out["blockers"]} if out.get("blockers") else {})})
    return {"settled": settled, "ledger": ledger_status()}


def op_extend_ledger(body):
    """Append-only policy change of this runtime's ledger (noteflow-agent-control#154) to the reviewed policy file:
    adds engines or tightens limits, refuses anything looser; recorded in the ledger's policy history."""
    actor, reason = body.get("actor"), body.get("reason")
    if not isinstance(actor, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@:-]{0,79}", actor) or not isinstance(reason, str):
        raise Refused(400, "INVALID_INPUT", "actor and reason are required")
    if not ledger_status()["exists"]:
        raise Refused(503, "LEDGER_NOT_INITIALISED", "create the ledger first (op init-ledger)")
    r = run(["python3", "-B", "-m", "agent_control", "budget-extend", "--database", str(ledger_path()), "--policy", str(POLICY),
             "--actor", actor, "--reason", reason], 60, cwd=str(EXECUTOR))
    try:
        out = json.loads(r["stdout"])
    except ValueError:
        out = {"changed": False, "error": "unreadable"}
    if r["exit"] != 0:
        raise Refused(422, "POLICY_NOT_APPEND_ONLY", str(out.get("error"))[:300])
    return {**out, "enabledProfiles": enabled_profiles(), "ledger": ledger_status()}


OPS = {
    "sandbox": {"probe": lambda b: isolation_report(), "cad-code": op_cad_code, "cad-recipe": op_cad_recipe, "cad-sweep": op_cad_sweep},
    "agent": {"probe": op_agent_probe, "init-ledger": op_init_ledger, "text-proposal": op_text_proposal, "reconcile": op_reconcile,
              "extend-ledger": op_extend_ledger},
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
