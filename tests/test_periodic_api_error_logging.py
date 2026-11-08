# -*- coding: utf-8 -*-
"""周期処理の API 接続エラーのログ衛生の回帰テスト。

Bot 自前 API は api/ を含むデプロイのたびに再起動されるため、周期処理が
その瞬間に API を叩くと接続不可（APIError code=API_CONNECTION_ERROR）に
なる。これは想定内・自己回復（次周期で再試行）なので、ERROR+traceback
ではなく WARNING 1行で残す。それ以外の失敗は従来どおり ERROR+traceback。
"""
import logging
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

from core.game.rta.worker import WorkerMixin
from core.game.seizon.cog import FujoSurvival
from core.support import public_ranking as public_ranking_pkg
from core.support.api_client import APIError, is_connection_error
from core.support.public_ranking.cog import PublicRankingCog

CONN_ERROR = APIError("自前DB APIに接続できません", code="API_CONNECTION_ERROR")
OTHER_API_ERROR = APIError("DB API request failed", code="TABLE_NOT_FOUND", status_code=404)


def _single_record(cm) -> logging.LogRecord:
    assert len(cm.records) == 1, [r.getMessage() for r in cm.records]
    return cm.records[0]


class IsConnectionErrorTests(unittest.TestCase):
    def test_connection_error_code(self):
        self.assertTrue(is_connection_error(CONN_ERROR))

    def test_other_api_error_codes(self):
        self.assertFalse(is_connection_error(OTHER_API_ERROR))
        self.assertFalse(is_connection_error(APIError("x")))  # 既定コード API_ERROR

    def test_non_api_error(self):
        self.assertFalse(is_connection_error(RuntimeError("boom")))
        self.assertFalse(is_connection_error(ConnectionRefusedError("refused")))

    def test_duck_typed_code_alone_is_not_enough(self):
        class Fake:
            code = "API_CONNECTION_ERROR"
        self.assertFalse(is_connection_error(Fake()))


class _Worker(WorkerMixin):
    """依存を差し替えて reminder_worker だけを叩くための最小サブクラス。"""


def _make_worker(reconcile_error: BaseException) -> _Worker:
    worker = _Worker()
    worker._sync_ntp_if_due = AsyncMock()
    worker._reconcile = AsyncMock(side_effect=reconcile_error)
    worker._log_clock_if_due = Mock()
    return worker


class ReminderWorkerLoggingTests(unittest.IsolatedAsyncioTestCase):
    async def test_connection_error_is_quiet_warning(self):
        worker = _make_worker(CONN_ERROR)
        with self.assertLogs("cogs.disboard_rta", level="DEBUG") as cm:
            await worker.reminder_worker()
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.WARNING)
        self.assertIsNone(record.exc_info)
        self.assertIn("skipped", record.getMessage())

    async def test_other_api_error_stays_error_with_traceback(self):
        worker = _make_worker(OTHER_API_ERROR)
        with self.assertLogs("cogs.disboard_rta", level="DEBUG") as cm:
            await worker.reminder_worker()
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.ERROR)
        self.assertIsNotNone(record.exc_info)

    async def test_unexpected_error_stays_error_with_traceback(self):
        worker = _make_worker(RuntimeError("boom"))
        with self.assertLogs("cogs.disboard_rta", level="DEBUG") as cm:
            await worker.reminder_worker()
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.ERROR)
        self.assertIsNotNone(record.exc_info)


def _make_fujo(error: BaseException) -> FujoSurvival:
    cog = FujoSurvival.__new__(FujoSurvival)
    cog.bot = types.SimpleNamespace(get_user=lambda uid: None)
    cog.users = {}
    cog.users_loaded = True
    cog._ensure_users = AsyncMock(side_effect=error)
    return cog


class SeizonLoopLoggingTests(unittest.IsolatedAsyncioTestCase):
    async def test_panic_check_connection_error_is_quiet_warning(self):
        cog = _make_fujo(CONN_ERROR)
        with self.assertLogs("core.game.seizon.cog", level="DEBUG") as cm:
            await cog.check_panic_alerts()
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.WARNING)
        self.assertIsNone(record.exc_info)

    async def test_panic_check_other_error_stays_error(self):
        cog = _make_fujo(RuntimeError("boom"))
        with self.assertLogs("core.game.seizon.cog", level="DEBUG") as cm:
            await cog.check_panic_alerts()
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.ERROR)
        self.assertIsNotNone(record.exc_info)

    async def test_pester_check_connection_error_is_quiet_warning(self):
        cog = _make_fujo(CONN_ERROR)
        with self.assertLogs("core.game.seizon.cog", level="DEBUG") as cm:
            await cog.check_duo_pester()
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.WARNING)
        self.assertIsNone(record.exc_info)

    async def test_pester_check_other_api_error_stays_error(self):
        cog = _make_fujo(OTHER_API_ERROR)
        with self.assertLogs("core.game.seizon.cog", level="DEBUG") as cm:
            await cog.check_duo_pester()
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.ERROR)
        self.assertIsNotNone(record.exc_info)


class PublicRankingLoggingTests(unittest.IsolatedAsyncioTestCase):
    def _make_cog(self) -> PublicRankingCog:
        bot = types.SimpleNamespace(guilds=[], wait_until_ready=AsyncMock())
        return PublicRankingCog(bot)

    async def _run_loop(self, error: BaseException):
        cog = self._make_cog()
        registry = types.SimpleNamespace(sync_all=AsyncMock())
        with patch.object(public_ranking_pkg.snapshot, "write_snapshot",
                          AsyncMock(side_effect=error)), \
             patch("core.support.guild_registry.get_registry", return_value=registry), \
             self.assertLogs("core.support.public_ranking.cog", level="DEBUG") as cm:
            await cog.publish_loop()
        return cm

    async def test_loop_connection_error_is_quiet_warning(self):
        cm = await self._run_loop(CONN_ERROR)
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.WARNING)
        self.assertIsNone(record.exc_info)

    async def test_loop_other_error_stays_error_with_traceback(self):
        cm = await self._run_loop(RuntimeError("boom"))
        record = _single_record(cm)
        self.assertEqual(record.levelno, logging.ERROR)
        self.assertIsNotNone(record.exc_info)


if __name__ == "__main__":
    unittest.main()
