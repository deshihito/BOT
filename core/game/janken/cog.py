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
from core.support.emojis import CROCK

import discord
from cogs.wallet import INSUFFICIENT
from core.game import game_panels
from core.game import prison as prison_core
from core.game.game_v2 import GamePanelView, LobbyView, safe_delete, text_panel
from core.support.messages import recruit_join_prompt
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
        self.last_reveal = None     # 最新の「ぽん！」表示（次で消す）

    @property
    def vs_bot(self) -> bool:
        return BOT_ID in self.players

    def name(self, uid) -> str:
        return "Bot" if uid == BOT_ID else self.players[uid].mention


class JoinView(LobbyView):
    """じゃんけんのロビー（共通規格）。参加は game.players にも同期する。"""

    def __init__(self, cog, game: JankenGame):
        self.cog, self.game = cog, game
        host = game.players.get(game.host_id)
        super().__init__(
            title="じゃんけん 参加者募集", host=host,
            min_players=1, max_players=MAX_PLAYERS,
            note=(f"{host.mention if host else ''} さんが募集中です。\n"
                  f"{recruit_join_prompt(RECRUIT_SECONDS)}\n"
                  + (f"勝敗コイン: 1人 {game.wager} AGO（勝者へ配分）\n" if game.wager else "")
                  + "だれも来なければ Bot が相手をします。"),
            timeout=RECRUIT_SECONDS + 30, join_hook=_janken_join_hook(game))

    async def _on_join(self, interaction: discord.Interaction):
        await super()._on_join(interaction)
        if interaction.user.id in self.players:
            self.game.players[interaction.user.id] = interaction.user

    async def _on_leave(self, interaction: discord.Interaction):
        await super()._on_leave(interaction)
        if interaction.user.id not in self.players:
            self.game.players.pop(interaction.user.id, None)


def _janken_join_hook(game: JankenGame):
    """賭け金ありの対局はマネー系操作 (E-7): 逮捕中の参加を拒否する。"""
    def hook(user):
        if game.wager:
            return prison_core.block_message(str(user.id))
        return None
    return hook


class HandPanel(GamePanelView):
    """手を選ぶパネル（V2）。押した手は本人にだけ見える。公開までは何度でも変えられる。"""

    def __init__(self, game: JankenGame, title: str = "", body: str = ""):
        super().__init__(title, body, timeout=HAND_SECONDS + 30)
        self.game = game
        self.rock = discord.ui.Button(label="✊ グー", style=discord.ButtonStyle.primary)
        self.rock.callback = self._rock
        self.scissors = discord.ui.Button(label="✌ チョキ", style=discord.ButtonStyle.primary)
        self.scissors.callback = self._scissors
        self.paper = discord.ui.Button(label="✋ パー", style=discord.ButtonStyle.primary)
        self.paper.callback = self._paper
        self.add_row(self.rock, self.scissors, self.paper)

    async def _choose(self, interaction, hand: str):
        g = self.game
        if g.phase != "choosing" or interaction.user.id not in g.alive:
            return await interaction.response.send_message("いまは手を出せません。", ephemeral=True)
        g.choices[interaction.user.id] = hand
        await interaction.response.send_message(f"{HAND_LABELS[hand]} を出しました（公開まで変えられます）。",
                                                ephemeral=True)

    async def _rock(self, interaction: discord.Interaction):
        await self._choose(interaction, "rock")

    async def _scissors(self, interaction: discord.Interaction):
        await self._choose(interaction, "scissors")

    async def _paper(self, interaction: discord.Interaction):
        await self._choose(interaction, "paper")


HandView = HandPanel  # 互換名


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
            lobby = JoinView(self, g)
            await game_panels.replace(channel, "party", view=lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                if lobby.started or lobby.cancelled:
                    break
                await asyncio.sleep(0.5)
            lobby.stop()
            if lobby.cancelled:
                return
            g.players = dict(lobby.members)
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)

    async def run_game(self, channel, g: JankenGame, rng=random):
        if len(g.players) < 2:
            g.players[BOT_ID] = None
        if g.wager and not await self._collect_wagers(g):
            await game_panels.clear(channel, "party")
            await channel.send("コインを賭けたじゃんけんを開始できませんでした（残高不足または更新エラー）。賭けコインは全額返金しました。")
            return
        g.alive = list(g.players)
        names = "、".join(g.name(uid) for uid in g.alive)
        await channel.send(view=text_panel("じゃんけん スタート！", f"参加者: {names}"))
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
        await game_panels.replace(channel, "party", view=HandPanel(
            g,
            title=f"第{g.round}回 じゃん けん…",
            body=(f"{'、'.join(g.name(u) for u in g.alive)}\n"
                  f"{HAND_SECONDS}秒以内に下のボタンで手を選んでください（ほかの人には見えません）。")))
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
        # 公開表示は次の回（または終了表示）が出たら役割を終えるので、
        # 前回の分を消してから新しい分を出す（常に最新の1通だけ残る）。
        old_reveal = getattr(g, "last_reveal", None)
        if old_reveal is not None:
            await safe_delete(old_reveal)
        g.last_reveal = await channel.send(view=text_panel("ぽん！", f"{shown}\n\n**{result}**"))

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
        lines = [text, "", "経過:", "\n".join(g.log)[-1024:] or "（なし）"]
        if g.wager:
            lines += ["", "勝敗コイン: " + (f"各人 {g.wager} AGO を預かり、勝者へ配分しました。" if winners else "勝者がいないため、預かり分は参加者へ返金しました。")]
        # 手選択パネルと最後の公開表示を片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        old_reveal = getattr(g, "last_reveal", None)
        if old_reveal is not None:
            g.last_reveal = None
            await safe_delete(old_reveal)
        await channel.send(view=text_panel("じゃんけん 終了", "\n".join(lines)))


async def setup(bot):
    await bot.add_cog(Janken(bot))
