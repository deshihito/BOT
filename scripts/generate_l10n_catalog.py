#!/usr/bin/env python3
"""Extract Japanese string literals and translate them into an English catalog."""
from __future__ import annotations
import ast, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "core" / "locales" / "ja_to_en_source.json"

values: dict[str, dict[str, object]] = {}
for folder in (ROOT / "cogs", ROOT / "core"):
    for path in folder.rglob("*.py"):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            value = node.value
            if not re.search(r"[ぁ-んァ-ン一-龥]", value) or not value.strip():
                continue
            if len(value) > 500 or value.startswith(("http://", "https://", "SELECT ", "INSERT ", "UPDATE ", "CREATE ", "ALTER ")):
                continue
            entry = values.setdefault(value, {"text": value, "locations": []})
            locations = entry["locations"]
            assert isinstance(locations, list)
            if len(locations) < 5:
                locations.append(f"{path.relative_to(ROOT)}:{node.lineno}")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(list(values.values()), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"wrote {len(values)} source strings to {OUT}")
