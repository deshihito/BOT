"""WORLD BOX ユニオンチャット → Discord 連携ワーカーのテスト。"""

import asyncio
import time

from core.general.circulation import worldbox_chat as chat


class FakeKV:
    def __init__(self, records):
        self.records = dict(records)
        self.deleted = []
        self.set_calls = []

    async def load_all(self):
        return dict(self.records)

    async def load_one(self, key):
        return self.records.get(key)

    async def set(self, key, value):
        self.set_calls.append(key)
        self.records[key] = value

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


# --- claim による二重投稿防止 ---

def test_poll_claims_before_send():
    """送信前に status "sending" + claim が書かれていること。"""
    seen = {}

    async def sender(channel_id, name, text):
        seen.update(chat.parse_outbox_entry(kv.records["m1"]) or {})
        return True

    kv = FakeKV({"m1": entry()})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    assert asyncio.run(worker.poll_once()) == 1
    assert seen["status"] == "sending"
    assert isinstance(seen["claim"], dict) and seen["claim"]["token"]
    assert kv.deleted == ["m1"]


def test_poll_no_resend_when_delete_fails():
    """投稿成功→削除失敗でも次回ポーリングで再送しない（新鮮な claim が守る）。"""

    class DeleteFailsKV(FakeKV):
        async def delete(self, key):
            raise RuntimeError("kv down")

    sent = []

    async def sender(channel_id, name, text):
        sent.append(text)
        return True

    kv = DeleteFailsKV({"m1": entry()})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    asyncio.run(worker.poll_once())
    assert sent == ["こんにちは"]
    # 2回目: claim が新鮮なので送らない
    asyncio.run(worker.poll_once())
    assert sent == ["こんにちは"]


def test_poll_drops_stale_claim_without_resend():
    """claim だけ古く残ったものは投稿済みか不明のため、再送せず破棄する。"""
    sent = []

    async def sender(channel_id, name, text):
        sent.append(text)
        return True

    old_ms = int((time.time() - chat.CLAIM_STALE_SECONDS - 10) * 1000)
    kv = FakeKV({"m1": entry(status="sending", claim={"token": "old", "at": old_ms})})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    assert asyncio.run(worker.poll_once()) == 1
    assert sent == []
    assert kv.deleted == ["m1"]


def test_poll_skips_fresh_claim_from_other_worker():
    """他ワーカー（前回の自分）が claim 中のものは送らず、触らない。"""
    sent = []

    async def sender(channel_id, name, text):
        sent.append(text)
        return True

    now_ms = int(time.time() * 1000)
    kv = FakeKV({"m1": entry(status="sending", claim={"token": "other", "at": now_ms})})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    assert asyncio.run(worker.poll_once()) == 0
    assert sent == []
    assert kv.deleted == []
    assert "m1" in kv.records


def test_poll_releases_claim_on_send_failure():
    """送信失敗時は claim を外して pending へ戻し、次回再試行できる。"""
    calls = {"n": 0}

    async def sender(channel_id, name, text):
        calls["n"] += 1
        return calls["n"] > 1

    kv = FakeKV({"m1": entry()})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    assert asyncio.run(worker.poll_once()) == 0
    assert "m1" in kv.records
    assert chat.parse_outbox_entry(kv.records["m1"])["status"] == "pending"
    assert chat.parse_outbox_entry(kv.records["m1"])["claim"] is None
    # 2回目で送信成功
    assert asyncio.run(worker.poll_once()) == 1
    assert kv.deleted == ["m1"]


def test_poll_claim_lost_race_skips_send():
    """claim 書き込み後に他者の claim で上書きされていたら送らない。"""

    class RaceLostKV(FakeKV):
        async def load_one(self, key):
            record = dict(self.records.get(key) or {})
            record["claim"] = {"token": "someone-else", "at": int(time.time() * 1000)}
            return record

    sent = []

    async def sender(channel_id, name, text):
        sent.append(text)
        return True

    kv = RaceLostKV({"m1": entry()})
    worker = chat.WorldBoxChatWorker(kv=kv, channel_sender=sender)
    assert asyncio.run(worker.poll_once()) == 0
    assert sent == []
