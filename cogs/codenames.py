# -*- coding: utf-8 -*-
"""コードネーム型チーム連想ゲーム（各チーム2人以上）。

リーダーはモーダルからヒント（単語＋個数）を出し、味方はセレクトで
単語を選ぶ。キーカードはリーダーの ephemeral 表示でのみ見られる。
進行は core/codenames.py の状態機械に従う。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core import game_panels, party_ranking
from core.codenames import TEAM_LABEL, CodenamesGame, other_team

logger = logging.getLogger(__name__)

GAME_ID = "codenames"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 45
KIND_MARK = {"red": "🔴", "blue": "🔵", "neutral": "⚪", "assassin": "💀"}


def board_text(game: CodenamesGame, reveal_key: bool = False) -> str:
    lines = []
    for r in range(5):
        cells = []
        for c in range(5):
            i = r * 5 + c
            word = game.words[i]
            if game.revealed[i]:
                cells.append(f"{KIND_MARK[game.key[i]]}{word}")
            elif reveal_key:
                cells.append(f"{KIND_MARK[game.key[i]]}{word}")
            else:
                cells.append(word)
        lines.append(" ｜ ".join(cells))
    return "\n".join(lines)


def status_text(game: CodenamesGame, session, note: str = "") -> str:
    red_left = game.remaining("red")
    blue_left = game.remaining("blue")
    text = (f"残り: 🔴 {red_left}枚 ／ 🔵 {blue_left}枚\n"
            f"リーダー: 🔴 {session['leaders']['red'].mention} ／ 🔵 {session['leaders']['blue'].mention}\n")
    if game.phase == "done":
        text += f"🏆 {TEAM_LABEL[game.winner]} の勝ちです。"
        if game.loser_reason == "assassin":
            text += "（暗殺者を選んでしまいました）"
    elif game.phase == "hint":
        text += f"{TEAM_LABEL[game.turn]} のリーダーはヒントを出してください。"
    else:
        word, count = game.last_hint
        text += (f"{TEAM_LABEL[game.turn]} のヒント: 「{word}」 {count}個"
                 f"（あと {game.guesses_left} 回選べます。パスもできます）")
    if note:
        text += f"\n{note}"
    return text + f"\n```\n{board_text(game)}\n```"


class HintModal(discord.ui.Modal, title="ヒントを出す"):
    word = discord.ui.TextInput(label="ヒントの単語（盤面の単語そのものは不可）", max_length=20)
    count = discord.ui.TextInput(label="個数（0〜9）", max_length=1)

    def __init__(self, cog, session):
        super().__init__()
        self.cog = cog
        self.session = session

    async def on_submit(self, interaction: discord.Interaction):
        game: CodenamesGame = self.session["game"]
        team = self.session["team_of"].get(interaction.user.id)
        try:
            count = int(self.count.value)
            game.give_hint(team, self.word.value, count)
        except (ValueError, TypeError) as e:
            return await interaction.response.send_message(f"ヒントを出せません: {e}", ephemeral=True)
        await interaction.response.defer()
        await self.cog.refresh_board(self.session,
                                      note=f"{TEAM_LABEL[team]} のリーダーがヒント「{self.word.value}」{count}個を出しました。")


class ControlView(discord.ui.View):
    def __init__(self, cog, session):
        super().__init__(timeout=None)
        self.cog = cog
        self.session = session

    def _team(self, interaction):
        return self.session["team_of"].get(interaction.user.id)

    @discord.ui.button(label="キーを見る（リーダー専用）", style=discord.ButtonStyle.secondary, row=1)
    async def show_key(self, interaction: discord.Interaction, button: discord.ui.Button):
        session = self.session
        leaders = {m.id for m in session["leaders"].values()}
        if interaction.user.id not in leaders:
            return await interaction.response.send_message("キーは各チームのリーダーだけが見られます。", ephemeral=True)
        game: CodenamesGame = session["game"]
        await interaction.response.send_message(
            f"キーカード（あなたは {TEAM_LABEL[self._team(interaction)]} のリーダー）:\n```\n{board_text(game, reveal_key=True)}\n```",
            ephemeral=True)

    @discord.ui.button(label="ヒントを出す（リーダー）", style=discord.ButtonStyle.primary, row=1)
    async def hint(self, interaction: discord.Interaction, button: discord.ui.Button):
        session = self.session
        game: CodenamesGame = session["game"]
        team = self._team(interaction)
        if team is None or session["leaders"][team].id != interaction.user.id:
            return await interaction.response.send_message("ヒントを出せるのはリーダーだけです。", ephemeral=True)
        if game.phase != "hint" or game.turn != team:
            return await interaction.response.send_message("今はあなたのチームのヒントの番ではありません。", ephemeral=True)
        await interaction.response.send_modal(HintModal(self.cog, session))

    @discord.ui.button(label="パス", style=discord.ButtonStyle.secondary, row=1)
    async def pass_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        session = self.session
        game: CodenamesGame = session["game"]
        team = self._team(interaction)
        if team != game.turn or game.phase != "guess":
            return await interaction.response.send_message("今はパスできません。", ephemeral=True)
        game.pass_turn(team)
        await interaction.response.defer()
        await self.cog.refresh_board(session, note=f"{TEAM_LABEL[team]} がパスしました。")


class GuessSelect(discord.ui.Select):
    def __init__(self, cog, session):
        self.cog = cog
        self.session = session
        game: CodenamesGame = session["game"]
        options = [discord.SelectOption(label=game.words[i], value=str(i))
                   for i in range(25) if not game.revealed[i]]
        super().__init__(placeholder="当てる単語を選んでください（味方のエージェント専用）", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        session = self.session
        game: CodenamesGame = session["game"]
        team = session["team_of"].get(interaction.user.id)
        if team is None or team != game.turn or game.phase != "guess":
            return await interaction.response.send_message("今は選べません。", ephemeral=True)
        if session["leaders"][team].id == interaction.user.id:
            return await interaction.response.send_message("リーダーは単語を選べません。", ephemeral=True)
        index = int(self.values[0])
        event = game.guess(team, index)
        await interaction.response.defer()
        kind = event["kind"]
        if kind == "assassin":
            note = f"💀 {interaction.user.mention} が「{event['word']}」を選んでしまった…暗殺者です。"
        elif kind == team:
            note = f"⭕ {interaction.user.mention} が「{event['word']}」を選んで正解！"
        elif kind == "neutral":
            note = f"△ {interaction.user.mention} が「{event['word']}」を選んだけど中立でした。"
        else:
            note = f"❌ {interaction.user.mention} が「{event['word']}」を選んだけど相手チームの単語でした。"
        await self.cog.refresh_board(session, note=note)


class TeamJoinView(discord.ui.View):
    def __init__(self, session):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.session = session

    @discord.ui.button(label="🔴 赤チームで参加", style=discord.ButtonStyle.danger)
    async def join_red(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._join(interaction, "red")

    @discord.ui.button(label="🔵 青チームで参加", style=discord.ButtonStyle.primary)
    async def join_blue(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._join(interaction, "blue")

    async def _join(self, interaction: discord.Interaction, team: str):
        session = self.session
        if interaction.user.id in session["team_of"]:
            return await interaction.response.send_message("すでに参加しています（チーム変更はできません）。", ephemeral=True)
        session["teams"][team].append(interaction.user)
        session["team_of"][interaction.user.id] = team
        await interaction.response.send_message(f"{TEAM_LABEL[team]} に参加しました。")


class Codenames(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.sessions = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.sessions:
            return await interaction.response.send_message("このチャンネルでは既に進行中です。", ephemeral=True)
        session = {"teams": {"red": [], "blue": []}, "team_of": {},
                   "channel": channel, "guild_id": interaction.guild_id, "game": None, "leaders": {}}
        self.sessions[channel.id] = session
        await interaction.response.send_message("コードネームの募集を開始しました。")
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="🕵 コードネーム 参加者募集",
                description=(f"チームを選んで参加してください（各チーム2人以上）。\n"
                             f"{RECRUIT_SECONDS}秒で締め切ります。各チームの最初の参加者がリーダーになります。"),
                color=COLOR), view=TeamJoinView(session))
            await asyncio.sleep(RECRUIT_SECONDS)
            if len(session["teams"]["red"]) < 2 or len(session["teams"]["blue"]) < 2:
                await channel.send("各チーム2人以上そろわなかったため、開始できませんでした。")
                return
            session["leaders"] = {"red": session["teams"]["red"][0], "blue": session["teams"]["blue"][0]}
            first = "red" if len(session["teams"]["red"]) >= len(session["teams"]["blue"]) else "blue"
            session["game"] = CodenamesGame(first_team=first, rng=random.Random())
            await self.refresh_board(session, note="ゲーム開始！")
            # 対局はビュー駆動で続くため、セッション登録は refresh_board の
            # 終局処理で外す。ここでは募集だけを閉じる。
            return
        finally:
            if session["game"] is None:
                self.sessions.pop(channel.id, None)

    async def refresh_board(self, session, note: str = ""):
        game: CodenamesGame = session["game"]
        channel = session["channel"]
        if game.phase == "done":
            if not session.get("recorded"):
                session["recorded"] = True
                winners = session["teams"][game.winner]
                for member in winners:
                    await party_ranking.shared().record_win(session["guild_id"], member.id, GAME_ID)
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="🕵 コードネーム 終了", description=status_text(game, session, note), color=COLOR))
            self.sessions.pop(channel.id, None)
            return
        view = ControlView(self, session)
        view.add_item(GuessSelect(self, session))
        await game_panels.replace(channel, "party", embed=discord.Embed(
            title="🕵 コードネーム", description=status_text(game, session, note), color=COLOR), view=view)


async def setup(bot):
    await bot.add_cog(Codenames(bot))
