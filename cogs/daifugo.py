# -*- coding: utf-8 -*-
"""大富豪: 場のカードより強いカードを同じ枚数で出していき、早く手札をなくした人ほど上の身分になる。

- スラッシュコマンドは増やさず、/game の「大富豪」から募集する（GameHub が start_recruit を呼ぶ）。
- 3〜6 人。足りないときは Bot が入る。絵文字は使わず、カードは "S5"・"HK"・"JOKER" のような文字で表す
  （S=スペード H=ハート D=ダイヤ C=クラブ）。
- 基本ルールだけ: 1 枚・2 枚（ペア）・3 枚・4 枚を同じ数字でそろえて出す。場と同じ枚数で、より強い数字だけ出せる。
  強さは 3 が最弱、2 が最強、ジョーカーはさらに強い（ジョーカーは 1 枚出しだけ）。
  ほかの全員がパスしたら場を流し、最後に出した人から（上がっていれば次の人から）。
- 4 枚出しで革命（数字の強さが逆になる。ジョーカーはいつでも最強）。もう一度 4 枚出しで戻る。
- 出すカードは「手札から出す」で本人にだけ見えるメニューから選ぶ。
- 手番は 30 秒。時間切れはパス（場が空で自分が親のときは一番弱いカードを出す）。
- 結果は 大富豪・富豪・平民・貧民・大貧民。大富豪の勝利を core/party_ranking.py に記録する（人間 2 人以上のときだけ）。
"""
import asyncio
import logging
import random

import discord
from core import game_panels, game_restore
from core.messages import recruit_join_prompt
from discord.ext import commands

from core import party_ranking

logger = logging.getLogger(__name__)

GAME_ID = "daifugo"
party_ranking.register(GAME_ID)

COLOR = 0xFFFFFF
RECRUIT_SECONDS = 30
TURN_SECONDS = 30
BOT_SECONDS = 1
MIN_PLAYERS = 3
MAX_PLAYERS = 6
BOT_IDS = (-1, -2)
JOKER = "JOKER"
PASS = "パス"
SUITS = "SHDC"
ORDER = ("3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2")


def make_deck() -> list:
    return [s + r for s in SUITS for r in ORDER] + [JOKER]


def rank(card: str) -> str:
    return JOKER if card == JOKER else card[1:]


def strength(r: str, revolution: bool = False) -> int:
    """数字の強さ。ジョーカーは常に最強。"""
    if r == JOKER:
        return 100
    i = ORDER.index(r)
    return len(ORDER) - 1 - i if revolution else i


def sort_hand(hand: list) -> list:
    return sorted(hand, key=lambda c: (strength(rank(c)), c))


SUIT_MARKS = {"S": "スペード", "H": "ハート", "D": "ダイヤ", "C": "クラブ"}


def card_label(card: str) -> str:
    """表示用にスート名で表す（内部表記 "S5" はそのまま保持）。

    大富豪は「絵文字を使わない」が設計上の約束（テストで担保）なので、
    スート記号（♠ 等）ではなく日本語のスート名で読みやすくする。
    """
    if card == JOKER:
        return "ジョーカー"
    return f"{SUIT_MARKS.get(card[0], card[0])}{card[1:]}"


def label(play) -> str:
    return PASS if play == PASS else " ".join(card_label(c) for c in play)


def legal_plays(hand: list, table, revolution: bool, spade3: bool = False) -> list:
    """出せる手（カードのタプル）の一覧。弱い順。table は場の手（なければ None）。"""
    groups = {}
    for c in sort_hand(hand):
        groups.setdefault(rank(c), []).append(c)
    plays = []
    for r, cards in groups.items():
        sizes = [1] if r == JOKER else range(1, len(cards) + 1)
        for n in sizes:
            plays.append(tuple(cards[:n]))
    if table:
        need, top = len(table), strength(rank(table[0]), revolution)
        legal = [p for p in plays if len(p) == need and strength(rank(p[0]), revolution) > top]
        # スペ3返し: ジョーカー1枚の場には ♠3 1枚だけ特別に出せる
        if spade3 and tuple(table) == (JOKER,) and ("S3",) in plays and ("S3",) not in legal:
            legal.append(("S3",))
        plays = legal
    return sorted(plays, key=lambda p: (len(p), strength(rank(p[0]), revolution), p))


def titles(n: int) -> list:
    """上がった順の身分。"""
    if n <= 1:
        return ["大富豪"][:n]
    if n == 2:
        return ["大富豪", "大貧民"]
    if n == 3:
        return ["大富豪", "平民", "大貧民"]
    return ["大富豪", "富豪"] + ["平民"] * (n - 4) + ["貧民", "大貧民"]


class DaifugoGame:
    def __init__(self, channel_id, guild_id, host_id):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players: dict = {}      # user_id -> member（参加順。Bot は負の id で None）
        self.hands: dict = {}
        self.finished: list = []
        self.phase = "recruit"       # recruit / playing / done
        self.turn = None             # 手番の id
        self.table = None            # 場のカード（タプル）
        self.last_player = None      # 場に最後に出した人
        self.passed: set = set()
        self.revolution = False
        self.acted = False           # この手番で行動した
        self.cleared = False         # 直前の行動で場が流れた
        self.eight_cut = False
        self.rule_eight_cut = True   # ルールオプション: 8切り（既定 ON = 従来どおり）
        self.rule_spade3 = False     # ルールオプション: スペ3返し（既定 OFF）

    def is_bot(self, uid) -> bool:
        return uid in BOT_IDS

    def name(self, uid) -> str:
        return f"Bot{-uid}" if self.is_bot(uid) else self.players[uid].mention

    @property
    def active(self) -> list:
        return [u for u in self.players if self.hands.get(u)]

    def next_active(self, uid):
        order = list(self.players)
        i = order.index(uid)
        for k in range(1, len(order) + 1):
            other = order[(i + k) % len(order)]
            if self.hands.get(other):
                return other
        return None

    def start(self, rng=random):
        deck = make_deck()
        rng.shuffle(deck)
        ids = list(self.players)
        self.hands = {u: [] for u in ids}
        for i, c in enumerate(deck):
            self.hands[ids[i % len(ids)]].append(c)
        for u in ids:
            self.hands[u] = sort_hand(self.hands[u])
        holder = next(u for u in ids if "D3" in self.hands[u])   # ダイヤの 3 を持つ人から
        self.turn = holder
        self.phase = "playing"

    def legal(self, uid) -> list:
        return legal_plays(self.hands[uid], self.table, self.revolution, spade3=self.rule_spade3)

    def can_play(self, uid, cards) -> bool:
        """手札にあるカードで、出せる手と同じ数字・同じ枚数か（スートの選び方は問わない）。"""
        hand = list(self.hands.get(uid, []))
        for c in cards:
            if c not in hand:
                return False
            hand.remove(c)
        if not cards or len({rank(c) for c in cards}) != 1:
            return False
        return any(len(p) == len(cards) and rank(p[0]) == rank(cards[0]) for p in self.legal(uid))

    def play(self, uid, cards) -> str:
        """カードを出す。結果: "ok" / "revolution" / "invalid"。"""
        cards = tuple(cards)
        if self.phase != "playing" or uid != self.turn or not self.can_play(uid, cards):
            return "invalid"
        for c in cards:
            self.hands[uid].remove(c)
        self.table, self.last_player = cards, uid
        self.passed = set()
        result = "ok"
        if len(cards) == 4:
            self.revolution = not self.revolution
            result = "revolution"
        if not self.hands[uid]:
            self.finished.append(uid)
        self.eight_cut = bool(self.rule_eight_cut) and any(rank(c) == "8" for c in cards)
        if self.eight_cut and self.phase == "playing":
            self.table, self.passed = None, set()
            self.turn = self.next_active(uid)
            self.cleared = True
        else:
            self._advance(uid)
        return result

    def pass_turn(self, uid) -> bool:
        if self.phase != "playing" or uid != self.turn or self.table is None:
            return False
        self.passed.add(uid)
        self._advance(uid)
        return True

    def _advance(self, uid):
        """次の手番を決める。ほかの全員がパスしたら場を流す。"""
        active = self.active
        if len(active) <= 1:
            if active:
                self.finished.append(active[0])
                self.hands[active[0]] = []
            self.phase = "done"
            self.turn = None
            return
        others = [u for u in active if u != self.last_player]
        if self.table is not None and all(u in self.passed for u in others):
            self.table, self.passed = None, set()
            lead = self.last_player if self.hands.get(self.last_player) else self.next_active(self.last_player)
            self.turn = lead
            self.cleared = True
            return
        self.cleared = False
        self.turn = self.next_active(uid)

    def results(self) -> list:
        return list(zip(self.finished, titles(len(self.finished))))


def table_text(g: DaifugoGame) -> str:
    table = label(g.table) if g.table else "（なし）"
    return f"場: {table}" + ("　【革命中】" if g.revolution else "")


class JoinView(discord.ui.View):
    def __init__(self, cog, game: DaifugoGame):
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


class PlaySelect(discord.ui.Select):
    def __init__(self, cog, game: DaifugoGame, plays: list):
        options = [discord.SelectOption(label=label(p)[:100], value=str(i)) for i, p in enumerate(plays[:25])]
        super().__init__(placeholder="出すカードを選ぶ", options=options)
        self.cog, self.game, self.plays = cog, game, plays

    async def callback(self, interaction: discord.Interaction):
        await self.cog.on_play(interaction, self.game, self.plays[int(self.values[0])])


class PlayView(discord.ui.View):
    """本人にだけ見える、出す手を選ぶメニュー。"""
    def __init__(self, cog, game, plays):
        super().__init__(timeout=TURN_SECONDS + 30)
        self.add_item(PlaySelect(cog, game, plays))


class TurnView(discord.ui.View):
    def __init__(self, cog, game: DaifugoGame):
        super().__init__(timeout=TURN_SECONDS + 30)
        self.cog, self.game = cog, game

    @discord.ui.button(label="手札から出す", style=discord.ButtonStyle.success)
    async def open_hand(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.open_hand(interaction, self.game)

    @discord.ui.button(label="パス", style=discord.ButtonStyle.secondary)
    async def pass_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.on_pass(interaction, self.game)

    @discord.ui.button(label="手札を見る", style=discord.ButtonStyle.secondary)
    async def show(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.show_hand(interaction, self.game)


class Daifugo(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> DaifugoGame

    async def start_recruit(self, interaction: discord.Interaction, eight_cut: bool = True, spade3: bool = False):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                embed=discord.Embed(description="このチャンネルでは既に大富豪が進行中です。", color=COLOR),
                ephemeral=True)
        g = DaifugoGame(channel.id, interaction.guild_id, interaction.user.id)
        g.rule_eight_cut = bool(eight_cut)
        g.rule_spade3 = bool(spade3)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(
            embed=discord.Embed(description=f"大富豪の募集を開始しました（{RECRUIT_SECONDS}秒）。", color=COLOR))
        try:
            await game_panels.replace(channel, "party", embed=discord.Embed(
                title="大富豪 参加者募集",
                description=(f"{interaction.user.mention} さんが募集中です。\n"
                             f"{recruit_join_prompt(RECRUIT_SECONDS)}（{MIN_PLAYERS}〜{MAX_PLAYERS}人）。\n"
                             f"{MIN_PLAYERS}人に足りないときは Bot が入ります。\n"
                             f"ルール: 8切り {'ON' if g.rule_eight_cut else 'OFF'} / スペ3返し {'ON' if g.rule_spade3 else 'OFF'}"),
                color=COLOR), view=JoinView(self, g))
            await asyncio.sleep(RECRUIT_SECONDS)
            await self.run_game(channel, g)
        finally:
            g.phase = "done"
            self.games.pop(channel.id, None)
            self._clear_snapshot(channel.id)

    def counts_text(self, g: DaifugoGame) -> str:
        return "\n".join(f"{g.name(u)}: {len(g.hands.get(u, []))}枚" + ("（上がり）" if u in g.finished else "")
                         for u in g.players)

    async def run_game(self, channel, g: DaifugoGame, rng=random):
        for bot_id in BOT_IDS:
            if len(g.players) >= MIN_PLAYERS:
                break
            g.players[bot_id] = None
        g.start(rng)
        await channel.send(embed=discord.Embed(
            title="大富豪 スタート！",
            description=("カードを配りました。ダイヤの3を持っている人からです。\n"
                         "自分の番に「手札から出す」で出すカードを選ぶか、「パス」を押してください。\n\n"
                         + self.counts_text(g)),
            color=COLOR))
        await self._play_loop(channel, g, rng)
        await self.finish(channel, g)

    async def _play_loop(self, channel, g: DaifugoGame, rng=random):
        while g.phase == "playing":
            await self.play_turn(channel, g, rng)

    async def play_turn(self, channel, g: DaifugoGame, rng=random):
        # 手番開始時点をチェックポイントとして保存する（復旧はここから再開する）
        self._save_snapshot(g)
        uid = g.turn
        g.acted = False
        plays = g.legal(uid)
        await game_panels.replace(channel, "party", embed=discord.Embed(
            description=(f"{g.name(uid)} さんの番です（{TURN_SECONDS}秒）。\n{table_text(g)}\n\n{self.counts_text(g)}"),
            color=COLOR), view=TurnView(self, g))
        if g.is_bot(uid):
            await asyncio.sleep(BOT_SECONDS)
            return await self.apply(channel, g, uid, plays[0] if plays else PASS)
        elapsed = 0
        while not g.acted and elapsed < TURN_SECONDS and g.phase == "playing":
            await asyncio.sleep(1)
            elapsed += 1
        if not g.acted and g.phase == "playing":
            action = PASS if g.table is not None else plays[0]
            await channel.send(embed=discord.Embed(
                description=f"{g.name(uid)} さんは時間切れのため自動で{('パス' if action == PASS else label(action) + ' を出しました')}。", color=COLOR))
            await self.apply(channel, g, uid, action)

    async def apply(self, channel, g: DaifugoGame, uid, play):
        g.acted = True
        if play == PASS:
            g.pass_turn(uid)
            lines = [f"{g.name(uid)} さんはパス。"]
        else:
            result = g.play(uid, play)
            lines = [f"{g.name(uid)} さんが {label(play)} を出しました。"]
            if result == "revolution":
                lines.append("革命！ 数字の強さが逆になります。" if g.revolution else "革命返し！ 強さが元に戻ります。")
            if g.eight_cut:
                lines.append("8切り！ 場を流します。")
            if uid in g.finished:
                lines.append(f"{g.name(uid)} さんが上がりました（{g.finished.index(uid) + 1}番目）。")
        if getattr(g, "cleared", False) and g.phase == "playing":
            lines.append(f"全員パスしたので場を流します。次は {g.name(g.turn)} さんから。")
        await channel.send(embed=discord.Embed(description="\n".join(lines), color=COLOR))

    def _check_turn(self, interaction, g: DaifugoGame):
        if g.phase != "playing":
            return "このゲームは終わりました。"
        if interaction.user.id != g.turn or g.acted:
            return "あなたの番ではありません。"
        return None

    async def open_hand(self, interaction: discord.Interaction, g: DaifugoGame):
        error = self._check_turn(interaction, g)
        if error:
            return await interaction.response.send_message(error, ephemeral=True)
        plays = g.legal(interaction.user.id)
        hand = " ".join(g.hands[interaction.user.id])
        if not plays:
            return await interaction.response.send_message(
                f"出せるカードがありません。パスしてください。\nあなたの手札: {hand}", ephemeral=True)
        await interaction.response.send_message(f"{table_text(g)}\nあなたの手札: {hand}",
                                                view=PlayView(self, g, plays), ephemeral=True)

    async def on_play(self, interaction: discord.Interaction, g: DaifugoGame, play):
        error = self._check_turn(interaction, g)
        if error:
            return await interaction.response.send_message(error, ephemeral=True)
        if not g.can_play(interaction.user.id, tuple(play)):
            return await interaction.response.send_message("その手はもう出せません。", ephemeral=True)
        await interaction.response.send_message(f"{label(play)} を出しました。")
        await self.apply(interaction.channel, g, interaction.user.id, tuple(play))

    async def on_pass(self, interaction: discord.Interaction, g: DaifugoGame):
        error = self._check_turn(interaction, g)
        if error:
            return await interaction.response.send_message(error, ephemeral=True)
        if g.table is None:
            return await interaction.response.send_message("場にカードがないので、パスはできません。", ephemeral=True)
        await interaction.response.send_message("パスしました。")
        await self.apply(interaction.channel, g, interaction.user.id, PASS)

    async def show_hand(self, interaction: discord.Interaction, g: DaifugoGame):
        uid = interaction.user.id
        if uid not in g.players:
            return await interaction.response.send_message("このゲームに参加していません。", ephemeral=True)
        hand = " ".join(sort_hand(g.hands.get(uid, []))) or "なし（上がり）"
        await interaction.response.send_message(f"あなたの手札: {hand}", ephemeral=True)

    async def finish(self, channel, g: DaifugoGame):
        g.phase = "done"
        results = g.results()
        humans = [u for u in g.players if not g.is_bot(u)]
        if results and len(humans) >= 2 and not g.is_bot(results[0][0]):
            await party_ranking.shared().record_win(g.guild_id, results[0][0], GAME_ID)
        text = "\n".join(f"{t}: {g.name(u)}" for u, t in results) or "（なし）"
        if len(humans) < 2:
            text += "\n（人間が2人以上いないゲームはランキングに数えません）"
        await channel.send(embed=discord.Embed(title="大富豪 終了", description=text, color=COLOR))

    # ------------------------------------------------------------------
    # 再起動復旧（core/game_restore.py）
    # ------------------------------------------------------------------
    def _save_snapshot(self, g: DaifugoGame) -> None:
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
            "turn": g.turn,
            "table": list(g.table) if g.table is not None else None,
            "last_player": g.last_player,
            "passed": sorted(g.passed),
            "revolution": bool(g.revolution),
            "cleared": bool(g.cleared),
            "eight_cut": bool(g.eight_cut),
            "rule_eight_cut": bool(g.rule_eight_cut),
            "rule_spade3": bool(g.rule_spade3),
        }
        game_restore.save_session("daifugo", g.channel_id, g.guild_id, state)

    def _clear_snapshot(self, channel_id) -> None:
        game_restore.clear_session("daifugo", channel_id)

    async def restore_after_restart(self) -> None:
        """再起動前に進行中だった大富豪を、手番の開始時点から再開する。"""
        entries = game_restore.session_entries("daifugo")
        for channel_id, entry in entries.items():
            try:
                restored = await self._restore_session(channel_id, entry)
            except Exception:
                logger.exception("channel %s: 大富豪の復旧に失敗しました", channel_id)
                restored = False
            if not restored:
                game_restore.clear_session("daifugo", channel_id)
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
        g = DaifugoGame(channel_id, guild_id, state.get("host_id"))
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
        g.turn = state.get("turn")
        table = state.get("table")
        g.table = tuple(table) if table is not None else None
        g.last_player = state.get("last_player")
        g.passed = {int(u) for u in state.get("passed") or []}
        g.revolution = bool(state.get("revolution"))
        g.cleared = bool(state.get("cleared"))
        g.eight_cut = bool(state.get("eight_cut"))
        g.rule_eight_cut = bool(state.get("rule_eight_cut", True))
        g.rule_spade3 = bool(state.get("rule_spade3", False))
        g.phase = "playing"
        self.games[channel_id] = g
        asyncio.create_task(self._run_restored_session(channel, g))
        return True

    async def _run_restored_session(self, channel, g: DaifugoGame):
        try:
            await self._play_loop(channel, g)
            await self.finish(channel, g)
        except Exception:
            logger.exception("channel %s: 復旧した大富豪の進行に失敗しました", g.channel_id)
        finally:
            g.phase = "done"
            if self.games.get(g.channel_id) is g:
                self.games.pop(g.channel_id, None)
            self._clear_snapshot(g.channel_id)


async def setup(bot):
    await bot.add_cog(Daifugo(bot))
