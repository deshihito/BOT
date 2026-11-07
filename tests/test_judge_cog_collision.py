"""judgement と judge_comment の両機能がロードできることの回帰テスト。

両モジュールが同名の ``JudgeCog`` クラスを定義していたため、discord.py の
cog 名一意性チェック（ClientException: Cog named 'JudgeCog' already loaded）に
引っかかり、後から読み込まれた方が常時ロード失敗していた（どちらが死ぬかは
os.listdir の順序依存）。judge_comment 側を ``JudgeCommentCog`` に改名したので、
読み込み順序によらず両機能が共存できることを確認する。

judgement はラズパイにだけ入っている ``needle`` に依存する。無い環境では
import 用の最小スタブを差し込んでテストする（実物がある環境ではそちらを使う）。
"""
import asyncio
import importlib
import importlib.util
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# test_cog_loading と同じダミー値（読み込みだけを確かめる。実際の通信はしない）
for name, value in {
    "BOT_API_BASE_URL": "http://127.0.0.1:8787",
    "BOT_API_KEY": "dummy-key",
    "GROQ_API_KEY": "dummy-key",
    "GEMINI_API_KEY": "dummy-key",
}.items():
    os.environ.setdefault(name, value)

import discord
from discord.ext import commands


def _install_needle_stub():
    """needle が無い環境向けに import 用スタブを差し込む。差し込んだら True。"""
    if importlib.util.find_spec("needle") is not None:
        return False
    stub = types.ModuleType("needle")
    stub.extract = lambda *args, **kwargs: None
    sys.modules["needle"] = stub
    return True


class JudgeCogCollisionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._cwd = os.getcwd()
        os.chdir(ROOT)
        cls._stubbed = _install_needle_stub()

    @classmethod
    def tearDownClass(cls):
        os.chdir(cls._cwd)
        if cls._stubbed:
            # スタブ前提で読み込まれたモジュールを残すと他のテストに漏れるため掃除する
            sys.modules.pop("needle", None)
            sys.modules.pop("core.general.judgement.cog", None)

    async def _load_both(self, order):
        # 集約入口 cogs/general.py 経由ではなく、衝突の当事者である2機能の
        # setup を指定順に直接呼ぶ（旧 cogs.judgement / cogs.judge_comment
        # extension の読み込みに相当）。
        modules = {
            "cogs.judgement": "core.general.judgement.cog",
            "cogs.judge_comment": "core.general.judge_comment.cog",
        }
        bot = commands.Bot(command_prefix="!", intents=discord.Intents.all())
        try:
            for ext in order:
                module = importlib.import_module(modules[ext])
                await module.setup(bot)
            return bot
        except Exception:
            await bot.close()
            raise

    def test_cog_names_are_distinct(self):
        from core.general.judge_comment import cog as judge_comment
        from core.general.judgement import cog as judgement

        self.assertEqual(judgement.JudgeCog.__cog_name__, "JudgeCog")
        self.assertEqual(judge_comment.JudgeCommentCog.__cog_name__, "JudgeCommentCog")
        self.assertIsNot(judgement.JudgeCog, judge_comment.JudgeCommentCog)

    def test_both_extensions_load_judgement_first(self):
        async def run():
            bot = await self._load_both(["cogs.judgement", "cogs.judge_comment"])
            try:
                from core.general.judge_comment import cog as judge_comment
                from core.general.judgement import cog as judgement

                judge = bot.get_cog("JudgeCog")
                comment = bot.get_cog("JudgeCommentCog")
                self.assertIsInstance(judge, judgement.JudgeCog)
                self.assertIsInstance(comment, judge_comment.JudgeCommentCog)
                # judge_comment 側のリスナーが登録されていること
                listener_names = [name for name, _ in comment.get_listeners()]
                self.assertIn("on_message", listener_names)
            finally:
                await bot.close()

        asyncio.run(run())

    def test_both_extensions_load_judge_comment_first(self):
        # 元バグは読み込み順で死ぬ側が変わったため、逆順でも共存できることを確認する
        async def run():
            bot = await self._load_both(["cogs.judge_comment", "cogs.judgement"])
            try:
                from core.general.judge_comment import cog as judge_comment
                from core.general.judgement import cog as judgement

                self.assertIsInstance(bot.get_cog("JudgeCog"), judgement.JudgeCog)
                self.assertIsInstance(
                    bot.get_cog("JudgeCommentCog"), judge_comment.JudgeCommentCog
                )
            finally:
                await bot.close()

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
