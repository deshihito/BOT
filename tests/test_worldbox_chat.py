"""WORLD BOX ユニオンチャット → Discord 連携ワーカーのテスト。"""

import asyncio
import time

from core.general.circulation import worldbox_chat as chat


class FakeKV:
    def __init__(self, records):
        self.records = dict(records)
        self.deleted = []

    async def load_all(self):
        return dict(self.records)

    async def delete(self, key):
        self.deleted.append(key)
        self.records.pop(key, None)


def entry(**over):
    now_ms = int(time.time() * 1000)
    base = {
        "id": "m1",
        "channelId": "123456789012345678",
        "name": "でし",
        "text": "こんにちは",
        "at": now_ms,
        "status": "pending",
    }
    base.update(over)
    return base


def test_parse_valid_and_invalid():
    assert chat.parse_outbox_entry(entry()) is not None
    assert chat.parse_outbox_entry(entry(channelId="abc")) is None
    assert chat.parse_outbox_entry(entry(text="")) is None
    assert chat.parse_outbox_entry(entry(status="sent")) is None
    assert chat.parse_outbox_entry("not json") is None
    assert chat.parse_outbox_entry(None) is None


def test_poll_sends_and_deletes():
    sent = []

    async def sender(channel_id, name, text):
        sent.append((channel_id, name, text))
        return True

    kv = FakeKV({"m1": entry()})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    handled = asyncio.run(worker.poll_once())
    assert handled == 1
    assert sent == [("123456789012345678", "でし", "こんにちは")]
    assert kv.deleted == ["m1"]


def test_poll_keeps_failed_for_retry():
    async def sender(channel_id, name, text):
        return False

    kv = FakeKV({"m1": entry()})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    handled = asyncio.run(worker.poll_once())
    assert handled == 0
    assert kv.deleted == []
    assert "m1" in kv.records


def test_poll_cleans_broken_and_expired():
    async def sender(channel_id, name, text):
        return True

    old_ms = int((time.time() - chat.ENTRY_MAX_AGE_SECONDS - 60) * 1000)
    kv = FakeKV({
        "broken": {"id": 123},
        "expired": entry(id="m2", at=old_ms),
    })
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    handled = asyncio.run(worker.poll_once())
    assert handled == 2
    assert sorted(kv.deleted) == ["broken", "expired"]


def test_poll_kv_failure_returns_zero():
    class DownKV:
        async def load_all(self):
            raise RuntimeError("down")

    async def sender(channel_id, name, text):
        return True

    worker = chat.WorldBoxChatWorker(kv=DownKV(), channel_sender=sender)
    assert asyncio.run(worker.poll_once()) == 0
