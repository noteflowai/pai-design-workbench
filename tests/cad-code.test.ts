import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { CadRequest, checkCadCode, DEFAULT_CAD_REQUIREMENTS } from "../src/cad.js";
import { sandboxArgs } from "../src/sandbox.js";

const template = await readFile(new URL("../native/cad_template.py", import.meta.url), "utf8");
const tail = "\nresult = 1\nMOTOR_AXIS_Z = 28\n";

test("static code policy: the template passes; imports, dunders, dynamic code, files and attribute writes do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-policy-"));
  // Layer 1 needs only a Python parser, so the host interpreter is enough here.
  const config = { ...configuration(), state: dir, cadquery: undefined };
  try {
    assert.deepEqual(await checkCadCode(config, template), []);
    const denied: Record<string, string> = {
      "import os": "import os" + tail,
      "from-import": "from cadquery import Workplane" + tail,
      "dunder import": "x = __import__('os')" + tail,
      "dunder attribute": "import cadquery as cq\nx = cq.Workplane.__init__.__globals__" + tail,
      "class escape": "x = ().__class__" + tail,
      "submodule chain": "import cadquery as cq\nx = cq.occ_impl.shapes" + tail,
      "exec": "exec('1')" + tail,
      "eval": "x = eval('1')" + tail,
      "open": "x = open('/etc/passwd')" + tail,
      "getattr": "import cadquery as cq\nx = getattr(cq, 'Workplane')" + tail,
      "export": "import cadquery as cq\ncq.Workplane('XY').box(1, 1, 1).exportStep('/tmp/x.step')" + tail,
      "attribute write": "import cadquery as cq\ncq.Workplane.box = None" + tail,
      "class": "class A:\n    pass" + tail,
      "try": "try:\n    x = 1\nexcept Exception:\n    x = 2" + tail,
      "with": "with x:\n    pass" + tail,
      "generator": "def f():\n    yield 1" + tail,
      "global": "def f():\n    global y" + tail,
      "dunder string": "x = '__globals__'" + tail,
      "missing result": "import math\nMOTOR_AXIS_Z = 28\n",
      "missing axis": "import math\nresult = 1\n",
      "syntax": "def (:" + tail,
      "too large": "x = 1\n".repeat(5000) + tail,
    };
    for (const [name, code] of Object.entries(denied)) {
      const violations = await checkCadCode(config, code);
      assert.ok(violations.length > 0, `${name} must be refused`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("generated requests require code, only generated takes code, and the sandbox hides state and home", () => {
  const base = { requestId: "00000000-0000-4000-8000-000000000001", projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS };
  assert.equal(CadRequest.safeParse({ ...base, variant: "generated" }).success, false);
  assert.equal(CadRequest.safeParse({ ...base, variant: "reference", source: { language: "cadquery-2.8", code: template } }).success, false);
  assert.equal(CadRequest.safeParse({ ...base, variant: "generated", source: { language: "cadquery-2.8", code: template } }).success, true);
  assert.equal(CadRequest.safeParse({ ...base, variant: "generated", source: { language: "python", code: template } }).success, false);

  const config = { ...configuration(), state: "/srv/pai-test-state-missing" };
  const args = sandboxArgs(config, { python: "/venv/bin/python", venv: "/venv", native: "/repo/native" }, { readOnly: ["/in.json"], writable: ["/out"] }, ["/venv/bin/python", "x.py"]);
  for (const flag of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2), ["--cap-drop", "ALL"]);
  const at = (flag: string, path: string) => args.findIndex((x, i) => x === flag && args[i + 1] === path);
  assert.ok(at("--ro-bind", "/") < at("--tmpfs", "/tmp"), "root first, then hidden paths");
  for (const hidden of ["/tmp", "/home"]) assert.ok(at("--tmpfs", hidden) > 0, hidden);
  assert.ok(at("--ro-bind", "/venv") > at("--tmpfs", "/home") && at("--bind", "/out") > at("--ro-bind", "/venv"), "explicit mounts come after hiding");
  assert.equal(args.filter(x => x === "--bind").length, 1, "only the output directory is writable");
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["/venv/bin/python", "x.py"]);
});
