# -*- coding: utf-8 -*-
"""ババ抜き: 同じ数字のペアを捨てていき、最後にジョーカーを持っていた人が負け。

- スラッシュコマンドは増やさず、/game の「ババ抜き」から募集する（GameHub が start_recruit を呼ぶ）。
- 2〜6 人。1 人だけなら Bot が相手をする。絵文字は使わず、カードは "S5"・"HK"・"JOKER" のような文字で表す
  （S=スペード H=ハート D=ダイヤ C=クラブ）。
- 配ったらペアを自動で捨てる。手番の人は、次の人（手札が残っている人）の手札から位置のボタンで 1 枚引く。
  引く前に相手の手札は混ぜるので、ボタンは位置だけで中身は分からない。そろったら自動で捨てる。
- 自分の手札は「手札を見る」で本人にだけ表示する。手札と、引く相手の手札
  （裏面の並びだけ）は共通基盤（core/game/board_image.py）のカード画像でも表示する。
- 手番は 30 秒。時間切れは core/autoplay.take_idle_turn で代わりに引く（代打ちがオフでもゲームが止まらないよう
  ランダムに引く）。
- 最初に手札がなくなった人の勝ち。勝利数は core/game/party_ranking.py に記録する（人間 2 人以上のときだけ）。
"""
import asyncio
import io
import logging
import random

import discord
from core.game import board_image, game_panels, game_restore
from core.game.board_image import render_cached, render_card_hand
from core.support.emojis import CROCK
from core.support.messages import recruit_join_prompt
from discord.ext import commands

from core.game import autoplay, party_ranking

logger = logging.getLogger(__name__)

GAME_ID = "babanuki"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 30
BOT_SECONDS = 1
MIN_PLAYERS = 2
MAX_PLAYERS = 6
BOT_ID = 0
JOKER = "JOKER"
SUITS = "SHDC"
RANKS = ("A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K")


def make_deck() -> list:
    return [s + r for s in SUITS for r in RANKS] + [JOKER]


def rank(card: str) -> str:
    return JOKER if card == JOKER else card[1:]


# --- カード画像（共通トランプ基盤） -------------------------------------------
def card_spec_of(card: str):
    """内部表記（"S5" / "HK" / "JOKER"）を描画基盤の正規形に変換する。"""
    if card == JOKER:
        return board_image.CARD_JOKER
    return board_image.card_spec(card[1:], card[0])


def hand_file(cards, filename="babanuki_hand.png"):
    specs = tuple(card_spec_of(c) for c in cards)
    data = render_cached(("babanuki-hand", specs),
                         lambda: render_card_hand(list(specs), title="あなたの手札"))
    return discord.File(io.BytesIO(data), filename=filename)


def backs_file(count: int, filename="babanuki_backs.png"):
    """引く相手の手札を裏面の並びで描く。受けるのは枚数だけで中身は渡らない。"""
    data = render_cached(("babanuki-backs", count),
                         lambda: render_card_hand([None] * count, title="相手の手札"))
    return discord.File(io.BytesIO(data), filename=filename)


def discard_pairs(hand: list) -> tuple:
    """(残りの手札, 捨てたペアのリスト)。同じ数字は 2 枚ずつ捨てる。"""
    by_rank = {}
    for c in hand:
        by_rank.setdefault(rank(c), []).append(c)
    rest, pairs = [], []
    for c in hand:
        group = by_rank[rank(c)]
        if c not in group:
            continue
        if rank(c) != JOKER and len(group) >= 2:
            a, b = group.pop(0), group.pop(0)
            pairs.append((a, b))
        else:
            group.remove(c)
            rest.append(c)
    return rest, pairs


def deal(player_ids: list, rng=random) -> dict:
    deck = make_deck()
    rng.shuffle(deck)
    hands = {uid: [] for uid in player_ids}
    for i, card in enumerate(deck):
        hands[player_ids[i % len(player_ids)]].append(card)
    return hands


class BabanukiGame:
    def __init__(self, channel_id, guild_id, host_id):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players: dict = {}      # user_id -> member（参加順＝手番の順。BOT_ID は Bot）
        self.hands: dict = {}
        self.finished: list = []     # 手札がなくなった順
        self.loser = None
        self.phase = "recruit"       # recruit / playing / done
        self.turn_index = 0
        self.drawn = None            # この手番で引いたカード（受付後）

    def name(self, uid) -> str:
        return "Bot" if uid == BOT_ID else self.players[uid].mention

    @property
    def active(self) -> list:
        return [uid for uid in self.players if self.hands.get(uid)]

    @property
    def current(self):
        order = list(self.players)
        for k in range(len(order)):
            uid = order[(self.turn_index + k) % len(order)]
            if self.hands.get(uid):
                return uid
        return None

    def target_of(self, uid):
        """uid が引く相手（次の、手札が残っている人）。"""
        order = list(self.players)
        i = order.index(uid)
        for k in range(1, len(order)):
            other = order[(i + k) % len(order)]
            if self.hands.get(other):
                return other
        return None

    def start(self, rng=random):
        self.hands = deal(list(self.players), rng)
        for uid in self.hands:
            self.hands[uid], _ = discard_pairs(self.hands[uid])
        self.phase = "playing"
        self._check_done()

    def draw(self, uid, position: int, rng=random):
        """uid が相手の手札の position 番目（0 始まり）を引く。(引いたカード, 捨てたペア) を返す。"""
        target = self.target_of(uid)
        card = self.hands[target].pop(position)
        self.hands[uid].append(card)
        self.hands[uid], pairs = discard_pairs(self.hands[uid])
        for p in (target, uid):
            if not self.hands[p] and p not in self.finished:
                self.finished.append(p)
        order = list(self.players)
        self.turn_index = (order.index(uid) + 1) % len(order)
        self._check_done()
        rng.shuffle(self.hands[uid])
        return card, pairs

    def _check_done(self):
        for uid in self.players:
            if not self.hands.get(uid) and uid not in self.finished:
                self.finished.append(uid)
        if len(self.active) <= 1:
            self.loser = self.active[0] if self.active else None
            self.phase = "done"


class JoinView(discord.ui.View):
    def __init__(self, cog, game: BabanukiGame):
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


class PickButton(discord.ui.Button):
    def __init__(self, cog, game, position: int):
        super().__init__(label=str(position + 1), style=discord.ButtonStyle.primary, row=position // 5)
        self.cog, self.game, self.position = cog, game, position

    async def callback(self, interaction: discord.Interaction):
        await self.cog.on_pick(interaction, self.game, self.position)


class HandButton(discord.ui.Button):
    def __init__(self, cog, game, row: int):
        super().__init__(label="手札を見る", style=discord.ButtonStyle.secondary, row=row)
        self.cog, self.game = cog, game

    async def callback(self, interaction: discord.Interaction):
        await self.cog.show_hand(interaction, self.game)


class TurnView(discord.ui.View):
    """相手の手札の位置ボタン（最大 14 枚）と「手札を見る」。"""
    def __init__(self, cog, game: BabanukiGame, count: int):
        super().__init__(timeout=TURN_SECONDS + 30)
        for i in range(count):
            self.add_item(PickButton(cog, game, i))
        self.add_item(HandButton(cog, game, row=min(4, (count + 4) // 5)))


class Babanuki(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> BabanukiGame

    async def start_recruit(self, interaction: discord.Interaction):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既にババ抜きが進行中です。", color=COLOR),
                ephemeral=True)
        g = BabanukiGame(channel.id, interaction.guild_id, interaction.user.id)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description=f"ババ抜きの募集を開始しました（{RECRUIT_SECONDS}秒）。", color=COLOR))
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="ババ抜き 参加者募集",
                description=(f"{interaction.user.mention} さんが募集中です。\n"
                             f"{recruit_join_prompt(RECRUIT_SECONDS)}（{MIN_PLAYERS}〜{MAX_PLAYERS}人）。\n"
                             "だれも来なければ Bot が相手をします。"),
                color=COLOR), view=JoinView(self, g))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)
            self._clear_snapshot(channel.id)

    def counts_text(self, g: BabanukiGame) -> str:
        return "\n".join(f"{g.name(uid)}: {len(g.hands.get(uid, []))}枚"
                         + ("（上がり）" if uid in g.finished else "") for uid in g.players)

    async def run_game(self, channel, g: BabanukiGame, rng=random):
        if len(g.players) < MIN_PLAYERS:
            g.players[BOT_ID] = None
        g.start(rng)
        await channel.send(embed=discord.Embed(
            title="ババ抜き スタート！",
            description=("カードを配り、そろっているペアを捨てました。\n"
                         "自分の手札は「手札を見る」で確認できます（本人にだけ見えます）。\n\n"
                         + self.counts_text(g)),
            color=COLOR))
        await self._play_loop(channel, g, rng)
        await self.finish(channel, g)

    async def _play_loop(self, channel, g: BabanukiGame, rng=random):
        while g.phase == "playing":
            await self.play_turn(channel, g, rng)

    async def play_turn(self, channel, g: BabanukiGame, rng=random):
        # 手番開始時点をチェックポイントとして保存する（復旧はここから再開する）
        self._save_snapshot(g)
        uid = g.current
        target = g.target_of(uid)
        rng.shuffle(g.hands[target])
        g.drawn = None
        count = len(g.hands[target])
        embed = discord.Embed(
            description=(f"{g.name(uid)} さんの番です。{g.name(target)} さんの手札（{count}枚）から"
                         f"1枚選んでください（{TURN_SECONDS}秒）。\n\n{self.counts_text(g)}"),
            color=COLOR)
        embed.set_image(url="attachment://babanuki_backs.png")
        await game_panels.replace(channel, "party", embed=embed,
                                  view=TurnView(self, g, count), file=backs_file(count))
        if uid == BOT_ID:
            await asyncio.sleep(BOT_SECONDS)
            return await self.apply_draw(channel, g, uid, rng.randrange(count), rng)
        elapsed = 0
        while g.drawn is None and elapsed < TURN_SECONDS:
            await asyncio.sleep(1)
            elapsed += 1
        if g.drawn is None:
            await self.idle_turn(channel, g, uid, count, rng)

    async def idle_turn(self, channel, g: BabanukiGame, uid, count: int, rng=random):
        member = g.players[uid]
        legal = [str(i + 1) for i in range(count)]
        result = await autoplay.take_idle_turn(
            None, guild_id=g.guild_id, player_name=member.display_name,
            state={"game": "ババ抜き", "my_hand": list(g.hands[uid]), "target_cards": count},
            legal_actions=legal,
            instructions="ババ抜きで、相手の手札から引く位置の番号を 1 つ選んでください",
            describe=lambda a: f"{a}番目のカードを引きま")
        if result is not None and result.action is not None:
            position = int(result.action) - 1
            notice = result.notice.lstrip(CROCK).strip()      # 絵文字を外して自分で送る
        else:
            position = rng.randrange(count)
            notice = f"{member.display_name}さんが時間切れのため、ランダムに{position + 1}番目のカードを引きました"
        await channel.send(embed=discord.Embed(description=notice, color=COLOR))
        await self.apply_draw(channel, g, uid, position, rng)

    async def apply_draw(self, channel, g: BabanukiGame, uid, position: int, rng=random):
        target = g.target_of(uid)
        card, pairs = g.draw(uid, position, rng)
        g.drawn = card
        lines = [f"{g.name(uid)} さんが {g.name(target)} さんから1枚引きました。"]
        if pairs:
            lines.append("ペアがそろって捨てました: " + "、".join(f"{a} {b}" for a, b in pairs))
        for p in (target, uid):
            if p in g.finished and not g.hands.get(p):
                lines.append(f"{g.name(p)} さんが上がりました（{g.finished.index(p) + 1}番目）。")
        await channel.send(embed=discord.Embed(description="\n".join(lines), color=COLOR))

    async def on_pick(self, interaction: discord.Interaction, g: BabanukiGame, position: int):
        if g.phase != "playing":
            return await interaction.response.send_message("このゲームは終わりました。", ephemeral=True)
        if interaction.user.id != g.current or g.drawn is not None:
            return await interaction.response.send_message("あなたの番ではありません。", ephemeral=True)
        target = g.target_of(interaction.user.id)
        if not 0 <= position < len(g.hands[target]):
            return await interaction.response.send_message("そのカードは引けません。", ephemeral=True)
        await self.apply_draw(interaction.channel, g, interaction.user.id, position)
        hand_cards = list(g.hands[interaction.user.id])
        hand = " ".join(hand_cards) or "なし"
        if hand_cards:
            await interaction.response.send_message(
                f"{g.drawn} を引きました。手札: {hand}", ephemeral=True,
                file=hand_file(hand_cards))
        else:
            await interaction.response.send_message(f"{g.drawn} を引きました。手札: {hand}", ephemeral=True)

    async def show_hand(self, interaction: discord.Interaction, g: BabanukiGame):
        uid = interaction.user.id
        if uid not in g.players:
            return await interaction.response.send_message("このゲームに参加していません。", ephemeral=True)
        hand_cards = sorted(g.hands.get(uid, []), key=lambda c: (rank(c) == JOKER, rank(c), c))
        hand = " ".join(hand_cards) or "なし（上がり）"
        if not hand_cards:
            return await interaction.response.send_message(f"あなたの手札: {hand}", ephemeral=True)
        await interaction.response.send_message(f"あなたの手札: {hand}", ephemeral=True,
                                                file=hand_file(hand_cards))

    async def finish(self, channel, g: BabanukiGame):
        g.phase = "done"
        humans = [u for u in g.players if u != BOT_ID]
        winner = g.finished[0] if g.finished else None
        if len(humans) >= 2 and winner is not None and winner != BOT_ID:
            await party_ranking.shared().record_win(g.guild_id, winner, GAME_ID)
        order = "\n".join(f"{i}. {g.name(u)}" for i, u in enumerate(g.finished, 1)) or "（なし）"
        text = f"勝者: {g.name(winner)}" if winner is not None else "勝者なし"
        if g.loser is not None:
            text += f"\n最後にジョーカーを持っていたのは {g.name(g.loser)} さんでした。"
        if BOT_ID in g.players:
            text += "\n（Bot戦はランキングに数えません）"
        embed = discord.Embed(title="ババ抜き 終了", description=text, color=COLOR)
        embed.add_field(name="上がった順", value=order[:1024], inline=False)
        await channel.send(embed=embed)

    # ------------------------------------------------------------------
    # 再起動復旧（core/game/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, g: BabanukiGame) -> None:
        if g.phase != "playing":
            return
        state = {
            "host_id": g.host_id,
            "players": [
                [uid, game_restore.member_ref(m) if m is not None else None]
                for uid, m in g.players.items()
            ],
            "hands": [[uid, list(cards)] for uid, cards in g.hands.items()],
            "finished": list(g.finished),
            "loser": g.loser,
            "turn_index": g.turn_index,
        }
        game_restore.save_session("babanuki", g.channel_id, g.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("babanuki", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だったババ抜きを、手番の開始時点から再開する。"""
        entries = game_restore.session_entries("babanuki")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: ババ抜きの復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("babanuki", channel_id)
        game_restore.flush_store()

    async def _restore_session(self, channel_id, entry) -> bool:
        state = entry.get("state")
        if not isinstance(state, dict) or channel_id in self.games:
            return False
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return False
        guild = getattr(channel, "guild", None)
        guild_id = entry.get("guild_id") or getattr(guild, "id", None)
        g = BabanukiGame(channel_id, guild_id, state.get("host_id"))
        players = {}
        for uid, ref in state["players"]:
            uid = int(uid)
            players[uid] = None if ref is None else game_restore.resolve_member(
                guild, ref.get("id"), ref.get("name"))
        if len(players) < 2:
            return False
        g.players = players
        g.hands = {int(uid): list(cards) for uid, cards in state["hands"]}
        g.finished = [int(u) for u in state.get("finished") or []]
        g.loser = state.get("loser")
        g.turn_index = int(state.get("turn_index") or 0)
        g.drawn = None
        g.phase = "playing"
        self.games[channel_id] = g
        asyncio.create_task(self._run_restored_session(channel, g))
        return True

    async def _run_restored_session(self, channel, g: BabanukiGame):
        try:
            await self._play_loop(channel, g)
            await self.finish(channel, g)
        except Exception:
            logger.exception("channel %s: 復旧したババ抜きの進行に失敗しました", g.channel_id)
        finally:
            g.phase = "done"
            if self.games.get(g.channel_id) is g:
                self.games.pop(g.channel_id, None)
            self._clear_snapshot(g.channel_id)


async def setup(bot):
    await bot.add_cog(Babanuki(bot))
