#!/usr/bin/env python3
"""Fill missing locale keys using a local LibreTranslate instance.

Usage:
  python scripts/sync_locales.py --targets en,zh,ko,id,th,ar,hi
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.libretranslate import LibreTranslateClient, LibreTranslateError

TOKEN_RE = re.compile(r"\{[^{}]+\}|`[^`]+`|https?://[^\s)]+")


def protect(text: str) -> tuple[str, dict[str, str]]:
    tokens: dict[str, str] = {}
    def replace(match: re.Match[str]) -> str:
        token = f"__AGOBOT_TOKEN_{len(tokens)}__"
        tokens[token] = match.group(0)
        return token
    return TOKEN_RE.sub(replace, text), tokens


def restore(text: str, tokens: dict[str, str]) -> str:
    for placeholder, original in tokens.items():
        text = text.replace(placeholder, original)
    return text


def load_json(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Expected an object: {path}")
    return {str(key): str(value) for key, value in data.items()}


def save_json(path: Path, data: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(dict(sorted(data.items())), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


async def sync_target(client: LibreTranslateClient, source: dict[str, str], target: str,
                      output_dir: Path, overwrite: bool) -> int:
    path = output_dir / f"{target}.json"
    existing = load_json(path)
    pending = [key for key in source if overwrite or key not in existing]
    if not pending:
        print(f"{target}: up to date ({len(existing)} keys)")
        return 0
    print(f"{target}: translating {len(pending)} key(s)")
    for index, key in enumerate(pending, 1):
        protected, tokens = protect(source[key])
        translated = await client.translate(protected, source="ja", target=target)
        translated = restore(translated, tokens).strip()
        if not translated:
            raise LibreTranslateError(f"Empty translation for key {key}")
        existing[key] = translated
        print(f"  [{index}/{len(pending)}] {key}")
    save_json(path, existing)
    return len(pending)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(ROOT / "locales" / "ja.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "locales"))
    parser.add_argument("--targets", default="en")
    parser.add_argument("--url", default=os.getenv("LIBRETRANSLATE_URL", "http://127.0.0.1:18080"))
    parser.add_argument("--api-key", default=os.getenv("LIBRETRANSLATE_API_KEY", ""))
    parser.add_argument("--overwrite", action="store_true", help="replace existing translations")
    parser.add_argument("--check-only", action="store_true",
                        help="report missing keys without contacting LibreTranslate")
    args = parser.parse_args()
    source = load_json(Path(args.source))
    if not source:
        print(f"No source keys found in {args.source}", file=sys.stderr)
        return 2
    targets = [value.strip() for value in args.targets.split(",") if value.strip() and value.strip() != "ja"]
    missing: dict[str, list[str]] = {}
    for target in targets:
        existing = load_json(Path(args.output_dir) / f"{target}.json")
        keys = [key for key in source if key not in existing]
        if keys:
            missing[target] = keys
    if args.check_only:
        if not missing:
            print("Locale catalogs are complete")
            return 0
        for target, keys in missing.items():
            print(f"{target}: {len(keys)} missing key(s)")
            for key in keys:
                print(f"  - {key}")
        return 1
    client = LibreTranslateClient(args.url, args.api_key)
    try:
        for target in targets:
            await sync_target(client, source, target, Path(args.output_dir), args.overwrite)
    except (OSError, json.JSONDecodeError, LibreTranslateError) as exc:
        print(f"Locale sync failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
