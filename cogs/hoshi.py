# -*- coding: utf-8 -*-
"""「星か爆弾か」（Skull 系ブラフ＆競りゲーム）。

盤面表現: 各人の「伏せた枚数・成功数」は少量の状態量で、空間的な盤面では
ないため V2 構造化テキストで十分に伝わる（画像化は更新頻度＝全アクション
ごとに見合わない。判断は実装ログ参照）。伏せた中身は最後まで非公開で、
置く操作は本人のボタン選択のみ（内容は共有面に出ない）。
操作フェーズごとにパネルを差し替える（配置/競り/めくり）。
"""
import asyncio
import logging

import discord
from discord.ext import commands

from core import party_ranking
from core.game_v2 import GamePanelView, text_panel
from core.hoshi import BOMB, FLOWER, HoshiGame

logger = logging.getLogger(__name__)

party_ranking.register("hoshi")

GAME_ID = "hoshi"
RECRUIT_SECONDS = 60
PHASE_SECONDS = 120
MIN_PLAYERS = 3
MAX_PLAYERS = 6


def status_text(game: HoshiGame) -> str:
    lines = []
    for uid in game.players:
        mark = "💀脱落" if uid in game.eliminated else f"成功{game.wins[uid]}/2・残り{sum(game.owned[uid].values()) + len(game.stacks[uid])}枚"
        lines.append(f"<@{uid}>: 伏せ{len(game.stacks[uid])}枚（{mark}）")
    return "\n".join(lines)


class Hoshi(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, HoshiGame | None] = {}
        self.messages: dict[int, discord.Message] = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}
        panel = GamePanelView("⭐ 星か爆弾か 参加者募集",
                              f"伏せたディスクをめくるブラフ＆競りゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"伏せたディスクをめくるブラフ＆競りゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                                   f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n"
                                   f"参加者（{len(players)}名）: " + " ".join(f"<@{p}>" for p in players))
            await inter.response.edit_message(view=panel)

        async def on_start(inter: discord.Interaction):
            if inter.user.id != players[0]:
                return await inter.response.send_message("開始できるのはホストだけです。", ephemeral=True)
            state["started"] = True
            await inter.response.send_message("開始します！", ephemeral=True)

        join_btn = discord.ui.Button(label="参加する", style=discord.ButtonStyle.success)
        join_btn.callback = on_join
        start_btn = discord.ui.Button(label="開始する（ホスト）", style=discord.ButtonStyle.primary)
        start_btn.callback = on_start
        panel.add_row(join_btn, start_btn)
        await interaction.response.send_message(view=panel)
        asyncio.create_task(self._run(channel, players, state))

    async def _run(self, channel, players: list[int], state: dict):
        try:
            for _ in range(RECRUIT_SECONDS * 2):
                if state["started"]:
                    break
                await asyncio.sleep(0.5)
            players = list(dict.fromkeys(players))
            if len(players) < MIN_PLAYERS:
                await channel.send(view=text_panel("星か爆弾か", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            game = HoshiGame(players)
            self.channels[channel.id] = game
            await self._phase_panel(channel, game)
            # 進行はボタンコールバックが駆動する。終了検知だけをここで待つ
            while game.phase != "done":
                await asyncio.sleep(1.0)
            await channel.send(view=text_panel(
                "🏆 星か爆弾か 結果", f"勝者は <@{game.winner}> です！"))
            guild = getattr(channel, "guild", None)
            if guild is not None and game.winner is not None:
                await party_ranking.shared().record_win(guild.id, game.winner, GAME_ID)
        except Exception:  # noqa: BLE001
            logger.exception("Hoshi: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)

    async def _phase_panel(self, channel, game: HoshiGame):
        if game.phase == "place":
            panel = GamePanelView(
                "⭐ 星か爆弾か 配置フェーズ",
                status_text(game) + f"\n\n手番は <@{game.current}> です。「星を置く/爆弾を置く」か、"
                "自分の山が1枚以上あれば「挑戦する」で競りを開始できます。中身は他の人には分かりません。")

            async def on_place_star(inter: discord.Interaction):
                await self._do_place(inter, game, FLOWER)

            async def on_place_bomb(inter: discord.Interaction):
                await self._do_place(inter, game, BOMB)

            async def on_challenge(inter: discord.Interaction):
                if inter.user.id != game.current or not game.stacks[inter.user.id]:
                    return await inter.response.send_message("挑戦できるのは、自分の山が1枚以上ある手番の人だけです。", ephemeral=True)
                total = game.total_on_table()
                view = discord.ui.View(timeout=60)
                select = discord.ui.Select(
                    placeholder="何枚めくると宣言しますか",
                    options=[discord.SelectOption(label=f"{n}枚", value=str(n)) for n in range(1, total + 1)])

                async def on_pick(inter2: discord.Interaction):
                    if game.challenge(inter.user.id, int(select.values[0])):
                        await inter2.response.send_message(f"挑戦！ {select.values[0]}枚で競り開始。", )
                        await self._phase_panel(inter2.channel, game)
                    else:
                        await inter2.response.send_message("宣言できませんでした。", ephemeral=True)

                select.callback = on_pick
                view.add_item(select)
                await inter.response.send_message(view=view, ephemeral=True)

            star_btn = discord.ui.Button(label="星を置く", style=discord.ButtonStyle.primary)
            star_btn.callback = on_place_star
            bomb_btn = discord.ui.Button(label="爆弾を置く", style=discord.ButtonStyle.danger)
            bomb_btn.callback = on_place_bomb
            chal_btn = discord.ui.Button(label="挑戦する", style=discord.ButtonStyle.success)
            chal_btn.callback = on_challenge
            panel.add_row(star_btn, bomb_btn, chal_btn)
        elif game.phase == "bid":
            panel = GamePanelView(
                "🔨 競り",
                status_text(game) + f"\n\n現在の宣言は **{game.bid_amount}枚**（<@{game.challenger}>）。"
                f"手番は <@{game.current}> です。「+1で競る」か「パス」を選んでください。")

            async def on_raise(inter: discord.Interaction):
                if game.raise_bid(inter.user.id, game.bid_amount + 1):
                    await inter.response.send_message(f"{game.bid_amount}枚に競り上げました。")
                    await self._phase_panel(inter.channel, game)
                else:
                    await inter.response.send_message("競れませんでした（手番でない・上限到達）。", ephemeral=True)

            async def on_pass(inter: discord.Interaction):
                if game.pass_bid(inter.user.id):
                    await inter.response.send_message("パスしました。", ephemeral=True)
                    await self._phase_panel(inter.channel, game)
                else:
                    await inter.response.send_message("パスできませんでした。", ephemeral=True)

            raise_btn = discord.ui.Button(label="+1で競る", style=discord.ButtonStyle.primary)
            raise_btn.callback = on_raise
            pass_btn = discord.ui.Button(label="パス", style=discord.ButtonStyle.secondary)
            pass_btn.callback = on_pass
            panel.add_row(raise_btn, pass_btn)
        elif game.phase == "reveal":
            flipped = " ".join("⭐" if k == FLOWER else "💣" for _, k in game.flipped)
            panel = GamePanelView(
                "🎲 めくり",
                status_text(game) + f"\n\n<@{game.challenger}> が {game.bid_amount}枚に挑戦中。"
                f"めくったもの: {flipped or 'なし'}\n"
                "まず自分の山から、無くなったら「めくる相手を選ぶ」で他人の山をめくります。")

            async def on_flip_own(inter: discord.Interaction):
                await self._do_flip(inter, game, inter.user.id)

            async def on_flip_pick(inter: discord.Interaction):
                if inter.user.id != game.challenger:
                    return await inter.response.send_message("めくれるのは宣言者だけです。", ephemeral=True)
                if game.stacks[game.challenger]:
                    return await inter.response.send_message("まず自分の山からめくってください。", ephemeral=True)
                targets = [uid for uid in game.players if game.stacks[uid]]
                if not targets:
                    return await inter.response.send_message("めくれる山がありません。", ephemeral=True)
                view = discord.ui.View(timeout=60)
                select = discord.ui.Select(
                    placeholder="誰の山をめくりますか",
                    options=[discord.SelectOption(label=f"プレイヤー {game.players.index(uid) + 1}", value=str(uid))
                             for uid in targets])

                async def on_pick(inter2: discord.Interaction):
                    await inter2.response.send_message("受け付けました。", ephemeral=True)
                    await self._do_flip(inter2, game, int(select.values[0]), already_responded=True)

                select.callback = on_pick
                view.add_item(select)
                await inter.response.send_message(view=view, ephemeral=True)

            own_btn = discord.ui.Button(label="自分の山をめくる", style=discord.ButtonStyle.primary)
            own_btn.callback = on_flip_own
            pick_btn = discord.ui.Button(label="めくる相手を選ぶ", style=discord.ButtonStyle.secondary)
            pick_btn.callback = on_flip_pick
            panel.add_row(own_btn, pick_btn)
        else:
            return
        msg = self.messages.get(channel.id)
        if msg is None:
            self.messages[channel.id] = await channel.send(view=panel)
        else:
            await msg.edit(view=panel)

    async def _do_place(self, inter: discord.Interaction, game: HoshiGame, kind: str):
        if game.place(inter.user.id, kind):
            label = "星" if kind == FLOWER else "爆弾"
            await inter.response.send_message(f"{label}を伏せて置きました。", ephemeral=True)
            await self._phase_panel(inter.channel, game)
        else:
            await inter.response.send_message("置けませんでした（手番でない・その種類を持っていない）。", ephemeral=True)

    async def _do_flip(self, inter: discord.Interaction, game: HoshiGame, target: int, already_responded: bool = False):
        result = game.flip(inter.user.id, target)
        if not result.get("ok"):
            if not already_responded:
                await inter.response.send_message(result.get("reason", "めくれませんでした。"), ephemeral=True)
            return
        kind = "⭐ 星" if result["kind"] == FLOWER else "💣 爆弾"
        if not already_responded:
            await inter.response.send_message(f"めくったのは {kind} でした。")
        else:
            await inter.channel.send(f"めくったのは {kind} でした。")
        if result.get("done"):
            if result["success"]:
                await inter.channel.send(view=text_panel("成功！", f"🎉 <@{inter.user.id}> の挑戦成功（成功{game.wins[inter.user.id]}/2）"))
            else:
                lost = "⭐ 星" if result.get("lost") == FLOWER else "💣 爆弾" if result.get("lost") else "なし"
                await inter.channel.send(view=text_panel("失敗…", f"💥 <@{inter.user.id}> は爆弾を踏み、{lost}のディスクを1枚失いました。"))
        if game.phase != "done":
            await self._phase_panel(inter.channel, game)


async def setup(bot):
    await bot.add_cog(Hoshi(bot))
