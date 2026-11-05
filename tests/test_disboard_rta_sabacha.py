import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import discord
from cogs.disboard_rta import SABACHA_BOT_ID, TAKASUMI_BOT_ID, COOLDOWN, _sabacha_next_time, detect_event

EVENT_AT = datetime(2026, 10, 13, 8, 0, 1, tzinfo=timezone.utc)
MESSAGE_ID = (int(EVENT_AT.timestamp() * 1000) - 1420070400000) << 22  # snowflake at EVENT_AT


def make_message(author_id, *, description="", footer=None, fields=(), user_id=123):
    metadata = SimpleNamespace(
        type=discord.InteractionType.application_command,
        user=SimpleNamespace(id=user_id) if user_id is not None else None,
        created_at=EVENT_AT,
    )
    embed = SimpleNamespace(
        description=description or None,
        footer=SimpleNamespace(text=footer) if footer is not None else None,
        fields=[SimpleNamespace(name=n, value=v) for n, v in fields],
        author=None,
        title=None,
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
        embeds=[embed] if (description or footer is not None or fields) else [],
        content="",
    )


class SabachaDetectionTest(unittest.TestCase):
    def test_vote_detected_with_footer(self):
        event = detect_event(make_message(SABACHA_BOT_ID, description="投票ありがとう", footer="voted"))
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "vote")
        self.assertEqual(event[1], 123)

    def test_vote_without_footer_ignored(self):
        self.assertIsNone(detect_event(make_message(SABACHA_BOT_ID, description="投票")))

    def test_vote_wrong_bot_ignored(self):
        self.assertIsNone(detect_event(make_message(999, description="x", footer="voted")))

    def test_next_time_from_discord_timestamp(self):
        due = EVENT_AT + timedelta(hours=2)
        event = detect_event(make_message(
            SABACHA_BOT_ID, description="x", footer="voted",
            fields=(("次回", f"<t:{int(due.timestamp())}:R> に投票できます"),),
        ))
        self.assertEqual(event[3], due)

    def test_next_time_from_jst_text(self):
        embeds = [SimpleNamespace(fields=[SimpleNamespace(name="次回", value="2026/10/13 19:00 に投票可能")])]
        self.assertEqual(
            _sabacha_next_time(embeds, EVENT_AT),
            datetime(2026, 10, 13, 19, 0, tzinfo=timezone(timedelta(hours=9))),
        )

    def test_next_time_rejects_past_or_far_future(self):
        past = [SimpleNamespace(fields=[SimpleNamespace(name="n", value="2020/01/01 00:00")])]
        far = [SimpleNamespace(fields=[SimpleNamespace(name="n", value="2030/01/01 00:00")])]
        self.assertIsNone(_sabacha_next_time(past, EVENT_AT))
        self.assertIsNone(_sabacha_next_time(far, EVENT_AT))

    def test_vote_cooldown_default_two_hours(self):
        self.assertEqual(COOLDOWN["vote"], timedelta(hours=2))


class TakasumiDetectionTest(unittest.TestCase):
    DESCRIPTION = "✅ UPしました\n表示順位が更新されました\nサーバー掲示板で確認してね!\n1時間後に通知します"

    def test_up_detected(self):
        event = detect_event(make_message(TAKASUMI_BOT_ID, description=self.DESCRIPTION))
        self.assertIsNotNone(event)
        self.assertEqual(event[0], "takasumi")
        self.assertIsNone(event[3])  # 固定1時間クールダウン側で計算する

    def test_partial_phrase_ignored(self):
        self.assertIsNone(detect_event(make_message(TAKASUMI_BOT_ID, description="✅ UPしました")))
        self.assertIsNone(detect_event(make_message(TAKASUMI_BOT_ID, description="表示順位が更新されました")))

    def test_wrong_bot_ignored(self):
        self.assertIsNone(detect_event(make_message(999, description=self.DESCRIPTION)))

    def test_takasumi_cooldown_one_hour(self):
        self.assertEqual(COOLDOWN["takasumi"], timedelta(hours=1))


if __name__ == "__main__":
    unittest.main()
