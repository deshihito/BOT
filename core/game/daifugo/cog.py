# -*- coding: utf-8 -*-
"""大富豪: 場のカードより強いカードを同じ枚数で出していき、早く手札をなくした人ほど上の身分になる。

- スラッシュコマンドは増やさず、/game の「大富豪」から募集する（GameHub が start_recruit を呼ぶ）。
- 3〜6 人。足りないときは Bot が入る。絵文字は使わず、カードは "S5"・"HK"・"JOKER" のような文字で表す
  （S=スペード H=ハート D=ダイヤ C=クラブ）。場のカードと自分の手札は、共通基盤
  （core/game/game/board_image.py）のカード画像でも表示する（テキスト表示は併記）。
- 基本ルールだけ: 1 枚・2 枚（ペア）・3 枚・4 枚を同じ数字でそろえて出す。場と同じ枚数で、より強い数字だけ出せる。
  強さは 3 が最弱、2 が最強、ジョーカーはさらに強い（ジョーカーは 1 枚出しだけ）。
  ほかの全員がパスしたら場を流し、最後に出した人から（上がっていれば次の人から）。
- 4 枚出しで革命（数字の強さが逆になる。ジョーカーはいつでも最強）。もう一度 4 枚出しで戻る。
- 出すカードは「手札から出す」で本人にだけ見えるメニューから選ぶ。
- 手番は 30 秒。時間切れはパス（場が空で自分が親のときは一番弱いカードを出す）。
- 結果は 大富豪・富豪・平民・貧民・大貧民。大富豪の勝利を core/game/game/party_ranking.py に記録する（人間 2 人以上のときだけ）。
"""
import asyncio
import io
import logging
import random

import discord
from core.game.game import board_image, game_panels, game_restore
from core.game.game.board_image import render_cached, render_card_hand
from core.game.game.game_v2 import GamePanelView, LobbyView, safe_delete, text_panel
from core.support.messages import recruit_join_prompt  # noqa: F401  cogs.daifugo シムの再輸出用に残す
from discord.ext import commands

from core.game.game import party_ranking
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
        # 終了ガード（2026-11-07）: Bot を除く人間全員が連続でパスし続けると
        # 対局が終わらないため、人間の連続パス回数を数える。Bot のプレイ/
        # パスではリセットされず、人間がカードを出すとその人だけリセット。
        self.human_pass_streak: dict = {}
        self.auto_ended = False      # 終了ガードで終わった対局か

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
        if not self.is_bot(uid):
            self.human_pass_streak[uid] = 0   # 人間が出したらその人の連続パスはリセット
        if self.eight_cut and self.phase == "playing":
            self.table, self.passed = None, set()
            # 8切りは場を流して「出した本人が続けてリードする」のが本来の動き。
            # 上がってしまった場合だけ次の人へ回す（バグ修正 2026-11-07:
            # 以前は常時次の人へ回っていて、本人の手番が戻らなかった）。
            self.turn = uid if self.hands.get(uid) else self.next_active(uid)
            self.cleared = True
        else:
            self._advance(uid)
        self._maybe_auto_end()
        return result

    def pass_turn(self, uid) -> bool:
        if self.phase != "playing" or uid != self.turn or self.table is None:
            return False
        self.passed.add(uid)
        self._advance(uid)
        if not self.is_bot(uid):
            self.human_pass_streak[uid] = self.human_pass_streak.get(uid, 0) + 1
        self._maybe_auto_end()
        return True

    #: 人間全員がこの回数だけ連続でパスしたら自動終了する（ユーザー指定: 2回）
    AUTO_END_HUMAN_PASSES = 2

    def _maybe_auto_end(self) -> None:
        """終了ガード: Bot を除く人間の全員が2回連続でパスしたら対局を打ち切る。

        Bot のプレイ/パスは人間の連続パスをリセットしない（Bot が出し
        続けるせいで「全員パスなのに終わらない」状態を断つため）。
        打ち切り時の順位は、既に上がった人の後ろに、残っている全員を
        残り手札の少ない順（同数なら参加順）で付ける。
        """
        if self.phase != "playing" or self.auto_ended:
            return
        active = self.active
        humans = [u for u in active if not self.is_bot(u)]
        if not humans:
            return
        if not all(self.human_pass_streak.get(u, 0) >= self.AUTO_END_HUMAN_PASSES for u in humans):
            return
        order = list(self.players)
        rest = sorted(active, key=lambda u: (len(self.hands.get(u, [])), order.index(u)))
        self.finished.extend(rest)
        self.auto_ended = True
        self.phase = "done"
        self.turn = None

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


# --- カード画像（共通トランプ基盤） -------------------------------------------
def card_spec_of(card: str):
    """内部表記（"S5" / "HK" / "JOKER"）を描画基盤の正規形に変換する。"""
    if card == JOKER:
        return board_image.CARD_JOKER
    return board_image.card_spec(card[1:], card[0])


def cards_specs(cards) -> tuple:
    return tuple(card_spec_of(c) for c in cards)


def table_image(g: DaifugoGame):
    """場のカードの画像 (bytes)。場が空なら None。"""
    if not g.table:
        return None
    specs = cards_specs(g.table)
    return render_cached(("daifugo-table", specs),
                         lambda: render_card_hand(list(specs), title="場のカード"))


def hand_file(cards, filename="daifugo_hand.png"):
    specs = cards_specs(cards)
    data = render_cached(("daifugo-hand", specs),
                         lambda: render_card_hand(list(specs), title="あなたの手札"))
    return discord.File(io.BytesIO(data), filename=filename)





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


class TurnPanel(GamePanelView):
    """手番パネル（Components V2）。ボタンは属性としても公開する。"""

    def __init__(self, cog, game: DaifugoGame, body: str, table_file=None):
        super().__init__("", body, timeout=TURN_SECONDS + 30)
        self.cog, self.game = cog, game
        if table_file is not None:
            gallery = discord.ui.MediaGallery()
            gallery.add_item(media="attachment://daifugo_table.png")
            self.add_extra(gallery)
        self.open_hand = discord.ui.Button(label="手札から出す", style=discord.ButtonStyle.success)
        self.open_hand.callback = self._open_hand
        self.pass_button = discord.ui.Button(label="パス", style=discord.ButtonStyle.secondary)
        self.pass_button.callback = self._pass_button
        self.show = discord.ui.Button(label="手札を見る", style=discord.ButtonStyle.secondary)
        self.show.callback = self._show
        self.add_row(self.open_hand, self.pass_button, self.show)

    async def _open_hand(self, interaction: discord.Interaction):
        await self.cog.open_hand(interaction, self.game)

    async def _pass_button(self, interaction: discord.Interaction):
        await self.cog.on_pass(interaction, self.game)

    async def _show(self, interaction: discord.Interaction):
        await self.cog.show_hand(interaction, self.game)


TurnView = TurnPanel  # 互換名（テスト・外部参照用）


class Daifugo(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games: dict = {}   # channel_id -> DaifugoGame
        self._logs: dict = {}   # channel_id -> 直近の行動ログメッセージ（残留対策で前回分を消す）

    async def start_recruit(self, interaction: discord.Interaction, eight_cut: bool = True, spade3: bool = False):
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message(
                "このチャンネルでは既に大富豪が進行中です。", ephemeral=True)
        g = DaifugoGame(channel.id, interaction.guild_id, interaction.user.id)
        g.rule_eight_cut = bool(eight_cut)
        g.rule_spade3 = bool(spade3)
        g.players[interaction.user.id] = interaction.user
        self.games[channel.id] = g
        await interaction.response.send_message(f"大富豪の募集を開始しました（{RECRUIT_SECONDS}秒）。")
        try:
            lobby = LobbyView(
                title="大富豪 参加者募集",
                host=interaction.user,
                min_players=1,   # 人数が足りない分は Bot が入るため、主催者だけでも開始できる
                max_players=MAX_PLAYERS,
                note=(f"{interaction.user.mention} さんが募集中です。\n"
                      f"{RECRUIT_SECONDS}秒で自動開始します（{MIN_PLAYERS}〜{MAX_PLAYERS}人、"
                      f"足りないときは Bot が入ります）。\n"
                      f"ルール: 8切り {'ON' if g.rule_eight_cut else 'OFF'} / スペ3返し {'ON' if g.rule_spade3 else 'OFF'}"),
                timeout=RECRUIT_SECONDS + 30)
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
        await channel.send(view=text_panel(
            "大富豪 スタート！",
            "カードを配りました。ダイヤの3を持っている人からです。\n"
            "自分の番に「手札から出す」で出すカードを選ぶか、「パス」を押してください。\n\n"
            + self.counts_text(g)))
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
        body = f"{g.name(uid)} さんの番です（{TURN_SECONDS}秒）。\n{table_text(g)}\n\n{self.counts_text(g)}"
        kwargs = {}
        data = table_image(g)
        if data is not None:
            kwargs["file"] = discord.File(io.BytesIO(data), filename="daifugo_table.png")
        panel = TurnPanel(self, g, body, table_file=kwargs.get("file"))
        await game_panels.replace(channel, "party", view=panel, **kwargs)
        if g.is_bot(uid):
            await asyncio.sleep(BOT_SECONDS)
            return await self.apply(channel, g, uid, plays[0] if plays else PASS)
        elapsed = 0
        while not g.acted and elapsed < TURN_SECONDS and g.phase == "playing":
            await asyncio.sleep(1)
            elapsed += 1
        if not g.acted and g.phase == "playing":
            action = PASS if g.table is not None else plays[0]
            note = f"{g.name(uid)} さんは時間切れのため自動で{('パス' if action == PASS else label(action) + ' を出しました')}。"
            await self.apply(channel, g, uid, action, note=note)

    async def _send_log(self, channel, text: str) -> None:
        """行動ログは1通だけ残す（前回分は役割を終えたので削除する）。"""
        old = self._logs.pop(channel.id, None)
        await safe_delete(old)
        self._logs[channel.id] = await channel.send(view=text_panel("", text))

    async def apply(self, channel, g: DaifugoGame, uid, play, note: str | None = None):
        g.acted = True
        lines = [note] if note else []
        if play == PASS:
            g.pass_turn(uid)
            if not note:
                lines.append(f"{g.name(uid)} さんはパス。")
            if getattr(g, "cleared", False) and g.phase == "playing":
                lines.append(f"全員パスしたので場を流します。次は {g.name(g.turn)} さんから。")
        else:
            result = g.play(uid, play)
            if not note:
                lines.append(f"{g.name(uid)} さんが {label(play)} を出しました。")
            if result == "revolution":
                lines.append("革命！ 数字の強さが逆になります。" if g.revolution else "革命返し！ 強さが元に戻ります。")
            if g.eight_cut:
                lines.append(f"8切り！ 場を流します。続けて {g.name(uid)} さんから出せます。")
            if uid in g.finished:
                lines.append(f"{g.name(uid)} さんが上がりました（{g.finished.index(uid) + 1}番目）。")
        if getattr(g, "auto_ended", False):
            lines.append("Bot を除く全員が2回連続でパスしたため、対局を自動終了します。")
        await self._send_log(channel, "\n".join(lines))

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
        hand_cards = list(g.hands[interaction.user.id])
        hand = " ".join(hand_cards)
        if not plays:
            return await interaction.response.send_message(
                f"出せるカードがありません。パスしてください。\nあなたの手札: {hand}",
                ephemeral=True, file=hand_file(hand_cards))
        await interaction.response.send_message(f"{table_text(g)}\nあなたの手札: {hand}",
                                                view=PlayView(self, g, plays), ephemeral=True,
                                                file=hand_file(hand_cards))

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
        hand_cards = sort_hand(list(g.hands.get(uid, [])))
        hand = " ".join(hand_cards) or "なし（上がり）"
        if not hand_cards:
            return await interaction.response.send_message(f"あなたの手札: {hand}", ephemeral=True)
        await interaction.response.send_message(f"あなたの手札: {hand}", ephemeral=True,
                                                file=hand_file(hand_cards))

    async def finish(self, channel, g: DaifugoGame):
        g.phase = "done"
        results = g.results()
        humans = [u for u in g.players if not g.is_bot(u)]
        if results and len(humans) >= 2 and not g.is_bot(results[0][0]):
            await party_ranking.shared().record_win(g.guild_id, results[0][0], GAME_ID)
        text = "\n".join(f"{t}: {g.name(u)}" for u, t in results) or "（なし）"
        if getattr(g, "auto_ended", False):
            text = ("Bot を除く全員が2回連続でパスしたため、対局を自動終了しました。"
                    "残り手札の少ない順に順位を付けています。\n" + text)
        if len(humans) < 2:
            text += "\n（人間が2人以上いないゲームはランキングに数えません）"
        # 役割を終えた進行パネルと行動ログを片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        await safe_delete(self._logs.pop(channel.id, None))
        await channel.send(view=text_panel("大富豪 終了", text))

    # ------------------------------------------------------------------
    # 再起動復旧（core/game/game/game_restore.py）
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
            "human_pass_streak": [[uid, n] for uid, n in g.human_pass_streak.items()],
            "auto_ended": bool(g.auto_ended),
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
        g.human_pass_streak = {int(uid): int(n) for uid, n in state.get("human_pass_streak") or []}
        g.auto_ended = bool(state.get("auto_ended", False))
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
