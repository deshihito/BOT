"""監査 #10「常時フッター／定型文の棚卸し」の結果を固定するテスト。

- /help: 📖 の凡例はカテゴリページ全ページのフッターから、概要（入口）へ移設
- /game: 詳細・ランキングの静的フッターを削除
- nation 状態表示: 空腹度の説明はフッターから空腹度フィールドのそばへ移設
- UNO 募集: ボタン説明の静的フッターを削除
Discord には接続しない。
"""

import asyncio
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))

import discord  # noqa: E402
from discord.ext import commands  # noqa: E402

from game_fakes import FakeBot, FakeChannel, FakeGuild, FakeInteraction, FakeMember, fast_time, press, real_sleep  # noqa: E402
from tests.test_all_commands import USER_ID, fake_interaction  # noqa: E402
from tests.test_nation import NationFakeDBAPI, run  # noqa: E402

from cogs import game as game_module  # noqa: E402
from cogs import nation as nation_module  # noqa: E402
from cogs import uno  # noqa: E402
from cogs.help import category_pages, overview_embed  # noqa: E402
from core.game.game.game_guides import GAME_ORDER  # noqa: E402

BOOK_LEGEND = "はガイド（くわしい説明）があるコマンドです"


def _catalog():
    return {
        "categories": [
            {"id": "general", "label": "一般", "description": "日常機能", "guide": ""},
        ],
        "commands": [
            {"name": "general", "kind": "slash", "hidden": False, "category": "general",
             "usage": "/general", "summary": "一般機能の操作パネルを表示します",
             "guide": "ガイド本文", "permissions": [], "options": [], "aliases": [],
             "guild_only": False},
        ],
    }


class HelpFooterTest(unittest.TestCase):
    def test_category_pages_have_no_book_legend_footer(self):
        pages = category_pages(_catalog(), "general")
        self.assertTrue(pages)
        for embed in pages:
            self.assertIsNone(embed.footer.text)
            # コマンド行の 📖 アイコン自体は残る（凡例の移設先は概要）
            self.assertIn("<:book:", embed.description)

    def test_overview_explains_book_icon(self):
        embed = overview_embed(_catalog())
        self.assertIn(BOOK_LEGEND, embed.description)


class GameFooterTest(unittest.TestCase):
    def test_detail_embed_has_no_footer(self):
        embed = game_module.detail_embed(GAME_ORDER[0])
        self.assertIsNone(embed.footer.text)
        field_names = [f.name for f in embed.fields]
        self.assertIn("人数の目安", field_names)
        self.assertIn("所要時間", field_names)

    def test_ranking_embed_has_no_footer(self):
        embed = asyncio.run(game_module.ranking_embed(None, GAME_ORDER[0]))
        self.assertIsNone(embed.footer.text)
        self.assertTrue(embed.title.endswith("のサーバーランキング"))


class NationStatusTest(unittest.TestCase):
    def setUp(self):
        self.db = NationFakeDBAPI()
        self.bot = commands.Bot(command_prefix="!", intents=discord.Intents.none())
        self.bot.db_api = self.db
        self.cog = nation_module.NationCog(self.bot)

    def call(self, name, user_id=USER_ID):
        interaction, _, _ = fake_interaction(self.bot)
        sent = []

        async def send(*args, **kwargs):
            sent.append(kwargs)

        interaction.user.id = user_id
        interaction.user.send = send
        interaction.user.guild_permissions = discord.Permissions.all()
        interaction.guild.owner_id = 1
        ctx = types.SimpleNamespace(guild=interaction.guild, author=interaction.user,
                                    send=send, bot=self.bot)
        run(getattr(self.cog, name).callback(self.cog, ctx))
        return sent

    def test_status_hunger_note_is_next_to_field_not_footer(self):
        self.call("found")
        self.call("join")
        sent = self.call("status")
        embed = sent[-1]["embed"]
        self.assertIsNone(embed.footer.text)
        hunger = next(f for f in embed.fields if f.name == "空腹度")
        self.assertIn("サーバーで発言すると少しずつ減ります", hunger.value)


class UnoLobbyFooterTest(unittest.IsolatedAsyncioTestCase):
    async def test_recruit_embed_has_no_footer(self):
        # 募集パネルは共通ロビー（V2）に移行し、embed 自体を持たない（footer も無い）
        guild = FakeGuild()
        channel = FakeChannel(200, guild)
        host = FakeMember(1, guild)
        cog = uno.Uno(FakeBot(channel))
        with fast_time():
            task = asyncio.create_task(cog.start_recruit(FakeInteraction(host, channel)))
            await real_sleep(0.05)
            panel = channel.sent[-1]
            self.assertIsNone(panel.embed)
            self.assertIsInstance(panel.view, uno.JoinView)
            await press(panel.view, "cancel", FakeInteraction(host, channel, message=panel))
            await task


if __name__ == "__main__":
    unittest.main()
