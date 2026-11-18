"""AGO WORLD BOX のワールド差分バックアップ / 復旧ツール（バッチ9b）。

bot_kv の worldbox_* 名前空間を丸ごと JSON ファイルへ書き出し（dump）、
ファイルから戻す（restore）。Pi 上で Bot を止めた状態で実行する想定。

使い方:
    python tools/worldbox_backup.py dump --out backup.json
    python tools/worldbox_backup.py restore --in backup.json [--yes]

restore は対象名前空間の既存キーを消してから書き戻す（完全復元）。
--yes が無い場合は対象と件数だけを表示して終わる（ドライラン）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.support.storage import KVStore  # noqa: E402

#: バックアップ対象の名前空間（web/lib/worldbox の *-online.ts の定数と一致）。
NAMESPACES = [
    "worldbox_arena",
    "worldbox_auth",
    "worldbox_board",
    "worldbox_casino",
    "worldbox_casino_tournament",
    "worldbox_chat",
    "worldbox_chat_outbox",
    "worldbox_containers",
    "worldbox_deaths",
    "worldbox_discord_directory",
    "worldbox_economy",
    "worldbox_economy_applied",
    "worldbox_fishing",
    "worldbox_guild_shop",
    "worldbox_instances",
    "worldbox_machines",
    "worldbox_metrics",
    "worldbox_metrics_econ",
    "worldbox_metrics_users",
    "worldbox_mobs",
    "worldbox_nation_settings",
    "worldbox_nations",
    "worldbox_objects",
    "worldbox_ops",
    "worldbox_party",
    "worldbox_presence",
    "worldbox_profiles",
    "worldbox_pvp",
    "worldbox_racing",
    "worldbox_requests",
    "worldbox_rest",
    "worldbox_save",
    "worldbox_stalls",
    "worldbox_tile_journal",
    "worldbox_tiles",
    "worldbox_tournament",
    "worldbox_union_board",
    "worldbox_union_settings",
    "worldbox_warp",
    "worldbox_wars",
]


async def dump_all() -> dict[str, dict[str, object]]:
    out: dict[str, dict[str, object]] = {}
    for ns in NAMESPACES:
        store = KVStore(ns)
        records = await store.load_all()
        out[ns] = dict(records)
    return out


async def restore_all(data: dict[str, dict[str, object]], *, apply: bool) -> dict[str, int]:
    counts: dict[str, int] = {}
    for ns, records in data.items():
        if ns not in NAMESPACES:
            continue
        counts[ns] = len(records)
        if not apply:
            continue
        store = KVStore(ns)
        current = await store.load_all()
        for key in current:
            if key not in records:
                await store.delete(key)
        for key, value in records.items():
            await store.set(key, value)
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="WORLD BOX バックアップ / 復旧")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_dump = sub.add_parser("dump")
    p_dump.add_argument("--out", required=True)
    p_restore = sub.add_parser("restore")
    p_restore.add_argument("--in", dest="infile", required=True)
    p_restore.add_argument("--yes", action="store_true", help="実際に書き戻す（無い場合はドライラン）")
    args = parser.parse_args()

    if args.cmd == "dump":
        data = asyncio.run(dump_all())
        Path(args.out).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        total = sum(len(v) for v in data.values())
        print(f"dump: {len(data)} namespaces, {total} keys -> {args.out}")
    else:
        data = json.loads(Path(args.infile).read_text(encoding="utf-8"))
        counts = asyncio.run(restore_all(data, apply=args.yes))
        total = sum(counts.values())
        mode = "restore" if args.yes else "dry-run"
        print(f"{mode}: {len(counts)} namespaces, {total} keys")


if __name__ == "__main__":
    main()
