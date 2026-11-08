"""再起動復旧の配線完全性テスト。

A-1（人狼が game_restore.GAME_IDS 未登録で復旧が丸ごと死んだ）/
A-2（五目並べ・四目並べは GAME_IDS 登録済みで保存・復旧も実装済みなのに、
main.py の復旧ディスパッチに無く起動時に呼ばれなかった）型の事故を防ぐため、
次を機械的に検証する:

- GAME_IDS の各 game_id について、対応するゲーム cog（cogs/game.py の
  登録テーブル経由で特定する、モジュール内で定義された restore_after_restart
  持ち Cog クラス）が main.py の _restore_voice_sessions の
  ディスパッチ一覧に含まれていること
- 逆向き: GAME_IDS 外のゲーム cog がディスパッチ一覧に含まれていないこと
  （保存側が GAME_IDS で弾かれ、復旧だけが空回りする事故を防ぐ）
- main.py の復旧件数ログ用対応表 GAME_RESTORE_COG_IDS が
  GAME_IDS と過不足なく一致すること

main.py は import すると Bot 本体が生成されるため、ast で静的に読む。
"""

import ast
import importlib
import inspect
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 読み込み時にクライアントを作る cog 用のダミー値（test_cog_loading と同じ）
for _name, _value in {
    "BOT_API_BASE_URL": "http://127.0.0.1:8787",
    "BOT_API_KEY": "dummy-key",
    "GROQ_API_KEY": "dummy-key",
    "GEMINI_API_KEY": "dummy-key",
}.items():
    os.environ.setdefault(_name, _value)

from discord.ext import commands  # noqa: E402

import cogs.game as game_aggregator  # noqa: E402
from core.game.game import game_restore  # noqa: E402


def _main_tree():
    return ast.parse((ROOT / "main.py").read_text(encoding="utf-8"))


def dispatch_cog_names():
    """main.py の _restore_voice_sessions が回す cog 名の集合を ast で取り出す。"""
    names = set()
    for node in ast.walk(_main_tree()):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_restore_voice_sessions":
            for sub in ast.walk(node):
                if isinstance(sub, ast.For) and isinstance(sub.iter, ast.Tuple):
                    for elt in sub.iter.elts:
                        if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                            names.add(elt.value)
    return names


def logged_game_cog_ids():
    """main.py の GAME_RESTORE_COG_IDS（cog 名 → game_id）を ast で取り出す。"""
    for node in _main_tree().body:
        if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict)):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "GAME_RESTORE_COG_IDS"
                   for t in node.targets):
            continue
        return {k.value: v.value for k, v in zip(node.value.keys, node.value.values)
                if isinstance(k, ast.Constant) and isinstance(v, ast.Constant)}
    return {}


def restore_capable_game_cogs():
    """登録テーブルの全モジュールから、モジュール内で定義された
    restore_after_restart 持ち Cog クラスを {ラベル: [クラス名]} で集める。"""
    found = {}
    for label, module_path in game_aggregator._FEATURE_MODULES:
        module = importlib.import_module(module_path)
        names = [obj.__name__ for obj in vars(module).values()
                 if inspect.isclass(obj) and issubclass(obj, commands.Cog)
                 and obj.__module__ == module.__name__
                 and hasattr(obj, "restore_after_restart")]
        if names:
            found[label] = names
    return found


class RestoreWiringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dispatch = dispatch_cog_names()
        cls.game_cogs = restore_capable_game_cogs()
        cls.logged_ids = logged_game_cog_ids()

    def test_dispatch_list_found(self):
        # ast の読み取り自体が壊れたら他の検証が無意味になるための番兵
        self.assertIn("VoiceCog", self.dispatch)
        self.assertTrue(self.game_cogs)

    def test_every_game_id_has_exactly_one_restore_cog(self):
        for game_id in game_restore.GAME_IDS:
            with self.subTest(game_id=game_id):
                self.assertIn(
                    game_id, self.game_cogs,
                    f"{game_id}: 復旧可能な cog が登録テーブルから見つかりません")
                self.assertEqual(
                    len(self.game_cogs[game_id]), 1,
                    f"{game_id}: 復旧可能な cog が複数あります {self.game_cogs[game_id]}")

    def test_every_game_cog_is_dispatched(self):
        # A-2 型: GAME_IDS にあって保存・復旧実装もあるのに、起動時に呼ばれない
        for game_id in game_restore.GAME_IDS:
            for cog_name in self.game_cogs.get(game_id, []):
                with self.subTest(game_id=game_id, cog=cog_name):
                    self.assertIn(
                        cog_name, self.dispatch,
                        f"{cog_name}（{game_id}）が main.py の復旧ディスパッチにありません")

    def test_no_unregistered_game_cog_is_dispatched(self):
        # 逆向き: GAME_IDS 外のゲーム cog がディスパッチに紛れていないこと
        for label, names in self.game_cogs.items():
            if label in game_restore.GAME_IDS:
                continue
            for cog_name in names:
                with self.subTest(label=label, cog=cog_name):
                    self.assertNotIn(
                        cog_name, self.dispatch,
                        f"{cog_name}（{label}）は GAME_IDS 外なのにディスパッチにあります")

    def test_logged_game_ids_match_game_ids(self):
        # 復旧件数ログ用の対応表が GAME_IDS と過不足なく一致すること
        self.assertEqual(set(self.logged_ids.values()), set(game_restore.GAME_IDS))
        for cog_name, game_id in self.logged_ids.items():
            with self.subTest(cog=cog_name):
                self.assertIn(cog_name, self.game_cogs.get(game_id, []),
                              f"{cog_name} は {game_id} の復旧 cog ではありません")


if __name__ == "__main__":
    unittest.main()
