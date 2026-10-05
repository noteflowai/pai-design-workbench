"""Run generated CadQuery code inside the OS sandbox (layers 2–3) and write only an exact BREP solid.

Launched by the workbench under bubblewrap (no network, read-only filesystem, hidden home/state,
fresh PID/IPC/UTS namespaces, all capabilities dropped). This process adds:
  - the static policy again (cad_code_policy.check),
  - resource limits (CPU, address space, file size, open files, no core dumps),
  - a PEP 578 audit hook that blocks process creation, sockets, ctypes and any write outside --output,
  - restricted builtins and an import function that returns only cadquery and math.
Nothing is measured here: a separate sandboxed process (cad_generated.py) reads the BREP and checks it.
Exit codes: 0 ok, 2 policy violation, 3 code error or invalid result, 4 resource limit.
"""
import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cad_code_policy import check  # noqa: E402
from cad_lockdown import limits, lockdown  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--code", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--cpu-seconds", type=int, default=60)
args = parser.parse_args()
out = Path(args.output).resolve()


def finish(code, payload):
    (out / "result.json").write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.exit(code)


source = Path(args.code).read_text(encoding="utf-8")
violations = check(source)
if violations:
    finish(2, {"status": "policy", "violations": violations[:20]})
limits(args.cpu_seconds)
import cadquery as cq  # noqa: E402  (trusted import before lockdown)

scope = lockdown(out, cq)
try:
    exec(compile(source, "<generated>", "exec"), scope)
except MemoryError:
    finish(4, {"status": "limit", "message": "内存超过 3 GiB 上限"})
except RecursionError:
    finish(3, {"status": "error", "type": "RecursionError", "message": "递归过深"})
except BaseException as e:  # noqa: BLE001 — report any failure of untrusted code without a host traceback
    finish(3, {"status": "error", "type": type(e).__name__, "message": str(e)[:500]})

result, axis = scope.get("result"), scope.get("AXIS_Z", scope.get("MOTOR_AXIS_Z"))
if isinstance(result, cq.Workplane):
    solids = [s for v in result.vals() if isinstance(v, cq.Shape) for s in v.Solids()]
elif isinstance(result, cq.Shape):
    solids = list(result.Solids())
else:
    finish(3, {"status": "error", "type": "ResultType", "message": "result 必须是 cq.Workplane 或 cq.Shape"})
if len(solids) != 1:
    finish(3, {"status": "error", "type": "ResultSolids", "message": f"result 必须恰好包含 1 个实体（实际 {len(solids)} 个）"})
if not isinstance(axis, (int, float)) or isinstance(axis, bool) or not math.isfinite(axis) or not 5 <= axis <= 500:
    finish(3, {"status": "error", "type": "MotorAxis", "message": "AXIS_Z（MOTOR_AXIS_Z）必须是 5–500 mm 的数值"})
solids[0].exportBrep(str(out / "generated.brep"))
finish(0, {"status": "ok", "motorAxisZ": float(axis), "solids": 1})
