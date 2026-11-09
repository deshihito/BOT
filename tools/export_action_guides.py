"""Web のコマンド解説（/commands）用の全アクション一覧（JSON）を書き出す。

    python -m tools.export_action_guides              # 標準出力へ
    python -m tools.export_action_guides -o web/data/action-guides.json

Bot 側レジストリ（core/general/action_registry.default_registry）を正として、
全アクションの ID・表示名・所属ジャンルをそのまま書き出す。Web 側は
手書きリストを持たず、この生成 JSON を描画する（＝機能の追加・削除・改名・
ジャンル移動がそのままサイトへ追従する）。

デプロイ時は deploy/deploy-web.sh がビルド前にこのツールを実行して
web/data/action-guides.json を再生成する（tools.export_commands と同じ経路）。
リポジトリにコミットされた JSON とレジストリの一致は
tests/test_action_guides_export.py が固定する。

Discord・DB API・外部サービスには接続しない（export_commands と同じ
オフライン環境で読み込む）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# /vc のレジストリ値のうち、パネル側のジャンル表（VOICE_ACTIONS_BY_GENRE）に
# 載っていないものの寄せ先。echo_status（やまびこ状態）は echo 本体と同じ
# studio（録音・音声制作）ジャンルの機能なので、そこで数える。
VC_GENRE_FALLBACK = {"echo_status": "studio"}


def _genre_meta(root: str) -> dict[str, tuple[str, str]]:
    """ルートごとのジャンル定義（key -> (表示名, 説明)）を正リストから取る。"""
    if root == "general":
        from core.general.entry import GENERAL_GENRES

        return dict(GENERAL_GENRES)
    if root == "support":
        from cogs.support import SUPPORT_GENRES

        return dict(SUPPORT_GENRES)
    if root == "vc":
        from core.vc.common import VOICE_GENRES

        return dict(VOICE_GENRES)
    if root == "game":
        return {"games": ("ゲーム一覧", "")}
    return {"help": ("ヘルプ", "")}


def _vc_genre_by_value() -> dict[str, str]:
    from core.vc.common import VOICE_ACTIONS_BY_GENRE

    return {
        value: genre
        for genre, items in VOICE_ACTIONS_BY_GENRE.items()
        for _label, value in items
    }


def build_action_guides() -> dict:
    """レジストリ全件を Web 描画用の階層（ルート→ジャンル→機能）にする。"""
    from core.game.game.game_guides import GAME_GUIDES
    from core.general.action_registry import ROOT_LABELS, ROOT_ORDER, default_registry

    registry = default_registry()
    vc_genres = _vc_genre_by_value()

    roots: list[dict] = []
    counts: dict[str, int] = {}
    for root in ROOT_ORDER:
        meta = _genre_meta(root)
        genres: dict[str, dict] = {}
        for spec in registry.by_root(root):
            if root == "vc":
                genre_key = vc_genres.get(spec.value) or VC_GENRE_FALLBACK.get(
                    spec.value, "vc")
            elif root == "game":
                genre_key = "games"
            elif root == "help":
                genre_key = "help"
            else:
                genre_key = spec.genre
            genre_label, genre_desc = meta.get(
                genre_key, (spec.genre_label, ""))
            genre = genres.setdefault(genre_key, {
                "key": genre_key,
                "label": genre_label,
                "description": genre_desc,
                "functions": [],
            })
            # 機能の説明は、レジストリ側に固有の説明がある場合だけ載せる
            # （assist_* の機能説明、今月のゲーム王など）。ジャンル説明の
            # 複写は載せない（ジャンル見出し側で出す）。
            description = spec.description
            if not description or description == genre_desc:
                description = ""
            note = ""
            if root == "game" and spec.value.startswith("game:"):
                guide = GAME_GUIDES.get(spec.value[len("game:"):]) or {}
                description = guide.get("summary") or description
                players = guide.get("players") or ""
                duration = guide.get("duration") or ""
                note = "／".join(part for part in (players, duration) if part)
            entry = {
                "id": spec.id,
                "value": spec.value,
                "title": spec.label,
                "description": description,
            }
            if note:
                entry["note"] = note
            if spec.permission:
                entry["permission"] = spec.permission
            genre["functions"].append(entry)
        counts[root] = sum(len(g["functions"]) for g in genres.values())
        # ジャンルの並びは各ルートの定義（パネル）の順に揃える
        ordered = [genres[key] for key in meta if key in genres]
        ordered += [g for key, g in genres.items() if key not in meta]
        roots.append({
            "root": root,
            "command": ROOT_LABELS[root],
            "genres": ordered,
        })

    return {
        "version": 1,
        "total": sum(counts.values()),
        "counts": counts,
        "game_count": len(GAME_GUIDES),
        "roots": roots,
    }


def export_action_guides() -> dict:
    from tools.export_commands import offline_environment

    with offline_environment():
        return build_action_guides()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Web コマンド解説用の全アクション一覧を JSON で書き出します。")
    parser.add_argument("-o", "--output", help="書き出すファイル（省略すると標準出力）")
    args = parser.parse_args(argv)
    output = Path(args.output).resolve() if args.output else None  # 一時フォルダに移る前に決める
    guides = export_action_guides()
    text = json.dumps(guides, ensure_ascii=False, indent=2) + "\n"
    if output:
        output.write_text(text, encoding="utf-8")
        print(f"{guides['total']} 件のアクションを {output} に書き出しました。", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
