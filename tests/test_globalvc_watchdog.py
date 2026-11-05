"""グローバルVC watchdog の適応間隔（監査 #5）のテスト。Discord には接続しない。

- 接続中のクライアントが無い間は間隔が長い（PLAYBACK_WATCHDOG_IDLE_SECONDS）こと
- 接続中のクライアントがある間は従来どおり短い（PLAYBACK_WATCHDOG_SECONDS）こと
- watchdog 本体が、接続中クライアントには再生再開（_ensure_playing）を試み、
  接続状況に応じて間隔を切り替えること
"""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from cogs import sio_globalVC as gvc  # noqa: E402
from tests.test_voice_session import make_bot  # noqa: E402


class IntervalDecisionTest(unittest.TestCase):
    """アクティブ判定 → 間隔の純関数テスト。"""

    def test_no_rooms_is_idle(self):
        self.assertEqual(gvc._watchdog_interval_seconds({}), gvc.PLAYBACK_WATCHDOG_IDLE_SECONDS)

    def test_room_without_clients_is_idle(self):
        self.assertEqual(gvc._watchdog_interval_seconds({'room': []}), gvc.PLAYBACK_WATCHDOG_IDLE_SECONDS)

    def test_room_with_client_is_active(self):
        self.assertEqual(gvc._watchdog_interval_seconds({'room': [object()]}), gvc.PLAYBACK_WATCHDOG_SECONDS)

    def test_default_reads_global_rooms(self):
        saved = dict(gvc.GLOBAL_ROOMS)
        try:
            gvc.GLOBAL_ROOMS.clear()
            self.assertEqual(gvc._watchdog_interval_seconds(), gvc.PLAYBACK_WATCHDOG_IDLE_SECONDS)
            gvc.GLOBAL_ROOMS['room'] = [object()]
            self.assertEqual(gvc._watchdog_interval_seconds(), gvc.PLAYBACK_WATCHDOG_SECONDS)
        finally:
            gvc.GLOBAL_ROOMS.clear()
            gvc.GLOBAL_ROOMS.update(saved)


class WatchdogSyncTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot, self.manager = make_bot()
        self.saved = dict(gvc.GLOBAL_ROOMS)
        gvc.GLOBAL_ROOMS.clear()
        self.cog = gvc.GlobalVCCog(self.bot)

    async def asyncTearDown(self):
        await self.manager.close()
        gvc.GLOBAL_ROOMS.clear()
        gvc.GLOBAL_ROOMS.update(self.saved)

    def fake_client(self):
        vc = Mock()
        vc.is_connected.return_value = True
        return vc

    def test_sync_switches_interval_with_activity(self):
        loop = self.cog._playback_watchdog
        self.assertEqual(loop.seconds, gvc.PLAYBACK_WATCHDOG_SECONDS)  # 初期値は従来どおり
        self.cog._sync_watchdog_interval()
        self.assertEqual(loop.seconds, gvc.PLAYBACK_WATCHDOG_IDLE_SECONDS)
        gvc.GLOBAL_ROOMS['room'] = [self.fake_client()]
        self.cog._sync_watchdog_interval()
        self.assertEqual(loop.seconds, gvc.PLAYBACK_WATCHDOG_SECONDS)
        gvc.GLOBAL_ROOMS.clear()
        self.cog._sync_watchdog_interval()
        self.assertEqual(loop.seconds, gvc.PLAYBACK_WATCHDOG_IDLE_SECONDS)

    async def test_body_ensures_playing_and_stays_active(self):
        vc = self.fake_client()
        gvc.GLOBAL_ROOMS['room'] = [vc]
        with patch.object(gvc, '_ensure_playing') as ensure:
            await gvc.GlobalVCCog._playback_watchdog.coro(self.cog)
        ensure.assert_called_once_with(vc)
        self.assertEqual(self.cog._playback_watchdog.seconds, gvc.PLAYBACK_WATCHDOG_SECONDS)

    async def test_body_without_clients_goes_idle(self):
        with patch.object(gvc, '_ensure_playing') as ensure:
            await gvc.GlobalVCCog._playback_watchdog.coro(self.cog)
        ensure.assert_not_called()
        self.assertEqual(self.cog._playback_watchdog.seconds, gvc.PLAYBACK_WATCHDOG_IDLE_SECONDS)


if __name__ == '__main__':
    unittest.main()
