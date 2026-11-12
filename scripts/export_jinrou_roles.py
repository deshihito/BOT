"""core/game/jinrou/common.py の HELP_ROLES から、サイトの役職図鑑用データ web/lib/jinrou-roles.ts を作る。

使い方: python scripts/export_jinrou_roles.py        # 書き出す
        python scripts/export_jinrou_roles.py --check # 差分があれば終了コード 1

役職 ID は、core/game/jinrou/jinrou_guide.py の ROLE_URL_USE_SLUG が True で役職データに英語の `id` があればそれを、
それ以外は日本語の役職名を使う。
役職一覧は ast で読み、勝ち方の文は core/game/jinrou/jinrou_guide.py の win_condition() を使う
（Bot の「？」ボタンと同じ文になる）。discord.py が要るので venv で実行する。
"""
from __future__ import annotations

import ast
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from core.game.jinrou import jinrou_guide  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
COG = ROOT / "core" / "game" / "jinrou" / "common.py"
ASSETS = ROOT / "Assets"
OUT_TS = ROOT / "web" / "lib" / "jinrou-roles.ts"
IMG_DIR = ROOT / "web" / "public" / "img" / "jinrou"

TEAMS = {"村人陣営": "village", "人狼陣営": "wolf", "第三者陣営": "third"}


def load_help_roles(path: Path = COG) -> list:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        target = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
        elif isinstance(node, ast.AnnAssign):
            target = node.target
        if isinstance(target, ast.Name) and target.id == "HELP_ROLES":
            return ast.literal_eval(node.value)
    raise RuntimeError("HELP_ROLES が見つかりません")


def load_use_slug(path: Path = ROOT / "core" / "game" / "jinrou" / "jinrou_guide.py") -> bool:
    """core/game/jinrou/jinrou_guide.py の ROLE_URL_USE_SLUG（Bot のリンクとサイトの URL を同じ切り替えでそろえる）。"""
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "ROLE_URL_USE_SLUG" for t in node.targets):
            return bool(ast.literal_eval(node.value))
    return True


USE_SLUG = load_use_slug()


def normalize(entry, use_slug: bool = True) -> dict:
    """タプル (名前, 陣営, 説明, 画像[, id]) でも dict でも受け付ける。"""
    if isinstance(entry, dict):
        name, faction = entry["name"], entry.get("faction") or entry.get("team")
        desc = entry.get("desc") or entry.get("description") or ""
        img, rid = entry.get("image") or entry.get("img"), entry.get("id")
    else:
        name, faction, desc, img = entry[:4]
        rid = entry[4] if len(entry) > 4 else None
    team = TEAMS[faction]
    return {
        "id": (rid if use_slug else None) or name,
        "name": name,
        "team": team,
        "teamLabel": faction,
        "ability": desc,
        "win": jinrou_guide.win_condition(name),
        "asset": img,
    }


def build_roles(path: Path = COG) -> list[dict]:
    help_roles = load_help_roles(path)
    jinrou_guide.register_roles(help_roles)
    roles = []
    for e in help_roles:
        r = normalize(e, use_slug=USE_SLUG)
        src = ASSETS / r.pop("asset") if r["asset"] else None
        r["image"] = f"/img/jinrou/{src.stem.lower()}.png" if src and src.exists() else None
        r["_src"] = src
        roles.append(r)
    return roles


def render_ts(roles: list[dict]) -> str:
    data = [{k: v for k, v in r.items() if not k.startswith("_")} for r in roles]
    body = json.dumps(data, ensure_ascii=False, indent=2)
    return (
        "// このファイルは scripts/export_jinrou_roles.py が core/game/jinrou/common.py から自動生成しています。手で編集しないでください。\n"
        "export type JinrouTeam = \"village\" | \"wolf\" | \"third\";\n\n"
        "export type JinrouRole = {\n  id: string;\n  name: string;\n  team: JinrouTeam;\n  teamLabel: string;\n"
        "  ability: string;\n  win: string;\n  image: string | null;\n};\n\n"
        f"export const JINROU_ROLES: JinrouRole[] = {body};\n"
    )


def main(argv: list[str]) -> int:
    roles = build_roles()
    ts = render_ts(roles)
    if "--check" in argv:
        current = OUT_TS.read_text(encoding="utf-8") if OUT_TS.exists() else ""
        if current != ts:
            print("web/lib/jinrou-roles.ts が古いです。scripts/export_jinrou_roles.py を実行してください。")
            return 1
        return 0
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    for r in roles:
        if r["image"]:
            shutil.copyfile(r["_src"], IMG_DIR / Path(r["image"]).name)
    OUT_TS.write_text(ts, encoding="utf-8")
    missing = [r["name"] for r in roles if not r["image"]]
    print(f"{len(roles)} 役職を書き出しました。絵がない役職: {missing or 'なし'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
