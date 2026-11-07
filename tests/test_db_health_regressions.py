"""DB系障害（2026-11-08）の回帰テスト。

対象:
- KVStore のローカルファイル書き込みがイベントループを塞がないこと
- KVStore の API 失敗が WARNING に残り（空文字の例外でも原因が追える）、復旧も記録されること
- ServerAssistCog._dispatch が設定を読み直し、起動時ロード失敗後も welcome が復旧すること
- 自前API の許可テーブルに party_game_monthly_ranking が入っていること（今月のゲーム王）
- PartyRanking の月次ビュー失敗が WARNING に残り、リモート無効化が自動で解けること
- 即抜けRTA の同時参加で joins が落ちないこと
"""

import ast
import asyncio
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.support import guild_settings  # noqa: E402
from core.support.guild_settings import GuildSettings  # noqa: E402
from core.support.storage import KVStore  # noqa: E402
from tests.fake_kv_supabase import APIError, FakeKVSupabase  # noqa: E402


class KVStoreLoopBlockingTest(unittest.IsolatedAsyncioTestCase):
    async def test_set_writes_local_file_off_the_event_loop_thread(self):
        threads = []
        original = KVStore._write_file

        def spy(self, data):
            threads.append(threading.current_thread())
            return original(self, data)

        with tempfile.TemporaryDirectory() as tmp:
            store = KVStore("ns", client=None, path=str(Path(tmp) / "bot_kv.json"))
            KVStore._write_file = spy
            try:
                await store.set("k", {"a": 1})
            finally:
                KVStore._write_file = original
        self.assertTrue(threads, "ローカルファイルへの書き込みが呼ばれていません")
        self.assertTrue(
            all(t is not threading.main_thread() for t in threads),
            "ファイル書き込みがイベントループのスレッドで実行されています",
        )


class KVStoreFailureLoggingTest(unittest.IsolatedAsyncioTestCase):
    def make_store(self, tmp, client):
        return KVStore("guild_settings", client=client, path=str(Path(tmp) / "bot_kv.json"))

    async def test_failure_warns_and_recovery_is_logged(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = FakeKVSupabase(error=APIError("connection refused", code="API_CONNECTION_ERROR"))
            store = self.make_store(tmp, client)
            with self.assertLogs("core.support.storage", level="WARNING") as caught:
                data = await store.load_all()
            self.assertEqual(data, {})
            self.assertTrue(store._remote_down)
            self.assertTrue(any("読み込み" in line for line in caught.output))

            client.error = None
            client.rows = [{"namespace": "guild_settings", "key": "1", "value": {"a": 1}}]
            with self.assertLogs("core.support.storage", level="INFO") as caught2:
                data = await store.load_all()
            self.assertEqual(data, {"1": {"a": 1}})
            self.assertFalse(store._remote_down)
            self.assertTrue(any("復旧" in line for line in caught2.output))

    async def test_timeout_error_is_logged_with_repr(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = FakeKVSupabase(error=asyncio.TimeoutError())
            store = self.make_store(tmp, client)
            with self.assertLogs("core.support.storage", level="WARNING") as caught:
                await store.load_all()
            self.assertTrue(
                any("TimeoutError" in line for line in caught.output),
                "str() が空の例外でもログに原因が残っていません: %r" % (caught.output,),
            )


class GuildSettingsRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_settings_recover_on_reload_after_api_outage(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = FakeKVSupabase(error=APIError("down", code="API_CONNECTION_ERROR"))
            kv = KVStore("guild_settings", client=client, path=str(Path(tmp) / "bot_kv.json"))
            store = GuildSettings(kv)
            await store.ensure_loaded()
            self.assertEqual(store.get(42, "welcome"), {})

            client.error = None
            client.rows = [{
                "namespace": "guild_settings", "key": "42",
                "value": {"welcome": {"welcome_enabled": True}},
            }]
            store.reload_interval = 0.0
            await store.ensure_loaded()
            self.assertEqual(store.get(42, "welcome"), {"welcome_enabled": True})


class WelcomeDispatchRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_reloads_settings_so_welcome_fires(self):
        from core.support.server_assist.cog import ServerAssistCog
        from core.support.server_assist.features import welcome as welcome_mod

        with tempfile.TemporaryDirectory() as tmp:
            client = FakeKVSupabase(rows=[{
                "namespace": "guild_settings", "key": "4242",
                "value": {"assist_welcome": {
                    "welcome_enabled": True, "welcome_channel_id": 777,
                    "welcome_message": "hi {user}",
                }},
            }])
            kv = KVStore("guild_settings", client=client, path=str(Path(tmp) / "bot_kv.json"))
            store = GuildSettings(kv)  # 起動直後: ローカルの控えは空
            self.assertEqual(store.get(4242, "assist_welcome"), {})
            guild_settings.set_store(store)
            sent = []

            async def fake_send(guild, member, kind, settings_value):
                sent.append((kind, settings_value))
                return True

            original_send = welcome_mod._send
            welcome_mod._send = fake_send
            try:
                cog = ServerAssistCog.__new__(ServerAssistCog)
                cog.modules = {"welcome": welcome_mod}
                member = SimpleNamespace(bot=False, guild=SimpleNamespace(id=4242))
                await cog._dispatch("on_member_join", member)
            finally:
                welcome_mod._send = original_send
                guild_settings.set_store(None)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][0], "welcome")
        self.assertEqual(sent[0][1]["welcome_channel_id"], 777)


class ApiAllowlistTest(unittest.TestCase):
    def test_monthly_ranking_view_is_allowed(self):
        tree = ast.parse((ROOT / "api" / "app.py").read_text(encoding="utf-8"))
        tables = None
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "TABLES" for t in node.targets
            ):
                container = node.value
                if isinstance(container, ast.Call) and container.args:
                    container = container.args[0]  # frozenset({...})
                tables = {
                    el.value for el in container.elts
                    if isinstance(el, ast.Constant) and isinstance(el.value, str)
                }
        self.assertIsNotNone(tables)
        self.assertIn("party_game_monthly_ranking", tables)


class _MonthlyClient:
    """RPC は成功するが月次ビューの select だけ API に弾かれる偽クライアント。"""

    def __init__(self):
        self.error = APIError("Table is not available through this API", code="TABLE_NOT_ALLOWED")

    def rpc(self, name, params):
        client = self

        class _RPC:
            def execute(self):
                return SimpleNamespace(data=1)

        return _RPC()

    def table(self, name):
        client = self

        class _Query:
            def select(self, *a, **k):
                return self

            def eq(self, *a, **k):
                return self

            def order(self, *a, **k):
                return self

            def limit(self, *a, **k):
                return self

            def execute(self):
                raise client.error

        return _Query()


class PartyRankingHealthTest(unittest.IsolatedAsyncioTestCase):
    async def test_monthly_view_failure_warns_and_falls_back_to_memory(self):
        from core.game.game import party_ranking

        ranking = party_ranking.PartyRanking(client=_MonthlyClient())
        await ranking.record_win(100, 1, "uno")
        with self.assertLogs("core.game.game.party_ranking", level="WARNING") as caught:
            rows = await ranking.monthly_top(100)
        self.assertEqual(rows, [(1, 1)])
        self.assertTrue(any("月次ビュー" in line for line in caught.output))

    async def test_remote_disabled_recovers_after_cooldown(self):
        from core.game.game import party_ranking

        class MissingRPC:
            def rpc(self, name, params):
                class _RPC:
                    def execute(self):
                        raise APIError("function missing", code="42883")

                return _RPC()

        ranking = party_ranking.PartyRanking(client=MissingRPC())
        await ranking.record_win(100, 1, "uno")
        self.assertTrue(ranking.remote_disabled)
        self.assertFalse(ranking.remote_enabled)
        ranking._disabled_at = time.monotonic() - (party_ranking.DISABLED_RETRY_SECONDS + 1)
        self.assertTrue(ranking.remote_enabled)


class SokunukeConcurrentJoinTest(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_joins_do_not_lose_entries(self):
        from core.game.sokunuke_rta.cog import SokuNukeRta

        with tempfile.TemporaryDirectory() as tmp:
            kv = KVStore("guild_settings", client=None, path=str(Path(tmp) / "bot_kv.json"))
            store = GuildSettings(kv)
            guild_settings.set_store(store)
            try:
                cog = SokuNukeRta(bot=None)
                original_get = cog._get_settings

                async def slow_get(guild_id):
                    settings = await original_get(guild_id)
                    await asyncio.sleep(0)  # 実環境の読み直し/通信に相当する割り込み点
                    return settings

                cog._get_settings = slow_get
                guild = SimpleNamespace(id=555)
                m1 = SimpleNamespace(id=111, bot=False, guild=guild)
                m2 = SimpleNamespace(id=222, bot=False, guild=guild)
                await asyncio.gather(cog.on_member_join(m1), cog.on_member_join(m2))
                joins = store.get(555, "sokunuke_rta").get("joins") or {}
            finally:
                guild_settings.set_store(None)
        self.assertEqual(set(joins), {"111", "222"})


if __name__ == "__main__":
    unittest.main()
