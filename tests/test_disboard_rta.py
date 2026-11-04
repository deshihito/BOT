import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
from cogs.disboard_rta import BumpRta, DISBOARD_BOT_ID, DISOKU_BOT_ID, detect_event
from cogs.support import SupportCog


class BumpRtaDetectionTest(unittest.TestCase):
    def make_message(self, author_id, description, *, user_id=123, application_id=None,
                     channel_type=discord.ChannelType.text,
                     interaction_type=discord.InteractionType.application_command):
        interaction_metadata = None
        if interaction_type is not None:
            interaction_metadata = SimpleNamespace(
                type=interaction_type,
                user=SimpleNamespace(id=user_id) if user_id is not None else None,
                created_at=datetime(2026, 10, 13, 8, 0, 0, tzinfo=timezone.utc),
            )
        return SimpleNamespace(
            guild=SimpleNamespace(id=456),
            channel=SimpleNamespace(type=channel_type),
            author=SimpleNamespace(id=author_id, bot=True),
            application_id=application_id if application_id is not None else author_id,
            interaction_metadata=interaction_metadata,
            interaction=None,
            created_at=datetime(2026, 10, 13, 8, 0, 1, tzinfo=timezone.utc),
            embeds=[SimpleNamespace(description=description, fields=[])] if description else [],
            content="",
        )

    def test_configured_service_ids(self):
        self.assertEqual(DISBOARD_BOT_ID, 302050872383242240)
        self.assertEqual(DISOKU_BOT_ID, 761562078095867916)

    def test_disboard_japanese_embed_is_bump(self):
        message = self.make_message(DISBOARD_BOT_ID, "表示順をアップしたよ 👍")
        event = detect_event(message)
        self.assertEqual(event[:2], ("bump", 123))
        self.assertEqual(event[2].isoformat(), "2026-10-13T08:00:00+00:00")

    def test_disboard_english_embed_is_bump(self):
        event = detect_event(self.make_message(DISBOARD_BOT_ID, "Bump done!"))
        self.assertEqual(event[0], "bump")

    def test_disoku_embed_is_separate_up_event(self):
        event = detect_event(self.make_message(DISOKU_BOT_ID, "Lunachan.com をアップしたよ! 🙏"))
        self.assertEqual(event[0], "up")

    def test_wrong_bot_application_or_text_is_ignored(self):
        self.assertIsNone(detect_event(self.make_message(999, "表示順をアップしたよ")))
        self.assertIsNone(detect_event(self.make_message(DISBOARD_BOT_ID, "表示順をアップしたよ", application_id=999)))
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
        cog = BumpRta(SimpleNamespace(db_api=object()))
        cog._is_enabled = AsyncMock(return_value=True)
        cog._schedule_reminder = AsyncMock()
        cog._record_rta_event = AsyncMock()
        for message_id, bot_id, description, kind in (
            (1, DISBOARD_BOT_ID, "表示順をアップしたよ 👍", "bump"),
            (2, DISOKU_BOT_ID, "Lunachan.com をアップしたよ! 🙏", "up"),
        ):
            message = self.make_event_message(message_id, bot_id, description, kind)
            await cog.on_message(message)
            event_at = message.interaction_metadata.created_at
            message.channel.send.assert_awaited_once()
            # Now sends an embed instead of plain text
            send_kwargs = message.channel.send.await_args.kwargs
            self.assertIn("embed", send_kwargs)
            self.assertEqual(send_kwargs["embed"].title, f"{kind.upper()} を検知しました")
            self.assertFalse(send_kwargs["allowed_mentions"].users)
            self.assertFalse(send_kwargs["allowed_mentions"].roles)
            self.assertFalse(send_kwargs["allowed_mentions"].everyone)
            cog._record_rta_event.assert_any_await(message, kind, 321, event_at)
            cog._schedule_reminder.assert_any_await(message, 321, kind, event_at)

    def make_event_message(self, message_id, bot_id, description, kind):
        return SimpleNamespace(
            id=message_id,
            guild=SimpleNamespace(id=456),
            channel=SimpleNamespace(id=789, type=discord.ChannelType.text, send=AsyncMock()),
            author=SimpleNamespace(id=bot_id, bot=True),
            application_id=bot_id,
            embeds=[SimpleNamespace(description=description, fields=[])],
            content="",
            created_at=datetime(2026, 10, 13, 8, 0, 1, tzinfo=timezone.utc),
            interaction_metadata=SimpleNamespace(
                type=discord.InteractionType.application_command,
                user=SimpleNamespace(id=321),
                created_at=datetime(2026, 10, 13, 8, 0, 0, tzinfo=timezone.utc),
            ),
        )

    def test_support_is_the_single_app_command(self):
        self.assertEqual(BumpRta.__cog_app_commands__, [])
        names = [command.name for command in SupportCog.__cog_app_commands__]
        self.assertEqual(names, ["support"])


if __name__ == "__main__":
    unittest.main()
