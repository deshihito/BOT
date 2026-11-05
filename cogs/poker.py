"""/game に収録するシンプルな5枚ドローポーカー。賭け金なし。"""
import asyncio
import random
from collections import Counter

import discord
from discord.ext import commands
from core import game_panels

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
DRAW_SECONDS = 60
RANKS = "23456789TJQKA"
SUITS = "♠♥♦♣"


def deck():
    return [r + s for s in SUITS for r in RANKS]


def card_value(card):
    return RANKS.index(card[0]) + 2


def evaluate(hand):
    """Return comparable (category, kickers) and its Japanese category label."""
    vals = sorted((card_value(c) for c in hand), reverse=True)
    counts = Counter(vals)
    groups = sorted(((n, v) for v, n in counts.items()), reverse=True)
    flush = len({c[1] for c in hand}) == 1
    unique = sorted(set(vals))
    straight_high = unique[-1] if len(unique) == 5 and unique[-1] - unique[0] == 4 else (5 if unique == [2, 3, 4, 5, 14] else 0)
    if flush and straight_high:
        return (8, straight_high), "ストレートフラッシュ"
    if groups[0][0] == 4:
        return (7, groups[0][1], groups[1][1]), "フォーカード"
    if [x[0] for x in groups] == [3, 2]:
        return (6, groups[0][1], groups[1][1]), "フルハウス"
    if flush:
        return (5, *vals), "フラッシュ"
    if straight_high:
        return (4, straight_high), "ストレート"
    if groups[0][0] == 3:
        return (3, groups[0][1], *sorted((v for v in vals if v != groups[0][1]), reverse=True)), "スリーカード"
    if [x[0] for x in groups] == [2, 2, 1]:
        pairs = sorted((v for n, v in groups if n == 2), reverse=True)
        kicker = next(v for n, v in groups if n == 1)
        return (2, *pairs, kicker), "ツーペア"
    if groups[0][0] == 2:
        pair = groups[0][1]
        return (1, pair, *sorted((v for v in vals if v != pair), reverse=True)), "ワンペア"
    return (0, *vals), "ハイカード"


def label_card(card):
    return f"{card[0]}{card[1]}"


class PokerGame:
    def __init__(self, channel_id, host_id):
        self.channel_id, self.host_id = channel_id, host_id
        self.players = {}
        self.hands = {}
        self.deck = []
        self.submitted = set()
        self.phase = "recruit"


class JoinView(discord.ui.View):
    def __init__(self, game):
        super().__init__(timeout=RECRUIT_SECONDS + 30)
        self.game = game

    @discord.ui.button(label="参加", style=discord.ButtonStyle.success)
    async def join(self, interaction, button):
        g = self.game
        if g.phase != "recruit":
            return await interaction.response.send_message("募集は終了しました。", ephemeral=True)
        if interaction.user.id in g.players:
            return await interaction.response.send_message("すでに参加しています。", ephemeral=True)
        if len(g.players) >= 6:
            return await interaction.response.send_message("定員（6人）です。", ephemeral=True)
        g.players[interaction.user.id] = interaction.user
        await interaction.response.send_message("参加しました。", ephemeral=True)

    @discord.ui.button(label="抜ける", style=discord.ButtonStyle.secondary)
    async def leave(self, interaction, button):
        g = self.game
        if g.phase != "recruit" or interaction.user.id not in g.players:
            return await interaction.response.send_message("参加中の募集がありません。", ephemeral=True)
        if interaction.user.id == g.host_id:
            return await interaction.response.send_message("募集主は抜けられません。", ephemeral=True)
        del g.players[interaction.user.id]
        await interaction.response.send_message("参加を取り消しました。", ephemeral=True)


class DiscardSelect(discord.ui.Select):
    def __init__(self, cog, game, uid):
        self.cog, self.game, self.uid = cog, game, uid
        hand = game.hands[uid]
        options = [discord.SelectOption(label=f"{i+1}. {label_card(c)}", value=str(i)) for i, c in enumerate(hand)]
        super().__init__(placeholder="交換するカードを最大3枚選択（0枚も可）", min_values=0, max_values=3, options=options)

    async def callback(self, interaction):
        if interaction.user.id != self.uid or self.uid in self.game.submitted:
            return await interaction.response.send_message("この選択は利用できません。", ephemeral=True)
        hand = self.game.hands[self.uid]
        indices = {int(v) for v in self.values}
        discarded = [hand[i] for i in sorted(indices)]
        kept = [c for i, c in enumerate(hand) if i not in indices]
        replacements = [self.game.deck.pop() for _ in discarded]
        self.game.hands[self.uid] = kept + replacements
        self.game.submitted.add(self.uid)
        await interaction.response.send_message(f"{len(discarded)}枚を交換しました。交換後の手札: {' '.join(label_card(c) for c in self.game.hands[self.uid])}", ephemeral=True)


class PokerView(discord.ui.View):
    def __init__(self, game):
        super().__init__(timeout=DRAW_SECONDS)
        self.game = game

    @discord.ui.button(label="手札を確認して交換", style=discord.ButtonStyle.primary)
    async def exchange(self, interaction, button):
        g = self.game
        if g.phase != "draw" or interaction.user.id not in g.players:
            return await interaction.response.send_message("進行中の参加者だけが操作できます。", ephemeral=True)
        if interaction.user.id in g.submitted:
            return await interaction.response.send_message("すでに交換を確定しています。", ephemeral=True)
        hand = g.hands[interaction.user.id]
        view = discord.ui.View(timeout=DRAW_SECONDS)
        view.add_item(DiscardSelect(self, g, interaction.user.id))
        await interaction.response.send_message("あなたの手札（相手には見えません）。交換したいカードを選択してください。", ephemeral=True, view=view)


class Poker(commands.Cog):
    def __init__(self, bot):
        self.bot, self.games = bot, {}

    async def start_recruit(self, interaction):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message("このチャンネルでは既にゲーム中です。", ephemeral=True)
        g = PokerGame(channel.id, interaction.user.id)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message("ポーカーの募集を開始しました。")
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="ポーカー（5枚ドロー）参加者募集", description=f"{interaction.user.mention} さんが募集中です。\n{RECRUIT_SECONDS}秒以内に参加してください（2〜6人、賭け金なし）。", color=COLOR), view=JoinView(g))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)

    async def run_game(self, channel, g):
        if len(g.players) < 2:
            await channel.send("参加者が2人集まらなかったため、ポーカーを開始できませんでした。")
            return
        g.deck = deck()
        random.shuffle(g.deck)
        for uid in g.players:
            g.hands[uid] = [g.deck.pop() for _ in range(5)]
        g.phase = "draw"
        await game_panels.replace(channel, "party", embed=discord.Embed(
            title="ポーカー：カード交換", description=f"各自、{DRAW_SECONDS}秒以内に手札を確認し、交換するカードを最大3枚選んでください。\n交換しない場合もボタンから0枚を確定できます。", color=COLOR), view=PokerView(g))
        elapsed = 0
        while len(g.submitted) < len(g.players) and elapsed < DRAW_SECONDS and g.phase == "draw":
            await asyncio.sleep(1)
            elapsed += 1
        g.phase = "done"
        results = sorted(((evaluate(g.hands[uid])[0], uid, evaluate(g.hands[uid])[1]) for uid in g.players), reverse=True)
        best = results[0][0]
        winners = [uid for score, uid, _ in results if score == best]
        lines = []
        for score, uid, rank_name in results:
            lines.append(f"{g.players[uid].mention}: **{rank_name}** — {' '.join(label_card(c) for c in g.hands[uid])}")
        title = "引き分け" if len(winners) > 1 else f"勝者: {g.players[winners[0]].mention}"
        await channel.send(embed=discord.Embed(title=f"ポーカー 終了 — {title}", description="\n".join(lines), color=COLOR))


async def setup(bot):
    await bot.add_cog(Poker(bot))
