# -*- coding: utf-8 -*-
"""「潜入者」（Insider 系の正体隠匿・質問推理ゲーム）。

盤面表現: 盤面を持たない会話ゲームのため V2 構造化テキストのみ（画像化対象外。
判断は実装ログ参照）。質問は自由チャット、マスターの回答はボタン、
お題当てはモーダル、投票はセレクトで行う。
"""
import asyncio
import logging

import discord
from discord.ext import commands

from core import party_ranking
from core.game.game_v2 import GamePanelView, text_panel
from core.game.insider import QUESTION_LIMIT, InsiderGame

logger = logging.getLogger(__name__)

party_ranking.register("insider")

GAME_ID = "insider"
RECRUIT_SECONDS = 60
VOTE_SECONDS = 60
MIN_PLAYERS = 4
MAX_PLAYERS = 8


class GuessModal(discord.ui.Modal, title="お題を当てる"):
    answer = discord.ui.TextInput(label="お題だと思う答え", max_length=30)

    def __init__(self, cog, game: InsiderGame):
        super().__init__()
        self.cog = cog
        self.game = game

    async def on_submit(self, interaction: discord.Interaction):
        await self.cog.apply_guess(interaction, self.game, str(self.answer.value))


class Insider(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.channels: dict[int, InsiderGame | None] = {}
        self.messages: dict[int, discord.Message] = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.channels:
            return await interaction.response.send_message("このチャンネルではすでに開催中です。", ephemeral=True)
        self.channels[channel.id] = None
        players = [interaction.user.id]
        state = {"started": False}
        panel = GamePanelView("🕵️ 潜入者 参加者募集",
                              f"お題を知っている潜入者を探すゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
                              f"ホストが「開始する」を押すか、{RECRUIT_SECONDS}秒たつと開始します。\n参加者: <@{players[0]}>")

        async def on_join(inter: discord.Interaction):
            if inter.user.id in players:
                return await inter.response.send_message("すでに参加しています。", ephemeral=True)
            if len(players) >= MAX_PLAYERS:
                return await inter.response.send_message("満員です。", ephemeral=True)
            players.append(inter.user.id)
            panel.set_content(body=f"お題を知っている潜入者を探すゲームです（{MIN_PLAYERS}〜{MAX_PLAYERS}名）。\n"
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
                await channel.send(view=text_panel("潜入者", f"人数不足（{MIN_PLAYERS}名以上必要）のため、開始できませんでした。"))
                return
            game = InsiderGame(players)
            self.channels[channel.id] = game
            await self._question_panel(channel, game)
            # 質問フェーズは「お題が当たる/回答切れ」まで（実時間の上限は設けず、
            # 回答回数制で必ず終わる設計。ガイドにも明記）
            while game.phase == "question":
                await asyncio.sleep(1.0)
            if game.phase == "vote":
                await self._vote_panel(channel, game)
                for _ in range(VOTE_SECONDS * 2):
                    if game.all_voted:
                        break
                    await asyncio.sleep(0.5)
                result = game.settle()
                await self._finish(channel, game, result)
            else:  # 回答切れで終了
                await self._finish(channel, game, game.result or "insider")
        except Exception:  # noqa: BLE001
            logger.exception("Insider: 進行中にエラーが発生しました")
        finally:
            self.channels.pop(channel.id, None)
            self.messages.pop(channel.id, None)

    async def _question_panel(self, channel, game: InsiderGame):
        panel = GamePanelView(
            "🕵️ 潜入者 質問フェーズ",
            f"マスターは <@{game.master}> です。お題はマスターと潜入者だけが知っています。\n"
            "チャットで自由に質問し、マスターはボタンで回答してください。\n"
            f"回答は残り {game.question_limit - game.answers_used} 回まで。お題が分かったら「お題を当てる」から答えてください。\n"
            "自分の役職は「役職を見る」で本人だけ確認できます。")

        async def on_role(inter: discord.Interaction):
            uid = inter.user.id
            if uid not in game.players:
                return await inter.response.send_message("参加者だけが見られます。", ephemeral=True)
            if uid == game.master:
                body = f"あなたは **マスター** です。お題は **{game.topic}**。質問に正直に答えてください。"
            elif uid == game.insider:
                body = f"あなたは **潜入者** です。お題は **{game.topic}**。バレないように誘導してください。"
            else:
                body = "あなたは **市民** です。お題は分かりません。質問してお題と潜入者を探してください。"
            await inter.response.send_message(view=GamePanelView("あなたの役職", body), ephemeral=True)

        async def make_answer(label: str):
            async def on_answer(inter: discord.Interaction):
                if inter.user.id != game.master:
                    return await inter.response.send_message("回答できるのはマスターだけです。", ephemeral=True)
                if not game.answer_question():
                    return await inter.response.send_message("質問フェーズは終わっています。", ephemeral=True)
                await inter.response.send_message(f"マスターの回答: **{label}**（残り {game.question_limit - game.answers_used} 回）")
                if game.phase != "question":
                    panel.set_content(body="回答回数を使い切りました。結果発表に進みます。")
                    panel.clear_rows()
                    msg = self.messages.get(channel.id)
                    if msg is not None:
                        await msg.edit(view=panel)
            return on_answer

        async def on_guess(inter: discord.Interaction):
            if inter.user.id == game.master or inter.user.id not in game.players:
                return await inter.response.send_message("お題当てはマスター以外の参加者ができます。", ephemeral=True)
            await inter.response.send_modal(GuessModal(self, game))

        role_btn = discord.ui.Button(label="役職を見る", style=discord.ButtonStyle.secondary)
        role_btn.callback = on_role
        guess_btn = discord.ui.Button(label="お題を当てる", style=discord.ButtonStyle.success)
        guess_btn.callback = on_guess
        panel.add_row(role_btn, guess_btn)
        yes_btn = discord.ui.Button(label="はい", style=discord.ButtonStyle.primary)
        yes_btn.callback = await make_answer("はい")
        no_btn = discord.ui.Button(label="いいえ", style=discord.ButtonStyle.primary)
        no_btn.callback = await make_answer("いいえ")
        na_btn = discord.ui.Button(label="関係ない", style=discord.ButtonStyle.primary)
        na_btn.callback = await make_answer("関係ない")
        panel.add_row(yes_btn, no_btn, na_btn)
        msg = await channel.send(view=panel)
        self.messages[channel.id] = msg

    async def apply_guess(self, interaction: discord.Interaction, game: InsiderGame, text: str):
        if game.guess_topic(interaction.user.id, text):
            await interaction.response.send_message(
                f"🎉 <@{interaction.user.id}> がお題「{game.topic}」を当てました！ 投票フェーズに進みます。")
        else:
            await interaction.response.send_message("違います。", ephemeral=True)

    async def _vote_panel(self, channel, game: InsiderGame):
        options = [discord.SelectOption(label=f"プレイヤー {i + 1}", value=str(uid))
                   for i, uid in enumerate(game.players) if uid != game.master]
        # 表示名はメンションに頼らず番号＋後段の対応表で示す（セレクトは25件上限内）
        names = "\n".join(f"プレイヤー {i + 1}: <@{uid}>" for i, uid in enumerate(game.players) if uid != game.master)
        panel = GamePanelView(
            "🗳️ 潜入者は誰？",
            f"お題は「{game.topic}」でした。潜入者だと思う人を選んでください（マスターは除く）。\n{names}\n"
            f"{VOTE_SECONDS}秒で締め切ります。同票の場合は潜入者の勝ちです。")
        select = discord.ui.Select(placeholder="潜入者だと思う人", options=options)

        async def on_vote(inter: discord.Interaction):
            if game.vote(inter.user.id, int(select.values[0])):
                await inter.response.send_message("投票しました。", ephemeral=True)
            else:
                await inter.response.send_message("投票できませんでした。", ephemeral=True)

        select.callback = on_vote
        panel.add_row(select)
        await channel.send(view=panel)

    async def _finish(self, channel, game: InsiderGame, result: str):
        if result == "citizens":
            text = (f"🎉 市民の勝ち！ 潜入者は <@{game.insider}> でした。\n"
                    f"お題を当てたのは <@{game.guesser}> です。")
            winners = game.citizens
        else:
            reason = "お題を当てられなかった" if game.guesser is None else "投票で外れた"
            text = (f"🕵️ 潜入者の勝ち！ 潜入者は <@{game.insider}> でした（{reason}）。\n"
                    f"お題は「{game.topic}」でした。")
            winners = [game.insider]
        await channel.send(view=text_panel("潜入者 結果", text))
        guild = getattr(channel, "guild", None)
        if guild is not None:
            for uid in winners:
                await party_ranking.shared().record_win(guild.id, uid, GAME_ID)


async def setup(bot):
    await bot.add_cog(Insider(bot))
