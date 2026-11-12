import asyncio
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
from cogs.game import COOLDOWN, BumpRta, DISBOARD_BOT_ID, DISOKU_BOT_ID, detect_event
from cogs.support import SupportCog

# 実物の discord.Message では created_at は Snowflake (id) から導かれる時刻と
# 一致する。旧フェイクは id を持たず created_at と interaction 時刻も食い違って
# いたため、現行の _event_time (REMINDER_ANCHOR="latest": メッセージの
# Snowflake 時刻、編集があればその時刻) では検知できなかった。
# 他の RTA テスト (test_disboard_rta_sabacha.py 等) と同じく、created_at から
# Snowflake を作って両者を一致させる。
MESSAGE_AT = datetime(2026, 10, 13, 8, 0, 1, tzinfo=timezone.utc)
MESSAGE_ID = (int(MESSAGE_AT.timestamp() * 1000) - 1420070400000) << 22


class BumpRtaDetectionTest(unittest.TestCase):
    def make_message(self, author_id, description, *, user_id=123, application_id=None,
                     channel_type=discord.ChannelType.text,
                     interaction_type=discord.InteractionType.application_command,
                     embed_title=None, embed_url=None, embed_fields=()):
        interaction_metadata = None
        if interaction_type is not None:
            interaction_metadata = SimpleNamespace(
                type=interaction_type,
                user=SimpleNamespace(id=user_id) if user_id is not None else None,
                created_at=datetime(2026, 10, 13, 8, 0, 0, tzinfo=timezone.utc),
            )
        embeds = []
        if description or embed_title or embed_fields:
            embeds = [SimpleNamespace(
                title=embed_title, description=description, url=embed_url,
                fields=[SimpleNamespace(name=n, value=v) for n, v in embed_fields],
            )]
        return SimpleNamespace(
            id=MESSAGE_ID,
            guild=SimpleNamespace(id=456),
            channel=SimpleNamespace(type=channel_type),
            author=SimpleNamespace(id=author_id, bot=True),
            application_id=application_id if application_id is not None else author_id,
            webhook_id=None,
            interaction_metadata=interaction_metadata,
            interaction=None,
            created_at=MESSAGE_AT,
            edited_at=None,
            embeds=embeds,
            components=[],
            content="",
        )

    def make_disoku_message(self, **kwargs):
        # 実物のディス速成功応答 (test_disboard_rta_notify_flow.py の実キャプチャ
        # 形状): 公式タイトル/URL の Embed で、サーバー名フィールドが
        # 「をアップしたよ」で終わる。旧フェイクは本文にフレーズを置くだけで、
        # 現行の署名照合 (タイトル+URL+フィールド) を満たさなかった。
        return self.make_message(
            DISOKU_BOT_ID, None,
            embed_title="ディス速 | Discordサーバー・友達募集・ボット掲示板",
            embed_url="https://dissoku.net/ja",
            embed_fields=(("Lunachan.com をアップしたよ! 🙏", "成功"),),
            **kwargs)

    def test_configured_service_ids(self):
        self.assertEqual(DISBOARD_BOT_ID, 302050872383242240)
        self.assertEqual(DISOKU_BOT_ID, 761562078095867916)

    def test_disboard_japanese_embed_is_bump(self):
        message = self.make_message(DISBOARD_BOT_ID, "表示順をアップしたよ 👍")
        event = detect_event(message)
        self.assertEqual(event[:2], ("bump", 123))
        # イベント時刻は interaction 時刻ではなくメッセージの Snowflake 時刻
        self.assertEqual(event[2].isoformat(), "2026-10-13T08:00:01+00:00")
        self.assertIsNone(event[3])

    def test_disboard_english_embed_is_bump(self):
        event = detect_event(self.make_message(DISBOARD_BOT_ID, "Bump done!"))
        self.assertEqual(event[0], "bump")

    def test_disoku_embed_is_separate_up_event(self):
        event = detect_event(self.make_disoku_message())
        self.assertEqual(event[0], "up")
        self.assertEqual(event[1], 123)

    def test_disoku_description_only_is_not_enough(self):
        # 署名 (公式タイトル/URL+フィールド) を欠く本文だけの投稿は Dis速扱いしない
        self.assertIsNone(detect_event(self.make_message(
            DISOKU_BOT_ID, "Lunachan.com をアップしたよ! 🙏")))

    def test_wrong_bot_application_or_text_is_ignored(self):
        self.assertIsNone(detect_event(self.make_message(999, "表示順をアップしたよ")))
        # application_id だけが Disboard でも、投稿者 (author) が公式Botでなければ不可。
        # 現行本番は Disboard を author で判定し、application_id 単独の一致では
        # 検知しない (他サービスは author/application/webhook のいずれかで照合)。
        self.assertIsNone(detect_event(self.make_message(
            999, "表示順をアップしたよ", application_id=DISBOARD_BOT_ID)))
        self.assertIsNone(detect_event(self.make_message(DISBOARD_BOT_ID, "あと2時間待ってください")))
        self.assertIsNone(detect_event(self.make_message(DISBOARD_BOT_ID, "表示順をアップしたよ", channel_type=discord.ChannelType.private)))

    def test_interaction_metadata_supplies_user_and_time_but_is_optional(self):
        with_metadata = self.make_message(
            DISBOARD_BOT_ID, "表示順をアップしたよ", interaction_type=discord.InteractionType.application_command)
        self.assertEqual(detect_event(with_metadata)[1], 123)
        without_metadata = self.make_message(
            DISBOARD_BOT_ID, "表示順をアップしたよ", user_id=None, interaction_type=None)
        self.assertIsNone(detect_event(without_metadata)[1])
        self.assertEqual(detect_event(without_metadata)[2], without_metadata.created_at)

    def test_non_command_interaction_is_ignored(self):
        msg = self.make_message(
            DISBOARD_BOT_ID, "表示順をアップしたよ", interaction_type=discord.InteractionType.component)
        self.assertIsNone(detect_event(msg))


class BumpRtaCogTest(unittest.IsolatedAsyncioTestCase):
    async def test_notifications_default_to_on(self):
        cog = BumpRta(SimpleNamespace(db_api=None))
        self.assertTrue(await cog._is_enabled(123))

    async def test_disabled_cache_is_respected(self):
        cog = BumpRta(SimpleNamespace(db_api=None))
        cog._enabled_cache["123"] = False
        self.assertFalse(await cog._is_enabled(123))

    async def test_disboard_and_disoku_responses_schedule_separate_types(self):
        # 現行フロー: on_message は即時に「検知しました」を送らず、
        # _register_reminder で種類別にリマインダーを登録し、記録・永続化・
        # RTAタイマー開始を行う (core/game/rta/events.py)。旧テストがモック
        # していた _schedule_reminder と即時送信は廃止された。
        cog = BumpRta(SimpleNamespace(db_api=object()))
        cog._is_enabled = AsyncMock(return_value=True)
        cog._record_rta_event = AsyncMock()
        cog._persist_reminder = AsyncMock()
        cog._start_rta_timer = AsyncMock()
        try:
            for message_id, bot_id, kind in (
                (MESSAGE_ID, DISBOARD_BOT_ID, "bump"),
                (MESSAGE_ID + 1, DISOKU_BOT_ID, "up"),
            ):
                message = self.make_event_message(message_id, bot_id, kind)
                await cog.on_message(message)
                event_at = MESSAGE_AT
                # 即時送信はしない
                message.channel.send.assert_not_awaited()
                # 種類別にリマインダーが登録され、期限は event_at + COOLDOWN
                rem = cog._reminders[str(message_id)]
                self.assertEqual(rem.kind, kind)
                self.assertEqual(rem.user_id, 321)
                self.assertEqual(rem.due_ts, (event_at + COOLDOWN[kind]).timestamp())
                cog._record_rta_event.assert_any_await(message, kind, 321, event_at)
                cog._persist_reminder.assert_any_await(rem, [])
                cog._start_rta_timer.assert_any_await(rem)
            self.assertEqual(
                sorted(rem.kind for rem in cog._reminders.values()), ["bump", "up"])
        finally:
            tasks = list(cog._timers.values())
            for mid in list(cog._reminders):
                cog._cancel(mid)
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            cog._executor.shutdown(wait=False)
            cog._ntp_executor.shutdown(wait=False)

    def make_event_message(self, message_id, bot_id, kind):
        if kind == "up":
            embeds = [SimpleNamespace(
                title="ディス速 | Discordサーバー・友達募集・ボット掲示板",
                description=None, url="https://dissoku.net/ja",
                fields=[SimpleNamespace(name="Lunachan.com をアップしたよ! 🙏", value="成功")],
            )]
        else:
            embeds = [SimpleNamespace(
                title=None, description="表示順をアップしたよ 👍", url=None, fields=[])]
        return SimpleNamespace(
            id=message_id,
            guild=SimpleNamespace(id=456),
            channel=SimpleNamespace(id=789, type=discord.ChannelType.text, send=AsyncMock()),
            author=SimpleNamespace(id=bot_id, bot=True),
            application_id=bot_id,
            webhook_id=None,
            embeds=embeds,
            components=[],
            content="",
            created_at=MESSAGE_AT,
            edited_at=None,
            interaction_metadata=SimpleNamespace(
                type=discord.InteractionType.application_command,
                user=SimpleNamespace(id=321),
                created_at=datetime(2026, 10, 13, 8, 0, 0, tzinfo=timezone.utc),
            ),
            interaction=None,
        )

    def test_support_is_the_single_app_command(self):
        self.assertEqual(BumpRta.__cog_app_commands__, [])
        names = [command.name for command in SupportCog.__cog_app_commands__]
        self.assertEqual(names, ["support"])


if __name__ == "__main__":
    unittest.main()
