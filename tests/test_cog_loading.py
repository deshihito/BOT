"""Discord に接続せずに cogs/ 配下の全拡張が読み込めるかを確認するテスト。

依存パッケージの書き忘れ、消えたファイルへの import、スラッシュコマンド名の重複を
起動前に検出するためのもの。外部サービスのキーはダミー値を入れて読み込みだけを確かめる。
"""
import asyncio
import importlib.util
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# 読み込み時にクライアントを作る cog 用のダミー値（実際の通信はしない）
for name, value in {
    "BOT_API_BASE_URL": "http://127.0.0.1:8787",
    "BOT_API_KEY": "dummy-key",
    "GROQ_API_KEY": "dummy-key",
    "GEMINI_API_KEY": "dummy-key",
}.items():
    os.environ.setdefault(name, value)

import discord
from discord.ext import commands

# ラズパイにだけ入っている（PyPI にない）ライブラリを使う cog。
# ライブラリが無い環境では読み込みチェックを飛ばす。
OPTIONAL_MODULES = {
    "cogs.judgement": "needle",  # needle3（軽量の意思決定モデル）
}


def _cog_modules():
    # main.py と同じ条件（.py で、__ で始まらない）
    return sorted(
        f"cogs.{name[:-3]}"
        for name in os.listdir(os.path.join(ROOT, "cogs"))
        if name.endswith(".py") and not name.startswith("__")
    )


class CogLoadingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._cwd = os.getcwd()
        os.chdir(ROOT)
        cls.failures, cls.skipped, cls.slash_names = {}, [], []

        async def run():
            bot = commands.Bot(command_prefix="!", intents=discord.Intents.all())
            for ext in _cog_modules():
                module = OPTIONAL_MODULES.get(ext)
                if module and importlib.util.find_spec(module) is None:
                    cls.skipped.append(ext)
                    continue
                try:
                    await bot.load_extension(ext)
                except Exception as exc:  # noqa: BLE001 - collect every failure
                    cause = exc.__cause__ or exc
                    cls.failures[ext] = f"{type(cause).__name__}: {cause}"
            cls.slash_names = [c.qualified_name for c in bot.tree.get_commands()]
            # バックグラウンドタスクを止めるため全拡張をアンロードする
            for ext in list(bot.extensions):
                try:
                    await bot.unload_extension(ext)
                except Exception:  # noqa: BLE001
                    pass
            await bot.close()

        asyncio.run(run())

    @classmethod
    def tearDownClass(cls):
        os.chdir(cls._cwd)

    def test_all_cogs_load(self):
        detail = "\n".join(f"{k}: {v}" for k, v in self.failures.items())
        self.assertEqual(self.failures, {}, f"読み込みに失敗した拡張があります:\n{detail}")

    def test_slash_command_names_are_unique(self):
        dupes = sorted({n for n in self.slash_names if self.slash_names.count(n) > 1})
        self.assertEqual(dupes, [], f"重複したスラッシュコマンド名: {dupes}")

    def test_slash_command_limit(self):
        # Discord のグローバルスラッシュコマンド上限は 100 個
        self.assertLessEqual(len(self.slash_names), 100)


if __name__ == "__main__":
    unittest.main()
