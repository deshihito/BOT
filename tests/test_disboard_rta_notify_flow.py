"""全7サービスの通知フロー通し回帰テスト。

ユーザー報告 (2026-11-08): Dicoall 等の新サービスで「RTA記録」embed と
リマインダーの「〜 できます」embed が投稿されない。

既存の検知テスト (test_disboard_rta_new_services.py 等) は detect_event のみを
対象にしていたため、検知→リマインダー登録→発火→完了記録→RTA embed 投稿の
通し経路はどのサービスについても検証されていなかった。本ファイルは実キャプ
チャ (2026-10-29 / 2026-11-05) と同じ形状のメッセージを使い、実エントリポイ
ント on_message 経由で全7種をパラメタライズして検証する。

フェイクは実物の discord.py Message が持つ属性だけを持たせる (余分な属性を
持たせると実物の欠陥を見逃すため)。
"""
import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import discord
from core.game.rta.entry import BumpRta
from core.game.rta.helpers import _snowflake_ts

DISCORD_EPOCH_MS = 1420070400000
GUILD_ID = 999
CHANNEL_ID = 555
USER_ID = 777

BOT_IDS = {
    "bump": 302050872383242240,
    "up": 761562078095867916,
    "vote": 1233072112139501608,
    "takasumi": 981314695543783484,
    "dicoall": 903541413298450462,
    "dcafe": 850493201064132659,
    "sharkbot": 1322100616369147924,
}


def _snowflake(dt):
    return ((int(dt.timestamp() * 1000) - DISCORD_EPOCH_MS) << 22) | 1


def _embed(title=None, description=None, url=None, footer=None, fields=()):
    return SimpleNamespace(
        title=title,
        description=description,
        url=url,
        footer=SimpleNamespace(text=footer),
        author=SimpleNamespace(name=None),
        fields=[SimpleNamespace(name=n, value=v) for n, v in fields],
    )


def _service_message(kind, at, channel):
    """実キャプチャと同じ形状のサービス成功メッセージを作る。"""
    bot_id = BOT_IDS[kind]
    if kind == "bump":
        embeds = [_embed(description="表示順をアップしたよ 👍")]
    elif kind == "up":
        embeds = [_embed(
            title="ディス速 | Discordサーバー・友達募集・ボット掲示板",
            url="https://dissoku.net/ja",
            fields=(("Lunachan.com をアップしたよ! 🙏", "成功"),),
        )]
    elif kind == "vote":
        nxt = (at + timedelta(hours=2)).strftime("%Y/%m/%d %H:%M")
        embeds = [_embed(footer="voted", fields=(("次回投票可能時刻", nxt),))]
    elif kind == "takasumi":
        embeds = [_embed(
            description="UPしました！表示順位が更新されました。1時間後に通知します")]
    elif kind == "dicoall":
        nxt = (at + timedelta(hours=1)).strftime("%Y/%m/%d %H:%M")
        embeds = [_embed(
            description=("サーバーがリストの最上段に更新されました。"
                         "サーバーリストのトップに正常に表示されています"),
            fields=(("次回の更新可能時間", nxt),),
        )]
    elif kind == "dcafe":
        embeds = [_embed(title="Discord Cafe | Discord掲示板",
                          description="サーバーの表示順位を上げました！")]
    elif kind == "sharkbot":
        embeds = [_embed(
            description="✅ サーバーをUpしました！\n2時間後に再度Upできます。")]
    else:  # pragma: no cover
        raise AssertionError(kind)
    return SimpleNamespace(
        id=_snowflake(at),
        guild=SimpleNamespace(id=GUILD_ID),
        channel=channel,
        author=SimpleNamespace(id=bot_id, bot=True),
        application_id=bot_id,
        webhook_id=None,
        interaction_metadata=SimpleNamespace(
            type=discord.InteractionType.application_command,
            user=SimpleNamespace(id=USER_ID),
            id=_snowflake(at) - 5,
        ),
        interaction=None,
        created_at=at,
        edited_at=None,
        embeds=embeds,
        content="",
        reference=None,
    )


class FakeTable:
    """api_client の fluent なテーブル操作の最小再現 (実在のメソッドのみ)。"""

    def __init__(self, db, name):
        self._db = db
        self._name = name
        self._filters = {}
        self._action = "select"
        self._values = None
        self._on_conflict = None
        self._ignore = False

    def select(self, *args, **kwargs):
        self._action = "select"
        return self

    def insert(self, values):
        self._action = "insert"
        self._values = values
        return self

    def upsert(self, values, on_conflict=None, ignore_duplicates=False):
        self._action = "upsert"
        self._values = values
        self._on_conflict = on_conflict
        self._ignore = ignore_duplicates
        return self

    def update(self, values):
        self._action = "update"
        self._values = values
        return self

    def delete(self):
        self._action = "delete"
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def is_(self, col, val):
        self._filters[col] = None
        return self

    def in_(self, col, vals):
        self._filters[col] = ("__in__", list(vals))
        return self

    def lt(self, col, val):
        self._filters[col] = ("__lt__", val)
        return self

    def order(self, *args, **kwargs):
        return self

    def limit(self, n):
        return self

    def _rows(self):
        return self._db.tables.setdefault(self._name, [])

    def _match(self, row):
        for col, val in self._filters.items():
            if isinstance(val, tuple) and val and val[0] == "__in__":
                if str(row.get(col)) not in [str(v) for v in val[1]]:
                    return False
            elif isinstance(val, tuple) and val and val[0] == "__lt__":
                if not (row.get(col) is not None and str(row.get(col)) < str(val[1])):
                    return False
            elif val is None:
                if row.get(col) is not None:
                    return False
            elif str(row.get(col)) != str(val):
                return False
        return True

    def execute(self):
        rows = self._rows()
        if self._action == "select":
            return SimpleNamespace(data=[dict(r) for r in rows if self._match(r)])
        if self._action == "insert":
            rows.append(dict(self._values))
            return SimpleNamespace(data=[self._values])
        if self._action == "upsert":
            keys = [k.strip() for k in (self._on_conflict or "").split(",") if k.strip()]
            for row in rows:
                if keys and all(str(row.get(k)) == str(self._values.get(k)) for k in keys):
                    if not self._ignore:
                        row.update(self._values)
                    return SimpleNamespace(data=[row])
            rows.append(dict(self._values))
            return SimpleNamespace(data=[self._values])
        if self._action == "update":
            for row in rows:
                if self._match(row):
                    row.update(self._values)
            return SimpleNamespace(data=[])
        if self._action == "delete":
            self._db.tables[self._name] = [r for r in rows if not self._match(r)]
            return SimpleNamespace(data=[])
        return SimpleNamespace(data=[])


class FakeDB:
    def __init__(self):
        self.tables = {}
        self.rpc_calls = []

    def table(self, name):
        return FakeTable(self, name)

    def rpc(self, name, params):
        db = self

        class _RPC:
            def execute(self):
                db.rpc_calls.append((name, params))
                return SimpleNamespace(data=None)

        return _RPC()


class FakeChannel:
    """送信された kwargs を記録するだけのチャンネル (実物の属性のみ)。"""

    def __init__(self, cid=CHANNEL_ID):
        self.id = cid
        self.type = discord.ChannelType.text
        self.sent = []
        self._next_id = 10 ** 18

    async def send(self, **kwargs):
        self.sent.append(kwargs)
        self._next_id += 1
        return SimpleNamespace(
            id=self._next_id, created_at=datetime.now(timezone.utc))


class ForbiddenChannel(FakeChannel):
    async def send(self, **kwargs):
        raise discord.Forbidden(
            SimpleNamespace(status=403, reason="Forbidden"), "Missing Access")


class NotifyFlowTest(unittest.IsolatedAsyncioTestCase):
    """検知→リマインダー登録/永続化→発火→完了→RTA embed の通し検証 (全7種)。"""

    def _make_cog(self, db, channel):
        bot = SimpleNamespace(db_api=object(), get_channel=lambda cid: channel)
        cog = BumpRta(bot)
        cog.db = db
        gate = asyncio.Event()
        cog._sleep_until = lambda target: gate.wait()
        cog._send_lead = lambda: 0.0
        return cog, gate

    async def _run_cycle(self, kind):
        db = FakeDB()
        channel = FakeChannel()
        cog, gate = self._make_cog(db, channel)
        t0 = datetime(2026, 11, 8, 1, 0, tzinfo=timezone.utc)

        await cog.on_message(_service_message(kind, t0, channel))
        self.assertEqual(len(cog._reminders), 1, f"{kind}: リマインダーが登録されていない")
        reminders = db.tables.get("bump_rta_reminders", [])
        self.assertEqual(len(reminders), 1, f"{kind}: リマインダーが永続化されていない")
        self.assertEqual(reminders[0]["event_type"], kind)
        pending = db.tables.get("bump_rta_pending", [])
        self.assertEqual(len(pending), 1, f"{kind}: pending マーカーがない")
        self.assertEqual(pending[0]["event_type"], kind)

        gate.set()
        for task in list(cog._timers.values()):
            await asyncio.wait_for(task, timeout=5)
        titles = [kw["embed"].title for kw in channel.sent if kw.get("embed")]
        self.assertTrue(
            any(t and t.endswith("できます") for t in titles),
            f"{kind}: リマインダー embed が投稿されていない: {channel.sent}",
        )

        due = datetime.fromisoformat(reminders[0]["due_at"].replace("Z", "+00:00"))
        t1 = due + timedelta(seconds=3)
        before = len(channel.sent)
        await cog.on_message(_service_message(kind, t1, channel))
        new_sends = channel.sent[before:]
        rta = [kw for kw in new_sends
               if kw.get("embed") and kw["embed"].title == "RTA記録"]
        self.assertTrue(rta, f"{kind}: RTA記録 embed が投稿されていない: {new_sends}")
        self.assertIn(kind, rta[0]["embed"].description)
        events = db.tables.get("bump_rta_events", [])
        self.assertEqual(len(events), 1, f"{kind}: イベント記録がない")
        self.assertEqual(events[0]["event_type"], kind)
        rpc_names = [name for name, _ in db.rpc_calls]
        self.assertIn("record_bump_rta_best", rpc_names)

    async def test_bump_full_cycle(self):
        await self._run_cycle("bump")

    async def test_up_full_cycle(self):
        await self._run_cycle("up")

    async def test_vote_full_cycle(self):
        await self._run_cycle("vote")

    async def test_takasumi_full_cycle(self):
        await self._run_cycle("takasumi")

    async def test_dicoall_full_cycle(self):
        await self._run_cycle("dicoall")

    async def test_dcafe_full_cycle(self):
        await self._run_cycle("dcafe")

    async def test_sharkbot_full_cycle(self):
        await self._run_cycle("sharkbot")


class ReconcileRestoreTest(unittest.IsolatedAsyncioTestCase):
    """再起動後に永続化行からリマインダーが復元され発火すること (新3種)。"""

    async def _run_restore(self, kind):
        db = FakeDB()
        channel = FakeChannel()
        bot = SimpleNamespace(db_api=object(), get_channel=lambda cid: channel)
        cog = BumpRta(bot)
        cog.db = db
        gate = asyncio.Event()
        cog._sleep_until = lambda target: gate.wait()
        cog._send_lead = lambda: 0.0

        t0 = datetime(2026, 11, 8, 1, 0, tzinfo=timezone.utc)
        due = t0 + timedelta(minutes=5)
        # 時計サンプルがないと実時刻で stale 判定されるため、t0 時点の
        # ゲートウェイサンプルを与えて cog の時計を t0 に固定する。
        cog.clock.observe(_snowflake_ts(_snowflake(t0)))
        db.tables["bump_rta_reminders"] = [{
            "message_id": str(_snowflake(t0)),
            "guild_id": str(GUILD_ID),
            "channel_id": str(CHANNEL_ID),
            "user_id": str(USER_ID),
            "event_type": kind,
            "due_at": due.isoformat(),
            "sent_at": None,
        }]
        await cog._reconcile()
        self.assertEqual(len(cog._reminders), 1, f"{kind}: 復元されていない")
        gate.set()
        for task in list(cog._timers.values()):
            await asyncio.wait_for(task, timeout=5)
        titles = [kw["embed"].title for kw in channel.sent if kw.get("embed")]
        self.assertTrue(
            any(t and t.endswith("できます") for t in titles),
            f"{kind}: 復元後に発火していない: {channel.sent}",
        )

    async def test_dicoall_restored_after_restart(self):
        await self._run_restore("dicoall")

    async def test_dcafe_restored_after_restart(self):
        await self._run_restore("dcafe")

    async def test_sharkbot_restored_after_restart(self):
        await self._run_restore("sharkbot")


class SendFailureVisibilityTest(unittest.IsolatedAsyncioTestCase):
    """送信権限がないチャンネルでは記録だけ進み、失敗がログに残ること。

    本番切り分けの要: 投稿先チャンネルで AGO が送信できない場合、記録は
    書かれるが embed は届かない。このとき失敗が WARNING/ERROR ログとして
    必ず残ることを保証する (握り潰して無言で進まないこと)。
    """

    async def test_rta_embed_forbidden_still_records_and_logs(self):
        db = FakeDB()
        channel = ForbiddenChannel()
        bot = SimpleNamespace(db_api=object(), get_channel=lambda cid: channel)
        cog = BumpRta(bot)
        cog.db = db
        gate = asyncio.Event()
        cog._sleep_until = lambda target: gate.wait()
        cog._send_lead = lambda: 0.0

        t0 = datetime(2026, 11, 8, 1, 0, tzinfo=timezone.utc)
        # pending マーカーを直接置き、完了イベントだけを流す
        db.tables["bump_rta_pending"] = [{
            "guild_id": str(GUILD_ID),
            "user_id": str(USER_ID),
            "event_type": "dcafe",
            "bump_message_id": str(_snowflake(t0)),
            "bump_at": t0.isoformat(),
        }]
        t1 = t0 + timedelta(hours=2, seconds=5)
        with self.assertLogs("cogs.disboard_rta", level="ERROR"):
            await cog.on_message(_service_message("dcafe", t1, channel))
        self.assertEqual(len(db.tables.get("bump_rta_events", [])), 1)

    async def test_unresolvable_channel_logs_warning_and_stays_unsent(self):
        db = FakeDB()
        channel = FakeChannel()

        async def fetch_channel(cid):
            raise discord.HTTPException(
                SimpleNamespace(status=500, reason="Internal Server Error"),
                "temporary failure")

        bot = SimpleNamespace(
            db_api=object(), get_channel=lambda cid: None,
            fetch_channel=fetch_channel)
        cog = BumpRta(bot)
        cog.db = db
        gate = asyncio.Event()
        cog._sleep_until = lambda target: gate.wait()
        cog._send_lead = lambda: 0.0

        t0 = datetime(2026, 11, 8, 1, 0, tzinfo=timezone.utc)
        await cog.on_message(_service_message("sharkbot", t0, channel))
        self.assertEqual(len(cog._reminders), 1)
        with self.assertLogs("cogs.disboard_rta", level="WARNING") as logs:
            gate.set()
            for task in list(cog._timers.values()):
                await asyncio.wait_for(task, timeout=5)
        self.assertTrue(
            any("could not be resolved" in line for line in logs.output),
            f"チャンネル解決失敗が WARNING に残っていない: {logs.output}",
        )
        row = db.tables["bump_rta_reminders"][0]
        self.assertIsNone(row.get("sent_at"), "未送信のまま再試行対象に残るべき")

    async def test_reminder_forbidden_finishes_with_warning(self):
        db = FakeDB()
        channel = ForbiddenChannel()
        bot = SimpleNamespace(db_api=object(), get_channel=lambda cid: channel)
        cog = BumpRta(bot)
        cog.db = db
        gate = asyncio.Event()
        cog._sleep_until = lambda target: gate.wait()
        cog._send_lead = lambda: 0.0

        t0 = datetime(2026, 11, 8, 1, 0, tzinfo=timezone.utc)
        await cog.on_message(_service_message("dicoall", t0, channel))
        self.assertEqual(len(cog._reminders), 1)
        with self.assertLogs("cogs.disboard_rta", level="WARNING") as logs:
            gate.set()
            for task in list(cog._timers.values()):
                await asyncio.wait_for(task, timeout=5)
        self.assertTrue(
            any("send rejected" in line for line in logs.output),
            f"403 の恒久拒否が WARNING に残っていない: {logs.output}",
        )


if __name__ == "__main__":
    unittest.main()
