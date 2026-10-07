"""English cuts must not invent numbers: captions resolve from the receipt or restate the recorder's own captions."""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import english_cut  # noqa: E402

SPECS = sorted((ROOT / "docs/evidence").glob("*.en-cut.json"))


class Templates(unittest.TestCase):
    receipt = {"facts": {"a": {"mass": 145.335, "bore": 0.00594, "frac": 0.0094}, "b": {"mass": 189.601}}}

    def test_formats(self):
        r = english_cut.resolve
        self.assertEqual(r("{facts.a.mass} g", self.receipt), "145.335 g")
        self.assertEqual(r("{um:facts.a.bore} µm", self.receipt), "5.94 µm")
        self.assertEqual(r("{pct1:facts.a.frac} %", self.receipt), "0.9 %")
        self.assertEqual(r("{lighter:facts.a.mass|facts.b.mass} %", self.receipt), "23 %")

    def test_unknown_field_fails_loudly(self):
        with self.assertRaises(KeyError):
            english_cut.resolve("{facts.a.missing}", self.receipt)


class PublishedSpecs(unittest.TestCase):
    def test_there_is_at_least_one_spec(self):
        self.assertTrue(SPECS)

    def test_every_spec_resolves_and_keeps_recorded_order(self):
        for path in SPECS:
            spec, receipt, segments = english_cut.load(path)
            self.assertTrue((ROOT / spec["video"]).exists(), path.name)
            last = -1
            for s in segments:
                a, b = s["source"]
                self.assertGreaterEqual(a, last, f"{path.name}: segments must keep recorded order")
                self.assertLess(a, b)
                self.assertGreaterEqual(s["speed"], 1)
                self.assertNotIn("{", s["headline"] + s["detail"])
                last = b

    def test_no_literal_number_is_invented(self):
        # A literal (non-template) number must already exist, as a whole token, in the receipt or in the caption/card
        # lines of the recorder that wrote the video's own captions. Anything else would be a retyped or invented figure.
        word = re.compile(r"[A-Za-zØ]*\d+(?:\.\d+)?[A-Za-z]*\d*")
        for path in SPECS:
            spec = json.loads(path.read_text())
            receipt = (ROOT / spec["receipt"]).read_text()
            recorder = ROOT / "scripts" / f"record-{Path(spec['video']).stem}.mjs"
            captions = [line for line in (recorder.read_text().splitlines() if recorder.exists() else []) if re.search(r"\b(caption|card|chapter)\(|name: \"", line)]
            allowed = set(word.findall(receipt + "\n" + "\n".join(captions)))
            for seg in spec["segments"]:
                texts = [seg.get("step", ""), seg.get("headline", ""), seg.get("detail", "")] + [r["text"] for r in seg.get("evidence", [])]
                for text in texts:
                    literal = english_cut.TOKEN.sub(" ", text)
                    literal = re.sub(r"^\d+  ", "", literal)          # the step number
                    for w in word.findall(literal):
                        self.assertTrue(w in allowed, f"{path.name}: '{w}' in {text!r} is not in the receipt, the recorder's captions or the UI labels it clicks")

if __name__ == "__main__":
    unittest.main()
