# -*- coding: utf-8 -*-
"""「価値観ゲージ」（Wavelength 系のチーム対戦）。

盤面表現: 目盛りとターゲット帯は空間情報なので、PIL で描いたゲージ画像
（core/board_image.render_gauge）を MediaGallery で見せる。公開タイミングが
ラウンドに数回だけなので画像再生成・添付コストは小さい。結果発表は毎回
新しいメッセージで送り、編集時の添付落ち（panel_v2 の既知問題）を避ける。
操作は目盛りボタン（ラベルは 00〜10 のゼロ埋めで幅均一）＋モーダル＋ボタン。
"""
import asyncio
import io
import logging

import discord
from discord.ext import commands

from core import party_ranking
from core.game.board_image import render_gauge
from core.game.game_v2 import GamePanelView, text_panel
from core.general.gauge import SCALE, TARGET_SCORE, GaugeGame

logger = logging.getLogger(__name__)

party_ranking.register("gauge")

GAME_ID = "gauge"
RECRUIT_SECONDS = 60
HINT_SECONDS = 90
GUESS_SECONDS = 90
COUNTER_SECONDS = 20
MIN_PLAYERS = 4
MAX_PLAYERS = 12


def gauge_panel(title: str, body: str, png: bytes, filename: str = "gauge.png") -> GamePanelView:
    panel = GamePanelView(title, body)
    panel.add_extra(discord.ui.MediaGallery(discord.MediaGalleryItem(f"attachment://{filename}")))
    return panel


class HintModal(discord.ui.Modal, title="ヒントを出す"):
    hint = discord.ui.TextInput(label="ターゲットの位置にふさわしい例え（1つ）", max_length=80)

    def __init__(self, cog, game: GaugeGame):
        super().__init__()
        self.cog = cog
        self.game = game

    async def on_submit(self, interaction: discord.Interaction):
        if self.game.set_hint(interaction.user.id, str(self.hint.value)):
            await interaction.response.send_message("ヒントを受け付けました。", ephemeral=True)
            await self.cog.begin_guess(interaction.channel)
        else:
            await interaction.response.send_message("出題者だけがヒントを出せます。", ephemeral=True)


class Gauge(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, GaugeGame | None] = {}
        self.guess_started: set[int] = set()

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}
        panel = GamePanelView("🎚️ 価値観ゲージ 参加者募集",
                              f"軸の上の正解位置を読み合うチーム対戦です（{MIN_PLAYERS}〜{MAX_PLAYERS}名、2チーム）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"軸の上の正解位置を読み合うチーム対戦です（{MIN_PLAYERS}〜{MAX_PLAYERS}名、2チーム）。\n"
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
                await channel.send(view=text_panel("価値観ゲージ", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            team_a = players[0::2]
            team_b = players[1::2]
            game = GaugeGame(team_a, team_b)
            self.channels[channel.id] = game
            await channel.send(view=text_panel(
                "チーム分け",
                "チームA: " + " ".join(f"<@{p}>" for p in team_a) + "\n"
                "チームB: " + " ".join(f"<@{p}>" for p in team_b)))
            await self._play(channel, game)
        except Exception:  # noqa: BLE001
            logger.exception("Gauge: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.guess_started.discard(channel.id)

    async def _play(self, channel, game: GaugeGame):
        while not game.finished:
            if not game.next_round():
                break
            self.guess_started.discard(channel.id)
            await self._psychic_panel(channel, game)
            for _ in range(HINT_SECONDS * 2):
                if game.hint is not None:
                    break
                await asyncio.sleep(0.5)
            if game.hint is None:
                await channel.send(view=text_panel("価値観ゲージ", "ヒントが出なかったため、このラウンドは流れました。"))
                continue
            if channel.id not in self.guess_started:
                await self.begin_guess(channel)
            for _ in range(GUESS_SECONDS * 2):
                if game.guess is not None:
                    break
                await asyncio.sleep(0.5)
            if game.guess is None:
                await channel.send(view=text_panel("価値観ゲージ", "予想が決まらなかったため、このラウンドは流れました。"))
                continue
            counter = await self._counter_phase(channel, game)
            result = game.settle(counter)
            await self._reveal(channel, game, result)
            await asyncio.sleep(2)
        await self._finish(channel, game)

    async def _psychic_panel(self, channel, game: GaugeGame):
        left, right = game.axis
        png = render_gauge(None, left=left, right=right)
        panel = gauge_panel(
            f"ラウンド{game.round_index + 1} 軸: {left} ⇔ {right}",
            f"出題者はチーム{game.turn_team} の <@{game.psychic}> です。\n"
            "「ターゲットを見る」で中心位置を自分だけ確認し、「ヒントを出す」から例えを1つ出してください。\n"
            f"現在のスコア: A {game.scores['A']}点 / B {game.scores['B']}点（先に{TARGET_SCORE}点で勝ち）", png)

        async def on_target(inter: discord.Interaction):
            if inter.user.id != game.psychic:
                return await inter.response.send_message("見られるのは出題者だけです。", ephemeral=True)
            target_png = render_gauge(game.center, left=left, right=right)
            view = gauge_panel("あなたのターゲット", f"中心は目盛り **{game.center}**（黄色の帯が得点圏）です。", target_png)
            await inter.response.send_message(file=discord.File(io.BytesIO(target_png), "gauge.png"), view=view, ephemeral=True)

        async def on_hint(inter: discord.Interaction):
            if inter.user.id != game.psychic:
                return await inter.response.send_message("ヒントを出せるのは出題者だけです。", ephemeral=True)
            await inter.response.send_modal(HintModal(self, game))

        target_btn = discord.ui.Button(label="ターゲットを見る", style=discord.ButtonStyle.secondary)
        target_btn.callback = on_target
        hint_btn = discord.ui.Button(label="ヒントを出す", style=discord.ButtonStyle.primary)
        hint_btn.callback = on_hint
        panel.add_row(target_btn, hint_btn)
        await channel.send(file=discord.File(io.BytesIO(png), "gauge.png"), view=panel)

    async def begin_guess(self, channel):
        game = self.channels.get(channel.id)
        if game is None or game.hint is None or channel.id in self.guess_started:
            return
        self.guess_started.add(channel.id)
        left, right = game.axis
        png = render_gauge(None, left=left, right=right)
        panel = gauge_panel(
            f"ヒント: 「{game.hint}」",
            f"チーム{game.turn_team} のみんなで議論し、目盛りボタンで予想位置を決めてください（{GUESS_SECONDS}秒）。\n"
            "押した人の予想がそのままチームの予想になります。", png)

        def make_pos(pos: int):
            async def on_pos(inter: discord.Interaction):
                if game.team_of(inter.user.id) != game.turn_team:
                    return await inter.response.send_message("予想できるのは出題チームだけです。", ephemeral=True)
                if game.set_guess(pos):
                    await inter.response.send_message(f"予想を目盛り {pos} に決めました。")
                else:
                    await inter.response.send_message("すでに予想が決まっています。", ephemeral=True)
            return on_pos

        buttons = []
        for pos in range(SCALE + 1):
            btn = discord.ui.Button(label=f"{pos:02d}", style=discord.ButtonStyle.primary)
            btn.callback = make_pos(pos)
            buttons.append(btn)
        panel.add_row(*buttons[:5])
        panel.add_row(*buttons[5:10])
        panel.add_row(buttons[10])
        await channel.send(file=discord.File(io.BytesIO(png), "gauge.png"), view=panel)

    async def _counter_phase(self, channel, game: GaugeGame) -> str | None:
        if game.guess == game.center:
            return None
        state = {"value": None}
        panel = GamePanelView(
            "相手チームのチャンス",
            f"予想は目盛り {game.guess} でした。正解の中心は予想より「左寄り」か「右寄り」か、"
            f"チーム{game.other_team} の誰かが {COUNTER_SECONDS}秒以内に押してください（当たれば +1点）。")

        def make(direction: str):
            async def on_counter(inter: discord.Interaction):
                if game.team_of(inter.user.id) != game.other_team:
                    return await inter.response.send_message("押せるのは相手チームだけです。", ephemeral=True)
                if state["value"] is None:
                    state["value"] = direction
                    await inter.response.send_message("受け付けました。", ephemeral=True)
                else:
                    await inter.response.send_message("すでに決まっています。", ephemeral=True)
            return on_counter

        left_btn = discord.ui.Button(label="左寄り", style=discord.ButtonStyle.primary)
        left_btn.callback = make("left")
        right_btn = discord.ui.Button(label="右寄り", style=discord.ButtonStyle.primary)
        right_btn.callback = make("right")
        panel.add_row(left_btn, right_btn)
        await channel.send(view=panel)
        for _ in range(COUNTER_SECONDS * 2):
            if state["value"] is not None:
                break
            await asyncio.sleep(0.5)
        return state["value"]

    async def _reveal(self, channel, game: GaugeGame, result: dict):
        left, right = game.axis
        png = render_gauge(game.center, guess=game.guess, left=left, right=right)
        counter_text = f"／相手チームの左右当て +{result['counter_point']}点" if result["counter_point"] else ""
        panel = gauge_panel(
            f"結果: 中心は {result['center']} でした",
            f"チーム{game.turn_team} の得点 +{result['points']}点{counter_text}\n"
            f"スコア: A {game.scores['A']}点 / B {game.scores['B']}点", png)
        await channel.send(file=discord.File(io.BytesIO(png), "gauge.png"), view=panel)

    async def _finish(self, channel, game: GaugeGame):
        if game.winner == "draw":
            text = f"引き分けです。スコア: A {game.scores['A']}点 / B {game.scores['B']}点"
            winners: list[int] = []
        else:
            text = (f"🏆 チーム{game.winner} の勝ち！ スコア: A {game.scores['A']}点 / B {game.scores['B']}点\n"
                    "メンバー: " + " ".join(f"<@{p}>" for p in game.teams[game.winner]))
            winners = game.teams[game.winner]
        await channel.send(view=text_panel("価値観ゲージ 最終結果", text))
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in winners:
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(Gauge(bot))
