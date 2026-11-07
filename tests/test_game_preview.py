# -*- coding: utf-8 -*-
"""開発先行公開フラグ（core/game/game/game_guides.py の PREVIEW_GAMES）のテスト。

フラグの単一の真実源・ハブ表示（セレクト/詳細/ガイド）・起動時通知・
ゲーム内パネルの注意行が、フラグの付け外しで切り替わることを確認する。
通信はしない。
"""
import random
import types
import unittest
from unittest.mock import patch

import discord

from game_fakes import (
    FakeBot, FakeChannel, FakeGuild, FakeInteraction, FakeMember,
    fast_time, real_sleep,
)
from core.game.game import game_guides
from core.game.game.game_guides import (
    GAME_GUIDES, GAME_ORDER, PREVIEW_GAMES, PREVIEW_LABEL, PREVIEW_NOTICE,
    guide_for_discord, is_preview_game, preview_notice_line,
)
from core.game.game.game_v2 import GamePanelView, LobbyView
from core.game.game.cog import GAME_COGS, GameHub, GameSelect, detail_embed, game_select_pages, select_label

EXPECTED_PREVIEW = {"wirecut", "liardice", "ito", "hanabi", "hoshi"}


def panel_text(view) -> str:
    return "\n".join(
        item.content or "" for item in view.walk_children()
        if isinstance(item, discord.ui.TextDisplay))


class PreviewSourceTest(unittest.TestCase):
    def test_initial_set(self):
        self.assertEqual(set(PREVIEW_GAMES), EXPECTED_PREVIEW)

    def test_flagged_games_are_registered(self):
        for game_id in PREVIEW_GAMES:
            self.assertIn(game_id, GAME_GUIDES)
            self.assertIn(game_id, GAME_ORDER)
            self.assertIn(game_id, GAME_COGS)

    def test_notice_line(self):
        for game_id in EXPECTED_PREVIEW:
            line = preview_notice_line(game_id)
            self.assertIsNotNone(line, game_id)
            self.assertIn(PREVIEW_LABEL, line)
            self.assertIn(PREVIEW_NOTICE, line)
        for game_id in ("quiz", "jinrou", "cipher", "insider"):
            self.assertIsNone(preview_notice_line(game_id), game_id)
            self.assertFalse(is_preview_game(game_id), game_id)


class GuideNoticeTest(unittest.TestCase):
    def test_guide_starts_with_notice_for_preview(self):
        for game_id in EXPECTED_PREVIEW:
            text = guide_for_discord(game_id)
            self.assertTrue(text.startswith(f"⚠ **{PREVIEW_LABEL}**"), game_id)
            self.assertIn(PREVIEW_NOTICE, text)
            self.assertLessEqual(len(text), 4096, game_id)

    def test_guide_unchanged_for_normal_games(self):
        for game_id in ("quiz", "jinrou", "cipher"):
            self.assertNotIn(PREVIEW_NOTICE, guide_for_discord(game_id))

    def test_guide_toggles_with_flag_set(self):
        with patch.object(game_guides, "PREVIEW_GAMES", frozenset({"quiz"})):
            self.assertIn(PREVIEW_NOTICE, guide_for_discord("quiz"))
            self.assertNotIn(PREVIEW_NOTICE, guide_for_discord("wirecut"))
        with patch.object(game_guides, "PREVIEW_GAMES", frozenset()):
            self.assertNotIn(PREVIEW_NOTICE, guide_for_discord("ito"))


class HubDisplayTest(unittest.TestCase):
    def _all_options(self):
        options = {}
        pages = game_select_pages()
        for i in range(len(pages)):
            select = GameSelect(page=i)
            for option in select.options:
                options[option.value] = option.label
        return options

    def test_select_labels(self):
        options = self._all_options()
        self.assertEqual(set(options), set(GAME_ORDER))
        for game_id, label in options.items():
            self.assertLessEqual(len(label), 100, game_id)
            if game_id in EXPECTED_PREVIEW:
                self.assertEqual(label, f"{GAME_GUIDES[game_id]['name']}（{PREVIEW_LABEL}）", game_id)
            else:
                self.assertEqual(label, GAME_GUIDES[game_id]["name"], game_id)

    def test_detail_embed(self):
        for game_id in EXPECTED_PREVIEW:
            embed = detail_embed(game_id)
            fields = {f.name: f.value for f in embed.fields}
            self.assertEqual(fields.get(f"⚠ {PREVIEW_LABEL}"), PREVIEW_NOTICE, game_id)
        embed = detail_embed("quiz")
        self.assertNotIn(f"⚠ {PREVIEW_LABEL}", [f.name for f in embed.fields])

    def test_hub_display_toggles_with_flag_set(self):
        with patch.object(game_guides, "PREVIEW_GAMES", frozenset({"quiz"})):
            self.assertEqual(select_label("quiz"),
                             f"{GAME_GUIDES['quiz']['name']}（{PREVIEW_LABEL}）")
            self.assertEqual(select_label("wirecut"), GAME_GUIDES["wirecut"]["name"])
            fields = {f.name: f.value for f in detail_embed("quiz").fields}
            self.assertEqual(fields.get(f"⚠ {PREVIEW_LABEL}"), PREVIEW_NOTICE)
            fields = {f.name: f.value for f in detail_embed("wirecut").fields}
            self.assertNotIn(f"⚠ {PREVIEW_LABEL}", fields)


class PanelNoticeTest(unittest.TestCase):
    def test_panel_without_notice_is_legacy_format(self):
        view = GamePanelView("題", "本文")
        self.assertEqual(panel_text(view), "## 題\n本文")

    def test_panel_with_notice(self):
        line = preview_notice_line("wirecut")
        view = GamePanelView("題", "本文", notice=line)
        self.assertEqual(panel_text(view), f"## 題\n{line}\n本文")

    def test_notice_survives_set_content(self):
        line = preview_notice_line("ito")
        view = GamePanelView("題", "本文", notice=line)
        view.set_content(body="差し替え")
        text = panel_text(view)
        self.assertIn(line, text)
        self.assertIn("差し替え", text)

    def test_lobby_view_notice(self):
        host = types.SimpleNamespace(id=42)
        line = preview_notice_line("hanabi")
        view = LobbyView(title="募集", host=host, min_players=2, max_players=4, notice=line)
        self.assertIn(line, panel_text(view))
        plain = LobbyView(title="募集", host=host, min_players=2, max_players=4)
        self.assertNotIn(PREVIEW_NOTICE, panel_text(plain))


class CogPanelTest(unittest.TestCase):
    def test_wirecut_main_panel(self):
        from cogs.wirecut import WireCut
        from core.game.wirecut.wirecut import WireCutGame
        cog = WireCut(FakeBot())
        panel = cog._panel(WireCutGame([1, 2]))
        self.assertIn(preview_notice_line("wirecut"), panel_text(panel))

    def test_liardice_main_panel(self):
        from cogs.liardice import LiarDice
        from core.game.liardice.liardice import LiarDiceGame
        cog = LiarDice(FakeBot())
        panel = cog._panel(LiarDiceGame([1, 2]))
        self.assertIn(preview_notice_line("liardice"), panel_text(panel))

    def test_hanabi_main_panel(self):
        from cogs.hanabi import Hanabi
        from core.game.hanabi.hanabi import HanabiGame
        cog = Hanabi(FakeBot())
        panel = cog._panel(123, HanabiGame([1, 2]))
        self.assertIn(preview_notice_line("hanabi"), panel_text(panel))


class CogPanelAsyncTest(unittest.IsolatedAsyncioTestCase):
    async def test_wirecut_recruit_panel(self):
        from cogs.wirecut import WireCut
        guild = FakeGuild()
        channel = FakeChannel(777, guild)
        host = FakeMember(1, guild)
        cog = WireCut(FakeBot(channel))
        inter = FakeInteraction(host, channel)
        with fast_time():
            await cog.start_recruit(inter)
            await real_sleep(0.3)
        view = inter.response.sent[0].view
        self.assertIn(preview_notice_line("wirecut"), panel_text(view))

    async def test_ito_round_panel(self):
        from cogs.ito import Ito
        from core.game.ito.ito import ItoSession
        guild = FakeGuild()
        channel = FakeChannel(778, guild)
        cog = Ito(FakeBot(channel))
        session = ItoSession([1, 2], ["テーマ"])
        session.next_round()
        await cog._round_panel(channel, session)
        self.assertIn(preview_notice_line("ito"), panel_text(channel.sent[0].view))

    async def test_hoshi_phase_panel(self):
        from cogs.hoshi import Hoshi
        from core.game.hoshi.hoshi import HoshiGame
        guild = FakeGuild()
        channel = FakeChannel(779, guild)
        cog = Hoshi(FakeBot(channel))
        game = HoshiGame([1, 2, 3], rng=random.Random(0))
        await cog._phase_panel(channel, game)
        self.assertIn(preview_notice_line("hoshi"), panel_text(channel.sent[0].view))


class _RecordingFollowup:
    def __init__(self):
        self.calls = []

    async def send(self, content=None, **kwargs):
        self.calls.append((content, kwargs))


class _StubCog:
    def __init__(self):
        self.started = 0

    async def start_recruit(self, interaction, *args, **kwargs):
        self.started += 1
        await interaction.response.send_message("募集を開始しました")


class _StubBot:
    def __init__(self, cogs):
        self._cogs = cogs

    def get_cog(self, name):
        return self._cogs.get(name)


class StartNoticeTest(unittest.IsolatedAsyncioTestCase):
    def _setup(self, cogs):
        guild = FakeGuild()
        channel = FakeChannel(780, guild)
        host = FakeMember(1, guild)
        hub = GameHub(_StubBot(cogs))
        inter = FakeInteraction(host, channel)
        inter.followup = _RecordingFollowup()
        return hub, inter

    async def test_preview_game_sends_start_notice_once(self):
        stub = _StubCog()
        hub, inter = self._setup({"WireCut": stub})
        await hub.start_game(inter, "wirecut")
        await real_sleep(0.5)
        self.assertEqual(stub.started, 1)
        self.assertEqual(len(inter.followup.calls), 1)
        content, kwargs = inter.followup.calls[0]
        self.assertIn(PREVIEW_LABEL, content)
        self.assertIn(PREVIEW_NOTICE, content)
        self.assertTrue(kwargs.get("ephemeral"))

    async def test_normal_game_sends_no_notice(self):
        stub = _StubCog()
        hub, inter = self._setup({"Quiz": stub})
        await hub.start_game(inter, "quiz")
        await real_sleep(0.5)
        self.assertEqual(stub.started, 1)
        self.assertEqual(inter.followup.calls, [])

    async def test_missing_cog_sends_no_notice(self):
        hub, inter = self._setup({})
        await hub.start_game(inter, "wirecut")
        await real_sleep(0.3)
        self.assertEqual(inter.followup.calls, [])
        self.assertEqual(len(inter.response.sent), 1)  # 利用不可の案内だけ


if __name__ == "__main__":
    unittest.main()
