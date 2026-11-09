# -*- coding: utf-8 -*-
"""人物分析（交流グラフ）の収集・計算・描画・登録のテスト。

収集は本文を見ず、返信先とメンション先の関係だけを数えること、
OFF ギルド・Bot・DM・webhook を記録しないことを固定する。
計算は既知の小グラフ（スター／パス／2成分）で順序を固定する。
"""
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402

from core.support.person_analysis import metrics, render  # noqa: E402
from core.support.person_analysis import store as pa_store  # noqa: E402
from core.support.person_analysis.cog import (  # noqa: E402
    PersonAnalysisCog,
    PersonAnalysisView,
    message_targets,
)

UTC_10AM = datetime(2026, 11, 9, 10, 0, tzinfo=timezone.utc)  # JST 19時


def make_user(user_id, bot=False):
    return types.SimpleNamespace(id=user_id, bot=bot)


def make_message(*, guild_id=1, author_id=10, author_bot=False,
                 webhook_id=None, msg_type=discord.MessageType.default,
                 reply_author=None, mentions=(), created_at=UTC_10AM):
    reference = None
    if reply_author is not None:
        reference = types.SimpleNamespace(
            resolved=types.SimpleNamespace(author=reply_author))
    return types.SimpleNamespace(
        guild=(types.SimpleNamespace(id=guild_id)
               if guild_id is not None else None),
        author=make_user(author_id, bot=author_bot),
        webhook_id=webhook_id,
        type=msg_type,
        reference=reference,
        mentions=list(mentions),
        created_at=created_at,
    )


class MessageTargetsTest(unittest.TestCase):
    def test_reply_counts_reply_author(self):
        message = make_message(reply_author=make_user(20))
        self.assertEqual(message_targets(message), [20])

    def test_mentions_counted(self):
        message = make_message(mentions=[make_user(20), make_user(30)])
        self.assertEqual(message_targets(message), [20, 30])

    def test_reply_and_mention_deduped(self):
        message = make_message(
            reply_author=make_user(20),
            mentions=[make_user(20), make_user(30)],
        )
        self.assertEqual(message_targets(message), [20, 30])

    def test_self_and_bots_excluded(self):
        message = make_message(
            reply_author=make_user(10),  # 自分への返信は数えない
            mentions=[make_user(10), make_user(99, bot=True), make_user(30)],
        )
        self.assertEqual(message_targets(message), [30])

    def test_bot_reply_author_excluded(self):
        message = make_message(reply_author=make_user(20, bot=True))
        self.assertEqual(message_targets(message), [])


class StoreRecordTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = pa_store.PersonGraphStore(
            Path(self.tmp.name) / "person_analysis.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_edges_and_histogram_accumulate(self):
        self.store.record(1, 10, [20, 30], 19)
        self.store.record(1, 10, [20], 19)
        self.store.record(1, 20, [10], 20)
        snapshot = self.store.guild_snapshot(1)
        self.assertEqual(snapshot["edges"], {10: {20: 2, 30: 1}, 20: {10: 1}})
        self.assertEqual(snapshot["hours"][10][19], 2)
        self.assertEqual(snapshot["hours"][20][20], 1)
        self.assertTrue(snapshot["started_at"])

    def test_message_without_targets_still_counts_histogram(self):
        self.store.record(1, 10, [], 3)
        snapshot = self.store.guild_snapshot(1)
        self.assertEqual(snapshot["edges"], {})
        self.assertEqual(snapshot["hours"][10][3], 1)

    def test_flush_and_reload_roundtrip(self):
        self.store.record(1, 10, [20], 19)
        self.store.flush()
        reloaded = pa_store.PersonGraphStore(
            Path(self.tmp.name) / "person_analysis.json")
        self.assertEqual(reloaded.guild_snapshot(1)["edges"], {10: {20: 1}})

    def test_unknown_guild_snapshot_is_empty(self):
        snapshot = self.store.guild_snapshot(999)
        self.assertEqual(snapshot["edges"], {})
        self.assertEqual(snapshot["hours"], {})


class _FakeSettingsStore:
    def __init__(self, enabled):
        self._enabled = enabled

    async def ensure_loaded(self):
        return None

    def get(self, guild_id, section):
        return {"enabled": True} if self._enabled else {}


class ListenerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cog = PersonAnalysisCog(types.SimpleNamespace())
        self.cog.store = pa_store.PersonGraphStore(
            Path(self.tmp.name) / "person_analysis.json")

    def tearDown(self):
        self.tmp.cleanup()

    async def _dispatch(self, message, enabled=True):
        from core.support import guild_settings
        with patch.object(guild_settings, "get_store",
                          lambda: _FakeSettingsStore(enabled)):
            await self.cog.on_message(message)

    async def test_records_reply_and_histogram_in_jst(self):
        await self._dispatch(make_message(reply_author=make_user(20)))
        snapshot = self.cog.store.guild_snapshot(1)
        self.assertEqual(snapshot["edges"], {10: {20: 1}})
        self.assertEqual(snapshot["hours"][10][19], 1)  # 10:00 UTC = 19:00 JST

    async def test_off_guild_records_nothing(self):
        await self._dispatch(
            make_message(reply_author=make_user(20)), enabled=False)
        self.assertEqual(self.cog.store.guild_snapshot(1)["edges"], {})

    async def test_dm_bot_and_webhook_are_skipped(self):
        await self._dispatch(make_message(guild_id=None))
        await self._dispatch(make_message(author_bot=True))
        await self._dispatch(make_message(webhook_id=555))
        self.assertFalse(self.cog.store.has_data(1))


class MetricsTest(unittest.TestCase):
    def test_totals(self):
        edges = {1: {2: 3, 3: 1}, 2: {1: 2}}
        self.assertEqual(metrics.out_total(edges, 1), 4)
        self.assertEqual(metrics.in_total(edges, 1), 2)
        self.assertEqual(metrics.in_total(edges, 3), 1)

    def test_pagerank_star_center_is_top(self):
        edges = {2: {1: 5}, 3: {1: 5}, 4: {1: 5}, 5: {1: 5}}
        ranks = metrics.pagerank(edges)
        self.assertEqual(max(ranks, key=ranks.get), 1)
        self.assertAlmostEqual(sum(ranks.values()), 1.0, places=5)

    def test_betweenness_path_middle_is_top(self):
        edges = {1: {2: 1}, 2: {3: 1}, 3: {4: 1}, 4: {5: 1}}
        centrality = metrics.betweenness(edges)
        self.assertEqual(max(centrality, key=centrality.get), 3)
        self.assertEqual(centrality[1], 0.0)
        self.assertEqual(centrality[5], 0.0)

    def test_betweenness_guard_returns_none(self):
        edges = {1: {2: 1}, 2: {3: 1}}
        self.assertIsNone(metrics.betweenness(edges, max_nodes=2))

    def test_components_larger_group_is_c1(self):
        edges = {1: {2: 1}, 2: {3: 1}, 4: {5: 1}}
        clusters = metrics.components(edges)
        self.assertEqual(clusters[1], ("C1", 3))
        self.assertEqual(clusters[3], ("C1", 3))
        self.assertEqual(clusters[4], ("C2", 2))

    def test_top_partners_orders_by_total_with_directions(self):
        edges = {1: {2: 3, 3: 10}, 2: {1: 4}, 3: {1: 1}, 4: {1: 2}}
        partners = metrics.top_partners(edges, 1)
        self.assertEqual(partners[0], (3, 10, 1))
        self.assertEqual(partners[1], (2, 3, 4))
        self.assertEqual(partners[2], (4, 0, 2))
        self.assertEqual(len(metrics.top_partners(edges, 1, limit=2)), 2)

    def test_peak_hours(self):
        hist = [0] * 24
        hist[19] = 50
        hist[20] = 40
        hist[2] = 30
        hist[8] = 1
        self.assertEqual(metrics.peak_hours(hist), [19, 20, 2])
        self.assertEqual(metrics.peak_hours([0] * 24), [])

    def test_analyze_empty_graph(self):
        result = metrics.analyze({}, 42)
        self.assertEqual(result.sent, 0)
        self.assertEqual(result.received, 0)
        self.assertIsNone(result.cluster_label)
        self.assertEqual(result.partners, [])


class RenderTest(unittest.TestCase):
    def test_card_renders_with_data(self):
        hours = [0] * 24
        hours[19] = 50
        hours[20] = 40
        hours[2] = 30
        card = render.PersonCard(
            name="いる科のCちゃん", username="ciajo08", user_id=100,
            cluster_label="C2", cluster_size=51,
            received=584, sent=505, pagerank=0.010, betweenness=0.0,
            hours=hours, peaks=[19, 20, 2],
            partners=[
                render.PartnerRow("StudioYebisu", 201, 163, 145),
                render.PartnerRow("たまねこ", 202, 45, 33),
            ],
        )
        png = render.render_person_card_png(card, {})
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertGreater(len(png), 1000)

    def test_card_renders_empty_state(self):
        card = render.PersonCard(name="新規さん", username="newbie",
                                 user_id=300, betweenness=None)
        png = render.render_person_card_png(card, {})
        self.assertTrue(png.startswith(b"\x89PNG"))


class RegistrationTest(unittest.TestCase):
    def test_action_registered_in_analysis_genre(self):
        from cogs.support import (
            SUPPORT_ACTIONS,
            SUPPORT_ACTIONS_BY_GENRE,
            SUPPORT_GENRES,
        )
        names = {choice.value: choice.name for choice in SUPPORT_ACTIONS}
        self.assertEqual(names.get("person_analysis"), "人物分析")
        self.assertEqual(SUPPORT_GENRES["analysis"], ("分析", ""))
        values = [value for _label, value in
                  SUPPORT_ACTIONS_BY_GENRE["analysis"]]
        self.assertEqual(values, ["person_analysis", "server_analytics"])

    def test_no_permission_required_but_key_present(self):
        from cogs.support import SupportCog
        perms = SupportCog.SUPPORT_REQUIRED_PERMISSIONS
        self.assertIn("person_analysis", perms)
        self.assertIsNone(perms["person_analysis"])

    def test_registry_spec_excludes_aitools(self):
        from core.general import action_registry
        spec = action_registry.default_registry().get("support:person_analysis")
        self.assertIsNotNone(spec)
        self.assertEqual(spec.label, "人物分析")
        self.assertNotIn("aitools", spec.surfaces)


class DispatchTest(unittest.IsolatedAsyncioTestCase):
    async def test_plain_member_can_dispatch(self):
        from cogs.support import SupportCog
        from core.general import action_usage
        from core.support import command_control
        from core.support.usage_stats import usage_stats

        show = AsyncMock()
        bot = types.SimpleNamespace(
            get_cog=lambda name: (
                types.SimpleNamespace(show_person_analysis=show)
                if name == "PersonAnalysisCog" else None),
        )
        cog = SupportCog(bot)
        interaction = types.SimpleNamespace(
            user=types.SimpleNamespace(
                id=42,
                guild_permissions=types.SimpleNamespace(
                    administrator=False, manage_guild=False,
                    manage_roles=False, manage_channels=False,
                    manage_messages=False),
            ),
            guild_id=1,
            guild=types.SimpleNamespace(id=1),
            response=types.SimpleNamespace(
                send_message=AsyncMock(), is_done=lambda: False),
        )
        with patch.object(command_control, "guard", AsyncMock(return_value=True)), \
                patch.object(action_usage, "record_safely_in_background",
                             lambda *a, **k: None), \
                patch.object(usage_stats, "record_action_safely",
                             lambda *a, **k: None):
            await cog.dispatch(interaction, "person_analysis")
        show.assert_awaited_once()


class ViewTest(unittest.IsolatedAsyncioTestCase):
    def _make_view(self, *, enabled, is_admin):
        cog = types.SimpleNamespace(
            bot=None,
            store=pa_store.PersonGraphStore(
                Path(tempfile.mkdtemp()) / "person_analysis.json"),
        )
        return PersonAnalysisView(
            cog, 1, owner_id=42, center_id=42,
            enabled=enabled, is_admin=is_admin)

    async def test_off_view_has_toggle_for_admin_only(self):
        admin_view = self._make_view(enabled=False, is_admin=True)
        await admin_view.prepare()
        admin_ids = {getattr(item, "custom_id", None)
                     for item in admin_view.children}
        self.assertIn("person_analysis:toggle", admin_ids)
        self.assertIn("person_analysis:close", admin_ids)
        self.assertIsNone(admin_view.panel_file())

        member_view = self._make_view(enabled=False, is_admin=False)
        await member_view.prepare()
        member_ids = {getattr(item, "custom_id", None)
                      for item in member_view.children}
        self.assertNotIn("person_analysis:toggle", member_ids)

    async def test_on_view_renders_card_without_data(self):
        view = self._make_view(enabled=True, is_admin=False)
        view.cog.store.record(1, 42, [77], 19)
        await view.prepare()
        self.assertIsNotNone(view.panel_file())
        ids = {getattr(item, "custom_id", None) for item in view.children}
        self.assertIn("person_analysis:user", ids)
        self.assertIn("person_analysis:close", ids)
        embed = view.embed()
        self.assertEqual(embed.image.url,
                         "attachment://person_analysis.png")


if __name__ == "__main__":
    unittest.main()
