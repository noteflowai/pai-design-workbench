"""Prepared dependencies must match both domain locks before any check runs."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check_cpu.sh"


class PreparedDependencies(unittest.TestCase):
    def setUp(self):
        # The sandbox deliberately keeps /tmp noexec; fixtures belong to the
        # explicitly admitted executable workspace used by the real npm tools.
        self.temporary = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.prepared = self.root / "prepared"
        self.bin = self.root / "bin"
        for folder in (self.source / "scripts", self.source / "tests", self.source / "infra",
                       self.prepared / "core", self.prepared / "infra", self.bin):
            folder.mkdir(parents=True)
        shutil.copy2(SCRIPT, self.source / "scripts/check_cpu.sh")
        (self.source / "tests/test_cpu_check.py").write_text(
            "import unittest\nfrom pathlib import Path\n"
            "class Fixture(unittest.TestCase):\n"
            " def test_dependencies_are_available(self):\n"
            "  self.assertEqual(Path('node_modules/fixture').read_text(), 'core')\n")
        locks = {}
        for label, folder in (("core", self.source), ("infra", self.source / "infra")):
            data = (label + " lock\n").encode()
            (folder / "package-lock.json").write_bytes(data)
            locks[label] = hashlib.sha256(data).hexdigest()
            (self.prepared / label / "fixture").write_text(label)
        (self.prepared / "locks.json").write_text(json.dumps({
            "schema_version": 1, "node": "v24.21.0", **locks}))
        for name, body in {
            "node": "#!/bin/sh\necho v24.21.0\n",
            "npm": "#!/bin/sh\necho called >> \"$CHECK_CALLS\"\n",
        }.items():
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)
        self.environment = {**os.environ, "PATH": str(self.bin) + ":" + os.environ["PATH"],
                            "CHECK_CALLS": str(self.root / "calls")}

    def run_check(self):
        return subprocess.run(["bash", "scripts/check_cpu.sh", "core",
                               "--prepared-dependencies", str(self.prepared)],
                              cwd=self.source, env=self.environment, capture_output=True)

    def test_matching_locks_run_checks(self):
        self.assertEqual(self.run_check().returncode, 0)
        self.assertTrue((self.root / "calls").exists())
        self.assertEqual((self.source / "node_modules/fixture").read_text(), "core")

    def test_changed_infra_lock_stops_before_copying_or_running(self):
        (self.source / "infra/package-lock.json").write_text("changed")
        self.assertNotEqual(self.run_check().returncode, 0)
        self.assertFalse((self.source / "node_modules").exists())
        self.assertFalse((self.root / "calls").exists())

    def test_existing_dependencies_are_preserved(self):
        (self.source / "node_modules").mkdir()
        (self.source / "node_modules/retained").write_text("retained")
        self.assertNotEqual(self.run_check().returncode, 0)
        self.assertEqual((self.source / "node_modules/retained").read_text(), "retained")
        self.assertFalse((self.root / "calls").exists())

    def test_wrong_node_stops_before_copying(self):
        (self.bin / "node").write_text("#!/bin/sh\necho v22.23.2\n")
        self.assertNotEqual(self.run_check().returncode, 0)
        self.assertFalse((self.source / "node_modules").exists())


if __name__ == "__main__":
    unittest.main()
