# -*- coding: utf-8 -*-
"""「アゴ遺跡の秘宝」（Incan Gold 系チキンレース）。

盤面表現: 探検の道（公開されたカードの履歴）はタイルの並びが視覚情報の核
なので、PIL タイル画像（core/board_image.render_tiles）で見せる。公開は
ステップごとに新しいメッセージで送り、編集時の添付落ちを避ける。
操作は「進む/帰る」の2ボタン同時選択に分離する。
"""
import asyncio
import io
import logging

import discord
from discord.ext import commands

from core import party_ranking
from core.game.board_image import render_tiles
from core.game.game_v2 import GamePanelView, text_panel
from core.game.ruins import TOTAL_ROUNDS, RuinsGame

logger = logging.getLogger(__name__)

party_ranking.register("ruins")

GAME_ID = "ruins"
RECRUIT_SECONDS = 60
DECIDE_SECONDS = 30
MIN_PLAYERS = 3
MAX_PLAYERS = 8

HAZARD_TILE = {"落石": ("落", (121, 85, 72)), "毒蛇": ("蛇", (104, 159, 56)),
               "大蜘蛛": ("蛛", (84, 110, 122)), "炎": ("炎", (229, 115, 115)),
               "ミイラ": ("ミ", (161, 136, 127))}


def path_png(game: RuinsGame) -> bytes:
    tiles = []
    for kind, value in game.path:
        if kind == "treasure":
            tiles.append((str(value), (0, 150, 136)))
        elif kind == "artifact":
            tiles.append(("秘", (255, 193, 7)))
        else:
            tiles.append(HAZARD_TILE.get(value, ("危", (120, 120, 120))))
    rows = [tiles[i:i + 10] for i in range(0, len(tiles), 10)] or [[("・", (60, 60, 60))]]
    return render_tiles(rows, tile=56, title=f"探検の道（ラウンド{game.round_index + 1}）")


def event_text(game: RuinsGame, event: dict) -> str:
    kind = event["type"]
    if kind == "treasure":
        return f"💎 宝石 {event['value']}！ 中の全員で山分け（1人 +{event['share']}、道に {event['path_gems']} 残り）"
    if kind == "artifact":
        return f"🏺 秘宝（{event['value']}点）が道に現れました。1人だけで帰ると全部もらえます。"
    if kind == "hazard":
        return f"⚠️ 危険「{event['value']}」が現れました。もう1枚出るとバーストです。"
    if kind == "round_end":
        base = f"🏁 ラウンド{event['round']}終了: {event['reason']}"
        if "lost" in event:
            lost = "、".join(f"<@{uid}>:-{v}" for uid, v in event["lost"].items() if v)
            if lost:
                base += f"\n没収: {lost}"
        return base
    return str(event)


class Ruins(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, RuinsGame | None] = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}
        panel = GamePanelView("🏺 アゴ遺跡の秘宝 参加者募集",
                              f"進むか帰るかを選ぶチキンレースです（{MIN_PLAYERS}〜{MAX_PLAYERS}名、{TOTAL_ROUNDS}ラウンド）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"進むか帰るかを選ぶチキンレースです（{MIN_PLAYERS}〜{MAX_PLAYERS}名、{TOTAL_ROUNDS}ラウンド）。\n"
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
                await channel.send(view=text_panel("アゴ遺跡の秘宝", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            game = RuinsGame(players)
            self.channels[channel.id] = game
            await self._play(channel, game)
        except Exception:  # noqa: BLE001
            logger.exception("Ruins: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)

    async def _play(self, channel, game: RuinsGame):
        while not game.game_finished:
            game.start_round()
            if game.game_finished:
                break
            await channel.send(view=text_panel(
                f"ラウンド{game.round_index + 1} 開始",
                "探検隊が遺跡に入ります。確定済みの宝石: "
                + "、".join(f"<@{uid}>:{game.banked[uid]}" for uid in game.players)))
            while game.phase == "decide" and game.in_ruin:
                event = game.reveal()
                png = path_png(game)
                panel = GamePanelView("探検の道", event_text(game, event))
                panel.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem("attachment://path.png")))
                await channel.send(file=discord.File(io.BytesIO(png), "path.png"), view=panel)
                if event["type"] == "round_end":
                    break
                await self._decision_phase(channel, game)
                result = game.resolve_decisions(default_go=False)
                if result["type"] == "continue":
                    leavers = result["leavers"]
                    if leavers:
                        gained = "、".join(f"<@{uid}>:+{result['gained'].get(uid, 0)}" for uid in leavers)
                        await channel.send(view=text_panel("帰還", f"帰った人: {gained}"))
                else:
                    await channel.send(view=text_panel("ラウンド終了", event_text(game, result)))
                    break
            await asyncio.sleep(2)
        rows = sorted(game.banked.items(), key=lambda kv: -kv[1])
        text = "\n".join(f"{i + 1}. <@{uid}> — {v}個" for i, (uid, v) in enumerate(rows))
        await channel.send(view=text_panel("🏆 アゴ遺跡の秘宝 最終結果", text))
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in game.winners():
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)

    async def _decision_phase(self, channel, game: RuinsGame):
        status = "、".join(f"<@{uid}>:所持{game.carrying[uid]}" for uid in sorted(game.in_ruin))
        panel = GamePanelView(
            "進む？ 帰る？",
            f"中にいる人: {status}\n道の端数: {game.path_gems}／秘宝: {game.path_artifacts or 'なし'}\n"
            f"{DECIDE_SECONDS}秒以内に選んでください（未選択は「帰る」扱い）。")

        def make(go: bool, label: str):
            async def on_decide(inter: discord.Interaction):
                if game.decide(inter.user.id, go):
                    await inter.response.send_message(f"「{label}」を選びました。", ephemeral=True)
                else:
                    await inter.response.send_message("選べませんでした（中にいない・締切）。", ephemeral=True)
            return on_decide

        go_btn = discord.ui.Button(label="進む", style=discord.ButtonStyle.danger)
        go_btn.callback = make(True, "進む")
        back_btn = discord.ui.Button(label="帰る", style=discord.ButtonStyle.success)
        back_btn.callback = make(False, "帰る")
        panel.add_row(go_btn, back_btn)
        await channel.send(view=panel)
        for _ in range(DECIDE_SECONDS * 2):
            if game.all_decided:
                break
            await asyncio.sleep(0.5)


async def setup(bot):
    await bot.add_cog(Ruins(bot))
