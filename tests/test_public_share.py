"""表示モダン化 §4.2-10/11: 選択式（C）の「公開で出す」導線と公開表示の点検。

- PublicShareView は本人だけが操作でき、押すと同じ embed を公開する
- /game レート表示は既定 ephemeral のまま「公開で出す」を備える
- EXPステータスは本人だけが操作でき、「公開で出す」で公開できる
- 公開化した EXPランキングの「更新」は誰が押しても同じ公開データを再表示する
"""
import types
import unittest
from unittest.mock import AsyncMock, patch

import discord

from core.public_share import PublicShareView


def fake_interaction(user_id=456, with_channel=True):
    sent = {}
    channel_sent = []

    async def send_message(content=None, **kwargs):
        sent["content"] = content
        sent.update(kwargs)

    async def channel_send(content=None, **kwargs):
        channel_sent.append((content, kwargs))

    interaction = types.SimpleNamespace(
        guild_id=123,
        user=types.SimpleNamespace(id=user_id),
        channel=(types.SimpleNamespace(send=AsyncMock(side_effect=channel_send))
                 if with_channel else None),
        response=types.SimpleNamespace(
            is_done=lambda: False,
            send_message=AsyncMock(side_effect=send_message),
            edit_message=AsyncMock(),
            defer=AsyncMock(),
        ),
        followup=types.SimpleNamespace(send=AsyncMock()),
    )
    return interaction, sent, channel_sent


class PublicShareViewTest(unittest.IsolatedAsyncioTestCase):
    async def test_only_owner_can_operate(self):
        view = PublicShareView(456, discord.Embed(title="x"))
        owner, _, _ = fake_interaction(user_id=456)
        other, _, _ = fake_interaction(user_id=999)
        self.assertTrue(await view.interaction_check(owner))
        self.assertFalse(await view.interaction_check(other))

    async def test_share_posts_embed_to_channel_and_acks_ephemerally(self):
        embed = discord.Embed(title="私の結果")
        view = PublicShareView(456, embed)
        interaction, sent, channel_sent = fake_interaction()
        await view.share.callback(interaction)
        self.assertEqual(len(channel_sent), 1)
        self.assertIs(channel_sent[0][1].get("embed"), embed)
        self.assertEqual(sent.get("ephemeral"), True)

    async def test_share_supports_callable_factory(self):
        view = PublicShareView(456, lambda: discord.Embed(title="動的"))
        interaction, _sent, channel_sent = fake_interaction()
        await view.share.callback(interaction)
        self.assertEqual(channel_sent[0][1]["embed"].title, "動的")


class RatingShareWiringTest(unittest.IsolatedAsyncioTestCase):
    async def test_rating_response_is_ephemeral_with_share_view(self):
        from cogs.game import GameDetailView

        embed = discord.Embed(title="レート")
        jinrou_cog = types.SimpleNamespace(rating_embed=AsyncMock(return_value=embed))
        cog = types.SimpleNamespace(bot=types.SimpleNamespace(get_cog=lambda _name: jinrou_cog))
        view = GameDetailView(cog, "jinrou")
        interaction, sent, _channel_sent = fake_interaction()
        button = next(item for item in view.children
                      if getattr(item, "custom_id", None) == "panel:game:rating")
        await button.callback(interaction)
        self.assertEqual(sent.get("ephemeral"), True)
        self.assertIsInstance(sent.get("view"), PublicShareView)
        self.assertIs(sent.get("embed"), embed)


class ExpStatusShareTest(unittest.IsolatedAsyncioTestCase):
    def make_view(self):
        from core.general.exp_ui import ExpStatusView

        return ExpStatusView(456, 123)

    async def test_interaction_check_restricts_to_author(self):
        view = self.make_view()
        owner, _, _ = fake_interaction(user_id=456)
        other, _, _ = fake_interaction(user_id=999)
        self.assertTrue(await view.interaction_check(owner))
        self.assertFalse(await view.interaction_check(other))

    async def test_share_button_posts_status_embed_publicly(self):
        view = self.make_view()
        interaction, sent, channel_sent = fake_interaction()
        button = next(item for item in view.children
                      if getattr(item, "label", None) == "公開で出す")
        await button.callback(interaction)
        self.assertEqual(len(channel_sent), 1)
        self.assertEqual(channel_sent[0][1]["embed"].title, "EXP状況")
        self.assertEqual(sent.get("ephemeral"), True)


class PublicRankingRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def test_any_user_can_refresh_public_exp_ranking(self):
        from core.general.exp_ui import ExpRankingView

        view = ExpRankingView(123)
        interaction, _sent, _channel_sent = fake_interaction(user_id=999)
        button = next(item for item in view.children
                      if getattr(item, "label", None) == "更新")
        await button.callback(interaction)
        interaction.response.edit_message.assert_awaited_once()
        kwargs = interaction.response.edit_message.call_args.kwargs
        self.assertIsNone(kwargs.get("embed"))
        self.assertIn("view", kwargs)


if __name__ == "__main__":
    unittest.main()
