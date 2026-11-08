# -*- coding: utf-8 -*-
"""コードネーム型チーム連想ゲーム（各チーム2人以上）。

リーダーはモーダルからヒント（単語＋個数）を出し、味方はセレクトで
単語を選ぶ。キーカードはリーダーの ephemeral 表示でのみ見られる。
進行は core/game/codenames/codenames.py の状態機械に従う。
"""
import asyncio
import io
import logging
import random
from core.support.emojis import FAILED

import discord
from discord.ext import commands

from core.game.game import party_ranking
from core.game.game import game_panels
from core.game.game.board_image import (codenames_key_cells, codenames_public_cells,
                                        render_cached, render_codenames_board)
from core.game.game.game_v2 import GamePanelView, refresh_panel, text_panel
from core.game.codenames.codenames import TEAM_LABEL, CodenamesGame, other_team

logger = logging.getLogger(__name__)

GAME_ID = "codenames"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 45
KIND_MARK = {"red": "🔴", "blue": "🔵", "neutral": "⚪", "assassin": "💀"}


def status_text(game: CodenamesGame, session, note: str = "") -> str:
    red_left = game.remaining("red")
    blue_left = game.remaining("blue")
    text = (f"残り: 🔴 {red_left}枚 ／ 🔵 {blue_left}枚\n"
            f"リーダー: 🔴 {session['leaders']['red'].display_name} ／ 🔵 {session['leaders']['blue'].display_name}\n")
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
    return text


def board_png(game: CodenamesGame, *, key_view: bool = False) -> bytes:
    """盤面画像。共有盤面は未開示セルの種類を落としてから描く（秘匿）。

    key_view=True はリーダーの ephemeral 専用で、キー全体を渡す。
    """
    if key_view:
        cells = codenames_key_cells(game.key, game.revealed)
    else:
        cells = codenames_public_cells(game.key, game.revealed)
    key = ("codenames-board", tuple(game.words), tuple(cells), key_view)
    return render_cached(key, lambda: render_codenames_board(game.words, cells))


def board_file(game: CodenamesGame, *, key_view: bool = False) -> discord.File:
    return discord.File(io.BytesIO(board_png(game, key_view=key_view)),
                        filename="codenames_key.png" if key_view else "board.png")


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


class ControlPanel(GamePanelView):
    """盤面＋単語セレクト＋操作ボタンのパネル（V2）。"""

    def __init__(self, cog, session, body: str = "", guess_select=None):
        super().__init__("🕵 コードネーム", body, timeout=None)
        self.cog = cog
        self.session = session
        self.add_extra(discord.ui.MediaGallery(
            discord.MediaGalleryItem("attachment://board.png")))
        self.guess_select = guess_select
        if guess_select is not None:
            self.add_row(guess_select)
        self.show_key = discord.ui.Button(label="キーを見る（リーダー専用）", style=discord.ButtonStyle.secondary)
        self.show_key.callback = self._show_key
        self.hint = discord.ui.Button(label="ヒントを出す（リーダー）", style=discord.ButtonStyle.primary)
        self.hint.callback = self._hint
        self.pass_button = discord.ui.Button(label="パス", style=discord.ButtonStyle.secondary)
        self.pass_button.callback = self._pass
        self.add_row(self.show_key, self.hint, self.pass_button)

    def _team(self, interaction):
        return self.session["team_of"].get(interaction.user.id)

    async def _show_key(self, interaction: discord.Interaction):
        session = self.session
        leaders = {m.id for m in session["leaders"].values()}
        if interaction.user.id not in leaders:
            return await interaction.response.send_message("キーは各チームのリーダーだけが見られます。", ephemeral=True)
        game: CodenamesGame = session["game"]
        await interaction.response.send_message(
            f"キーカード（あなたは {TEAM_LABEL[self._team(interaction)]} のリーダー）",
            file=board_file(game, key_view=True), ephemeral=True)

    async def _hint(self, interaction: discord.Interaction):
        session = self.session
        game: CodenamesGame = session["game"]
        team = self._team(interaction)
        if team is None or session["leaders"][team].id != interaction.user.id:
            return await interaction.response.send_message("ヒントを出せるのはリーダーだけです。", ephemeral=True)
        if game.phase != "hint" or game.turn != team:
            return await interaction.response.send_message("今はあなたのチームのヒントの番ではありません。", ephemeral=True)
        await interaction.response.send_modal(HintModal(self.cog, session))

    async def _pass(self, interaction: discord.Interaction):
        session = self.session
        game: CodenamesGame = session["game"]
        team = self._team(interaction)
        if team != game.turn or game.phase != "guess":
            return await interaction.response.send_message("今はパスできません。", ephemeral=True)
        if team is not None and session["leaders"][team].id == interaction.user.id:
            return await interaction.response.send_message("リーダーはパスできません。", ephemeral=True)
        game.pass_turn(team)
        await interaction.response.defer()
        await self.cog.refresh_board(session, note=f"{TEAM_LABEL[team]} がパスしました。")


ControlView = ControlPanel  # 互換名


class GuessSelect(discord.ui.Select):
    def __init__(self, cog, session):
        self.cog = cog
        self.session = session
        game: CodenamesGame = session["game"]
        options = [discord.SelectOption(label=game.words[i], value=str(i))
                   for i in range(25) if not game.revealed[i]]
        super().__init__(placeholder="当てる単語を選んでください（味方のエージェント専用）", options=options)

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
            note = f"{FAILED} {interaction.user.mention} が「{event['word']}」を選んだけど相手チームの単語でした。"
        await self.cog.refresh_board(session, note=note)


class TeamJoinPanel(GamePanelView):
    """チーム選択型ロビー（V2）。

    共通ロビー（LobbyView）は単一参加者プール前提のため使えないが、
    規格は揃える: 参加は新規メッセージを出さずパネルをその場編集して
    チーム別参加者一覧を更新し、エラーだけ ephemeral で返す。
    開始はホスト操作ではなく制限時間で締め切る（従来どおり）。
    """

    def __init__(self, session):
        super().__init__("🕵 コードネーム 参加者募集", "", timeout=RECRUIT_SECONDS + 30)
        self.session = session
        self.join_red = discord.ui.Button(label="🔴 赤チームで参加", style=discord.ButtonStyle.danger)
        self.join_red.callback = self._join_red
        self.join_blue = discord.ui.Button(label="🔵 青チームで参加", style=discord.ButtonStyle.primary)
        self.join_blue.callback = self._join_blue
        self.add_row(self.join_red, self.join_blue)
        self._sync_body()

    def _sync_body(self) -> None:
        session = self.session
        lines = ["チームを選んで参加してください（各チーム2人以上）。",
                 f"{RECRUIT_SECONDS}秒で締め切ります。各チームの最初の参加者がリーダーになります。"]
        for team in ("red", "blue"):
            members = session["teams"][team]
            names = "、".join(m.display_name for m in members) or "（まだいません）"
            lines.append(f"{TEAM_LABEL[team]}（{len(members)}人）: {names}")
        self.set_content(body="\n".join(lines))

    async def _join_red(self, interaction: discord.Interaction):
        await self._join(interaction, "red")

    async def _join_blue(self, interaction: discord.Interaction):
        await self._join(interaction, "blue")

    async def _join(self, interaction: discord.Interaction, team: str):
        session = self.session
        if interaction.user.id in session["team_of"]:
            return await interaction.response.send_message("すでに参加しています（チーム変更はできません）。", ephemeral=True)
        session["teams"][team].append(interaction.user)
        session["team_of"][interaction.user.id] = team
        self._sync_body()
        await refresh_panel(interaction, self)


TeamJoinView = TeamJoinPanel  # 互換名


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
            lobby = TeamJoinPanel(session)
            await game_panels.replace(channel, "party", view=lobby)
            await asyncio.sleep(RECRUIT_SECONDS)
            lobby.stop()
            if len(session["teams"]["red"]) < 2 or len(session["teams"]["blue"]) < 2:
                await game_panels.clear(channel, "party")
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
            # 盤面パネルを片付け、結果だけを残す（最終盤面の画像つき）。
            await game_panels.clear(channel, "party")
            await channel.send(view=text_panel("🕵 コードネーム 終了", status_text(game, session, note)),
                               file=board_file(game))
            self.sessions.pop(channel.id, None)
            return
        view = ControlPanel(self, session, body=status_text(game, session, note),
                            guess_select=GuessSelect(self, session))
        await game_panels.replace(channel, "party", view=view, file=board_file(game))


async def setup(bot):
    await bot.add_cog(Codenames(bot))
