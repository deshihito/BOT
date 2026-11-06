# -*- coding: utf-8 -*-
"""ラブレター型カードゲーム「アゴ姫への手紙」（2〜4人）。

手札は公開パネルでは「手札1／手札2」とだけ示し、実際のカードは
本人の ephemeral ビューでだけ確認・プレイする（秘匿情報のため）。
進行は core/game/loveletter.py の状態機械に従い、手番は60秒で自動プレイ。
"""
import asyncio
import logging
import random

import discord
from discord.ext import commands

from core.game import party_ranking
from core.game import game_panels
from core.game.loveletter import CARD_INFO, NEEDS_TARGET, LoveLetterGame, card_name

logger = logging.getLogger(__name__)

GAME_ID = "loveletter"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 60
MAX_PLAYERS = 4


def public_state_text(game: LoveLetterGame, members: dict) -> str:
    lines = [f"ラウンド {game.round_no}／山札の残り: {len(game.deck)}枚"]
    if game.removed:
        lines.append("公開除外: " + "、".join(card_name(r) for r in game.removed))
    for pid in game.players:
        status = []
        if pid not in game.alive:
            status.append("脱落")
        if pid in game.protected:
            status.append("侍女の守り")
        discards = "、".join(card_name(r) for r in game.discards[pid]) or "なし"
        lines.append(f"{members[pid].mention}: 手紙 {game.tokens[pid]}通／捨て札: {discards}"
                     + (f"（{'・'.join(status)}）" if status else ""))
    return "\n".join(lines)


class PlayConfirmView(discord.ui.View):
    """本人だけの ephemeral ビュー: カードの確認と対象・推測の選択。"""

    def __init__(self, cog, session, rank: int):
        super().__init__(timeout=55)
        self.cog = cog
        self.session = session
        self.rank = rank
        self.turn_no = session["turn_no"]
        self.target = None
        self.guess = None
        game: LoveLetterGame = session["game"]
        targets = game.valid_targets(rank)
        if targets:
            options = [discord.SelectOption(
                label=session["members"][pid].display_name, value=str(pid),
                description="自分" if pid == game.current else None) for pid in targets]
            select = discord.ui.Select(placeholder="対象を選んでください", options=options, row=0)
            select.callback = self._target_callback
            self.add_item(select)
        if rank == 1:
            options = [discord.SelectOption(label=f"{r} {card_name(r)}", value=str(r))
                       for r in range(2, 9)]
            select = discord.ui.Select(placeholder="相手の手札を当てる（門番以外）", options=options, row=1)
            select.callback = self._guess_callback
            self.add_item(select)

    async def _target_callback(self, interaction: discord.Interaction):
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.row == 0 and item.values:
                self.target = int(item.values[0])
        await interaction.response.defer()

    async def _guess_callback(self, interaction: discord.Interaction):
        for item in self.children:
            if isinstance(item, discord.ui.Select) and item.row == 1 and item.values:
                self.guess = int(item.values[0])
        await interaction.response.defer()

    @discord.ui.button(label="このカードを出す", style=discord.ButtonStyle.success, row=2)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        session = self.session
        game: LoveLetterGame = session["game"]
        if session["turn_no"] != self.turn_no or game.current != interaction.user.id:
            return await interaction.response.edit_message(content="手番が進んでしまったため、この操作は無効です。", view=None)
        targets = game.valid_targets(self.rank)
        if targets and self.target is None:
            return await interaction.response.send_message("対象を選んでください。", ephemeral=True)
        if self.rank == 1 and targets and self.guess is None:
            return await interaction.response.send_message("当てるカードを選んでください。", ephemeral=True)
        session["pending_play"] = (self.rank, self.target, self.guess)
        session["acted"].set()
        await interaction.response.edit_message(content="カードを出しました。", view=None)
        self.stop()


class TurnView(discord.ui.View):
    def __init__(self, cog, session):
        super().__init__(timeout=TURN_SECONDS + 30)
        self.cog = cog
        self.session = session

    @discord.ui.button(label="手札を見る", style=discord.ButtonStyle.secondary)
    async def show_hand(self, interaction: discord.Interaction, button: discord.ui.Button):
        game: LoveLetterGame = self.session["game"]
        pid = interaction.user.id
        if pid not in game.players or pid not in game.alive:
            return await interaction.response.send_message("あなたはこの対局に参加していません。", ephemeral=True)
        cards = [game.hands[pid]]
        if game.current == pid and game.drawn is not None:
            cards.append(game.drawn)
        text = "あなたの手札: " + "／".join(f"{r} {card_name(r)}" for r in cards)
        if game.current == pid:
            legal = game.legal_cards()
            text += "\n出せるのは: " + "／".join(f"{r} {card_name(r)}" for r in legal)
        await interaction.response.send_message(text, ephemeral=True)

    @discord.ui.button(label="カードを出す（1枚目）", style=discord.ButtonStyle.primary)
    async def play_first(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._open_play(interaction, 0)

    @discord.ui.button(label="カードを出す（2枚目）", style=discord.ButtonStyle.primary)
    async def play_second(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._open_play(interaction, 1)

    @discord.ui.button(label="通知を見る", style=discord.ButtonStyle.secondary)
    async def inbox(self, interaction: discord.Interaction, button: discord.ui.Button):
        notes = self.session["inbox"].pop(interaction.user.id, [])
        text = "\n".join(notes) if notes else "新しい通知はありません。"
        await interaction.response.send_message(text, ephemeral=True)

    async def _open_play(self, interaction: discord.Interaction, index: int):
        game: LoveLetterGame = self.session["game"]
        if game.current != interaction.user.id:
            return await interaction.response.send_message("今はあなたの番ではありません。", ephemeral=True)
        cards = game.current_cards()
        if index >= len(cards):
            return await interaction.response.send_message("そのカードはありません。", ephemeral=True)
        rank = cards[index]
        if rank not in game.legal_cards():
            return await interaction.response.send_message(
                "女伯爵を持っている間は、道化か王子があるとき女伯爵を出さなければなりません。", ephemeral=True)
        name, _, desc = CARD_INFO[rank]
        await interaction.response.send_message(
            f"**{rank} {name}**: {desc}\n対象などを選んで「このカードを出す」を押してください。",
            view=PlayConfirmView(self.cog, self.session, rank), ephemeral=True)


class JoinView(discord.ui.View):
    def __init__(self, session):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.session = session

    @discord.ui.button(label="参加", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        members = self.session["members"]
        if interaction.user.id in members:
            return await interaction.response.send_message("すでに参加しています。", ephemeral=True)
        if len(members) >= MAX_PLAYERS:
            return await interaction.response.send_message("定員です。", ephemeral=True)
        members[interaction.user.id] = interaction.user
        await interaction.response.send_message("参加しました。")


class LoveLetter(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.sessions = {}

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.sessions:
            return await interaction.response.send_message("このチャンネルでは既に進行中です。", ephemeral=True)
        session = {"members": {interaction.user.id: interaction.user},
                   "channel": channel, "guild_id": interaction.guild_id,
                   "game": None, "inbox": {}, "turn_no": 0,
                   "acted": asyncio.Event(), "pending_play": None}
        self.sessions[channel.id] = session
        await interaction.response.send_message("アゴ姫への手紙の募集を開始しました。")
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="💌 アゴ姫への手紙 参加者募集",
                description=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2〜{MAX_PLAYERS}人）。",
                color=COLOR), view=JoinView(session))
            await asyncio.sleep(RECRUIT_SECONDS)
            if len(session["members"]) < 2:
                await channel.send("参加者が2人集まらなかったため、開始できませんでした。")
                return
            game = LoveLetterGame(list(session["members"].keys()), rng=random.Random())
            session["game"] = game
            await self._run_match(session)
        finally:
            self.sessions.pop(channel.id, None)

    async def _run_match(self, session):
        channel = session["channel"]
        game: LoveLetterGame = session["game"]
        members = session["members"]
        while game.game_winner is None:
            await channel.send(embed=discord.Embed(
                title=f"💌 ラウンド {game.round_no} 開始",
                description=public_state_text(game, members), color=COLOR))
            while not game.round_over:
                await self._run_turn(session)
            winners = "、".join(members[pid].mention for pid in game.round_winners)
            await channel.send(embed=discord.Embed(
                title=f"💌 ラウンド {game.round_no} 終了",
                description=f"このラウンドの勝者: {winners}（手紙+1）\n" + public_state_text(game, members),
                color=COLOR))
            if game.game_winner is None:
                game.start_round()
                await asyncio.sleep(3)
        winner = members[game.game_winner]
        await party_ranking.shared().record_win(session["guild_id"], game.game_winner, GAME_ID)
        await channel.send(embed=discord.Embed(
            title="💌 アゴ姫への手紙 終了",
            description=f"🏆 勝者: {winner.mention}\n" + public_state_text(game, members), color=COLOR))

    async def _run_turn(self, session):
        channel = session["channel"]
        game: LoveLetterGame = session["game"]
        members = session["members"]
        actor = game.begin_turn()
        session["turn_no"] += 1
        session["acted"].clear()
        session["pending_play"] = None
        embed = discord.Embed(
            title="💌 アゴ姫への手紙",
            description=public_state_text(game, members) +
                        f"\n\n{members[actor].mention} さんの番です。「手札を見る」で確認し、「カードを出す」からプレイしてください。",
            color=COLOR)
        await game_panels.replace(channel, "party", embed=embed, view=TurnView(self, session))
        try:
            await asyncio.wait_for(session["acted"].wait(), timeout=TURN_SECONDS)
            rank, target, guess = session["pending_play"]
        except asyncio.TimeoutError:
            rank, target, guess = self._auto_play(game)
            await channel.send(f"{members[actor].mention} さんは時間切れのため、自動でプレイしました。")
        event = game.play(rank, target=target, guess=guess)
        await self._announce(session, event)

    def _auto_play(self, game: LoveLetterGame):
        legal = game.legal_cards()
        rank = next((r for r in legal if r not in NEEDS_TARGET), legal[0])
        targets = game.valid_targets(rank)
        target = targets[0] if targets else None
        guess = random.choice([r for r in range(2, 9)]) if rank == 1 else None
        return rank, target, guess

    async def _announce(self, session, event):
        channel = session["channel"]
        members = session["members"]
        actor = members[event["actor"]]
        rank = event["rank"]
        parts = [f"{actor.mention} さんが **{rank} {card_name(rank)}** を出しました。"]
        target = event.get("target")
        if event.get("note") == "no_target":
            parts.append("全員が侍女に守られていて、効果はありませんでした。")
        if target is not None:
            tname = members[target].mention
            if rank == 1:
                parts.append(f"{tname} の手札は **{event['guessed']} {card_name(event['guessed'])}** だと予想。")
                if target in event["eliminated"]:
                    parts.append("的中！")
                else:
                    parts.append("外れでした。")
            elif rank == 2:
                session["inbox"].setdefault(event["actor"], []).append(
                    f"密偵: {members[target].display_name} の手札は {event['peek'][event['actor']]} {card_name(event['peek'][event['actor']])} です。")
                parts.append(f"{tname} の手札をのぞき見しました（結果は本人の「通知」に届いています）。")
            elif rank == 3:
                for pid, seen in event["peek"].items():
                    other = target if pid == event["actor"] else event["actor"]
                    session["inbox"].setdefault(pid, []).append(
                        f"騎士: {members[other].display_name} の手札は {seen} {card_name(seen)} でした。")
                parts.append(f"{tname} と手札を見せ合いました（結果は2人の「通知」に届いています）。")
            elif rank == 5:
                parts.append(f"{tname} は手札（{event['dropped']} {card_name(event['dropped'])}）を捨て、1枚引き直しました。")
            elif rank == 6:
                parts.append(f"{tname} と手札を交換しました。")
        if rank == 4:
            parts.append(f"{actor.mention} は侍女の守りに入りました。")
        for pid in event["eliminated"]:
            parts.append(f"💀 {members[pid].mention} さんが脱落しました。")
        await channel.send(" ".join(parts))


async def setup(bot):
    await bot.add_cog(LoveLetter(bot))
