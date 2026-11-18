"""WORLD BOX Python 側サポート状態表示とバックアップ対象名前空間のテスト。"""

from __future__ import annotations

import ast
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_state_module():
    path = ROOT / "core" / "support" / "worldbox" / "state.py"
    spec = importlib.util.spec_from_file_location("worldbox_support_state", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _backup_namespaces() -> list[str]:
    tree = ast.parse((ROOT / "tools" / "worldbox_backup.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "NAMESPACES":
                    return ast.literal_eval(node.value)
    raise AssertionError("NAMESPACES not found in tools/worldbox_backup.py")


def test_role_names_includes_teleporter():
    st = _load_state_module()
    assert st.ROLE_NAMES["teleporter"] == "テレポーター"
    lines = st.build_state_lines(
        user_id="123",
        balance=1500,
        profile={
            "hp": 90,
            "hunger": 80,
            "role": "teleporter",
            "mastery": {"teleporter": {"xp": 80}},
            "items": {"wood": 5, "stone": 12},
        },
        presence={"space": "world", "x": 10.5, "y": -4.5},
        save=None,
        nation_name="AGO国",
        nation_role="国民",
    )
    text = "\n".join(lines)
    assert "残高: 1,500 コイン" in text
    assert "役職 テレポーター（熟練ランク 3）" in text
    assert "現在地: world (10.5, -4.5)" in text
    assert "所属ユニオン: AGO国（国民）" in text


def test_build_state_lines_fallbacks():
    st = _load_state_module()
    no_prof = st.build_state_lines(
        user_id="999",
        balance=None,
        profile=None,
        presence=None,
        save=None,
        nation_name=None,
        nation_role=None,
    )
    assert any("取得できませんでした" in line for line in no_prof)
    assert any("未プレイ" in line for line in no_prof)

    with_save = st.build_state_lines(
        user_id="999",
        balance=0,
        profile={"hp": 100, "hunger": 100, "role": "free"},
        presence=None,
        save={"space": "lobby", "x": 28.5, "y": 32.5},
        nation_name=None,
        nation_role=None,
    )
    joined = "\n".join(with_save)
    assert "最終位置: lobby (28.5, 32.5)" in joined
    assert "所属ユニオン: なし" in joined


def test_backup_namespaces_cover_all_live_stores():
    namespaces = _backup_namespaces()
    assert "worldbox_war" not in namespaces
    assert len(namespaces) == len(set(namespaces))
    assert namespaces == sorted(namespaces)

    ns_def_re = re.compile(r'(?:NAMESPACE|NS)\s*=\s*"(worldbox_[a-z0-9_]+)"')
    expected = set()
    for p in (ROOT / "web" / "lib" / "worldbox").glob("*.ts"):
        expected.update(ns_def_re.findall(p.read_text(encoding="utf-8")))
    expected.update(
        ns_def_re.findall((ROOT / "web" / "app" / "api" / "worldbox" / "plaza" / "route.ts").read_text(encoding="utf-8"))
    )

    missing = sorted(expected - set(namespaces))
    assert not missing, f"missing namespaces in worldbox_backup.py: {missing}"
