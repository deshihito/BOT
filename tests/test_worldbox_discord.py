"""WORLD BOX Discord 連携（ディレクトリ公開＋受信リレー）のテスト。"""

import asyncio
import json
import time

from core.general.circulation import worldbox_discord as wd

GID = "111111111111111111"
CID = "222222222222222222"
CID2 = "333333333333333333"
GLOBAL_CID = "444444444444444444"


class FakeKV:
    def __init__(self, records=None):
        self.records = dict(records or {})

    async def load_one(self, key):
        return self.records.get(key)

    async def set(self, key, value):
        self.records[key] = value


def make_worker(*, nations=None, settings=None, directory=None, board=None,
                guild_channels=None, global_ids=None):
    kvs = {
        "directory": FakeKV(directory),
        "nations": FakeKV(nations),
        "settings": FakeKV(settings),
        "board": FakeKV(board),
    }
    worker = wd.WorldBoxDiscordWorker(
        directory_kv=kvs["directory"],
        nations_kv=kvs["nations"],
        settings_kv=kvs["settings"],
        board_kv=kvs["board"],
        guild_channels_provider=lambda: guild_channels or [],
        global_channel_ids_provider=lambda: global_ids or set(),
    )
    return worker, kvs


def snapshot(**over):
    base = {
        "guild_id": GID,
        "channel_id": CID,
        "message_id": "555555555555555555",
        "author_name": "でし",
        "author_is_bot": False,
        "is_webhook": False,
        "content": "やあ",
        "at_ms": int(time.time() * 1000),
    }
    base.update(over)
    return base


# --- ディレクトリ構築 ---

def test_build_directory_entry_caps_and_global():
    channels = [{"id": CID, "name": "general"}, {"id": GLOBAL_CID, "name": "global-chat"}]
    channels += [{"id": f"9000000000000000{i:02d}", "name": f"ch{i}"} for i in range(150)]
    entry = wd.build_directory_entry(channels, {GLOBAL_CID}, 123)
    assert len(entry["channels"]) == wd.MAX_CHANNELS
    assert entry["globalChatChannelId"] == GLOBAL_CID
    assert entry["updatedAt"] == 123
    # グローバル連携がそのギルドに無ければ null
    entry2 = wd.build_directory_entry(channels, {"999999999999999999"}, 1)
    assert entry2["globalChatChannelId"] is None
    # 不正な ID は落とす
    entry3 = wd.build_directory_entry([{"id": "abc", "name": "x"}, {"id": CID, "name": "ok"}], set(), 1)
    assert [c["id"] for c in entry3["channels"]] == [CID]


def test_parse_nation_guild_ids():
    raw = json.dumps({"v": 1, "nations": {GID: {"guildId": GID}, CID: {"guildId": CID}}})
    assert wd.parse_nation_guild_ids(raw) == {GID, CID}
    assert wd.parse_nation_guild_ids(None) == set()
    assert wd.parse_nation_guild_ids("not json") == set()
    assert wd.parse_nation_guild_ids({"nations": {}}) == set()


def test_publish_directory_only_for_nations():
    nations = {"nations": json.dumps({"v": 1, "nations": {GID: {"guildId": GID}}})}
    guild_channels = [
        (GID, [{"id": CID, "name": "general"}, {"id": GLOBAL_CID, "name": "global-chat"}]),
        (CID2, [{"id": CID, "name": "other"}]),  # 国が無いギルドは公開しない
    ]
    worker, kvs = make_worker(nations=nations, guild_channels=guild_channels, global_ids={GLOBAL_CID})
    published = asyncio.run(worker.publish_directory_once())
    assert published == 1
    entry = json.loads(kvs["directory"].records[GID])
    assert entry["globalChatChannelId"] == GLOBAL_CID
    assert [c["name"] for c in entry["channels"]] == ["general", "global-chat"]
    assert CID2 not in kvs["directory"].records


# --- 連携設定の解釈と宛先解決 ---

def test_parse_union_link_modes_and_legacy():
    assert wd.parse_union_link({"mode": "global"}) == ("global", None)
    assert wd.parse_union_link({"mode": "channel", "channelId": CID}) == ("channel", CID)
    assert wd.parse_union_link({"mode": "channel", "channelId": "x"}) == ("none", None)
    assert wd.parse_union_link({"mode": "none"}) == ("none", None)
    # 旧形式（ID 手入力時代）は channel として移行読込
    assert wd.parse_union_link({"chatChannelId": CID}) == ("channel", CID)
    assert wd.parse_union_link({"chatChannelId": ""}) == ("none", None)
    assert wd.parse_union_link(None) == ("none", None)
    assert wd.parse_union_link(json.dumps({"mode": "channel", "channelId": CID})) == ("channel", CID)


def test_resolve_receive_channel():
    directory = {"channels": [], "globalChatChannelId": GLOBAL_CID}
    assert wd.resolve_receive_channel_id(("channel", CID), None) == CID
    assert wd.resolve_receive_channel_id(("global", None), directory) == GLOBAL_CID
    assert wd.resolve_receive_channel_id(("global", None), None) is None
    assert wd.resolve_receive_channel_id(("none", None), directory) is None


# --- サニタイズとループ防止 ---

def test_sanitize_relay_text():
    assert wd.sanitize_relay_text("hi <@123456789012345678> !") == "hi !"
    assert wd.sanitize_relay_text("<@&123456789012345678> <#222222222222222222>") == ""
    assert wd.sanitize_relay_text("@everyone やあ") == "everyone やあ"
    assert wd.sanitize_relay_text("a\n\nb\tc") == "a b c"
    assert len(wd.sanitize_relay_text("x" * 200)) == 120


def test_is_relay_text():
    assert wd.is_relay_text("**でし**（WORLD BOX ユニオン）: やあ")
    assert not wd.is_relay_text("普通の投稿")
    assert not wd.is_relay_text("**でし**: やあ")


def test_append_board_entry_prunes_and_dedupes():
    now = int(time.time() * 1000)
    old = {"id": "a", "channel": "union", "text": "old", "at": now - wd.BOARD_TTL_MS - 1}
    keep = {"id": "b", "channel": "union", "text": "keep", "at": now - 1000}
    entry = wd.build_board_entry(message_id="1", guild_id=GID, name="n", text="t", at_ms=now)
    board = wd.append_board_entry([old, keep], entry, now)
    assert [e["id"] for e in board] == [entry["id"], "b"]
    # 同じ投稿の再取り込みは重複しない
    board2 = wd.append_board_entry(board, entry, now)
    assert len(board2) == 2
    assert entry["source"] == "discord" and entry["channel"] == "union"


# --- 受信リレー（ワーカー） ---

def test_handle_message_appends_to_board():
    settings = {GID: json.dumps({"mode": "channel", "channelId": CID})}
    board = {f"union:{GID}": json.dumps([])}
    worker, kvs = make_worker(settings=settings, board=board)
    assert asyncio.run(worker.handle_message(snapshot())) is True
    entries = json.loads(kvs["board"].records[f"union:{GID}"])
    assert len(entries) == 1
    assert entries[0]["source"] == "discord"
    assert entries[0]["text"] == "やあ"
    assert entries[0]["guildId"] == GID


def test_handle_message_filters():
    settings = {GID: json.dumps({"mode": "channel", "channelId": CID})}
    board = {f"union:{GID}": json.dumps([])}
    worker, kvs = make_worker(settings=settings, board=board)
    # Bot 自身・webhook は拾わない
    assert asyncio.run(worker.handle_message(snapshot(author_is_bot=True))) is False
    assert asyncio.run(worker.handle_message(snapshot(is_webhook=True))) is False
    # 自分がリレーした文面は拾わない
    assert asyncio.run(worker.handle_message(snapshot(content="**でし**（WORLD BOX ユニオン）: やあ"))) is False
    # 連携チャンネル以外は拾わない
    assert asyncio.run(worker.handle_message(snapshot(channel_id=CID2))) is False
    # メンションだけの投稿は空になって落ちる
    assert asyncio.run(worker.handle_message(snapshot(content="<@123456789012345678>"))) is False
    assert json.loads(kvs["board"].records[f"union:{GID}"]) == []


def test_handle_message_global_mode_uses_directory():
    settings = {GID: json.dumps({"mode": "global"})}
    directory = {GID: json.dumps({"channels": [{"id": GLOBAL_CID, "name": "global-chat"}], "globalChatChannelId": GLOBAL_CID, "updatedAt": 1})}
    board = {f"union:{GID}": json.dumps([])}
    worker, kvs = make_worker(settings=settings, directory=directory, board=board)
    # グローバルチャットへの直接投稿だけが対象
    assert asyncio.run(worker.handle_message(snapshot(channel_id=GLOBAL_CID))) is True
    assert asyncio.run(worker.handle_message(snapshot(channel_id=CID, message_id="666666666666666666"))) is False
    entries = json.loads(kvs["board"].records[f"union:{GID}"])
    assert len(entries) == 1


def test_handle_message_no_link():
    board = {f"union:{GID}": json.dumps([])}
    worker, kvs = make_worker(board=board)
    assert asyncio.run(worker.handle_message(snapshot())) is False
