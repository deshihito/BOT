"""グローバルチャットの荒らし対策のテスト。Supabase は使わず、一時フォルダの bot_kv.json にだけ書く。"""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.support import globalchat_moderation as mod  # noqa: E402
from core.support import guild_settings  # noqa: E402
from core.support.storage import KVStore  # noqa: E402
from cogs import globalchat  # noqa: E402


class NormalizeTest(unittest.TestCase):
    def test_nfkc_kana_lower(self):
        self.assertEqual(mod.normalize("ＳＰＡＭ スパム ｽﾊﾟﾑ"), "spamすぱむすぱむ")

    def test_find_ng_word(self):
        self.assertEqual(mod.find_ng_word("おまえ ｼ ﾈ", ["しね"]), "しね")
        self.assertEqual(mod.find_ng_word("FUCK", mod.DEFAULT_NG_WORDS), "fuck")
        self.assertEqual(mod.find_ng_word("https://Discord.gg/abc", mod.DEFAULT_NG_WORDS), "discord.gg/")
        self.assertIsNone(mod.find_ng_word("シネマに行こう", mod.DEFAULT_NG_WORDS))
        self.assertIsNone(mod.find_ng_word("hello", ["", " "]))

    def test_parse(self):
        self.assertEqual(mod.parse_words("スパム、すぱむ\nad, "), ["スパム", "ad"])
        self.assertEqual(mod.parse_ids("<@1>, 2 2 x <#3>"), [1, 2, 3])


class RateLimiterTest(unittest.TestCase):
    def test_limit_and_cooldown(self):
        now = [0.0]
        rl = mod.RateLimiter(limit=5, window=10, cooldown=30, max_cooldown=300, clock=lambda: now[0])
        for _ in range(5):
            self.assertTrue(rl.check(1)[0])
            now[0] += 1
        ok, wait, first = rl.check(1)
        self.assertEqual((ok, wait, first), (False, 30, True))
        self.assertTrue(rl.check(2)[0])  # 他の人は影響なし
        now[0] += 5
        ok, wait, first = rl.check(1)  # 送り続けると延びる
        self.assertFalse(ok)
        self.assertFalse(first)
        self.assertGreater(wait, 25)
        now[0] += 100
        self.assertTrue(rl.check(1)[0])

    def test_window_slides(self):
        now = [0.0]
        rl = mod.RateLimiter(limit=5, window=10, clock=lambda: now[0])
        for _ in range(20):
            self.assertTrue(rl.check(1)[0])
            now[0] += 2.5

    def test_repeat_offender_longer(self):
        now = [0.0]
        rl = mod.RateLimiter(limit=2, window=10, cooldown=10, max_cooldown=300, clock=lambda: now[0])
        rl.check(1); rl.check(1)
        self.assertEqual(rl.check(1)[1], 10)
        now[0] += 11
        rl.check(1); rl.check(1)
        self.assertEqual(rl.check(1)[1], 20)


class FakeChannel:
    def __init__(self, cid, guild):
        self.id, self.guild = cid, guild
        self.hook = types.SimpleNamespace(name="GlobalChat-Webhook", send=AsyncMock())

    def permissions_for(self, member):
        return types.SimpleNamespace(manage_webhooks=True)

    async def webhooks(self):
        return [self.hook]


def guild(gid):
    return types.SimpleNamespace(id=gid, name=f"g{gid}", me=object())


class CogTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        guild_settings.set_store(guild_settings.GuildSettings(
            KVStore("guild_settings", client=None, path=os.path.join(tmp.name, "kv.json"))))
        self.addCleanup(guild_settings.set_store, None)
        self.g1, self.g2, self.g3 = guild(1), guild(2), guild(3)
        self.c1, self.c2, self.c3 = FakeChannel(11, self.g1), FakeChannel(22, self.g2), FakeChannel(33, self.g3)
        chans = {c.id: c for c in (self.c1, self.c2, self.c3)}
        bot = types.SimpleNamespace(get_channel=chans.get)
        self.cog = globalchat.GlobalChatCog.__new__(globalchat.GlobalChatCog)
        self.cog.bot = bot
        self.cog.save_file = os.path.join(tmp.name, "gc.json")
        self.cog.active_channels = {11, 22, 33}
        self.cog.rate_limiter = mod.RateLimiter()

    def msg(self, content, user_id=7):
        author = types.SimpleNamespace(id=user_id, bot=False, display_name="u",
                                       display_avatar=types.SimpleNamespace(url="x"), send=AsyncMock())
        return types.SimpleNamespace(content=content, author=author, webhook_id=None, channel=self.c1,
                                     guild=self.g1, add_reaction=AsyncMock(), reply=AsyncMock())

    def sent(self):
        return [c.hook.send.await_count for c in (self.c1, self.c2, self.c3)]

    async def test_relay_normal(self):
        await self.cog.on_message(self.msg("こんにちは"))
        self.assertEqual(self.sent(), [0, 1, 1])

    async def test_default_ng_word_blocked_and_notified(self):
        m = self.msg("ﾌｧｯｸ fUcK")
        await self.cog.on_message(m)
        self.assertEqual(self.sent(), [0, 0, 0])
        m.author.send.assert_awaited_once()

    async def test_source_guild_word_blocks_everywhere(self):
        await mod.save(1, ng_words=["スパム"], blocked_users=[], blocked_guilds=[])
        await self.cog.on_message(self.msg("すぱむです"))
        self.assertEqual(self.sent(), [0, 0, 0])

    async def test_target_guild_word_skips_only_that_guild(self):
        await mod.save(2, ng_words=["ネタバレ"], blocked_users=[], blocked_guilds=[])
        await self.cog.on_message(self.msg("ねたばれ注意"))
        self.assertEqual(self.sent(), [0, 0, 1])

    async def test_dm_fail_falls_back_to_reply(self):
        m = self.msg("死ね")
        m.author.send.side_effect = RuntimeError("closed")
        await self.cog.on_message(m)
        m.add_reaction.assert_awaited_with("<:failed:1490986584676368535>")
        self.assertEqual(m.reply.await_args.kwargs["delete_after"], 10)

    async def test_block_user_and_guild(self):
        await mod.save(2, ng_words=[], blocked_users=[7], blocked_guilds=[])
        await mod.save(3, ng_words=[], blocked_users=[], blocked_guilds=[1])
        await self.cog.on_message(self.msg("hi"))
        self.assertEqual(self.sent(), [0, 0, 0])
        await self.cog.on_message(self.msg("hi", user_id=8))
        self.assertEqual(self.sent(), [0, 1, 0])

    async def test_rate_limit_notifies_once(self):
        msgs = [self.msg(f"m{i}") for i in range(8)]
        for m in msgs:
            await self.cog.on_message(m)
        self.assertEqual(self.sent(), [0, 5, 5])
        notified = sum(m.author.send.await_count for m in msgs)
        self.assertEqual(notified, 1)
