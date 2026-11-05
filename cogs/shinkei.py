# -*- coding: utf-8 -*-
"""神経衰弱: 裏向きのカード（ボタン）を 2 枚ずつめくって、同じ絵のペアを集めるゲーム。

- スラッシュコマンドは増やさず、/game の「神経衰弱」から募集する（GameHub が start_recruit を呼ぶ）。
- カードは 24 枚（12 ペア）。Discord の 1 メッセージのボタン上限 25 個に収まるよう 5・5・5・5・4 で並べる。
- 1〜6 人。参加順に手番。そろえば得点してもう一度、外れたら少し見せてから裏に戻して次の人へ。
- 手番の時間切れでは core/autoplay.take_idle_turn で代わりにめくる（サーバー設定でオフなら手番を飛ばす）。
- 全部そろったら、ペアの数が一番多い人の勝ち（同点は全員勝ち）。
  勝利数は core/party_ranking.py に記録する（2 人以上の勝負のときだけ。ひとり遊びは数えない）。
"""
import asyncio
import random

import discord
from core import game_panels
from core.emojis import CROCK
from core.messages import recruit_join_prompt
from discord.ext import commands

from core import autoplay, party_ranking

GAME_ID = "shinkei"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 30
REVEAL_SECONDS = 2
MIN_PLAYERS = 1
MAX_PLAYERS = 6
PAIRS = 12
ROW_SIZES = (5, 5, 5, 5, 4)       # 合計 24 枚（ボタン 25 個まで）
SYMBOLS = tuple("ABCDEFGHIJKL")   # カードの面（絵文字は使わない）
BACK = "?"


def deal(rng=random) -> list:
    cards = [s for s in SYMBOLS[:PAIRS] for _ in range(2)]
    rng.shuffle(cards)
    return cards


def row_of(index: int) -> int:
    total = 0
    for row, size in enumerate(ROW_SIZES):
        total += size
        if index < total:
            return row
    raise IndexError(index)


class ShinkeiGame:
    def __init__(self, channel_id, guild_id, host_id, cards=None):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players: dict = {}            # user_id -> member（参加順＝手番の順）
        self.cards = cards or deal()
        self.matched: dict = {}            # カード番号 -> そろえた user_id
        self.face_up: list = []            # この手番でめくったカード（0〜2 枚）
        self.scores: dict = {}
        self.turn_index = 0
        self.phase = "recruit"             # recruit / playing / done
        self.turn_done = False             # この手番が終わった（外れ・時間切れ）
        self.message = None

    @property
    def order(self) -> list:
        return list(self.players)

    @property
    def current(self):
        return self.order[self.turn_index % len(self.order)] if self.players else None

    @property
    def finished(self) -> bool:
        return len(self.matched) == len(self.cards)

    def hidden(self) -> list:
        """いまめくれるカードの番号。"""
        return [i for i in range(len(self.cards)) if i not in self.matched and i not in self.face_up]

    def flip(self, uid, index: int) -> str:
        """カードをめくる。結果: "first" / "match" / "miss" / "invalid"。"""
        if self.phase != "playing" or uid != self.current or len(self.face_up) >= 2 or index not in self.hidden():
            return "invalid"
        self.face_up.append(index)
        if len(self.face_up) == 1:
            return "first"
        a, b = self.face_up
        if self.cards[a] == self.cards[b]:
            self.matched[a] = self.matched[b] = uid
            self.scores[uid] = self.scores.get(uid, 0) + 1
            self.face_up = []
            return "match"
        return "miss"

    def next_turn(self):
        self.face_up = []
        self.turn_index = (self.turn_index + 1) % len(self.order)

    def winners(self) -> list:
        if not self.scores:
            return []
        best = max(self.scores.values())
        return [uid for uid in self.order if self.scores.get(uid, 0) == best]

    def score_text(self) -> str:
        return "\n".join(f"{'> ' if uid == self.current and self.phase == 'playing' else ''}"
                         f"{m.mention}: {self.scores.get(uid, 0)}ペア" for uid, m in self.players.items())


class CardButton(discord.ui.Button):
    def __init__(self, cog, game: ShinkeiGame, index: int):
        if index in game.matched:
            label, style, disabled = game.cards[index], discord.ButtonStyle.success, True
        elif index in game.face_up:
            label, style, disabled = game.cards[index], discord.ButtonStyle.primary, True
        else:
            label, style, disabled = BACK, discord.ButtonStyle.secondary, game.phase != "playing"
        super().__init__(label=label, style=style, disabled=disabled, row=row_of(index),
                         custom_id=f"shinkei:{game.channel_id}:{index}")
        self.cog, self.game, self.index = cog, game, index

    async def callback(self, interaction: discord.Interaction):
        await self.cog.on_flip(interaction, self.game, self.index)


class BoardView(discord.ui.View):
    def __init__(self, cog, game: ShinkeiGame):
        super().__init__(timeout=None)
        for i in range(len(game.cards)):
            self.add_item(CardButton(cog, game, i))


class JoinView(discord.ui.View):
    def __init__(self, cog, game: ShinkeiGame):
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
        g.players[interaction.user.id] = interaction.user
        await interaction.response.send_message(f"参加しました（{len(g.players)}人）。", ephemeral=True)

    @discord.ui.button(label="抜ける", style=discord.ButtonStyle.secondary)
    async def leave(self, interaction: discord.Interaction, button: discord.ui.Button):
        g = self.game
        if g.phase != "recruit" or interaction.user.id not in g.players:
            return await interaction.response.send_message("抜けられる募集がありません。", ephemeral=True)
        if interaction.user.id == g.host_id:
            return await interaction.response.send_message("募集した人は抜けられません。", ephemeral=True)
        del g.players[interaction.user.id]
        await interaction.response.send_message("参加をやめました。", ephemeral=True)


class Shinkei(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> ShinkeiGame

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既に神経衰弱が進行中です。", color=COLOR),
                ephemeral=True)
        g = ShinkeiGame(channel.id, interaction.guild_id, interaction.user.id)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description=f"神経衰弱の募集を開始しました（{RECRUIT_SECONDS}秒）。", color=COLOR))
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="神経衰弱 参加者募集",
                description=(f"{interaction.user.mention} さんが募集中です。\n"
                             f"{recruit_join_prompt(RECRUIT_SECONDS)}（{MIN_PLAYERS}〜{MAX_PLAYERS}人。"
                             "ひとりでも遊べます）。"),
                color=COLOR), view=JoinView(self, g))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)

    def board_embed(self, g: ShinkeiGame, note: str = "") -> discord.Embed:
        if g.phase == "playing":
            head = f"{g.players[g.current].mention} さんの番です（{TURN_SECONDS}秒）。? のカードを2枚めくってください。"
        else:
            head = "ゲーム終了"
        embed = discord.Embed(title="神経衰弱", description=f"{head}\n{note}".strip(), color=COLOR)
        embed.add_field(name=f"ペア（残り {PAIRS - len(g.matched) // 2}）", value=g.score_text()[:1024], inline=False)
        return embed

    async def refresh(self, g: ShinkeiGame, note: str = ""):
        if g.message is not None:
            await g.message.edit(embed=self.board_embed(g, note), view=BoardView(self, g))

    async def run_game(self, channel, g: ShinkeiGame):
        g.phase = "playing"
        order = " → ".join(m.display_name for m in g.players.values())
        g.message = await game_panels.replace(channel, "party", embed=self.board_embed(g, f"順番: {order}"), view=BoardView(self, g))
        idle_streak = 0
        while not g.finished:
            result = await self.play_turn(channel, g)
            if result == "timeout":
                idle_streak += 1
                if idle_streak >= 2 * len(g.players):
                    await channel.send(embed=discord.Embed(
                        description="だれもめくらない状態が続いたので終了します。", color=COLOR))
                    break
            else:
                idle_streak = 0
        await self.finish(channel, g)

    async def play_turn(self, channel, g: ShinkeiGame) -> str:
        """1 人の手番。そろえ続けるあいだは同じ人。戻り値: "miss" / "done" / "timeout" / "auto"。"""
        g.turn_done = False
        uid = g.current
        elapsed = 0
        while not g.turn_done and not g.finished and elapsed < TURN_SECONDS:
            await asyncio.sleep(1)
            elapsed += 1
            if g.current != uid:   # 念のため
                return "miss"
        if g.finished:
            return "done"
        if g.turn_done:      # 外れ: 少し見せてから戻す
            await asyncio.sleep(REVEAL_SECONDS)
            g.next_turn()
            await self.refresh(g)
            return "miss"
        return await self.idle_turn(channel, g, uid)

    async def idle_turn(self, channel, g: ShinkeiGame, uid) -> str:
        """時間切れ。代打ちでめくり、オフなら手番を飛ばす。"""
        member = g.players[uid]
        while not g.finished and g.current == uid:
            legal = [str(i + 1) for i in g.hidden()]
            result = await autoplay.take_idle_turn(
                None, guild_id=g.guild_id, player_name=member.display_name,
                state={"game": "神経衰弱", "cards": len(g.cards),
                       "face_up": {str(i + 1): g.cards[i] for i in g.face_up},
                       "matched": sorted(i + 1 for i in g.matched)},
                legal_actions=legal,
                instructions="神経衰弱で、めくるカードの番号を 1 つ選んでください",
                describe=lambda a: f"{a}番のカードをめく")
            if result is None or result.action is None:
                g.next_turn()
                await channel.send(embed=discord.Embed(
                    description=f"{member.mention} さんは時間切れのため、手番を飛ばします。", color=COLOR))
                await self.refresh(g)
                return "timeout"
            await channel.send(embed=discord.Embed(
                description=result.notice.lstrip(CROCK).strip(), color=COLOR))   # 絵文字を外して自分で送る
            outcome = g.flip(uid, int(result.action) - 1)
            await self.refresh(g)
            if outcome == "miss":
                await asyncio.sleep(REVEAL_SECONDS)
                g.next_turn()
                await self.refresh(g)
                return "timeout"
            if outcome == "invalid":   # 起きないはずだが、止まらないように
                g.next_turn()
                return "timeout"
        return "timeout"

    async def on_flip(self, interaction: discord.Interaction, g: ShinkeiGame, index: int):
        if g.phase != "playing":
            return await interaction.response.send_message("このゲームは終わりました。", ephemeral=True)
        if interaction.user.id != g.current:
            return await interaction.response.send_message("あなたの番ではありません。", ephemeral=True)
        if g.turn_done or len(g.face_up) >= 2:
            return await interaction.response.send_message("カードを戻しています。少し待ってください。", ephemeral=True)
        outcome = g.flip(interaction.user.id, index)
        if outcome == "invalid":
            return await interaction.response.send_message("そのカードはめくれません。", ephemeral=True)
        note = {"first": "", "match": "そろいました！ もう一度めくれます。",
                "miss": "残念、そろいませんでした。"}[outcome]
        if outcome == "miss":
            g.turn_done = True
        if g.finished:
            g.turn_done = True
        await interaction.response.edit_message(embed=self.board_embed(g, note), view=BoardView(self, g))

    async def finish(self, channel, g: ShinkeiGame):
        g.phase = "done"
        g.face_up = []
        winners = g.winners() if g.finished else []
        if len(g.players) >= 2:
            for uid in winners:
                await party_ranking.shared().record_win(g.guild_id, uid, GAME_ID)
        await self.refresh(g)
        if winners:
            text = "勝者: " + "、".join(g.players[u].mention for u in winners)
            if len(g.players) < 2:
                text = "全部そろいました！（ひとり遊びはランキングに数えません）"
        else:
            text = "勝者なし"
        embed = discord.Embed(title="神経衰弱 終了", description=text, color=COLOR)
        embed.add_field(name="結果", value=g.score_text()[:1024] or "（なし）", inline=False)
        await channel.send(embed=embed)


async def setup(bot):
    await bot.add_cog(Shinkei(bot))
