"""アプリ絵文字ロールアウトの同型バグ再発防止ガード。

Discord はコンポーネントの label / placeholder 文字列内ではカスタム絵文字
markup を描画しない (本文/TextDisplay/Embed では描画される)。そのため:

- label= / placeholder= 引数に core.support.emojis の定数や "<:" markup を埋めない
  (絵文字は emoji= 引数側で持たせる)。
- 通常文字列 (f文字列でないセグメント) に {MUSIC} のような定数名
  プレースホルダを残さない (暗黙の文字列連結で f文字列に混ざると
  そのセグメントだけ展開されず波括弧ごと表示される)。

対象は修正済みモジュール群。入力書式の例示 placeholder や Embed の
title は描画・用途が異なるため対象外 (監査で個別に disposition 済み)。
"""
import ast
import re
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

TARGET_FILES = [
    *sorted((REPO_ROOT / "core/vc/music").glob("*.py")),
    REPO_ROOT / "core/support/binjou.py",
    REPO_ROOT / "core/game/chess/cog.py",
    REPO_ROOT / "core/game/shogi/cog.py",
]

_SINGLE_BRACE = re.compile(r"(?<!\{)\{([A-Za-z_][A-Za-z0-9_]*)\}(?!\})")


def _emoji_names(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.endswith("emojis"):
            for alias in node.names:
                if alias.name == "*":
                    # star import: core.support.emojis の全定数名を対象にする
                    emojis_tree = ast.parse(
                        (REPO_ROOT / "core/support/emojis.py").read_text(encoding="utf-8"))
                    for top in emojis_tree.body:
                        if isinstance(top, ast.Assign):
                            for target in top.targets:
                                if isinstance(target, ast.Name):
                                    names.add(target.id)
                else:
                    names.add(alias.asname or alias.name)
    return names


def _value_uses_emoji(node, emoji_names):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and sub.id in emoji_names:
            return True
        if isinstance(sub, ast.Attribute) and sub.attr in emoji_names:
            return True
        if isinstance(sub, ast.Constant) and isinstance(sub.value, str) and "<:" in sub.value:
            return True
    return False


def _violations(path):
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    emoji_names = _emoji_names(tree)
    found = []

    joined_segments = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            for value in node.values:
                joined_segments.add(id(value))
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    for match in _SINGLE_BRACE.finditer(value.value):
                        if match.group(1) in emoji_names:
                            found.append(
                                f"{path.name}:{value.lineno} f文字列セグメントに "
                                f"{{{match.group(1)}}} が残っている")
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) \
                and id(node) not in joined_segments:
            for match in _SINGLE_BRACE.finditer(node.value):
                if match.group(1) in emoji_names:
                    found.append(
                        f"{path.name}:{node.lineno} 通常文字列に "
                        f"{{{match.group(1)}}} が残っている")
        if isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg in ("label", "placeholder") \
                        and _value_uses_emoji(kw.value, emoji_names):
                    found.append(
                        f"{path.name}:{node.lineno} {kw.arg}= にアプリ絵文字が埋め込まれている")
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Attribute) and target.attr in ("label", "placeholder") \
                        and _value_uses_emoji(node.value, emoji_names):
                    found.append(
                        f"{path.name}:{node.lineno} .{target.attr} 代入にアプリ絵文字が埋め込まれている")
    return found


class EmojiComponentGuardTest(unittest.TestCase):
    def test_no_emoji_markup_in_component_labels(self):
        violations = []
        for path in TARGET_FILES:
            violations.extend(_violations(path))
        self.assertEqual(violations, [])


class ChessShogiPageOptionsEmojiTest(unittest.TestCase):
    def test_chess_page_options_use_emoji_arg(self):
        from core.game.chess.cog import page_options
        first = page_options([("1", None)], 0, 2)
        self.assertEqual(first[-1].label, "次のページ")
        self.assertIsNotNone(first[-1].emoji)
        self.assertEqual(first[-1].emoji.name, "Right")
        second = page_options([("2", None)], 1, 2)
        self.assertEqual(second[-1].label, "前のページ")
        self.assertIsNotNone(second[-1].emoji)
        self.assertEqual(second[-1].emoji.name, "Left")


class BinjouViewEmojiTest(unittest.TestCase):
    def test_thinking_buttons_use_emoji_arg(self):
        from core.support.binjou import EmojiBinjouView
        view = EmojiBinjouView(types.SimpleNamespace(), {})
        thinking = [
            child for child in view.children
            if getattr(child, "emoji", None) is not None and child.emoji.name == "thinking"
        ]
        self.assertEqual(sorted(child.label for child in thinking), ["オフ", "オン"])
        for child in view.children:
            label = getattr(child, "label", None)
            if isinstance(label, str):
                self.assertNotIn("<:", label)


class SpatialControlViewEmojiTest(unittest.TestCase):
    def _view(self, rot_mode):
        from core.vc.music.spatial import SpatialControlView
        state = {"spatial_rot_mode": rot_mode}
        cog = types.SimpleNamespace(get_state=lambda guild_id: state)
        return SpatialControlView(cog, 1)

    def test_rot_off_uses_pause_emoji_arg(self):
        view = self._view("off")
        self.assertEqual(view.toggle_rot_mode.label, "回転: OFF")
        self.assertIsNotNone(view.toggle_rot_mode.emoji)
        self.assertEqual(view.toggle_rot_mode.emoji.name, "Pause")

    def test_rot_standard_has_text_label_without_emoji(self):
        view = self._view("standard")
        self.assertEqual(view.toggle_rot_mode.label, "🌀 回転: 通常")
        self.assertIsNone(view.toggle_rot_mode.emoji)

    def test_select_placeholders_and_options_have_no_markup(self):
        # AGC セレクトは廃止されたため、現行の全セレクトを対象にする:
        # placeholder / option label に絵文字 markup を埋めず、絵文字は
        # emoji= 引数 (オブジェクト) でのみ持つことを守る。
        view = self._view("standard")
        selects = [
            child for child in view.children
            if getattr(child, "placeholder", None)]
        self.assertTrue(selects)
        for select in selects:
            self.assertNotIn("<:", select.placeholder)
            self.assertTrue(select.options)
            for option in select.options:
                self.assertNotIn("<:", option.label)
                if option.emoji is not None:
                    self.assertNotIn("<:", option.emoji.name or "")


if __name__ == "__main__":
    unittest.main()
