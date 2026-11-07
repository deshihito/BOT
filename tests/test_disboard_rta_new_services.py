import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import discord
from cogs.game import (
    COOLDOWN,
    DCAFE_BOT_ID,
    DICOALL_BOT_ID,
    SHARKBOT_BOT_ID,
    _named_field_next_time,
    detect_event,
)

EVENT_AT = datetime(2026, 10, 29, 7, 59, 0, tzinfo=timezone.utc)  # 2026/10/29 16:59 JST
MESSAGE_ID = (int(EVENT_AT.timestamp() * 1000) - 1420070400000) << 22  # snowflake at EVENT_AT


def make_message(author_id, *, title=None, description="", fields=(), user_id=123):
    metadata = SimpleNamespace(
        type=discord.InteractionType.application_command,
        user=SimpleNamespace(id=user_id) if user_id is not None else None,
        created_at=EVENT_AT,
    )
    embed = SimpleNamespace(
        title=title,
        description=description or None,
        footer=None,
        fields=[SimpleNamespace(name=n, value=v) for n, v in fields],
        author=None,
        url=None,
    )
    return SimpleNamespace(
        id=MESSAGE_ID,
        guild=SimpleNamespace(id=456),
        channel=SimpleNamespace(type=discord.ChannelType.text),
        author=SimpleNamespace(id=author_id, bot=True),
        application_id=author_id,
        webhook_id=None,
        interaction_metadata=metadata,
        interaction=None,
        created_at=EVENT_AT,
        embeds=[embed] if (title or description or fields) else [],
        content="",
    )


class DicoallDetectionTest(unittest.TestCase):
    DESCRIPTION = (
        "🎉 サーバーがリストの最上段に更新されました！\n"
        "サーバーリストのトップに正常に表示されています。\n"
        "以下のリンクから他の機能もご確認ください。"
    )

    def test_up_detected(self):
        event = detect_event(make_message(DICOALL_BOT_ID, description=self.DESCRIPTION))
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "dicoall")
        self.assertEqual(event[1], 123)

    def test_next_time_parsed_from_named_field(self):
        due = EVENT_AT + timedelta(hours=1)
        event = detect_event(make_message(
            DICOALL_BOT_ID, description=self.DESCRIPTION,
            fields=(
                ("🔗 クイックリンク", "Botの使い方 | サーバーページ"),
                ("📅 次回の更新可能時間", f"<t:{int(due.timestamp())}:R>"),
                ("サブスク案内", "自動UPサブスクを見る"),
            ),
        ))
        self.assertEqual(event[3], due)

    def test_next_time_missing_field_is_none(self):
        event = detect_event(make_message(DICOALL_BOT_ID, description=self.DESCRIPTION))
        self.assertIsNone(event[3])  # フォールバックは COOLDOWN 側で計算する

    def test_next_time_rejects_out_of_window(self):
        embeds = [SimpleNamespace(fields=[
            SimpleNamespace(name="📅 次回の更新可能時間", value="<t:1000000000:R>"),
        ])]
        self.assertIsNone(_named_field_next_time(embeds, EVENT_AT, "次回の更新可能時間"))

    def test_partial_phrase_ignored(self):
        self.assertIsNone(detect_event(make_message(
            DICOALL_BOT_ID, description="🎉 サーバーがリストの最上段に更新されました！")))
        self.assertIsNone(detect_event(make_message(
            DICOALL_BOT_ID, description="サーバーリストのトップに正常に表示されています。")))

    def test_wrong_bot_ignored(self):
        self.assertIsNone(detect_event(make_message(999, description=self.DESCRIPTION)))
        self.assertIsNone(detect_event(make_message(DCAFE_BOT_ID, description=self.DESCRIPTION)))

    def test_dicoall_cooldown_one_hour(self):
        self.assertEqual(COOLDOWN["dicoall"], timedelta(hours=1))


class DCafeDetectionTest(unittest.TestCase):
    TITLE = "Discord Cafe | Discord掲示板"
    DESCRIPTION = "サーバーの表示順位を上げました！"

    def test_up_detected(self):
        event = detect_event(make_message(DCAFE_BOT_ID, title=self.TITLE, description=self.DESCRIPTION))
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "dcafe")
        self.assertEqual(event[1], 123)
        self.assertIsNone(event[3])  # 次回情報なし・固定クールダウン

    def test_wrong_title_ignored(self):
        self.assertIsNone(detect_event(make_message(
            DCAFE_BOT_ID, title="別のタイトル", description=self.DESCRIPTION)))
        self.assertIsNone(detect_event(make_message(
            DCAFE_BOT_ID, description=self.DESCRIPTION)))

    def test_wrong_bot_ignored(self):
        self.assertIsNone(detect_event(make_message(
            999, title=self.TITLE, description=self.DESCRIPTION)))
        self.assertIsNone(detect_event(make_message(
            DICOALL_BOT_ID, title=self.TITLE, description=self.DESCRIPTION)))

    def test_dcafe_cooldown_two_hours(self):
        self.assertEqual(COOLDOWN["dcafe"], timedelta(hours=2))


class SharkBotDetectionTest(unittest.TestCase):
    DESCRIPTION = "✅ サーバーをUpしました！\n2時間後に再度Upできます。"

    def test_up_detected(self):
        event = detect_event(make_message(SHARKBOT_BOT_ID, description=self.DESCRIPTION))
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "sharkbot")
        self.assertEqual(event[1], 123)
        self.assertIsNone(event[3])

    def test_partial_phrase_ignored(self):
        self.assertIsNone(detect_event(make_message(
            SHARKBOT_BOT_ID, description="✅ サーバーをUpしました！")))
        self.assertIsNone(detect_event(make_message(
            SHARKBOT_BOT_ID, description="2時間後に再度Upできます。")))

    def test_wrong_bot_ignored(self):
        self.assertIsNone(detect_event(make_message(999, description=self.DESCRIPTION)))

    def test_sharkbot_cooldown_two_hours(self):
        self.assertEqual(COOLDOWN["sharkbot"], timedelta(hours=2))


class UnrelatedMessageTest(unittest.TestCase):
    def test_plain_message_ignored(self):
        self.assertIsNone(detect_event(make_message(424242)))

    def test_new_service_embeds_from_unrelated_bot_ignored(self):
        self.assertIsNone(detect_event(make_message(
            424242, title="Discord Cafe | Discord掲示板",
            description="サーバーの表示順位を上げました！")))


if __name__ == "__main__":
    unittest.main()
