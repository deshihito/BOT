# -*- coding: utf-8 -*-
"""EXPランキング再構築（対話型ボード/個人カード/活動ボード）の検証。

- 集計: 軸別ソート・全体合算・ページング境界・ライバル計算
- 描画: 盤面/カードが所定サイズの PNG を返し、アバター欠落でも落ちない
- 活動ボード: フェイクデータで各軸トップの抽出
"""
import io
import unittest

from PIL import Image

from core.general.exp import exp_board as board


def sample_data():
    return {
        "100": {
            "1": {"chat_exp": 5000, "vc_exp": 3000},
            "2": {"chat_exp": 4000, "vc_exp": 4500},
            "3": {"chat_exp": 100, "vc_exp": 50},
        },
        "200": {
            "1": {"chat_exp": 700, "vc_exp": 100},
            "4": {"chat_exp": 9999, "vc_exp": 1},
        },
    }


class AggregationTest(unittest.TestCase):
    def test_general_sort_uses_level_then_total(self):
        rows = board.build_rows(sample_data(), "general", 100)
        self.assertEqual([r["user_id"] for r in rows], [2, 1, 3])
        self.assertEqual([r["rank"] for r in rows], [1, 2, 3])
        # general軸の value は合計EXP
        self.assertEqual(rows[0]["value"], 8500)

    def test_chat_sort_uses_chat_exp(self):
        rows = board.build_rows(sample_data(), "chat", 100)
        self.assertEqual([r["user_id"] for r in rows], [1, 2, 3])
        self.assertEqual(rows[0]["value"], 5000)
        self.assertEqual(rows[0]["level"], rows[0]["level"])

    def test_vc_sort_uses_vc_exp(self):
        rows = board.build_rows(sample_data(), "vc", 100)
        self.assertEqual([r["user_id"] for r in rows], [2, 1, 3])

    def test_global_merges_guilds(self):
        rows = board.build_rows(sample_data(), "chat", None)
        by_id = {r["user_id"]: r for r in rows}
        self.assertEqual(by_id[1]["chat_exp"], 5700)
        self.assertEqual(by_id[1]["vc_exp"], 3100)
        self.assertEqual(rows[0]["user_id"], 4)

    def test_unknown_axis_falls_back_to_general(self):
        rows = board.build_rows(sample_data(), "bogus", 100)
        self.assertEqual([r["user_id"] for r in rows], [2, 1, 3])

    def test_progress_within_unit_interval(self):
        for axis in board.AXES:
            for row in board.build_rows(sample_data(), axis, 100):
                self.assertGreaterEqual(row["progress"], 0.0)
                self.assertLessEqual(row["progress"], 1.0)


class PaginateTest(unittest.TestCase):
    def setUp(self):
        data = {"1": {str(i): {"chat_exp": 1000 - i, "vc_exp": 0}
                      for i in range(25)}}
        self.rows = board.build_rows(data, "chat", 1)

    def test_pages_of_ten(self):
        page0, total, idx = board.paginate(self.rows, 0)
        self.assertEqual((len(page0), total, idx), (10, 3, 0))
        page2, _, idx2 = board.paginate(self.rows, 2)
        self.assertEqual((len(page2), idx2), (5, 2))

    def test_page_clamped(self):
        _rows, _total, idx = board.paginate(self.rows, 99)
        self.assertEqual(idx, 2)
        _rows, _total, idx = board.paginate(self.rows, -3)
        self.assertEqual(idx, 0)

    def test_empty_rows(self):
        page, total, idx = board.paginate([], 0)
        self.assertEqual((page, total, idx), ([], 1, 0))


class RivalTest(unittest.TestCase):
    def setUp(self):
        self.rows = board.build_rows(sample_data(), "chat", 100)

    def test_middle_user_has_rival_above(self):
        info = board.rival_info(self.rows, 2)
        self.assertEqual(info["rank"], 2)
        self.assertEqual(info["above_user_id"], 1)
        self.assertEqual(info["gap"], 1000)

    def test_top_user_has_no_rival(self):
        info = board.rival_info(self.rows, 1)
        self.assertEqual(info["rank"], 1)
        self.assertIsNone(info["above_user_id"])
        self.assertEqual(info["gap"], 0)

    def test_unranked_user(self):
        self.assertIsNone(board.rival_info(self.rows, 999))
        self.assertIsNone(board.find_rank(self.rows, 999))

    def test_general_gap_uses_total_exp(self):
        rows = board.build_rows(sample_data(), "general", 100)
        info = board.rival_info(rows, 1)
        above = rows[0]
        me = rows[1]
        self.assertEqual(info["gap"],
                         above["chat_exp"] + above["vc_exp"]
                         - (me["chat_exp"] + me["vc_exp"]))


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.rows = board.build_rows(sample_data(), "general", 100)
        self.names = {1: "さくら", 2: "たろう", 3: "さん"}

    def test_board_first_page_has_podium_layout(self):
        png = board.render_board_png(
            self.rows, axis="general", scope_label="サーバー内",
            page=0, total_pages=1, names=self.names, avatars={})
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.format, "PNG")
        self.assertEqual(img.width, board.BOARD_W)
        # 表彰台 + 残り行なし（3人）でもヘッダーより高い
        self.assertGreater(img.height, board.HEADER_H + board.PODIUM_H)

    def test_board_later_page_and_missing_avatars(self):
        rows = board.build_rows(
            {"1": {str(i): {"chat_exp": 5000 - i * 10, "vc_exp": 0}
                   for i in range(15)}}, "chat", 1)
        page_rows, total, _ = board.paginate(rows, 1)
        png = board.render_board_png(
            page_rows, axis="chat", scope_label="全体", page=1,
            total_pages=total, names={}, avatars={5: b"not-an-image"})
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.width, board.BOARD_W)
        self.assertEqual(img.height,
                         board.HEADER_H + 5 * board.ROW_H + 16)

    def test_board_empty_rows(self):
        png = board.render_board_png(
            [], axis="vc", scope_label="全体", page=0, total_pages=1,
            names={}, avatars={})
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.width, board.BOARD_W)

    def test_card_size_and_placeholder_avatar(self):
        png = board.render_card_png(
            user_id=42, name="名無し", avatar_bytes=None,
            chat_exp=1234, vc_exp=567, server_rank=2, global_rank=None)
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.size, (board.CARD_W, board.CARD_H))

    def test_card_with_real_avatar_bytes(self):
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), (200, 30, 30)).save(buf, "PNG")
        png = board.render_card_png(
            user_id=7, name="赤い人", avatar_bytes=buf.getvalue(),
            chat_exp=0, vc_exp=0, server_rank=None, global_rank=None)
        self.assertTrue(png.startswith(b"\x89PNG"))


class ActivityExtractionTest(unittest.TestCase):
    def test_top_clan_picks_highest_points(self):
        clans = [
            {"name": "弱小", "total_points": 10, "level": 1, "member_count": 2},
            {"name": "最強", "total_points": 999, "level": 5, "member_count": 9},
            {"name": "中堅", "total_points": 100, "level": 2, "member_count": 4},
        ]
        self.assertEqual(board.top_clan(clans)["name"], "最強")

    def test_top_clan_empty(self):
        self.assertIsNone(board.top_clan([]))
        self.assertIsNone(board.top_clan(None))

    async def _activity_view(self):
        from core.general.exp.exp_ui import ActivityBoardView
        return ActivityBoardView(100, bot=None)

    def test_activity_embed_sections(self):
        import asyncio

        async def run():
            view = await self._activity_view()
            view._server_entries = [("EXP総合", "さくら", "general Lv.21")]
            view._global_entries = [("コイン保有", "たろう", "1,000 AGO")]
            return view.embed()

        embed = asyncio.run(run())
        self.assertIn("サーバー活動ボード", embed.title)
        self.assertIn("サーバー内の王者", embed.description)
        self.assertIn("全体の王者", embed.description)
        self.assertIn("さくら", embed.description)
        self.assertIn("たろう", embed.description)


class RankingViewWiringTest(unittest.TestCase):
    def test_view_has_required_controls(self):
        from core.general.exp.exp_ui import ExpRankingView
        view = ExpRankingView(123)
        labels = [getattr(item, "label", None) for item in view.children]
        for expected in ("総合", "チャット", "VC", "サーバー内", "全体",
                         "更新", "自分の順位", "活動ボード"):
            self.assertIn(expected, labels)

    def test_view_embed_points_at_board_attachment(self):
        from core.general.exp.exp_ui import ExpRankingView
        view = ExpRankingView(123)
        embed = view.embed()
        self.assertEqual(embed.title, "EXPランキング")
        self.assertEqual(embed.image.url, "attachment://exp_board.png")
        self.assertTrue(view.board_file().filename == "exp_board.png")


if __name__ == "__main__":
    unittest.main()
