# -*- coding: utf-8 -*-
"""導線最適化ラウンド4（ガチャ編成セレクト）の回帰テスト。

R4-4: 編成中のキャラが常にセレクト25件枠の先頭に入ることの固定。
"""
import types
import unittest


class GachaPartySelectTest(unittest.TestCase):
    """R4-4: 編成中のキャラが常にセレクト25件枠の先頭に入る。"""

    def test_party_members_come_first(self):
        import tempfile
        from pathlib import Path

        import discord

        from cogs.gacha import PartyView
        from core.game import gacha as gacha_core

        with tempfile.TemporaryDirectory() as tmp:
            store = gacha_core.GachaStore(path=Path(tmp) / "gacha.json")
            all_ids = [c["id"] for c in gacha_core.CHARACTERS]
            self.assertGreater(len(all_ids), 25)
            for char_id in all_ids:
                store.add("1", char_id)
            # 最もレア度の低いキャラを編成に入れる（従来ソートでは枠外）。
            lowest = gacha_core.CHARACTERS[-1]["id"]
            store.set_party("1", [lowest])
            cog = types.SimpleNamespace(store=store)
            view = PartyView(cog, 1)
            select = next(
                c for c in view.children if isinstance(c, discord.ui.Select))
            self.assertLessEqual(len(select.options), 25)
            self.assertIn(lowest, [o.value for o in select.options])




if __name__ == "__main__":
    unittest.main()
