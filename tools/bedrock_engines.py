"""Render the Bedrock engine settings from tools/bedrock-engines.json (the one source).

    python3 tools/bedrock_engines.py codex-config   # ~/.codex/config.toml: provider and region only, no credentials
    python3 tools/bedrock_engines.py claude-region
"""
import json
import sys
from pathlib import Path

spec = json.loads((Path(__file__).resolve().parent / "bedrock-engines.json").read_text())
what = sys.argv[1] if len(sys.argv) > 1 else ""
if what == "codex-config":
    c = spec["codex"]
    # The model and effort are not set here: the executor pins them per session (CODEX_CONFIG from engine-pins.json).
    print(f'model_provider = "{c["provider"]}"\n\n[model_providers.{c["provider"]}.aws]\nregion = "{c["region"]}"')
elif what == "claude-region":
    print(spec["claude"]["region"])
else:
    raise SystemExit("usage: bedrock_engines.py codex-config | claude-region")
