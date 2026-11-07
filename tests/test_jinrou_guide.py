"""人狼の初心者ガイド（core/game/jinrou/jinrou_guide.py）と役職 ID のテスト。通信はしない。"""
import re
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "tests"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import game_fakes  # noqa: E402,F401  （環境変数などの準備）
import discord  # noqa: E402
import core.game.jinrou.entry as jinrou
from core.game.jinrou import jinrou_guide as guide  # noqa: E402


def view_text(view):
    """V2 パネル内の TextDisplay 本文を集める。"""
    return "\n".join(
        item.content or "" for item in view.walk_children()
        if isinstance(item, discord.ui.TextDisplay))

SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def interaction(uid):
    return types.SimpleNamespace(user=types.SimpleNamespace(id=uid),
                                 guild=types.SimpleNamespace(get_member=lambda _: None),
                                 response=types.SimpleNamespace(send_message=AsyncMock()))


class RoleIdTest(unittest.TestCase):
    def test_every_role_has_unique_url_safe_slug(self):
        names = [r[0] for r in jinrou.HELP_ROLES]
        slugs = [r[4] for r in jinrou.HELP_ROLES]
        self.assertTrue(all(len(r) == 5 for r in jinrou.HELP_ROLES))
        self.assertEqual(len(set(names)), len(names))
        self.assertEqual(len(set(slugs)), len(slugs), "役職 ID が重複しています")
        for slug in slugs:
            self.assertRegex(slug, SLUG)
            self.assertTrue(slug.isascii())

    def test_url_follows_switch(self):
        from unittest.mock import patch
        self.assertTrue(guide.ROLE_URL_USE_SLUG)
        with patch.object(guide, "ROLE_URL_USE_SLUG", False):
            # False のときは encodeURIComponent(日本語の役職名)
            self.assertEqual(guide.role_url("人狼"), "https://bot-deshihito.vercel.app/jinrou/roles/%E4%BA%BA%E7%8B%BC")
        if True:
            self.assertEqual(guide.role_url("ハゲ"), f"{guide.ROLE_GUIDE_BASE_URL}/hage")
            self.assertEqual(guide.role_url("人狼"), "https://bot-deshihito.vercel.app/jinrou/roles/werewolf")

    def test_links_match_site_ids(self):
        import json, re
        from urllib.parse import unquote
        text = (ROOT / "web" / "lib" / "jinrou-roles.ts").read_text(encoding="utf-8")
        site_ids = {r["id"] for r in json.loads(re.search(r"JINROU_ROLES: JinrouRole\[\] = (\[.*\]);", text, re.S).group(1))}
        for name, *_ in jinrou.HELP_ROLES:
            self.assertIn(unquote(guide.role_id(name)), site_ids, name)
        self.assertEqual(guide.role_url(None), guide.ROLE_GUIDE_BASE_URL)
        self.assertTrue(guide.role_url("未知の役職").startswith(guide.ROLE_GUIDE_BASE_URL + "/%E6"))


class GuideTextTest(unittest.TestCase):
    def test_every_role_has_full_guide(self):
        for name, team, desc, *_ in jinrou.HELP_ROLES:
            fields = dict(guide.guide_fields(name))
            self.assertEqual(fields["陣営"], team)
            self.assertEqual(fields["能力"], desc)
            self.assertTrue(fields["勝利条件"])
            self.assertTrue(fields["今夜やること"])

    def test_fallback_for_new_role(self):
        fields = dict(guide.guide_fields("新しい役職"))
        self.assertEqual(fields["陣営"], "不明")
        self.assertEqual(fields["今夜やること"], guide.PASSIVE_TODO)
        guide.register_roles([("新しい役職", "人狼陣営", "テスト", "X.PNG", "new-role")])
        try:
            self.assertEqual(dict(guide.guide_fields("新しい役職"))["能力"], "テスト")
            self.assertTrue(guide.role_url("新しい役職").endswith("/new-role"))
            self.assertEqual(guide.role_id("新しい役職", use_slug=False), "%E6%96%B0%E3%81%97%E3%81%84%E5%BD%B9%E8%81%B7")
            self.assertEqual(guide.role_id("新しい役職", use_slug=True), "new-role")
        finally:
            guide._roles.pop("新しい役職", None)
            guide.ROLE_IDS.pop("新しい役職", None)

    def test_win_conditions(self):
        self.assertIn("人狼陣営の勝ち", guide.win_condition("狂人"))
        self.assertIn("村人陣営の勝ち", guide.win_condition("占い師"))
        self.assertIn("追放されたら", guide.win_condition("ハゲ"))
        self.assertIn("襲う", guide.night_todo("人狼"))


class RoleNoticeTest(unittest.IsolatedAsyncioTestCase):
    def game(self, roles):
        game = jinrou.JinrouGame()
        game.roles = dict(roles)
        game.display_roles = dict(roles)
        return game

    async def test_role_notice_includes_guide_in_same_message(self):
        game = self.game({1: "占い師"})
        cog = MagicMock()
        cog.get_wolves_names.return_value = "なし"
        it = interaction(1)
        view = jinrou.RoleCheckView(game, cog)
        await view.check.callback(it)
        it.response.send_message.assert_awaited_once()
        kwargs = it.response.send_message.await_args.kwargs
        self.assertTrue(kwargs["ephemeral"])
        text = view_text(kwargs["view"])
        self.assertIn("🔰 今夜やること", text)
        self.assertIn(guide.role_url("占い師"), text)
        self.assertTrue(guide.role_url("占い師").endswith("/seer"))

    async def test_hidden_role_is_not_leaked(self):
        game = self.game({1: "入狼"})
        cog = MagicMock()
        cog.get_wolves_names.return_value = "なし"
        it = interaction(1)
        await jinrou.RoleCheckView(game, cog).check.callback(it)
        text = view_text(it.response.send_message.await_args.kwargs["view"])
        self.assertNotIn("入狼", text)
        self.assertNotIn("nyurou", text)
        self.assertIn(guide.role_url("一般通過あごむに"), text)


class PhaseButtonTest(unittest.IsolatedAsyncioTestCase):
    async def test_button_sends_ephemeral_phase_help(self):
        game = jinrou.JinrouGame()
        game.roles = {1: "騎士"}
        for phase in ("night", "day", "vote"):
            button = guide.PhaseHelpButton(phase, jinrou._guide_role_lookup(game))
            self.assertEqual(button.label, "？")
            it = interaction(1)
            await button.callback(it)
            kwargs = it.response.send_message.await_args.kwargs
            self.assertTrue(kwargs["ephemeral"])
            text = view_text(kwargs["view"])
            self.assertIn(guide.PHASES[phase][0], text)
            self.assertIn(guide.role_url("騎士"), text)
        it = interaction(99)  # 参加していない人
        await guide.PhaseHelpButton("vote", jinrou._guide_role_lookup(game)).callback(it)
        self.assertIn(guide.ROLE_GUIDE_BASE_URL, view_text(it.response.send_message.await_args.kwargs["view"]))

    async def test_phase_messages_have_help_button(self):
        game = jinrou.JinrouGame()
        sent = []
        game.game_channel = types.SimpleNamespace(send=AsyncMock(side_effect=lambda *a, **k: sent.append(k)))
        game.is_running = True
        cog = jinrou.JinrouCog.__new__(jinrou.JinrouCog)
        import asyncio
        real = asyncio.sleep
        jinrou.asyncio.sleep = AsyncMock()
        try:
            await cog.run_discussion(game, 2, "昼")
        finally:
            jinrou.asyncio.sleep = real
        labels = [getattr(i, "label", None) for k in sent if k.get("view") for i in k["view"].walk_children()]
        self.assertIn("？", labels)
        night = jinrou.NightActionView(game)
        night.add_help_button(guide.PhaseHelpButton("night", lambda _: None))
        button_labels = [i.label for i in night.walk_children() if isinstance(i, discord.ui.Button)]
        self.assertEqual(button_labels, ["夜のアクション", "？"])


if __name__ == "__main__":
    unittest.main()


class YandereTeamTest(unittest.IsolatedAsyncioTestCase):
    def assert_victory_embed(self, game, text):
        # 勝敗確定はフェーズ集約 V2 パネルで発表される（表示モダン化 §4.2-9）
        for call in game.game_channel.send.await_args_list:
            view = call.kwargs.get("view")
            if view is not None:
                panel = view_text(view)
                if "勝敗確定" in panel and text in panel:
                    return
        raise AssertionError(f"勝敗確定パネルが見つかりません: {text}")

    def setUp(self):
        from unittest.mock import patch
        p = patch.object(jinrou, "db_api", MagicMock())
        p.start()
        self.addCleanup(p.stop)

    def game(self, roles, alive=None):
        game = jinrou.JinrouGame()
        players = [types.SimpleNamespace(id=i, mention=f"<@{i}>", display_name=str(i)) for i in roles]
        game.players = players
        game.alive_players = [p for p in players if alive is None or p.id in alive]
        game.roles = dict(roles)
        game.is_running = True
        game.game_channel = types.SimpleNamespace(send=AsyncMock(), guild=types.SimpleNamespace(id=5))
        return game

    def cog(self):
        cog = jinrou.JinrouCog.__new__(jinrou.JinrouCog)
        cog._process_elo_ratings = AsyncMock()
        cog._record_wins = AsyncMock()
        return cog

    def test_yandere_is_wolf_side(self):
        game = self.game({1: "ヤンデレ", 2: "占い師"})
        self.assertTrue(jinrou._is_wolf_side(game, 1))
        self.assertFalse(jinrou._is_wolf_side(game, 2))
        self.assertIn("人狼陣営の勝ち", guide.win_condition("ヤンデレ"))

    async def test_parity_counts_yandere(self):
        # 人狼 1 + ヤンデレ 1 対 村人 2 → 人狼陣営の勝ち
        game = self.game({1: "人狼", 2: "ヤンデレ", 3: "占い師", 4: "騎士"})
        cog = self.cog()
        self.assertTrue(await cog.check_victory(game))
        self.assert_victory_embed(game, "人狼が支配した。人狼陣営の勝利です。")
        winners = cog._record_wins.await_args.args[1]
        self.assertEqual(sorted(winners), [1, 2])

    async def test_yandere_alone_does_not_keep_game_going(self):
        # 人狼が全滅すれば、ヤンデレが生きていても村人陣営の勝ち（狂人と同じ）
        game = self.game({1: "人狼", 2: "ヤンデレ", 3: "占い師", 4: "騎士"}, alive={2, 3, 4})
        cog = self.cog()
        self.assertTrue(await cog.check_victory(game))
        self.assert_victory_embed(game, "人狼全滅。村人陣営の勝利です。")
        self.assertEqual(sorted(cog._record_wins.await_args.args[1]), [3, 4])
