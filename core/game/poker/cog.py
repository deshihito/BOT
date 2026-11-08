"""/game のポーカー（5枚ドロー、チップ制テーブル）。

旧版は賭けなし・交換1回で終わる役比べだけだったため、チップ制の
テーブル形式に作り替えた（/game 提案 A3）。

- バイイン: AGOコイン → チップ（等価、100 / 500 / 1000 の段階制）。
  wallet の CAS 更新（_change_balance）と transaction_history
  （reason: poker_buyin / poker_cashout）を必ず通す。チップの精算は
  ハンド単位で完結し、持ち越しはテーブル（セッション）内のみ。
  退出・テーブル終了時は残チップを必ずコインに戻す。
- 再起動対策: 対局そのものは復旧しない（core/game/game/game_restore.py の対象外）が、
  預かっているチップは data/poker_chips.json の台帳に都度記録し、
  起動時に未精算分を全額返金する（cogs/gambling.py の未完了セッション
  返金と同じ考え方）。台帳の1人あたり金額は「スタック＋ハンド中の
  自分の拠出」で、ハンドの途中で再起動しても本人の拠出はそのまま戻る。
- ハンドの流れ: アンティ → 配札 → ベット1ラウンド（順番制、
  コール / レイズ / フォールド）→ 交換1回 → ショーダウン。
  ポットはサイドポット方式で分配し、レーキとして各勝者の受取から
  5%（切り捨て）を消却する（インフレ対策）。
- ハンドの勝者（ポットを獲得した全員）は core/game/game/party_ranking.py に
  ハンド勝利数として記録する。
- AI tools からの起動（game:poker）: 起動自体はコインを動かさず、
  バイインは参加者本人のボタン操作でのみ行うため、数字当て・
  じゃんけん（賭け金は既定0）と同じく AI_BLOCKED には入れない。
"""
import asyncio
import io
import json
import logging
import os
import random
from collections import Counter
from pathlib import Path

import discord
from discord.ext import commands
import config
from cogs.general import INSUFFICIENT, NEW_USER_BALANCE
from core.game.game import party_ranking
from core.game.game import board_image
from core.game.game.board_image import render_cached, render_card_hand, render_card_rows
from core.game.game import game_panels
from core.game.game.game_v2 import GamePanelView, LobbyView, text_panel
from core.game.game import prison as prison_core
logger = logging.getLogger(__name__)

#: 配札シャッフル専用の CSPRNG (E-12)。グローバル random (MT) の状態を
#: 他機能と共有しないため SystemRandom を使う。
_SHUFFLE_RNG = random.SystemRandom()

COLOR = 0xFFFFFF
GAME_ID = "poker"
POKER_HOUSE_ID = "POKER"
party_ranking.register(GAME_ID)

RECRUIT_SECONDS = 30
BUYIN_SECONDS = 90
BET_SECONDS = 60
DRAW_SECONDS = 60
CONTINUE_SECONDS = 45
MAX_PLAYERS = 6
ANTE = 10
BUYIN_OPTIONS = (100, 500, 1000)
REBUY_MAX_STACK = 100          # スタックがこれ未満ならハンド間にリバイイン可
RAISE_UNIT = 20
MAX_RAISES = 3
RAKE_PERCENT = 5               # 各勝者の受取から 5%（切り捨て）を消却
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


# --- カード画像（core/game/game/board_image.py の共通トランプ基盤） ----------------
_SUIT_TO_LETTER = {"♠": "S", "♥": "H", "♦": "D", "♣": "C"}


def card_spec_of(card):
    """内部表記（"A♠" / "T♥"）を描画基盤の正規形 (ランク, スート) に変換する。"""
    rank = "10" if card[0] == "T" else card[0]
    return board_image.card_spec(rank, _SUIT_TO_LETTER[card[1]])


def hand_specs(hand):
    return tuple(card_spec_of(c) for c in hand)


def hand_image(hand) -> bytes:
    """手札5枚の画像。並びは手札リストの順（交換セレクトの番号と一致させる）。"""
    specs = hand_specs(hand)
    return render_cached(("poker-hand", specs),
                         lambda: render_card_hand(list(specs), title="あなたの手札"))


def hand_file(hand, filename="poker_hand.png"):
    return discord.File(io.BytesIO(hand_image(hand)), filename=filename)


# ---------------------------------------------------------------------------
# ベットラウンド（純ロジック）
# ---------------------------------------------------------------------------
class BettingRound:
    """順番制ベット1ラウンド分の状態機械。

    stacks は uid -> 手元チップ（呼び出し側と共有する dict で、支払うたびに
    減る）。contributions はこのラウンドで各人がポットへ出した額。
    オールイン（スタック0）になった人は以後の手番を飛ばし、フォールドも
    しない（ショーダウンまで残る）。
    """

    def __init__(self, order, stacks):
        self.order = list(order)
        self.stacks = stacks
        self.contributions = {uid: 0 for uid in self.order}
        self.folded = set()
        self.current_bet = 0
        self.raises = 0
        self._acted = set()
        self._next = 0           # 次に探し始める着席位置

    def live(self):
        return [uid for uid in self.order if uid not in self.folded]

    def to_call(self, uid):
        return max(0, self.current_bet - self.contributions[uid])

    def _needs_action(self, uid):
        if uid in self.folded or self.stacks[uid] <= 0:
            return False
        return uid not in self._acted or self.contributions[uid] < self.current_bet

    def is_complete(self):
        live = self.live()
        if len(live) <= 1:
            return True
        return all(not self._needs_action(uid) for uid in live)

    def current_player(self):
        if len(self.live()) <= 1:
            return None
        for n in range(len(self.order)):
            uid = self.order[(self._next + n) % len(self.order)]
            if self._needs_action(uid):
                return uid
        return None

    def can_raise(self, uid):
        return (self.raises < MAX_RAISES
                and self.stacks[uid] > self.to_call(uid))

    def act(self, uid, action):
        """action は 'fold' / 'call' / 'raise'。手番でない・不正な操作は ValueError。"""
        if uid != self.current_player():
            raise ValueError("手番のプレイヤーだけが操作できます")
        if action == "fold":
            self.folded.add(uid)
        elif action == "call":
            pay = min(self.to_call(uid), self.stacks[uid])
            self.stacks[uid] -= pay
            self.contributions[uid] += pay
        elif action == "raise":
            if not self.can_raise(uid):
                raise ValueError("レイズできません")
            target = self.current_bet + RAISE_UNIT
            pay = min(target - self.contributions[uid], self.stacks[uid])
            self.stacks[uid] -= pay
            self.contributions[uid] += pay
            if self.contributions[uid] >= target:
                self.current_bet = target
                self.raises += 1
                self._acted = {uid}
        else:
            raise ValueError(f"未知のアクション: {action}")
        self._acted.add(uid)
        self._next = (self.order.index(uid) + 1) % len(self.order)


def distribute_pot(contributions, folded, scores):
    """ポット分配。戻り値は (payouts, rake)。

    - サイドポット方式: 拠出額の段ごとに、その段まで拠出した
      フォールドしていない人の中で最強の手の人が山分けする。
      端数は着席順（contributions の挿入順）に1チップずつ配る。
    - レーキ: 各勝者の受取総額から 5%（切り捨て）を差し引いて消却する。
    - 保存則: sum(payouts.values()) + rake == sum(contributions.values())
    """
    total = sum(contributions.values())
    payouts = {uid: 0 for uid in contributions}
    live = [uid for uid in contributions if uid not in folded]
    if total <= 0 or not live:
        return payouts, 0
    if len(live) == 1:
        payouts[live[0]] = total
    else:
        prev = 0
        for level in sorted({amt for amt in contributions.values() if amt > 0}):
            tier = sum(max(0, min(amt, level) - prev) for amt in contributions.values())
            prev = level
            if tier <= 0:
                continue
            eligible = [uid for uid in live if contributions[uid] >= level]
            if not eligible:  # 理論上は到達しない保険（ベット構造上、最高段には必ず残存者がいる）
                eligible = live
            best = max(scores[uid] for uid in eligible)
            winners = [uid for uid in contributions if uid in eligible and scores[uid] == best]
            share, remainder = divmod(tier, len(winners))
            for i, uid in enumerate(winners):
                payouts[uid] += share + (1 if i < remainder else 0)
    rake = 0
    for uid, amount in payouts.items():
        cut = amount * RAKE_PERCENT // 100
        payouts[uid] -= cut
        rake += cut
    return payouts, rake


def settle_hand(stacks, contributions, folded, scores):
    """ハンドを精算してスタックへ払い戻す。(payouts, rake) を返す。

    保存則: 精算後のスタック合計 + rake == 精算前のスタック合計 + ポット総額。
    """
    payouts, rake = distribute_pot(contributions, folded, scores)
    for uid, amount in payouts.items():
        stacks[uid] = stacks.get(uid, 0) + amount
    return payouts, rake


# ---------------------------------------------------------------------------
# チップ預かり台帳（再起動時の返金用）
# ---------------------------------------------------------------------------
_DEFAULT_CHIPS_PATH = Path(__file__).resolve().parent.parent.parent.parent / "data" / "poker_chips.json"


def chips_path() -> Path:
    return Path(os.environ.get("POKER_CHIPS_PATH") or _DEFAULT_CHIPS_PATH)


class ChipCustodyStore:
    """テーブルが預かっているチップの台帳。金額が動くたびに書き出す。

    {channel_id: {user_id: 預かり額}}。預かり額は「本人のスタック＋
    ハンド中の自分の拠出」で、ハンド途中でも変わらない（拠出は
    スタックからポットへ移るだけで本人の預かり総額は一定）。
    変わるのは バイイン（増）/ ハンド精算（再配分）/ 精算・返金（消滅）
    の3点だけなので、その都度 set() すれば台帳は常に実態と一致する。
    """

    def __init__(self, path=None):
        self.path = Path(path) if path else chips_path()
        self.data = {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                self.data = {
                    str(ch): {str(uid): int(amount) for uid, amount in users.items() if int(amount) > 0}
                    for ch, users in raw.items() if isinstance(users, dict)
                }
        except FileNotFoundError:
            pass
        except Exception:
            logger.exception("poker: チップ台帳の読み込みに失敗しました（空として開始）")

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)
        except Exception:
            logger.exception("poker: チップ台帳の保存に失敗しました")

    def set(self, channel_id, user_id, amount):
        channel = self.data.setdefault(str(channel_id), {})
        if amount > 0:
            channel[str(user_id)] = int(amount)
        else:
            channel.pop(str(user_id), None)
        if not channel:
            self.data.pop(str(channel_id), None)
        self._save()

    def entries(self):
        """{channel_id(int): {user_id(int): amount}} のコピーを返す。"""
        return {int(ch): {int(uid): amount for uid, amount in users.items()}
                for ch, users in self.data.items() if users}


# ---------------------------------------------------------------------------
# テーブル状態
# ---------------------------------------------------------------------------
class PokerTable:
    def __init__(self, channel_id, guild_id, host_id):
        self.channel_id, self.guild_id, self.host_id = channel_id, guild_id, host_id
        self.players = {}        # uid -> user（参加者、着席順）
        self.stacks = {}         # uid -> チップ（バイイン済みの人だけ）
        self.hands = {}
        self.deck = []
        self.submitted = set()   # 交換を確定した人
        self.leaving = set()     # ハンド終了時に退出する人
        self.ready = set()       # 次ハンド継続を押した人
        self.start_requested = False
        self.close_requested = False
        self.pending_action = None   # (uid, action) ベット用
        self.hands_played = 0
        self.phase = "recruit"


def _panel_button(label, style, callback):
    button = discord.ui.Button(label=label, style=style)
    button.callback = callback
    return button


class BuyInSelect(discord.ui.Select):
    """バイイン額の選択。選んだ本人のチップになる（他人の分は買えない）。"""

    def __init__(self, cog, table):
        self.cog, self.table = cog, table
        options = [discord.SelectOption(label=f"{amount:,} チップ（{amount:,} AGO）", value=str(amount))
                   for amount in BUYIN_OPTIONS]
        super().__init__(placeholder="バイイン額を選ぶ（コイン→チップ）", options=options)

    async def callback(self, interaction):
        amount = int(self.values[0])
        ok, message = await self.cog.buy_in(self.table, interaction.user, amount)
        await interaction.response.send_message(message, ephemeral=True)


class BuyInPanel(GamePanelView):
    """バイイン額セレクト＋募集主の開始ボタンのパネル（V2）。"""

    def __init__(self, cog, table, body: str = ""):
        super().__init__("ポーカー：バイイン", body, timeout=BUYIN_SECONDS + 30)
        self.cog, self.table = cog, table
        self.buyin_select = BuyInSelect(cog, table)
        self.add_row(self.buyin_select)
        self.start = _panel_button("開始する（募集主）", discord.ButtonStyle.success, self._start)
        self.add_row(self.start)

    async def _start(self, interaction):
        t = self.table
        if interaction.user.id != t.host_id:
            return await interaction.response.send_message("開始できるのは募集主だけです。", ephemeral=True)
        if len(t.stacks) < 2:
            return await interaction.response.send_message("バイイン済みの人が2人必要です。", ephemeral=True)
        t.start_requested = True
        await interaction.response.send_message("テーブルを開始します。", ephemeral=True)


BuyInView = BuyInPanel  # 互換名


class BettingPanel(GamePanelView):
    """ベット操作パネル（V2）。"""

    def __init__(self, cog, table, round_, body: str = ""):
        super().__init__("ポーカー：ベット", body, timeout=BET_SECONDS + 30)
        self.cog, self.table, self.round = cog, table, round_
        self.call = _panel_button("コール／チェック", discord.ButtonStyle.primary,
                                  lambda i: self._act(i, "call"))
        self.raise_ = _panel_button("レイズ（+20）", discord.ButtonStyle.success,
                                    lambda i: self._act(i, "raise"))
        self.fold = _panel_button("フォールド", discord.ButtonStyle.danger,
                                  lambda i: self._act(i, "fold"))
        self.add_row(self.call, self.raise_, self.fold)
        self.show_hand = _panel_button("手札を見る", discord.ButtonStyle.secondary, self._show_hand)
        self.leave = _panel_button("退出（フォールドして離脱）", discord.ButtonStyle.secondary, self._leave)
        self.add_row(self.show_hand, self.leave)

    async def _act(self, interaction, action):
        t, r = self.table, self.round
        if interaction.user.id != r.current_player():
            return await interaction.response.send_message("あなたの手番ではありません。", ephemeral=True)
        try:
            r.act(interaction.user.id, action)
        except ValueError as e:
            return await interaction.response.send_message(str(e), ephemeral=True)
        t.pending_action = (interaction.user.id, action)
        await interaction.response.send_message(f"{action_label(action, r)}しました。", ephemeral=True)

    async def _show_hand(self, interaction):
        t = self.table
        if interaction.user.id not in t.hands:
            return await interaction.response.send_message("参加者だけが操作できます。", ephemeral=True)
        hand = t.hands[interaction.user.id]
        await interaction.response.send_message(
            f"あなたの手札（相手には見えません）: {' '.join(label_card(c) for c in hand)}",
            ephemeral=True, file=hand_file(hand))

    async def _leave(self, interaction):
        t, r = self.table, self.round
        if interaction.user.id not in t.players or interaction.user.id in r.folded:
            return await interaction.response.send_message("参加者だけが操作できます。", ephemeral=True)
        t.leaving.add(interaction.user.id)
        if r.current_player() == interaction.user.id:
            r.act(interaction.user.id, "fold")
        await interaction.response.send_message("このハンドで退出します（残チップはハンド終了時に精算されます）。", ephemeral=True)


BettingView = BettingPanel  # 互換名


def action_label(action, round_=None):
    return {"call": "コール／チェック", "raise": "レイズ", "fold": "フォールド"}[action]


class DiscardSelect(discord.ui.Select):
    def __init__(self, cog, table, uid):
        self.cog, self.table, self.uid = cog, table, uid
        hand = table.hands[uid]
        options = [discord.SelectOption(label=f"{i+1}. {label_card(c)}", value=str(i)) for i, c in enumerate(hand)]
        super().__init__(placeholder="交換するカードを最大3枚選択（0枚も可）", min_values=0, max_values=3, options=options)

    async def callback(self, interaction):
        t = self.table
        if interaction.user.id != self.uid or self.uid in t.submitted:
            return await interaction.response.send_message("この選択は利用できません。", ephemeral=True)
        hand = t.hands[self.uid]
        indices = {int(v) for v in self.values}
        discarded = [hand[i] for i in sorted(indices)]
        kept = [c for i, c in enumerate(hand) if i not in indices]
        replacements = [t.deck.pop() for _ in discarded]
        t.hands[self.uid] = kept + replacements
        t.submitted.add(self.uid)
        await interaction.response.send_message(
            f"{len(discarded)}枚を交換しました。交換後の手札: {' '.join(label_card(c) for c in t.hands[self.uid])}",
            ephemeral=True, file=hand_file(t.hands[self.uid]))


class DrawPanel(GamePanelView):
    """カード交換フェーズのパネル（V2）。交換セレクト自体は ephemeral。"""

    def __init__(self, cog, table, body: str = ""):
        super().__init__("ポーカー：カード交換", body, timeout=DRAW_SECONDS)
        self.cog, self.table = cog, table
        self.exchange = _panel_button("手札を確認して交換", discord.ButtonStyle.primary, self._exchange)
        self.leave = _panel_button("このハンドで退出", discord.ButtonStyle.secondary, self._leave)
        self.add_row(self.exchange, self.leave)

    async def _exchange(self, interaction):
        t = self.table
        if t.phase != "draw" or interaction.user.id not in t.players or interaction.user.id not in t.hands:
            return await interaction.response.send_message("進行中の参加者だけが操作できます。", ephemeral=True)
        if interaction.user.id in t.submitted:
            return await interaction.response.send_message("すでに交換を確定しています。", ephemeral=True)
        view = discord.ui.View(timeout=DRAW_SECONDS)
        view.add_item(DiscardSelect(self.cog, t, interaction.user.id))
        await interaction.response.send_message(
            "あなたの手札（相手には見えません）。交換したいカードを選択してください。",
            ephemeral=True, view=view, file=hand_file(t.hands[interaction.user.id]))

    async def _leave(self, interaction):
        t = self.table
        if interaction.user.id not in t.players:
            return await interaction.response.send_message("参加者だけが操作できます。", ephemeral=True)
        t.leaving.add(interaction.user.id)
        await interaction.response.send_message("このハンドで退出します（残チップはハンド終了時に精算されます）。", ephemeral=True)


DrawView = DrawPanel  # 互換名


class ContinuePanel(GamePanelView):
    """ハンド間の継続確認パネル（V2）。リバイイン用セレクトつき。"""

    def __init__(self, cog, table, body: str = ""):
        super().__init__("ポーカー：次のハンド", body, timeout=CONTINUE_SECONDS + 30)
        self.cog, self.table = cog, table
        self.buyin_select = BuyInSelect(cog, table)
        self.add_row(self.buyin_select)
        self.next_hand = _panel_button("次のハンドへ", discord.ButtonStyle.success, self._next_hand)
        self.leave_table = _panel_button("退出（チップをコインに精算）", discord.ButtonStyle.danger, self._leave_table)
        self.close_table_btn = _panel_button("テーブルを閉じる（募集主）", discord.ButtonStyle.secondary, self._close_table)
        self.add_row(self.next_hand, self.leave_table, self.close_table_btn)

    async def _next_hand(self, interaction):
        t = self.table
        if interaction.user.id not in t.players:
            return await interaction.response.send_message("参加者だけが操作できます。", ephemeral=True)
        if t.stacks.get(interaction.user.id, 0) < ANTE:
            return await interaction.response.send_message("チップがアンティ未満です。リバイインするか退出してください。", ephemeral=True)
        t.ready.add(interaction.user.id)
        await interaction.response.send_message("次のハンドに参加します。", ephemeral=True)

    async def _leave_table(self, interaction):
        t = self.table
        if interaction.user.id not in t.players:
            return await interaction.response.send_message("参加者だけが操作できます。", ephemeral=True)
        ok = await self.cog.cash_out(t, interaction.user.id)
        if not ok:
            return await interaction.response.send_message("精算に失敗しました。チップは台帳に残り、Bot再起動時に自動で返金されます。", ephemeral=True)
        t.players.pop(interaction.user.id, None)
        t.ready.discard(interaction.user.id)
        await interaction.response.send_message("チップをコインに精算して退出しました。", ephemeral=True)

    async def _close_table(self, interaction):
        t = self.table
        if interaction.user.id != t.host_id:
            return await interaction.response.send_message("閉じられるのは募集主だけです。", ephemeral=True)
        t.close_requested = True
        await interaction.response.send_message("テーブルを閉じます。全員のチップを精算します。", ephemeral=True)


ContinueView = ContinuePanel  # 互換名


def _round_signature(r):
    return (r.current_player(), r.current_bet, len(r.folded),
            tuple(sorted(r.contributions.items())))


class Poker(commands.Cog):
    def __init__(self, bot):
        self.bot, self.games = bot, {}
        self.custody = ChipCustodyStore()
        self._refunded = False

    # ------------------------------------------------------------------
    # コイン移動（wallet の安全な経路 + 取引履歴）
    # ------------------------------------------------------------------
    def _wallet(self):
        return self.bot.get_cog("WalletCog") if hasattr(self.bot, "get_cog") else None

    async def _record_history(self, sender_id, receiver_id, amount, reason):
        try:
            await asyncio.to_thread(lambda: config.db_api.table("transaction_history").insert({
                "sender_id": sender_id, "receiver_id": receiver_id,
                "amount": amount, "reason": reason,
            }).execute())
        except Exception:
            logger.exception("poker: 取引履歴の記録に失敗 sender=%s receiver=%s amount=%s",
                             sender_id, receiver_id, amount)

    async def buy_in(self, t, user, amount):
        """コイン→チップ。(成功可否, メッセージ) を返す。"""
        # 逮捕中はマネー系全面禁止 (E-7)。マネージャンルの execute_* と同型に
        # prison の一元チェックで入口を拒否する。
        blocked = prison_core.block_message(str(user.id))
        if blocked:
            return False, blocked
        if user.id not in t.players:
            return False, "このテーブルに参加していません。"
        if amount not in BUYIN_OPTIONS:
            return False, "バイイン額が不正です。"
        if t.phase == "buyin" and t.stacks.get(user.id, 0) > 0:
            return False, "すでにバイイン済みです。"
        if t.phase == "continue" and t.stacks.get(user.id, 0) >= REBUY_MAX_STACK:
            return False, f"リバイインはスタックが {REBUY_MAX_STACK} 未満のときだけできます。"
        if t.phase not in ("buyin", "continue"):
            return False, "今はバイインできません。"
        wallet = self._wallet()
        if wallet is None:
            return False, "コイン機能が読み込まれていません。"
        result = await wallet._change_balance(str(user.id), -amount, require_funds=True)
        if result is INSUFFICIENT:
            return False, f"残高が不足しています（{amount:,} AGO 必要です）。"
        if result is None:
            return False, "バイインの処理に失敗しました。もう一度お試しください。"
        await self._record_history(str(user.id), POKER_HOUSE_ID, amount, "poker_buyin")
        t.stacks[user.id] = t.stacks.get(user.id, 0) + amount
        self.custody.set(t.channel_id, user.id, t.stacks[user.id])
        return True, f"{amount:,} チップをバイインしました（残りスタック {t.stacks[user.id]:,}）。"

    async def cash_out(self, t, uid):
        """残チップ→コイン。成功したら True。失敗時は台帳を残して False。"""
        # 逮捕中はマネー系全面禁止 (E-7)。拒否時はチップを台帳に残したまま
        # False を返し、釈放後の精算・再起動時の自動返金で戻る経路を残す
        # (起動時の未精算返金 _refund_orphaned はユーザー操作ではないため
        # ここを通らず従来どおり返金される)。
        if prison_core.block_message(str(uid)):
            return False
        amount = t.stacks.get(uid, 0)
        if amount <= 0:
            t.stacks.pop(uid, None)
            self.custody.set(t.channel_id, uid, 0)
            return True
        wallet = self._wallet()
        if wallet is None:
            return False
        result = await wallet._change_balance(str(uid), amount, create_with=NEW_USER_BALANCE)
        if result is None or result is INSUFFICIENT:
            logger.critical("poker: 精算に失敗しました。台帳に残し再起動時に返金します user=%s amount=%s", uid, amount)
            return False
        await self._record_history(POKER_HOUSE_ID, str(uid), amount, "poker_cashout")
        t.stacks[uid] = 0
        self.custody.set(t.channel_id, uid, 0)
        return True

    async def _refund_orphaned(self):
        """起動時: 前回の未精算チップを台帳から全額返金する（初回のみ）。"""
        if self._refunded:
            return
        wallet = self._wallet()
        if wallet is None:
            return
        entries = self.custody.entries()
        live = set(self.games)
        self._refunded = True
        for channel_id, users in entries.items():
            if channel_id in live:
                continue
            for uid, amount in users.items():
                try:
                    result = await wallet._change_balance(str(uid), amount, create_with=NEW_USER_BALANCE)
                    if result is None or result is INSUFFICIENT:
                        logger.critical("poker: 未精算チップの返金に失敗しました。手動対応が必要です user=%s amount=%s", uid, amount)
                        continue
                    await self._record_history(POKER_HOUSE_ID, str(uid), amount, "poker_chips_refund")
                    self.custody.set(channel_id, uid, 0)
                    logger.info("poker: 未精算チップを返金しました user=%s amount=%s", uid, amount)
                except Exception:
                    logger.exception("poker: 未精算チップの返金で例外 user=%s", uid)

    @commands.Cog.listener()
    async def on_ready(self):
        await self._refund_orphaned()

    # ------------------------------------------------------------------
    # テーブルの進行
    # ------------------------------------------------------------------
    async def start_recruit(self, interaction):
        await self._refund_orphaned()
        channel = interaction.channel
        if channel.id in self.games:
            return await interaction.response.send_message("このチャンネルでは既にゲーム中です。", ephemeral=True)
        t = PokerTable(channel.id, interaction.guild_id, interaction.user.id)
        t.players[interaction.user.id] = interaction.user
        self.games[channel.id] = t
        try:
            lobby = LobbyView(
                title="ポーカー（チップ制・5枚ドロー）参加者募集", host=interaction.user,
                min_players=2, max_players=MAX_PLAYERS,
                note=(f"{interaction.user.mention} さんが募集中です。\n"
                      f"{RECRUIT_SECONDS}秒以内に参加してください。\n"
                      f"参加後にバイイン（{'/'.join(f'{a:,}' for a in BUYIN_OPTIONS)} AGO→チップ）が必要です。"),
                timeout=RECRUIT_SECONDS + 30)
            await game_panels.send_as_response(interaction, channel, "party", lobby)
            for _ in range(RECRUIT_SECONDS * 2):
                if lobby.started or lobby.cancelled:
                    break
                await asyncio.sleep(0.5)
            lobby.stop()
            if lobby.cancelled:
                return
            t.players = dict(lobby.members)
            await self.run_table(channel, t)
        finally:
            t.phase = "done"
            self.games.pop(channel.id, None)

    async def run_table(self, channel, t):
        if len(t.players) < 2:
            await game_panels.clear(channel, "party")
            await channel.send(view=text_panel("", "参加者が2人集まらなかったため、ポーカーを開始できませんでした。"))
            return
        t.phase = "buyin"
        await game_panels.replace(channel, "party", view=BuyInPanel(
            self, t,
            body=(f"{BUYIN_SECONDS}秒以内にバイイン額を選んでください（チップ=コイン等価）。\n"
                  "バイインした人だけで始めます。募集主は2人以上バイインしたら「開始する」を押せます。")))
        elapsed = 0
        while elapsed < BUYIN_SECONDS and t.phase == "buyin":
            if t.start_requested and len(t.stacks) >= 2:
                break
            if len(t.stacks) >= len(t.players) and len(t.stacks) >= 2:
                break
            await asyncio.sleep(1)
            elapsed += 1
        # バイインしなかった人はテーブルから外れる（コインは動いていない）
        for uid in [uid for uid in t.players if t.stacks.get(uid, 0) <= 0]:
            del t.players[uid]
        if len(t.players) < 2:
            for uid in list(t.stacks):
                await self.cash_out(t, uid)
            await game_panels.clear(channel, "party")
            await channel.send(view=text_panel("", "バイインした人が2人集まらなかったため、ポーカーを開始できませんでした（チップは精算済みです）。"))
            return
        await channel.send(view=text_panel(
            "ポーカー開始",
            "\n".join(f"{t.players[uid].mention}: {t.stacks[uid]:,} チップ（アンティ {ANTE}）" for uid in t.players)))
        while len(t.players) >= 2:
            seated = [uid for uid in t.players if t.stacks.get(uid, 0) >= ANTE]
            if len(seated) < 2:
                break
            await self.run_hand(channel, t, seated)
            t.hands_played += 1
            # ハンド終了時退出の精算
            for uid in list(t.leaving):
                await self.cash_out(t, uid)
                t.players.pop(uid, None)
            t.leaving.clear()
            if len(t.players) < 2:
                break
            if not await self._continue_phase(channel, t):
                break
        await self._close_table(channel, t)

    async def _continue_phase(self, channel, t):
        """ハンド間の継続確認。次ハンドへ進むなら True。"""
        t.phase = "continue"
        t.ready = set()
        t.close_requested = False
        stacks_line = " / ".join(f"{t.players[uid].mention}: {t.stacks.get(uid, 0):,}" for uid in t.players)
        await game_panels.replace(channel, "party", view=ContinuePanel(
            self, t,
            body=(f"現在のスタック: {stacks_line}\n"
                  f"{CONTINUE_SECONDS}秒以内に「次のハンドへ」を押してください。"
                  f"スタック {REBUY_MAX_STACK} 未満の人はリバイイン（上の選択）もできます。")))
        elapsed = 0
        while elapsed < CONTINUE_SECONDS and t.phase == "continue":
            if t.close_requested:
                return False
            can_play = [uid for uid in t.players if t.stacks.get(uid, 0) >= ANTE]
            if len(can_play) >= 2 and all(uid in t.ready for uid in can_play):
                return True
            await asyncio.sleep(1)
            elapsed += 1
        return False

    async def _close_table(self, channel, t):
        lines = []
        for uid in list(t.players):
            amount = t.stacks.get(uid, 0)
            ok = await self.cash_out(t, uid)
            name = t.players[uid].mention
            if amount > 0 and ok:
                lines.append(f"{name}: {amount:,} チップをコインに精算")
            elif amount > 0:
                lines.append(f"{name}: {amount:,} チップの精算に失敗（再起動時に自動返金されます）")
        description = f"{t.hands_played} ハンドで終了しました。"
        if lines:
            description += "\n" + "\n".join(lines)
        # 役割を終えた進行パネル（継続確認など）を片付け、結果だけを残す。
        await game_panels.clear(channel, "party")
        await channel.send(view=text_panel("ポーカー 終了", description))

    # ------------------------------------------------------------------
    # ハンドの進行
    # ------------------------------------------------------------------
    async def run_hand(self, channel, t, seated):
        t.phase = "betting"
        t.deck = deck()
        _SHUFFLE_RNG.shuffle(t.deck)
        t.hands = {uid: [t.deck.pop() for _ in range(5)] for uid in seated}
        t.submitted = set()
        # アンティ（スタック→ポット。台帳上の預かり総額は変わらない）
        contributions = {}
        for uid in seated:
            pay = min(ANTE, t.stacks[uid])
            t.stacks[uid] -= pay
            contributions[uid] = pay
        round_ = BettingRound(seated, t.stacks)
        await channel.send(view=text_panel(
            f"ポーカー：ハンド {t.hands_played + 1}",
            f"アンティ {ANTE} を全員が出しました（ポット {sum(contributions.values()):,}）。\n"
            "ベットは「コール／チェック」「レイズ（+20）」「フォールド」で順番に行います。"))
        while not round_.is_complete():
            uid = round_.current_player()
            if uid is None:
                break
            if uid in t.leaving:
                round_.act(uid, "fold")
                continue
            signature = _round_signature(round_)
            to_call = round_.to_call(uid)
            bet_line = f"現在のベット {round_.current_bet:,}（コールには {to_call:,}）" if round_.current_bet else "まだベットはありません（チェック可）"
            await game_panels.replace(channel, "party", view=BettingPanel(
                self, t, round_,
                body=(f"{t.players[uid].mention} さんの番です。{bet_line}。\n"
                      f"ポット {sum(contributions.values()) + sum(round_.contributions.values()):,} / あなたのスタック {t.stacks[uid]:,}\n"
                      f"（{BET_SECONDS}秒で自動フォールド、コール不要なら自動チェック）")))
            elapsed = 0
            while elapsed < BET_SECONDS and _round_signature(round_) == signature and t.phase == "betting":
                await asyncio.sleep(1)
                elapsed += 1
            if _round_signature(round_) == signature and t.phase == "betting":
                # 時間切れ: コール不要ならチェック、必要ならフォールド
                try:
                    round_.act(uid, "call" if round_.to_call(uid) == 0 else "fold")
                except ValueError:
                    pass
        for uid in seated:
            contributions[uid] += round_.contributions[uid]
        folded = set(round_.folded)
        live = [uid for uid in seated if uid not in folded]
        if len(live) > 1:
            t.phase = "draw"
            await game_panels.replace(channel, "party", view=DrawPanel(
                self, t,
                body=f"残った人だけ、{DRAW_SECONDS}秒以内に手札を確認し、交換するカードを最大3枚選んでください。"))
            elapsed = 0
            while len(t.submitted) < len(live) and elapsed < DRAW_SECONDS and t.phase == "draw":
                await asyncio.sleep(1)
                elapsed += 1
        await self._showdown(channel, t, contributions, folded)

    async def _showdown(self, channel, t, contributions, folded):
        t.phase = "showdown"
        live = [uid for uid in contributions if uid not in folded]
        scores, labels = {}, {}
        for uid in live:
            scores[uid], labels[uid] = evaluate(t.hands[uid])
        payouts, rake = settle_hand(t.stacks, contributions, folded, scores)
        pot = sum(contributions.values())
        # 台帳の付け直し: 精算後はスタックのみが預かり（拠出は分配済み）
        for uid in t.stacks:
            self.custody.set(t.channel_id, uid, t.stacks[uid])
        for uid, amount in payouts.items():
            if amount > 0:
                await party_ranking.shared().record_win(t.guild_id, uid, GAME_ID)
        lines = [f"ポット {pot:,}（レーキ {rake:,} を差し引き）"]
        for uid in contributions:
            name = getattr(t.players[uid], "display_name", str(uid))
            if uid in folded:
                # フォールドした手札は公開しない（sweep2 GA-27）。
                lines.append(f"{name}: フォールド")
            else:
                hand = " ".join(label_card(c) for c in t.hands[uid])
                gain = payouts.get(uid, 0)
                lines.append(f"{name}: **{labels[uid]}** — {hand}（+{gain:,}）")
        lines.append("スタック: " + " / ".join(f"{getattr(t.players[uid], 'display_name', str(uid))} {t.stacks.get(uid, 0):,}" for uid in t.players))
        # ショーダウンに残った手札だけを公開する（フォールド分はテキスト・画像ともに出さない）。
        # 共有画像として各プレイヤーの手札を行で描く。本ゲームは5枚ドローで
        # コミュニティカードは存在しないため、共有画像はこの開示が担う。
        rows = []
        for uid in contributions:
            if uid in folded:
                continue
            name = getattr(t.players[uid], "display_name", str(uid))
            rows.append((f"{name}（{labels[uid]}）", hand_specs(t.hands[uid])))
        data = render_cached(
            ("poker-showdown", tuple((label, specs) for label, specs in rows)),
            lambda: render_card_rows([(label, list(specs)) for label, specs in rows],
                                     title="ショーダウン"))
        panel = GamePanelView("ポーカー：ショーダウン", "\n".join(lines), timeout=None)
        gallery = discord.ui.MediaGallery()
        gallery.add_item(media="attachment://poker_showdown.png")
        panel.add_extra(gallery)
        await channel.send(view=panel, file=discord.File(io.BytesIO(data), filename="poker_showdown.png"))


async def setup(bot):
    await bot.add_cog(Poker(bot))
