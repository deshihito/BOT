"""逮捕時間の帯変更（30分〜1時間）と脱獄のテスト（2026-11-06）。

- 逮捕時間の定数が 30〜60 分の帯に収まっていること
- 脱獄: 成功で即時釈放、失敗で +10 分（通算 60 分キャップ）、
  10 分間隔のクールダウン、試行状態の永続化
- マネーパネル: 脱獄ボタンは逮捕中のときだけ出ること、逮捕中でない
  ユーザーは脱獄できないこと
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import prison as prison_core
from core.items import JST

T0 = datetime(2026, 11, 6, 12, 0, tzinfo=JST)


class _ScriptedRandom:
    """random() が決められた値を順に返す抽選スタブ。"""

    def __init__(self, values):
        self._values = list(values)

    def random(self):
        return self._values.pop(0) if self._values else 0.99


def _store(tmp, rng=None):
    return prison_core.PrisonStore(
        Path(tmp) / "prison.json", rng=rng or _ScriptedRandom([]))


class PrisonDurationBandTest(unittest.TestCase):
    def test_durations_within_band(self):
        self.assertEqual(prison_core.BATON_PRISON_MINUTES, 30)
        self.assertEqual(prison_core.DAI_BATON_PRISON_MINUTES, 60)
        self.assertEqual(prison_core.MUD_HAT_PRISON_MINUTES, 30)
        self.assertEqual(prison_core.DAI_MUD_HAT_PRISON_MINUTES, 60)
        for minutes in (
            prison_core.BATON_PRISON_MINUTES,
            prison_core.DAI_BATON_PRISON_MINUTES,
            prison_core.MUD_HAT_PRISON_MINUTES,
            prison_core.DAI_MUD_HAT_PRISON_MINUTES,
        ):
            self.assertGreaterEqual(minutes, 30)
            self.assertLessEqual(minutes, 60)


class JailbreakStoreTest(unittest.TestCase):
    def test_success_releases_immediately(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _ScriptedRandom([0.0]))
            store.imprison("1", minutes=30, now=T0)
            result = store.attempt_jailbreak("1", now=T0)
            self.assertEqual(result["outcome"], "success")
            self.assertFalse(store.is_imprisoned("1", T0))

    def test_failure_extends_by_ten_minutes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _ScriptedRandom([0.99]))
            store.imprison("1", minutes=30, now=T0)
            result = store.attempt_jailbreak("1", now=T0)
            self.assertEqual(result["outcome"], "failure")
            self.assertAlmostEqual(result["remaining"], 40 * 60, delta=1)
            self.assertAlmostEqual(
                store.remaining_seconds("1", T0), 40 * 60, delta=1)

    def test_failure_extension_capped_at_sixty_minutes_total(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _ScriptedRandom([0.99, 0.99, 0.99, 0.99]))
            store.imprison("1", minutes=30, now=T0)
            store.attempt_jailbreak("1", now=T0)  # 残り40分
            store.attempt_jailbreak("1", now=T0 + timedelta(minutes=10))
            store.attempt_jailbreak("1", now=T0 + timedelta(minutes=20))
            result = store.attempt_jailbreak(
                "1", now=T0 + timedelta(minutes=30))
            self.assertEqual(result["outcome"], "failure")
            # 逮捕開始（T0）から通算60分を超えない。
            status = store.status("1", T0)
            self.assertLessEqual(
                status["until"], T0 + timedelta(minutes=60))

    def test_cooldown_between_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _ScriptedRandom([0.99, 0.0]))
            store.imprison("1", minutes=60, now=T0)
            first = store.attempt_jailbreak("1", now=T0)
            self.assertEqual(first["outcome"], "failure")
            second = store.attempt_jailbreak(
                "1", now=T0 + timedelta(minutes=5))
            self.assertEqual(second["outcome"], "cooldown")
            self.assertAlmostEqual(second["wait_seconds"], 5 * 60, delta=1)
            # クールダウン中の試行は回数に数えない。
            self.assertEqual(store.jailbreak_status("1", T0)["attempts"], 1)
            third = store.attempt_jailbreak(
                "1", now=T0 + timedelta(minutes=10))
            self.assertEqual(third["outcome"], "success")

    def test_not_imprisoned_cannot_jailbreak(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _ScriptedRandom([0.0]))
            result = store.attempt_jailbreak("1", now=T0)
            self.assertEqual(result["outcome"], "not_imprisoned")
            self.assertEqual(store.jailbreak_status("1", T0)["attempts"], 0)

    def test_attempt_state_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prison.json"
            store = prison_core.PrisonStore(path, rng=_ScriptedRandom([0.99]))
            store.imprison("1", minutes=30, now=T0)
            store.attempt_jailbreak("1", now=T0)
            store.flush()
            reloaded = prison_core.PrisonStore(path, rng=_ScriptedRandom([0.0]))
            status = reloaded.jailbreak_status("1", T0)
            self.assertEqual(status["attempts"], 1)
            self.assertFalse(status["can_attempt"])
            self.assertTrue(
                reloaded.jailbreak_status(
                    "1", T0 + timedelta(minutes=10))["can_attempt"])

    def test_rearrest_resets_attempt_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _store(tmp, _ScriptedRandom([0.99, 0.0]))
            store.imprison("1", minutes=30, now=T0)
            store.attempt_jailbreak("1", now=T0)
            # 釈放後に再逮捕されたら試行状態はリセットされる。
            store.release("1")
            store.imprison("1", minutes=30, now=T0 + timedelta(hours=2))
            status = store.jailbreak_status("1", T0 + timedelta(hours=2))
            self.assertEqual(status["attempts"], 0)
            self.assertTrue(status["can_attempt"])


class _FakeBot:
    def __init__(self, circulation):
        self._circulation = circulation

    def get_cog(self, name):
        return self._circulation if name == "CirculationCog" else None


class JailbreakPanelTest(unittest.TestCase):
    def _cog(self, tmp, rng):
        from cogs.money_panel import MoneyPanelCog

        store = _store(tmp, rng)
        circulation = SimpleNamespace(prison_store=store)
        cog = MoneyPanelCog(
            _FakeBot(circulation), balance_reader=lambda uid: 0)
        return cog, store

    def test_button_only_when_imprisoned(self):
        from cogs.money_panel import MoneyPanelView

        with tempfile.TemporaryDirectory() as tmp:
            cog, store = self._cog(tmp, _ScriptedRandom([]))
            view = MoneyPanelView(cog, 1)
            labels = [getattr(c, "label", None) for c in view.children]
            self.assertNotIn("脱獄を試みる", labels)
            view._prison = True
            view.refresh()
            labels = [getattr(c, "label", None) for c in view.children]
            self.assertIn("脱獄を試みる", labels)

    def test_cog_attempt_outcomes(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, store = self._cog(tmp, _ScriptedRandom([0.99, 0.0]))
            # 逮捕中でないユーザーは脱獄できない。
            message = asyncio.run(cog.attempt_jailbreak(1))
            self.assertIn("逮捕されていません", message)
            store.imprison("1", minutes=30, now=datetime.now(JST))
            message = asyncio.run(cog.attempt_jailbreak(1))
            self.assertIn("失敗", message)
            message = asyncio.run(cog.attempt_jailbreak(1))
            self.assertIn("まだ脱獄を試みられません", message)

    def test_cog_attempt_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            cog, store = self._cog(tmp, _ScriptedRandom([0.0]))
            store.imprison("1", minutes=30, now=datetime.now(JST))
            message = asyncio.run(cog.attempt_jailbreak(1))
            self.assertIn("脱獄成功", message)
            self.assertFalse(store.is_imprisoned("1"))


if __name__ == "__main__":
    unittest.main()
