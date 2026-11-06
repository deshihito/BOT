"""表示モダン化 §4.1: 閲覧系の公開化（ランキング/キュー/チャート/開始通知）。

- /game のランキングボタンは公開送信（wallet 直通 leaderboard と統一）
- 音楽キュー表示は公開送信
- 市場チャートは公開送信（保有量を含む市場パネル本体は本人のみ維持）
- /general の EXP ランキングは公開、EXP ステータスは本人のみ維持
- 対局の開始通知は公開、参加ACK 等の個別応答は ephemeral 維持

ephemeral第2波（2026-11-06、ユーザー方針で上書き）: 既定は公開に反転。
EXP ステータス・参加/退出の成功ACK・ルートパネルも公開する。維持するのは
ゲームが壊れる秘密情報（手札・役職・各自のワード等）、認証・秘密情報、
他人の個人情報、入力/権限エラー通知、panel_recovery の開き直しだけ。
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
        from core.vc.music.panel import PanelMixin

        mixin = PanelMixin.__new__(PanelMixin)
        mixin.build_queue_embed = lambda guild_id: discord.Embed(title="queue")
        interaction, sent = fake_interaction()
        await mixin._queue_impl(interaction)
        self.assertEqual(sent["embed"].title, "queue")
        self.assertNotEqual(sent.get("ephemeral"), True)


class MarketChartVisibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_market_panel_posts_chart_file_publicly(self):
        # チャートボタンによる遷移は廃止し、市場パネルを開いた時点で
        # チャート画像を添付して embed 内にデフォルト表示する（公開）。
        import random
        import tempfile

        import cogs.market as market_module
        from core.general import market as market_core
        from cogs.market import MarketCog

        with tempfile.TemporaryDirectory() as tmp:
            store = market_core.MarketStore(
                pathlib.Path(tmp) / "market.json", rng=random.Random(42))
            cog = MarketCog(
                types.SimpleNamespace(get_cog=lambda _name: None), store=store)
            interaction, sent = fake_interaction()
            with patch.object(
                    market_module, "CHART_PATH", pathlib.Path(__file__)):
                await cog.show_market(interaction)
            self.assertIn("view", sent)
            self.assertIn("files", sent)
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

    async def test_exp_status_dispatch_is_public(self):
        # ephemeral第2波方針（2026-11-06）: EXPステータスも既定で公開する。
        from cogs.general import GeneralCog

        cog = GeneralCog.__new__(GeneralCog)
        cog.bot = types.SimpleNamespace(get_cog=lambda _name: None)
        interaction, sent = fake_interaction()
        await cog.dispatch_general(interaction, "exp_status")
        self.assertIn("view", sent)
        self.assertNotEqual(sent.get("ephemeral"), True)


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

    def test_join_acks_are_public(self):
        # ephemeral第2波方針（2026-11-06）: 参加・退出の成功ACKも公開する。
        text = (ROOT / "cogs/chess.py").read_text(encoding="utf-8")
        self.assertIn('send_message("参加しました。")', text)
        self.assertNotIn('send_message("参加しました。", ephemeral=True)', text)


if __name__ == "__main__":
    unittest.main()


class Wave2PublicSourceTest(unittest.TestCase):
    """第2波: 原則公開化と、維持した例外の回帰防止（ソース確認）。"""

    def read(self, rel):
        return (ROOT / rel).read_text(encoding="utf-8")

    def test_root_panels_are_public(self):
        self.assertNotIn("defer(ephemeral=True, thinking=True)", self.read("cogs/general.py"))
        # 導線最適化 M5: /game・/vc は履歴セレクトの読み込みのため defer→followup に
        # 変わったが、defer は ephemeral=False（公開）が既定で公開方針は不変。
        for rel in ("cogs/game.py", "core/vc/hub.py"):
            src = self.read(rel)
            # ルートコマンドの defer は公開（ephemeral 指定なし）であること
            self.assertIn("await interaction.response.defer(thinking=True)", src, rel)
            self.assertIn("await interaction.followup.send(view=as_panel_v2(view))", src, rel)

    def test_panels_have_owner_checks(self):
        for rel in ("core/general/panel.py", "core/vc/hub.py", "cogs/game.py", "cogs/help.py"):
            self.assertIn("interaction_check", self.read(rel), rel)

    def test_economy_panels_public_with_owner_check(self):
        for rel in ("core/general/items_cog/cog.py", "cogs/workshop.py", "cogs/circulation.py", "core/general/market_cog/cog.py"):
            self.assertIn("interaction_check", self.read(rel), rel)

    def test_exceptions_stay_ephemeral(self):
        # 手札表示（poker の交換後手札・daifugo の手札パネル）は維持
        self.assertIn("交換後の手札", self.read("cogs/poker.py"))
        self.assertIn("あなたの手札: {hand}", self.read("cogs/daifugo.py"))
        # wordwolf の自分のワード確認は維持
        self.assertIn("あなたのワードは", self.read("cogs/wordwolf.py"))
        # panel_recovery の開き直しは維持
        self.assertIn("ephemeral=True", self.read("cogs/panel_recovery.py"))
        # auth（認証・秘密情報）は維持
        self.assertIn("ephemeral=True", self.read("core/support/auth.py"))
