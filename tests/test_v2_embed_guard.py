# -*- coding: utf-8 -*-
"""Components V2 と embeds の併用 (50035) の再発防止ガード。

Discord は IS_COMPONENTS_V2 フラグ付きメッセージで embeds を使えず、
送信/編集ペイロードに「空でない embeds」と「V2 ビュー」が同居すると
400 Bad Request (error code: 50035) になる。embed=None (embed のクリア)
と V2 ビューの併用は edit_panel_v2 の正規パターンなので対象外。

静的に断定できるのは「同じ呼び出しの中で embed(s)= (None 以外) と
V2 ビュー生成 (as_panel_v2 / as_embed_v2 / wrap_panel_view /
PanelLayoutView / EmbedLayoutView) を同時に渡す」形だけなので、
ガードの範囲はそこに限る。V2 で送信されたパネルの callback が
embed= で編集する形 (2026-11-10 の自動翻訳設定の障害) は呼び出し側と
送信側が離れていて静的には断定できないため、フローの回帰テスト
(tests/test_translation_panel_v2.py) で固定する。
"""
import ast
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TARGET_DIRS = [REPO_ROOT / "core", REPO_ROOT / "cogs"]
V2_VIEW_FUNCS = {
    "as_panel_v2", "as_embed_v2", "wrap_panel_view",
    "PanelLayoutView", "EmbedLayoutView",
}
SEND_EDIT_ATTRS = {
    "send", "send_message", "edit", "edit_message", "edit_original_response",
}


def _is_none(expr):
    return isinstance(expr, ast.Constant) and expr.value is None


def _builds_v2_view(expr):
    for node in ast.walk(expr):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name in V2_VIEW_FUNCS:
                return True
    return False


def _violations_in_source(src, label):
    found = []
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr not in SEND_EDIT_ATTRS:
            continue
        kwargs = {kw.arg: kw.value for kw in node.keywords if kw.arg}
        embed_expr = kwargs.get("embed", kwargs.get("embeds"))
        if embed_expr is None or _is_none(embed_expr):
            continue
        view_expr = kwargs.get("view")
        if view_expr is not None and _builds_v2_view(view_expr):
            found.append(
                f"{label}:{node.lineno} {func.attr}() が embed と V2 ビューを"
                "同時に渡しています (50035 になります)")
    return found


def _violations(path):
    return _violations_in_source(path.read_text(encoding="utf-8"),
                                 str(path.relative_to(REPO_ROOT)))


class V2EmbedGuardTest(unittest.TestCase):
    def test_no_embed_with_v2_view_in_same_call(self):
        violations = []
        for base in TARGET_DIRS:
            for path in sorted(base.rglob("*.py")):
                violations.extend(_violations(path))
        self.assertEqual(violations, [])

    def test_detector_catches_the_pattern(self):
        # ガード自体が壊れて何も検出しなくなることを防ぐ自己検証。
        bad = (
            "async def f(interaction, view):\n"
            "    await interaction.response.send_message(\n"
            "        embed=view.embed(), view=as_panel_v2(view))\n"
        )
        self.assertEqual(len(_violations_in_source(bad, "synthetic")), 1)
        ok_clear = (
            "async def f(interaction, view):\n"
            "    await interaction.response.edit_message(\n"
            "        embed=None, view=as_panel_v2(view))\n"
        )
        self.assertEqual(_violations_in_source(ok_clear, "synthetic"), [])
        ok_plain = (
            "async def f(interaction, view):\n"
            "    await interaction.response.edit_message(\n"
            "        embed=view.embed(), view=view)\n"
        )
        self.assertEqual(_violations_in_source(ok_plain, "synthetic"), [])


if __name__ == "__main__":
    unittest.main()
