"""表示モダン化 §4.1: 閲覧系の公開化（ランキング/キュー/チャート/開始通知）。

- /game のランキングボタンは公開送信（wallet 直通 leaderboard と統一）
- 音楽キュー表示は公開送信
- 市場チャートは公開送信（保有量を含む市場パネル本体は本人のみ維持）
- /general の EXP ランキングは公開、EXP ステータスは本人のみ維持
- 対局の開始通知は公開、参加ACK 等の個別応答は ephemeral 維持
"""
import pathlib
import types
import unittest
from unittest.mock import AsyncMock, patch

import discord

ROOT = pathlib.Path(__file__).resolve().parents[1]


def fake_interaction():
    sent = {}

    async def send_message(content=None, **kwargs):
        sent["content"] = content
        sent.update(kwargs)

    interaction = types.SimpleNamespace(
        guild_id=123, guild=None,
        user=types.SimpleNamespace(id=456),
        response=types.SimpleNamespace(
            is_done=lambda: False,
            send_message=AsyncMock(side_effect=send_message),
            defer=AsyncMock(),
        ),
        followup=types.SimpleNamespace(send=AsyncMock()),
    )
    return interaction, sent


def find_button(view, *, custom_id=None, label=None):
    for item in view.children:
        if custom_id and getattr(item, "custom_id", None) == custom_id:
            return item
        if label and getattr(item, "label", None) == label:
            return item
    raise AssertionError(f"button not found: {custom_id or label}")


class GameRankingVisibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_ranking_button_posts_publicly(self):
        from cogs.game import GameDetailView

        view = GameDetailView(types.SimpleNamespace(), "ngword")
        interaction, sent = fake_interaction()
        embed = discord.Embed(title="ranking")
        with patch("cogs.game.ranking_embed", new=AsyncMock(return_value=embed)):
            button = find_button(view, custom_id="panel:game:ranking")
            await button.callback(interaction)
        self.assertIs(sent.get("embed"), embed)
        self.assertNotEqual(sent.get("ephemeral"), True)

    async def test_rating_button_stays_ephemeral(self):
        from cogs.game import GameDetailView

        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_cog=lambda _name: None))
        view = GameDetailView(cog, "jinrou")
        interaction, sent = fake_interaction()
        button = find_button(view, custom_id="panel:game:rating")
        await button.callback(interaction)
        self.assertEqual(sent.get("ephemeral"), True)


class MusicQueueVisibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_queue_impl_posts_publicly(self):
        from core.music.panel import PanelMixin

        mixin = PanelMixin.__new__(PanelMixin)
        mixin.build_queue_embed = lambda guild_id: discord.Embed(title="queue")
        interaction, sent = fake_interaction()
        await mixin._queue_impl(interaction)
        self.assertEqual(sent["embed"].title, "queue")
        self.assertNotEqual(sent.get("ephemeral"), True)


class MarketChartVisibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_chart_button_posts_publicly(self):
        from cogs.market import MarketView

        cog = types.SimpleNamespace(chart_path=lambda: __file__)
        view = MarketView(cog, 456)
        interaction, sent = fake_interaction()
        button = find_button(view, label="チャート")
        await button.callback(interaction)
        self.assertIn("file", sent)
        self.assertNotEqual(sent.get("ephemeral"), True)


class GeneralRankingVisibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_exp_ranking_dispatch_posts_publicly(self):
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(get_cog=lambda _name: None)
        interaction, sent = fake_interaction()
        await cog.dispatch_general(interaction, "exp_ranking")
        self.assertIn("view", sent)
        self.assertNotEqual(sent.get("ephemeral"), True)

    async def test_exp_status_dispatch_stays_ephemeral(self):
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(get_cog=lambda _name: None)
        interaction, sent = fake_interaction()
        await cog.dispatch_general(interaction, "exp_status")
        self.assertIn("view", sent)
        self.assertEqual(sent.get("ephemeral"), True)


class GameStartNoticeSourceTest(unittest.TestCase):
    """開始通知の入口だけ ephemeral な箇所が残っていないこと（個別ACKは維持）。"""

    START_FILES = {
        "cogs/chess.py": ("チェスの募集を開始しました", "CPU対戦"),
        "cogs/othello.py": ("オセロの募集を開始しました", "オセロCPU対戦"),
        "cogs/shogi.py": ("将棋の募集を開始しました", "将棋CPU対戦"),
        "cogs/poker.py": ("ポーカーの募集を開始しました",),
        "cogs/uno.py": ("UNOゲームの募集を開始しました",),
        "cogs/doubt.py": ("ダウトの募集を開始しました",),
        "cogs/babanuki.py": ("ババ抜きの募集を開始しました",),
        "cogs/daifugo.py": ("大富豪の募集を開始しました",),
        "cogs/janken.py": ("じゃんけんの募集を開始しました",),
        "cogs/ngword.py": ("NGワードの募集を開始しました",),
        "cogs/shinkei.py": ("神経衰弱の募集を開始しました",),
        "cogs/shiritori.py": ("お題しりとりの募集を開始しました",),
    }

    def test_start_notices_are_not_ephemeral(self):
        for rel, markers in self.START_FILES.items():
            lines = (ROOT / rel).read_text(encoding="utf-8").splitlines()
            for lineno, line in enumerate(lines, start=1):
                if any(marker in line for marker in markers):
                    window = "\n".join(lines[lineno - 1:lineno + 1])
                    self.assertNotIn(
                        "ephemeral=True", window,
                        f"{rel}:{lineno} の開始通知が ephemeral のままです",
                    )

    def test_join_acks_stay_ephemeral(self):
        text = (ROOT / "cogs/chess.py").read_text(encoding="utf-8")
        self.assertIn('send_message("参加しました。", ephemeral=True)', text)


if __name__ == "__main__":
    unittest.main()
