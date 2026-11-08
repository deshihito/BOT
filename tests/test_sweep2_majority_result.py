"""sweep2 GA-17 回帰テスト: majority の最終結果が最後まで送られること。

監査で判明した不具合: _play のラウンド結果組み立てで表示名辞書 `names` を
文字列で上書き (shadowing) していたため、回答のあったラウンドがあると
最終結果の生成 (names.get) で AttributeError になり、最終結果も
record_win も実行されなかった。
"""
import types
import unittest
from unittest.mock import AsyncMock, patch

from core.game.majority import cog as majority_cog
from core.game.majority.majority import MajoritySession


class MajorityFinalResultTest(unittest.IsolatedAsyncioTestCase):
    async def test_play_reaches_final_result_with_display_names(self):
        cog = majority_cog.Majority(types.SimpleNamespace())
        cog._bars_file = lambda rows, filename: None
        session = MajoritySession(["お題"])
        for uid in (1, 2, 3):
            session.add_player(uid)
        session.submit(1, "りんご")
        session.submit(2, "りんご")
        session.submit(3, "みかん")
        names = {1: "Alice", 2: "Bob", 3: "Carol"}

        sent = []

        async def fake_send(**kwargs):
            sent.append(kwargs)
            return None

        channel = types.SimpleNamespace(id=999, guild=None, send=AsyncMock(side_effect=fake_send))
        panels = types.SimpleNamespace(
            replace=AsyncMock(return_value=None), clear=AsyncMock(return_value=None)
        )
        with patch.object(majority_cog, "game_panels", panels), \
             patch("asyncio.sleep", AsyncMock(return_value=None)):
            await cog._play(channel, session, names)

        self.assertEqual(len(sent), 1, "最終結果が1通送られること")
        body = str(sent[0]["view"].to_components())
        self.assertIn("Alice", body)
        self.assertNotIn("<@1>", body)


if __name__ == "__main__":
    unittest.main()
