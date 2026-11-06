# -*- coding: utf-8 -*-
"""じゃんけん: チャンネルのみんなで（または Bot と）遊ぶじゃんけん。

- スラッシュコマンドは増やさず、/game の「じゃんけん」から募集する（GameHub が start_recruit を呼ぶ）。
- 手はボタンで選び、返事は本人にだけ見える（ephemeral）。全員そろうか時間切れで一斉に公開する。
- 参加者が 1 人だけなら Bot が相手になる。
- 3 種類の手がそろう／全員同じ手のときは「あいこ」で、同じ人でもう一度。
  勝った手の人だけが残り、最後の 1 人が勝ち。時間内に出さなかった人は負け。
- 勝利数は core/game/party_ranking.py に記録する（人間 2 人以上の勝負のときだけ。Bot 戦は数えない）。
- 放置した人の手を代わりに出す共通の仕組み（Lunancy さん担当）ができたら ``auto_hand`` を差し替えて使える。
"""
import asyncio
import random
from core.emojis import CROCK

import discord
from cogs.wallet import INSUFFICIENT
from core.game import game_panels
from core.game import prison as prison_core
from core.messages import recruit_join_prompt
from discord.ext import commands

from core.game import party_ranking

GAME_ID = "janken"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
HAND_SECONDS = 20
MAX_PLAYERS = 10
MAX_ROUNDS = 20
BOT_ID = 0

HANDS = ("rock", "scissors", "paper")
HAND_LABELS = {"rock": "✊ グー", "scissors": "✌ チョキ", "paper": "✋ パー"}
BEATS = {"rock": "scissors", "scissors": "paper", "paper": "rock"}


def judge(choices: dict) -> list:
    """{user_id: 手} から勝った人のリストを返す。あいこなら空リスト。"""
    kinds = set(choices.values())
    if len(kinds) != 2:
        return []
    a, b = kinds
    win = a if BEATS[a] == b else b
    return [uid for uid, h in choices.items() if h == win]


def auto_hand(rng=random) -> str:
    """Bot（や将来の放置対策）が出す手。"""
    return rng.choice(HANDS)


class JankenGame:
    def __init__(self, channel_id: int, guild_id: int, host_id: int):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players: dict = {}     # user_id -> member（BOT_ID は Bot）
        self.alive: list = []
        self.choices: dict = {}     # この回の手
        self.phase = "recruit"      # recruit / choosing / done
        self.round = 0
        self.log: list = []         # 各回の結果テキスト
        self.wager = 0
        self.escrow = []

    @property
    def vs_bot(self) -> bool:
        return BOT_ID in self.players

    def name(self, uid) -> str:
        return "Bot" if uid == BOT_ID else self.players[uid].mention


class JoinView(discord.ui.View):
    def __init__(self, cog, game: JankenGame):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.cog, self.game = cog, game

    @discord.ui.button(label="参加", style=discord.ButtonStyle.success)
    async def join(self, interaction: discord.Interaction, button: discord.ui.Button):
        g = self.game
        if g.phase != "recruit":
            return await interaction.response.send_message("募集は終わりました。", ephemeral=True)
        if interaction.user.id in g.players:
            return await interaction.response.send_message("もう参加しています。", ephemeral=True)
        if len(g.players) >= MAX_PLAYERS:
            return await interaction.response.send_message(f"定員（{MAX_PLAYERS}人）に達しました。", ephemeral=True)
        # 賭け金ありの対局はマネー系操作 (E-7): 逮捕中の参加は拒否する。
        blocked = prison_core.block_message(str(interaction.user.id)) if g.wager else None
        if blocked:
            return await interaction.response.send_message(blocked, ephemeral=True)
        g.players[interaction.user.id] = interaction.user
        await interaction.response.send_message(f"参加しました（{len(g.players)}人）。")

    @discord.ui.button(label="抜ける", style=discord.ButtonStyle.secondary)
    async def leave(self, interaction: discord.Interaction, button: discord.ui.Button):
        g = self.game
        if g.phase != "recruit" or interaction.user.id not in g.players:
            return await interaction.response.send_message("抜けられる募集がありません。", ephemeral=True)
        if interaction.user.id == g.host_id:
            return await interaction.response.send_message("募集した人は抜けられません。", ephemeral=True)
        del g.players[interaction.user.id]
        await interaction.response.send_message("参加をやめました。")


class HandView(discord.ui.View):
    """手を選ぶボタン。押した手は本人にだけ見える。公開までは何度でも変えられる。"""
    def __init__(self, game: JankenGame):
        super().__init__(timeout=HAND_SECONDS + 30)
        self.game = game

    async def _choose(self, interaction, hand: str):
        g = self.game
        if g.phase != "choosing" or interaction.user.id not in g.alive:
            return await interaction.response.send_message("いまは手を出せません。", ephemeral=True)
        g.choices[interaction.user.id] = hand
        await interaction.response.send_message(f"{HAND_LABELS[hand]} を出しました（公開まで変えられます）。",
                                                ephemeral=True)

    @discord.ui.button(label="✊ グー", style=discord.ButtonStyle.primary)
    async def rock(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._choose(interaction, "rock")

    @discord.ui.button(label="✌ チョキ", style=discord.ButtonStyle.primary)
    async def scissors(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._choose(interaction, "scissors")

    @discord.ui.button(label="✋ パー", style=discord.ButtonStyle.primary)
    async def paper(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._choose(interaction, "paper")


class Janken(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> JankenGame

    async def start_recruit(self, interaction: discord.Interaction, wager: int = 0):
        channel = interaction.channel
        # 賭け金ありの募集開始はマネー系操作 (E-7): 逮捕中は拒否する。
        blocked = prison_core.block_message(str(interaction.user.id)) if wager else None
        if blocked:
            return await interaction.response.send_message(blocked, ephemeral=True)
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既にじゃんけんが進行中です。", color=COLOR),
                ephemeral=True)
        g = JankenGame(channel.id, interaction.guild_id, interaction.user.id)
        g.wager = max(0, min(int(wager), 500))
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description=f"じゃんけんの募集を開始しました（{RECRUIT_SECONDS}秒）。", color=COLOR))
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="じゃんけん 参加者募集",
                description=(f"{interaction.user.mention} さんが募集中です。\n"
                             f"{recruit_join_prompt(RECRUIT_SECONDS)}（最大{MAX_PLAYERS}人）。\n"
                             + (f"勝敗コイン: 1人 {g.wager} AGO（勝者へ配分）\n" if g.wager else "")
                             + "だれも来なければ Bot が相手をします。"),
                color=COLOR), view=JoinView(self, g))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)

    async def run_game(self, channel, g: JankenGame, rng=random):
        if len(g.players) < 2:
            g.players[BOT_ID] = None
        if g.wager and not await self._collect_wagers(g):
            await channel.send("コインを賭けたじゃんけんを開始できませんでした（残高不足または更新エラー）。賭けコインは全額返金しました。")
            return
        g.alive = list(g.players)
        names = "、".join(g.name(uid) for uid in g.alive)
        await channel.send(embed=discord.Embed(title="じゃんけん スタート！",
                                               description=f"参加者: {names}", color=COLOR))
        winners = []
        while len(g.alive) > 1 and g.round < MAX_ROUNDS:
            await self.play_round(channel, g, rng)
        if len(g.alive) == 1:
            winners = g.alive
        await self.finish(channel, g, winners)

    async def play_round(self, channel, g: JankenGame, rng=random):
        g.round += 1
        g.choices = {}
        if BOT_ID in g.alive:
            g.choices[BOT_ID] = auto_hand(rng)
        g.phase = "choosing"
        humans = [uid for uid in g.alive if uid != BOT_ID]
        await game_panels.replace(channel, "party", embed=discord.Embed(
            title=f"第{g.round}回 じゃん けん…",
            description=(f"{'、'.join(g.name(u) for u in g.alive)}\n"
                         f"{HAND_SECONDS}秒以内に下のボタンで手を選んでください（ほかの人には見えません）。"),
            color=COLOR), view=HandView(g))
        elapsed = 0
        while elapsed < HAND_SECONDS and any(u not in g.choices for u in humans):
            await asyncio.sleep(1)
            elapsed += 1
        g.phase = "reveal"
        missing = [u for u in g.alive if u not in g.choices]
        shown = "\n".join(f"{g.name(u)}: {HAND_LABELS[h]}" for u, h in g.choices.items()) or "（だれも出しませんでした）"
        if missing:
            shown += "\n" + "\n".join(f"{g.name(u)}: {CROCK} 時間切れ（負け）" for u in missing)
        if not g.choices:
            g.alive = []
            result = "全員時間切れのため終了です。"
        elif len(g.choices) == 1:
            g.alive = list(g.choices)
            result = f"{g.name(g.alive[0])} さんだけが手を出しました。"
        else:
            won = judge(g.choices)
            if won:
                g.alive = won
                result = f"勝ち: {'、'.join(g.name(u) for u in won)}"
            else:
                g.alive = list(g.choices)
                result = "あいこ！ もう一度。" if not missing else "あいこ！ 出した人でもう一度。"
        g.log.append(f"第{g.round}回: {result}")
        await channel.send(embed=discord.Embed(title="ぽん！", description=f"{shown}\n\n**{result}**", color=COLOR))

    async def _collect_wagers(self, g):
        wallet = self.bot.get_cog("WalletCog") if hasattr(self.bot, "get_cog") else None
        if wallet is None:
            return False
        # 二層防御 (E-7): 募集後に逮捕された参加者がいても、徴収前に
        # 全員分を再チェックする (誰からも引く前に止める)。
        for uid in g.players:
            if uid != BOT_ID and prison_core.block_message(str(uid)):
                return False
        debited = []
        for uid in g.players:
            if uid == BOT_ID:
                continue
            result = await wallet._change_balance(str(uid), -g.wager, require_funds=True)
            if result is INSUFFICIENT or result is None:
                for paid_uid in debited:
                    await wallet._change_balance(str(paid_uid), g.wager)
                return False
            debited.append(uid)
        g.escrow = debited
        return True

    async def _pay_winners(self, g, winners):
        if not g.escrow:
            return
        wallet = self.bot.get_cog("WalletCog") if hasattr(self.bot, "get_cog") else None
        if wallet is None:
            return
        prize = len(g.escrow) * g.wager
        recipients = [uid for uid in winners if uid in g.escrow]
        if not recipients:
            recipients = g.escrow
        each, remainder = divmod(prize, len(recipients))
        for index, uid in enumerate(recipients):
            await wallet._change_balance(str(uid), each + (1 if index < remainder else 0))
        g.escrow = []

    async def finish(self, channel, g: JankenGame, winners: list):
        g.phase = "done"
        await self._pay_winners(g, winners)
        humans = [u for u in g.players if u != BOT_ID]
        if len(humans) >= 2:
            for uid in winners:
                await party_ranking.shared().record_win(g.guild_id, uid, GAME_ID)
        if winners:
            text = f"🏆 勝者: {g.name(winners[0])}"
            if g.vs_bot:
                text += "（Bot 戦はランキングに数えません）"
        else:
            text = "勝者なし" if g.round < MAX_ROUNDS or not g.alive else f"{MAX_ROUNDS}回あいこが続いたので引き分けです。"
        embed = discord.Embed(title="じゃんけん 終了", description=text, color=COLOR)
        embed.add_field(name="経過", value="\n".join(g.log)[-1024:] or "（なし）", inline=False)
        if g.wager:
            embed.add_field(name="勝敗コイン", value=(f"各人 {g.wager} AGO を預かり、勝者へ配分しました。" if winners else "勝者がいないため、預かり分は参加者へ返金しました。"), inline=False)
        await channel.send(embed=embed)


async def setup(bot):
    await bot.add_cog(Janken(bot))
