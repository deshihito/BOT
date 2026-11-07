# -*- coding: utf-8 -*-
"""保存先パスずれ (core 再編成 #505–#514) の移行テスト。

再編成で各ストアモジュールが1階層深くなった際、保存先が本来の
``<repo>/data/`` から ``<repo>/core/data/`` (zetamodoki_custom は
``core/game/data/``) にずれていた。PR #525 (EXP/MIQ) と同じ方式で:

- 既定の保存先が ``<repo>/data/<file>`` を指すこと (パス回帰)
- 旧パスにだけデータがある場合は読み込めること
- 両パスにある場合はストアごとのマージ規則に従うこと
  (dict 型 = 旧パス主 + 正規パスの補完 / スナップショット型 = 旧パス全体 /
  lottery = ラウンドは旧パス・履歴は統合 / usage_stats = カウンタ最大値)
- 環境変数で保存先が指定されている場合は移行しないこと

を13ストア分確認する。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.support import data_paths
from core.game import lottery, mining
from core.game.game import elo, game_records, game_restore, prison
from core.game.gambling import gambling
from core.game.zeta import store as zeta_store
from core.general.circulation import economy_pool
from core.general.items import items
from core.general.market import market
from core.support import usage_stats
from core.vc import voice_restore

REPO_ROOT = Path(__file__).resolve().parents[1]

# (module, filename, env var name)
STORES = [
    (items, "items.json", "ITEMS_DATA_PATH"),
    (market, "market.json", "MARKET_DATA_PATH"),
    (economy_pool, "economy_pool.json", "ECONOMY_POOL_DATA_PATH"),
    (gambling, "gambling.json", "GAMBLING_DATA_PATH"),
    (elo, "elo_ratings.json", "ELO_RATINGS_PATH"),
    (game_records, "game_records.json", "GAME_RECORDS_PATH"),
    (game_restore, "game_restore.json", "GAME_RESTORE_DATA_PATH"),
    (lottery, "lottery.json", "LOTTERY_DATA_PATH"),
    (mining, "mining.json", "MINING_DATA_PATH"),
    (prison, "prison.json", "PRISON_DATA_PATH"),
    (usage_stats, "usage_stats.json", "USAGE_STATS_PATH"),
    (voice_restore, "voice_restore.json", "VOICE_RESTORE_DATA_PATH"),
]
ALL_ENV_NAMES = [env for _, _, env in STORES] + ["ZETAMODOKI_CUSTOM_PATH"]


def _clean_env() -> dict:
    return {k: v for k, v in os.environ.items() if k not in ALL_ENV_NAMES}


class DefaultPathRegressionTest(unittest.TestCase):
    """(a) 既定の保存先が <repo>/data/<file>、旧パスが core/data/<file>。"""

    def test_default_paths_point_to_repo_data(self):
        with mock.patch.dict(os.environ, _clean_env(), clear=True):
            for module, filename, _env in STORES:
                with self.subTest(module=module.__name__):
                    self.assertEqual(
                        module.default_path(), REPO_ROOT / "data" / filename)
                    self.assertEqual(
                        module._STRAY_PATH, REPO_ROOT / "core" / "data" / filename)
                    self.assertEqual(
                        data_paths.data_path(filename), REPO_ROOT / "data" / filename)

    def test_zeta_paths(self):
        from core.game.zeta import common as zeta_common

        self.assertEqual(
            zeta_common.CUSTOM_FILE, REPO_ROOT / "data" / "zetamodoki_custom.json")
        self.assertEqual(
            zeta_common.STRAY_CUSTOM_FILE,
            REPO_ROOT / "core" / "game" / "data" / "zetamodoki_custom.json")


class _MigrationBase(unittest.TestCase):
    """モジュールの _DEFAULT_PATH / _STRAY_PATH を tmp に差し替える土台。"""

    module = None  # type: ignore
    env_name = ""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.canon = root / "data" / "store.json"
        self.stray = root / "core_data" / "store.json"
        patchers = [
            mock.patch.object(self.module, "_DEFAULT_PATH", self.canon),
            mock.patch.object(self.module, "_STRAY_PATH", self.stray),
            mock.patch.dict(os.environ, _clean_env(), clear=True),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def write(self, path: Path, payload) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


class DataPathsHelperTest(unittest.TestCase):
    def test_load_migrated_without_stray_reads_canonical(self):
        with tempfile.TemporaryDirectory() as tmp:
            canon = Path(tmp) / "a.json"
            stray = Path(tmp) / "b.json"
            canon.write_text('{"x": 1}', encoding="utf-8")
            self.assertEqual(data_paths.load_migrated(canon, stray, fill=True), {"x": 1})
            self.assertEqual(data_paths.load_migrated(canon, stray, fill=False), {"x": 1})

    def test_load_migrated_both_missing_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(data_paths.load_migrated(
                Path(tmp) / "a.json", Path(tmp) / "b.json", fill=True))

    def test_fill_merge_two_levels(self):
        canon = {"s": {"u1": {"a": 1}, "u2": {"a": 2}}, "t": 1}
        stray = {"s": {"u1": {"a": 9}}, "t": 2}
        merged = data_paths.fill_merge(canon, stray)
        self.assertEqual(merged["s"]["u1"], {"a": 9})
        self.assertEqual(merged["s"]["u2"], {"a": 2})
        self.assertEqual(merged["t"], 2)


class ItemsMigrationTest(_MigrationBase):
    module = items
    env_name = "ITEMS_DATA_PATH"

    def test_stray_only_is_loaded(self):
        self.write(self.stray, {
            "users": {"111": {"scrap": {"count": 3, "expires": None}}},
            "effects": {},
        })
        store = items.ItemStore()
        self.assertEqual(store.count("111", "scrap"), 3)

    def test_both_paths_stray_wins_and_canonical_fills(self):
        self.write(self.stray, {
            "users": {"111": {"scrap": {"count": 3, "expires": None}}},
            "effects": {},
        })
        self.write(self.canon, {
            "users": {
                "111": {"scrap": {"count": 9, "expires": None}},
                "222": {"metal_piece": {"count": 2, "expires": None}},
            },
            "effects": {},
        })
        store = items.ItemStore()
        self.assertEqual(store.count("111", "scrap"), 3)       # 旧パス優先
        self.assertEqual(store.count("222", "metal_piece"), 2)  # 正規パスから補完

    def test_env_override_disables_migration(self):
        env_path = Path(self.tmp.name) / "env" / "items.json"
        self.write(env_path, {
            "users": {"999": {"scrap": {"count": 4, "expires": None}}},
            "effects": {},
        })
        self.write(self.stray, {
            "users": {"111": {"scrap": {"count": 3, "expires": None}}},
            "effects": {},
        })
        with mock.patch.dict(os.environ, {"ITEMS_DATA_PATH": str(env_path)}):
            store = items.ItemStore()
        self.assertEqual(store.count("999", "scrap"), 4)
        self.assertEqual(store.count("111", "scrap"), 0)  # 旧パスは読まれない


class MarketMigrationTest(_MigrationBase):
    module = market

    def test_both_paths_stray_state_wins_wholesale(self):
        self.write(self.stray, {
            "rate": 123.0, "pool_aga": 900000, "pool_token": 999990.0,
            "balances": {"111": 10.0}, "history": [],
        })
        self.write(self.canon, {
            "rate": 55.0, "pool_aga": 800000, "pool_token": 999995.0,
            "balances": {"222": 5.0}, "history": [],
        })
        store = market.MarketStore()
        self.assertEqual(store.rate(), 123.0)
        self.assertEqual(store.token_balance("111"), 10.0)
        # スナップショット型なので正規パス側の保有量は混ざらない
        self.assertEqual(store.token_balance("222"), 0.0)


class EconomyPoolMigrationTest(_MigrationBase):
    module = economy_pool

    def test_both_paths_stray_balances_win(self):
        self.write(self.stray, {"pool": 777, "treasury": 333})
        self.write(self.canon, {"pool": 1, "treasury": 2})
        store = economy_pool.EconomyPoolStore()
        self.assertEqual(store.pool_balance(), 777)
        self.assertEqual(store.treasury_balance(), 333)

    def test_stray_only_is_loaded(self):
        self.write(self.stray, {"pool": 42, "treasury": 5})
        store = economy_pool.EconomyPoolStore()
        self.assertEqual(store.pool_balance(), 42)


class GamblingMigrationTest(_MigrationBase):
    module = gambling

    def test_both_paths_stray_sessions_win_wholesale(self):
        self.write(self.stray, {
            "users": {},
            "sessions": {"111": {"kind": "slot", "remaining": 5, "total": 10}},
            "duels": {},
        })
        self.write(self.canon, {
            "users": {},
            "sessions": {"222": {"kind": "slot", "remaining": 3, "total": 10}},
            "duels": {},
        })
        store = gambling.GamblingStore()
        self.assertIsNotNone(store.session("111"))
        # 再編前のセッションは復活させない (二重返金防止)
        self.assertIsNone(store.session("222"))


class EloMigrationTest(_MigrationBase):
    module = elo

    def test_both_paths_stray_wins_and_canonical_fills(self):
        self.write(self.stray, {
            "100:chess:1": {"rating": 1600.0, "wins": 3, "losses": 0, "draws": 0},
        })
        self.write(self.canon, {
            "100:chess:1": {"rating": 1400.0, "wins": 0, "losses": 3, "draws": 0},
            "100:chess:2": {"rating": 1500.0, "wins": 1, "losses": 1, "draws": 0},
        })
        store = elo.EloStore()
        self.assertEqual(store.get(100, "chess", 1)["rating"], 1600.0)
        self.assertEqual(store.get(100, "chess", 2)["wins"], 1)


class GameRecordsMigrationTest(_MigrationBase):
    module = game_records

    def test_both_paths_fill_per_user(self):
        key = game_records.flash_setting_key(5, 2, 0.5)
        self.write(self.stray, {"flash": {"111": {key: {
            "plays": 7, "correct": 6, "best_streak": 3, "streak": 1}}}})
        self.write(self.canon, {"flash": {
            "111": {key: {"plays": 99, "correct": 99, "best_streak": 9, "streak": 9}},
            "222": {key: {"plays": 2, "correct": 1, "best_streak": 1, "streak": 0}},
        }})
        store = game_records.GameRecordsStore()
        self.assertEqual(store._data["flash"]["111"][key]["plays"], 7)
        self.assertEqual(store._data["flash"]["222"][key]["plays"], 2)


class GameRestoreMigrationTest(_MigrationBase):
    module = game_restore

    def test_both_paths_stray_snapshot_wins_wholesale(self):
        self.write(self.stray, {"shogi": {"room1": {"board": [1]}}})
        self.write(self.canon, {
            "shogi": {"room2": {"board": [2]}},
            "chess": {"room3": {"board": [3]}},
        })
        store = game_restore.GameRestoreStore()
        self.assertIn("room1", store._data["shogi"])
        self.assertNotIn("room2", store._data["shogi"])
        self.assertEqual(store._data["chess"], {})


class LotteryMigrationTest(_MigrationBase):
    module = lottery

    @staticmethod
    def _history(round_id, drawn_at, pool):
        return {"round_id": round_id, "drawn_at": drawn_at, "pool": pool,
                "payout": 0, "burned": 0, "carryover": 0, "boost": 0, "winners": []}

    def test_both_paths_round_from_stray_history_merged(self):
        self.write(self.stray, {
            "round": {"id": 3, "pool": 500, "tickets": {"111": 2},
                      "closes_at": "2026-11-07T21:00:00+09:00", "boost": 0},
            "history": [self._history(2, "2026-11-06T21:00:00+09:00", 100)],
        })
        self.write(self.canon, {
            "round": {"id": 9, "pool": 999, "tickets": {"222": 1},
                      "closes_at": "2026-11-05T21:00:00+09:00", "boost": 0},
            "history": [
                self._history(1, "2026-11-05T21:00:00+09:00", 50),
                self._history(2, "2026-11-06T21:00:00+09:00", 70),
            ],
        })
        store = lottery.LotteryStore()
        # 現行ラウンドは旧パス (最新) のもの
        self.assertEqual(store._state["round"]["id"], 3)
        self.assertEqual(store._state["round"]["pool"], 500)
        # 履歴は統合され、同じ (round_id, drawn_at) は旧パス側が残る
        history = store._state["history"]
        self.assertEqual([h["round_id"] for h in history], [1, 2])
        self.assertEqual(history[1]["pool"], 100)


class MiningMigrationTest(_MigrationBase):
    module = mining

    def test_both_paths_fill_per_user(self):
        self.write(self.stray, {"users": {
            "111": {"last": None, "session_left": 5, "direct": False}}})
        self.write(self.canon, {"users": {
            "111": {"last": None, "session_left": 19, "direct": False},
            "222": {"last": None, "session_left": 7, "direct": True}}})
        store = mining.MiningStore()
        self.assertEqual(store.status("111")["session_left"], 5)
        self.assertEqual(store.status("222")["session_left"], 7)


class PrisonMigrationTest(_MigrationBase):
    module = prison

    FUTURE = "2999-01-01T00:00:00+09:00"

    def test_both_paths_fill_per_user(self):
        self.write(self.stray, {"users": {
            "111": {"until": self.FUTURE, "reason": "stray"}}})
        self.write(self.canon, {"users": {
            "111": {"until": self.FUTURE, "reason": "canon"},
            "222": {"until": self.FUTURE, "reason": "canon"}}})
        store = prison.PrisonStore()
        self.assertEqual(store._state["users"]["111"]["reason"], "stray")
        self.assertIn("222", store._state["users"])
        self.assertTrue(store.is_imprisoned("222"))


class UsageStatsMigrationTest(_MigrationBase):
    module = usage_stats

    def test_both_paths_counters_take_max(self):
        self.write(self.stray, {
            "started_at": "2026-11-06T00:00:00+09:00",
            "commands": {"!a": 5, "!b": 3},
            "actions": {},
            "daily": {"2026-11-06": {"commands": 5, "actions": 1}},
        })
        self.write(self.canon, {
            "started_at": "2026-11-01T00:00:00+09:00",
            "commands": {"!a": 9, "!c": 7},
            "actions": {"x": 2},
            "daily": {
                "2026-11-05": {"commands": 4, "actions": 2},
                "2026-11-06": {"commands": 8, "actions": 0},
            },
        })
        store = usage_stats.UsageStatsStore()
        snap = store.snapshot()
        # 合算せずキーごとに最大値 (二重計上の回避)
        self.assertEqual(snap["commands"], {"!a": 9, "!b": 3, "!c": 7})
        self.assertEqual(snap["actions"], {"x": 2})
        self.assertEqual(snap["daily"]["2026-11-05"], {"commands": 4, "actions": 2})
        self.assertEqual(snap["daily"]["2026-11-06"], {"commands": 8, "actions": 1})
        self.assertEqual(snap["started_at"], "2026-11-06T00:00:00+09:00")


class VoiceRestoreMigrationTest(_MigrationBase):
    module = voice_restore

    def test_both_paths_stray_snapshot_wins_wholesale(self):
        self.write(self.stray, {"sessions": {"100": {"channel_id": 1}}})
        self.write(self.canon, {
            "sessions": {"200": {"channel_id": 2}},
            "gvc_rooms": {"roomA": {"owner": 1}},
        })
        store = voice_restore.VoiceRestoreStore()
        self.assertIn("100", store._data["sessions"])
        self.assertNotIn("200", store._data["sessions"])
        # 古いスナップショットは復活させない
        self.assertEqual(store._data["gvc_rooms"], {})


class ZetaMigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.canon = root / "data" / "zetamodoki_custom.json"
        self.stray = root / "stray" / "zetamodoki_custom.json"
        patchers = [
            mock.patch.object(zeta_store, "CUSTOM_FILE", self.canon),
            mock.patch.object(zeta_store, "STRAY_CUSTOM_FILE", self.stray),
            mock.patch.dict(os.environ, _clean_env(), clear=True),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def write(self, path: Path, payload) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    @staticmethod
    def _entry(entry_id, name):
        return {"id": entry_id, "name": name, "persona": "p",
                "situation": "s", "first_message": "f", "icon_url": ""}

    def test_both_paths_fill_per_user(self):
        self.write(self.stray, {"111": [self._entry("aaa", "Stray")]})
        self.write(self.canon, {
            "111": [self._entry("bbb", "Canon")],
            "222": [self._entry("ccc", "Canon2")],
        })
        store = zeta_store.CustomSituationStore(path=self.canon)
        self.assertEqual([e["id"] for e in store.list(111)], ["aaa"])
        self.assertEqual([e["id"] for e in store.list(222)], ["ccc"])

    def test_stray_only_is_loaded(self):
        self.write(self.stray, {"111": [self._entry("aaa", "Stray")]})
        store = zeta_store.CustomSituationStore(path=self.canon)
        self.assertEqual([e["id"] for e in store.list(111)], ["aaa"])


if __name__ == "__main__":
    unittest.main()
