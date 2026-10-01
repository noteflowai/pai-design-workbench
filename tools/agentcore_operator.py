"""Operate the PAI AgentCore deployment through the scoped operator role (never prints credentials or prompts).

  python3 tools/agentcore_operator.py build                  # start the native arm64 CodeBuild image build and wait
  python3 tools/agentcore_operator.py invoke --runtime sandbox|agent --payload FILE|JSON [--session ID]
  python3 tools/agentcore_operator.py logs --runtime sandbox|agent [--minutes 30]

Every sandbox job should use a fresh --session (default: random), i.e. a fresh microVM.
"""
import argparse
import json
import sys
import time
import uuid
from pathlib import Path

import boto3
from botocore.config import Config

REGION, ACCOUNT = "ap-northeast-1", "820674626047"


def session(role):
    c = boto3.client("sts").assume_role(RoleArn=f"arn:aws:iam::{ACCOUNT}:role/{role}", RoleSessionName="pai-agentcore-operator")["Credentials"]
    return boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"], region_name=REGION)


def outputs(name):
    lookup = session(f"cdk-hnb659fds-lookup-role-{ACCOUNT}-{REGION}")
    stack = lookup.client("cloudformation").describe_stacks(StackName=name)["Stacks"][0]
    return {p["OutputKey"]: p["OutputValue"] for p in stack.get("Outputs", [])}


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["build", "invoke", "logs"])
parser.add_argument("--runtime", choices=["sandbox", "agent"])
parser.add_argument("--payload")
parser.add_argument("--session")
parser.add_argument("--minutes", type=int, default=30)
args = parser.parse_args()
op = session(f"cdk-hnb659fds-pai-operator-role-{ACCOUNT}-{REGION}")

if args.action == "build":
    base = outputs("PAIAgentCoreBase")
    cb = op.client("codebuild")
    build = cb.start_build(projectName=base["BuildProject"])["build"]
    print(json.dumps({"build": build["id"], "tag": base["ImageTag"]}), file=sys.stderr)
    while True:
        time.sleep(20)
        b = cb.batch_get_builds(ids=[build["id"]])["builds"][0]
        if b["buildStatus"] != "IN_PROGRESS":
            break
    lg = op.client("logs")
    events = lg.get_log_events(logGroupName=b["logs"]["groupName"], logStreamName=b["logs"]["streamName"], startFromHead=False, limit=400)["events"]
    keep = [e["message"].rstrip() for e in events if any(k in e["message"] for k in ("exists ", "ERROR", "error:", "failed"))]
    images = [e["message"].strip() for e in events if e["message"].startswith(("PAI_IMAGE", "sandbox-", "agent-"))]
    print(json.dumps({"status": b["buildStatus"], "seconds": int((b["endTime"] - b["startTime"]).total_seconds()), "tag": base["ImageTag"],
                      "phases": [(p["phaseType"], p.get("phaseStatus")) for p in b["phases"] if p.get("phaseStatus")], "images": images, "log": keep[-20:]}, indent=1, default=str))
    sys.exit(0 if b["buildStatus"] == "SUCCEEDED" else 1)

rt = outputs("PAIAgentCoreRuntime")
arn = rt["SandboxRuntimeArn" if args.runtime == "sandbox" else "AgentRuntimeArn"]
if args.action == "invoke":
    payload = Path(args.payload).read_text() if args.payload and Path(args.payload).exists() else (args.payload or '{"op":"probe"}')
    client = op.client("bedrock-agentcore", config=Config(read_timeout=900, connect_timeout=30, retries={"max_attempts": 1, "mode": "standard"}))
    sid = args.session or f"pai-{args.runtime}-{uuid.uuid4()}"
    started = time.time()
    r = client.invoke_agent_runtime(agentRuntimeArn=arn, runtimeSessionId=sid, payload=payload.encode(), contentType="application/json", accept="application/json")
    body = b"".join(r["response"]) if hasattr(r["response"], "__iter__") and not hasattr(r["response"], "read") else r["response"].read()
    out = json.loads(body)
    out["_invocation"] = {"session": sid, "seconds": round(time.time() - started, 1), "statusCode": r.get("statusCode")}
    print(json.dumps(out, ensure_ascii=False))
elif args.action == "logs":
    runtime_id = arn.split("/")[-1]
    lg = op.client("logs")
    groups = f"/aws/bedrock-agentcore/runtimes/{runtime_id}-DEFAULT"
    events = lg.filter_log_events(logGroupName=groups, startTime=int((time.time() - args.minutes * 60) * 1000), limit=200)["events"]
    for e in events[-80:]:
        print(e["message"].rstrip()[:300])
