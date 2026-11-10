# -*- coding: utf-8 -*-
"""連携広告枠のパートナー広告配信（core/ads.py フェーズ2）のテスト。

- 配信対象の選別（承認済み・guild_registry に現存するものだけ。
  掲載期限は無いので expires_at は無視する）
- 配分（承認広告がある間はハウス25%＋承認広告均等、0件なら従来どおり）
- キャッシュ（60秒TTL、読み込み失敗時は手元のキャッシュで継続）
- 裏読み込みの予約（pick_creative からのスケジュール）
Discord / DB には接続しない（KV はフェイクに差し替える）。
"""

import asyncio
import itertools
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from core import ads  # noqa: E402

NOW = datetime(2026, 11, 10, 0, 0, 0, tzinfo=timezone.utc)
FUTURE = (NOW + timedelta(days=10)).isoformat()
PAST = (NOW - timedelta(days=1)).isoformat()
REGISTRY = {"111": {"name": "対象鯖"}, "222": {"name": "別鯖"}}


def record(**overrides):
    base = {
        "guild_id": "111",
        "guild_name": "対象鯖",
        "text": "みんなでゲームする鯖です",
        "url": "https://discord.gg/example",
        "status": "approved",
        "expires_at": None,
    }
    base.update(overrides)
    return base


class FakeKv:
    """KVStore の load_all だけを持つフェイク。"""

    def __init__(self, data=None, error=None):
        self.data = data or {}
        self.error = error
        self.calls = 0

    async def load_all(self):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return dict(self.data)


class AdsStateMixin:
    def setUp(self):
        self._old = (
            ads._slot_counter, ads._house_counter, ads._partner_counter,
            ads._partner_creatives, ads._partner_loaded_at, ads._kv_factory,
        )
        ads._slot_counter = itertools.count()
        ads._house_counter = itertools.count()
        ads._partner_counter = itertools.count()
        ads._partner_creatives = []
        ads._partner_loaded_at = ads.time.monotonic()
        self.addCleanup(self._restore)

    def _restore(self):
        (ads._slot_counter, ads._house_counter, ads._partner_counter,
         ads._partner_creatives, ads._partner_loaded_at, ads._kv_factory) = self._old


class RecordFilterTest(unittest.TestCase):
    def select(self, records, registry=REGISTRY):
        return ads.partner_creatives_from_records(records, set(registry))

    def test_approved_in_registry_is_selected(self):
        picked = self.select({"a1": record()})
        self.assertEqual(len(picked), 1)
        self.assertEqual(picked[0].text, "みんなでゲームする鯖です")
        self.assertEqual(picked[0].url, "https://discord.gg/example")
        self.assertEqual(picked[0].name, "対象鯖")

    def test_non_approved_statuses_are_excluded(self):
        for status in ("pending", "rejected", "expired", "revoked"):
            self.assertEqual(self.select({"a1": record(status=status)}), [], status)

    def test_expires_at_is_ignored(self):
        # 掲載期限は撤廃されたため、expires_at が過去でも・壊れていても・
        # 無くても、承認済みで在籍中なら配信される（永続表示）。
        self.assertEqual(len(self.select({"a1": record(expires_at=PAST)})), 1)
        self.assertEqual(len(self.select({"a1": record(expires_at=FUTURE)})), 1)
        self.assertEqual(len(self.select({"a1": record(expires_at="not-a-date")})), 1)
        without_key = record()
        del without_key["expires_at"]
        self.assertEqual(len(self.select({"a1": without_key})), 1)

    def test_guild_removed_from_registry_is_excluded(self):
        # Bot が退出したギルドの広告は、レコードが approved のままでも配信しない
        self.assertEqual(self.select({"a1": record(guild_id="999")}), [])
        self.assertEqual(self.select({"a1": record()}, registry={}), [])

    def test_broken_records_are_skipped_not_fatal(self):
        records = {
            "a1": "not-a-dict",
            "a2": record(text=""),
            "a3": record(url="http://insecure.example"),
            "a4": record(url=None),
            "a5": record(),
        }
        picked = self.select(records)
        self.assertEqual(len(picked), 1)
        self.assertEqual(picked[0].text, "みんなでゲームする鯖です")

    def test_order_is_stable_by_key(self):
        records = {
            "b2": record(guild_id="222", guild_name="別鯖", text="二番目"),
            "a1": record(text="一番目"),
        }
        picked = self.select(records)
        self.assertEqual([c.text for c in picked], ["一番目", "二番目"])


class DistributionTest(AdsStateMixin, unittest.TestCase):
    def set_partners(self, *texts):
        ads._partner_creatives = [
            ads.Creative(name=t, text=t, url=f"https://discord.gg/{t}") for t in texts
        ]

    def test_no_partners_means_house_rotation_as_before(self):
        picks = [ads.pick_creative() for _ in range(len(ads.CREATIVES))]
        self.assertEqual(picks, list(ads.CREATIVES))

    def test_house_share_is_one_in_four_with_partners(self):
        self.set_partners("p1", "p2")
        picks = [ads.pick_creative() for _ in range(8)]
        house = [p for p in picks if p in ads.CREATIVES]
        partner = [p for p in picks if p not in ads.CREATIVES]
        self.assertEqual(len(house), 2)     # 8回中2回 = 25%
        self.assertEqual(len(partner), 6)
        # 承認広告は均等に回る（2件が交互）
        self.assertEqual([p.text for p in partner], ["p1", "p2", "p1", "p2", "p1", "p2"])

    def test_single_partner_gets_all_partner_slots(self):
        self.set_partners("only")
        picks = [ads.pick_creative() for _ in range(4)]
        self.assertEqual([p.text for p in picks if p.text != "x"], [p.text for p in picks])
        partner = [p for p in picks if p.text == "only"]
        self.assertEqual(len(partner), 3)


class RefreshTest(AdsStateMixin, unittest.IsolatedAsyncioTestCase):
    def install_kv(self, partner_data=None, registry_data=None,
                   partner_error=None, registry_error=None):
        stores = {
            ads.PARTNER_NAMESPACE: FakeKv(partner_data, partner_error),
            ads.REGISTRY_NAMESPACE: FakeKv(registry_data, registry_error),
        }
        ads.set_kv_factory(lambda namespace: stores[namespace])
        return stores

    async def test_refresh_loads_filtered_partners(self):
        self.install_kv(
            {"a1": record(), "a2": record(status="pending")},
            {"111": {"name": "対象鯖"}},
        )
        ads._partner_loaded_at = None
        loaded = await ads.refresh_partner_ads()
        self.assertEqual(len(loaded), 1)
        self.assertEqual(ads._partner_creatives[0].text, "みんなでゲームする鯖です")

    async def test_refresh_respects_ttl(self):
        stores = self.install_kv({}, {})
        ads._partner_loaded_at = None
        await ads.refresh_partner_ads()
        await ads.refresh_partner_ads()
        self.assertEqual(stores[ads.PARTNER_NAMESPACE].calls, 1)
        await ads.refresh_partner_ads(force=True)
        self.assertEqual(stores[ads.PARTNER_NAMESPACE].calls, 2)

    async def test_refresh_failure_keeps_previous_cache(self):
        self.install_kv(partner_error=RuntimeError("api down"))
        ads._partner_creatives = [ads.Creative(name="keep", text="keep", url="https://discord.gg/keep")]
        ads._partner_loaded_at = None
        loaded = await ads.refresh_partner_ads()
        self.assertEqual([c.text for c in loaded], ["keep"])
        # 失敗しても配信はハウス枠＋手元キャッシュで続く（例外を外に出さない）

    async def test_refresh_failure_from_empty_cache_means_house_only(self):
        self.install_kv(registry_error=RuntimeError("api down"))
        ads._partner_loaded_at = None
        loaded = await ads.refresh_partner_ads()
        self.assertEqual(loaded, [])
        self.assertIn(ads.pick_creative(), ads.CREATIVES)

    async def test_pick_schedules_background_refresh_when_stale(self):
        self.install_kv({"a1": record()}, {"111": {"name": "対象鯖"}})
        ads._partner_loaded_at = None
        ads.pick_creative()
        await asyncio.sleep(0.1)
        self.assertEqual(len(ads._partner_creatives), 1)


if __name__ == "__main__":
    unittest.main()
