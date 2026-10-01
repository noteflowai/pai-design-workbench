"""Static policy for generated CadQuery code (layer 1 of the sandbox; parses only, never executes).

Allowed: `import cadquery as cq`, `import math`, assignments, arithmetic, comprehensions, if/for,
plain functions and a small set of builtins. Denied: other imports, dunder or private names,
attribute assignment, file/export/import APIs, dynamic code, classes, context managers, try/raise,
async and generators. The program must assign `result` (one solid) and `MOTOR_AXIS_Z` at module level.

Run as `python -I cad_code_policy.py FILE` to print {"ok": bool, "violations": [...]} as JSON.
"""
import ast
import json
import sys

MAX_BYTES, MAX_NODES, MAX_LINES = 20_000, 8_000, 400
SAFE_BUILTINS = ("abs", "all", "any", "bool", "dict", "divmod", "enumerate", "filter", "float", "int", "isinstance", "len", "list", "map",
                 "max", "min", "pow", "range", "reversed", "round", "set", "sorted", "str", "sum", "tuple", "zip", "True", "False", "None")
DENIED_NAMES = {"exec", "eval", "compile", "open", "globals", "locals", "vars", "getattr", "setattr", "delattr", "hasattr", "input", "breakpoint",
                "help", "exit", "quit", "memoryview", "type", "object", "super", "dir", "id", "print", "classmethod", "staticmethod", "property",
                "os", "sys", "subprocess", "ctypes", "importlib", "builtins", "socket", "shutil", "pathlib", "io", "pickle", "marshal", "OCP"}
DENIED_ATTRS = {"os", "sys", "subprocess", "ctypes", "importlib", "builtins", "socket", "shutil", "pathlib", "io", "pickle", "marshal", "OCP",
                "system", "popen", "spawn", "fork", "kill", "environ", "modules", "loader", "spec", "mro", "f_globals", "f_locals", "f_back",
                "gi_frame", "cr_frame", "tb_frame", "tb_next", "func_globals", "occ_impl", "exporters", "importers", "wrapped", "Path", "open"}
DENIED_ATTR_PREFIXES = ("_", "export", "import", "save", "write", "load", "read", "dump", "exec", "eval", "compile", "remove", "unlink", "rename")
DENIED_NODES = {
    ast.ImportFrom: "from-import", ast.Global: "global", ast.Nonlocal: "nonlocal", ast.ClassDef: "class", ast.With: "with", ast.AsyncWith: "async",
    ast.AsyncFunctionDef: "async", ast.AsyncFor: "async", ast.Await: "async", ast.Yield: "generator", ast.YieldFrom: "generator",
    ast.Try: "try", ast.Raise: "raise", ast.Delete: "del", ast.Starred: "starred",
}
if hasattr(ast, "TryStar"):
    DENIED_NODES[ast.TryStar] = "try"


def check(source: str) -> list[str]:
    violations = []
    if len(source.encode("utf-8")) > MAX_BYTES:
        return [f"代码超过 {MAX_BYTES} 字节"]
    if source.count("\n") + 1 > MAX_LINES:
        return [f"代码超过 {MAX_LINES} 行"]
    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as e:
        return [f"语法错误：第 {e.lineno} 行 {e.msg}"]
    nodes = list(ast.walk(tree))
    if len(nodes) > MAX_NODES:
        return [f"语法树超过 {MAX_NODES} 个节点"]

    def deny(node, what):
        violations.append(f"第 {getattr(node, 'lineno', '?')} 行：{what}")

    for node in nodes:
        for kind, label in DENIED_NODES.items():
            if isinstance(node, kind):
                deny(node, f"不允许 {label}")
        if isinstance(node, ast.Import):
            for alias in node.names:
                if (alias.name, alias.asname) not in {("cadquery", "cq"), ("math", None)}:
                    deny(node, f"只允许 import cadquery as cq 与 import math（发现 {alias.name}）")
        elif isinstance(node, ast.Name):
            if node.id.startswith("_") or node.id in DENIED_NAMES:
                deny(node, f"不允许名称 {node.id}")
        elif isinstance(node, ast.Attribute):
            if node.attr in DENIED_ATTRS or node.attr.startswith(DENIED_ATTR_PREFIXES):
                deny(node, f"不允许属性 .{node.attr}")
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                deny(node, "不允许给属性赋值")
        elif isinstance(node, (ast.FunctionDef, ast.Lambda)):
            args = node.args
            for a in [*args.posonlyargs, *args.args, *args.kwonlyargs, *(x for x in (args.vararg, args.kwarg) if x)]:
                if a.arg.startswith("_"):
                    deny(node, f"不允许参数名 {a.arg}")
            if isinstance(node, ast.FunctionDef) and (node.name.startswith("_") or node.decorator_list):
                deny(node, "不允许私有函数名或装饰器")
        elif isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Store) and not isinstance(node.value, ast.Name):
            deny(node, "只允许给局部变量的元素赋值")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and "__" in node.value:
            deny(node, "字符串中不允许双下划线")
        elif isinstance(node, ast.keyword) and node.arg and node.arg.startswith("_"):
            deny(node, f"不允许关键字参数 {node.arg}")

    assigned = {t.id for n in tree.body if isinstance(n, (ast.Assign, ast.AnnAssign, ast.AugAssign))
                for t in (n.targets if isinstance(n, ast.Assign) else [n.target]) for t in ast.walk(t) if isinstance(t, ast.Name)}
    for required in ("result", "MOTOR_AXIS_Z"):
        if required not in assigned:
            violations.append(f"必须在模块顶层给 {required} 赋值")
    return violations


if __name__ == "__main__":
    text = open(sys.argv[1], encoding="utf-8").read(MAX_BYTES + 1)
    found = check(text)
    print(json.dumps({"ok": not found, "violations": found[:20]}, ensure_ascii=False))
