# -*- coding: utf-8 -*-
"""マネーパネル: マネー系の実行を1つのパネルに集約する統合画面。

/general のマネージャンルには個別アクションが20件以上並んでいて、
1操作ごとにパネルを開き直す必要があった。このパネルは /game の画面の
ように、上部にその場の判断に必要なステータス（コイン残高・トークン
残高とレート・所持アイテム・加工機・宝くじ・採掘）を集約表示し、
カテゴリ切替で各機能をそのまま実行できる入口にする。

実行そのものは各 cog の既存の実行部と dispatch を再利用し、ここでは
二重化しない:
- モーダル系・別ビューを開く系は GeneralCog.dispatch_general 経由で
  既存アクション（general:token_buy 等）をそのまま呼ぶ
- その場で完結する系（採掘・受け取り・宝箱）は各 cog の execute_* を
  呼び、結果表示後にパネルを最新ステータスへ更新する

パネルは他の経済系パネルと同様、core/support/panel_v2.py の PanelLayoutView
で包んでコンポーネントV2表示にする（embed は非同期に集約するため、
ビルド結果をキャッシュして embed() から返す）。賭け金エスクロー等の
資産保全は各 cog 側の仕組みに任せるため、
パネルが死んでも資産は消えない。入口は新規スラッシュを作らず、
/general の action 経由（general:money_panel）だけ。表示は他のマネー系
パネルと同じく公開で、操作は interaction_check で本人のみに制限する。
パネルを開く自体は読み取り扱いで AI tools の対象外にはしないが、
メッセージ経由ショートカットの候補には入れない
（core/action_registry の MESSAGE_SHORTCUT_BLOCKED_IDS、items /
workshop と同じ扱い）。
"""
from __future__ import annotations

import asyncio
import inspect
import io
import logging
import random
import re
from datetime import datetime
from typing import Callable

import discord
from discord.ext import commands

import config
from core.general import economy_helpers
from core.economy_image import PanelHero, PanelRow, render_panel_png
from core.general.money_panel import daily_bonus as daily_core
from core.general.items import items as items_core
from core.general.market import market as market_core
from core.general.user_names import resolve_display_names
from core.game.game import prison as prison_core
from core.general.money_panel import starter as starter_core
from core.leaderboard_image import fetch_avatar_bytes
from core.support.messages import ACTION_FAILED_RETRY, CLAIM_FAILED_RETRY, ITEMS_NOT_LOADED, WORKSHOP_NOT_LOADED, feature_not_loaded
from core.support.panel_v2 import as_panel_v2, edit_message_v2, edit_panel_v2, wrap_panel_view as _wrap
from cogs import general as wallet_module  # 定数は実行時に引く（テストの cog 再読込対策）

logger = logging.getLogger(__name__)

MONEY_PANEL_COLOR = 0xF39C12
STATUS_FILENAME = "money_status.png"
MONEY_ACCENT = (217, 164, 32)


#: カテゴリ定義（value, ラベル）。コンポーネント上限（25）の関係で
#: 操作はカテゴリごとにページングする。
CATEGORIES: tuple[tuple[str, str], ...] = (
    ("home", "概要"),
    ("market", "市場（交換）"),
    ("items", "アイテム"),
    ("craft", "合成・工房（生産）"),
    ("play", "あそぶ"),
    ("more", "その他"),
)
CATEGORY_LABELS = dict(CATEGORIES)

#: ギャンブルのセッション種別 → 表示名。
_SESSION_LABELS = {
    "slot": "スロット",
    "double": "ダブルアップ",
    "blackjack": "ブラックジャック",
}


_fmt_tokens = economy_helpers.fmt_tokens


def _fmt_minutes(seconds: float) -> str:
    """残り時間の表記は prison の format_remaining に統一する（S4-1）。"""
    return prison_core.format_remaining(seconds)


def _next_step_line(status: dict) -> str | None:
    """「次の1手」を最大1行で返す（S4-1、優先順位つき）。

    逮捕中 → 工房の受け取り可 → スターター未受取 → デイリーボーナス
    未受取 → 残高が少ない の順で、最初に当たったものだけを出す。
    どれにも当たらなければ何も出さない。
    """
    if status.get("prison_remaining"):
        # 逮捕状態は公開パネルに出さない（B-2）。本人への通知は
        # show_panel の ephemeral フォローアップが担うため、ここでは
        # 出さない。逮捕中は他の「次の1手」も実行できないので None でよい。
        return None
    if status.get("workshop_ready"):
        return "🏭 工房で受け取りができます。"
    if status.get("starter_claimed") is False:
        return "🎁 スターターを受け取れます。"
    if status.get("daily_claimed") is False:
        return "🎁 今日のボーナスを受け取れます。"
    if (status.get("balance") is not None
            and status["balance"] < starter_core.GUIDE_BALANCE_THRESHOLD):
        # 残高が少ないユーザー向けの導線は1行だけ（チュートリアルは作らない）。
        return "まずは採掘と宝くじから始めてみてください。"
    return None


def status_embed(status: dict, *, image: bool = False) -> discord.Embed:
    """collect_status の結果をパネル上部のステータス表示にする。

    image=True のときは数値表示をステータスカード画像（status_panel_png）
    に寄せ、embed はタイトルと画像参照だけを持つ（V2 変換で画像は
    MediaGallery に残り、本文の二重表示を避ける）。「次の1手」も
    画像内のバナーに移るため description には入れない。
    """
    embed = discord.Embed(title="マネーパネル", color=MONEY_PANEL_COLOR)
    if image:
        embed.set_image(url=f"attachment://{STATUS_FILENAME}")
        return embed
    # B-2: 逮捕状態（逮捕中であること・残り時間）は公開パネルに出さない。
    # S4 の線引き（逮捕・没収・脱獄の結果は ephemeral）に合わせ、状態も
    # 本人にだけ ephemeral で知らせる（show_panel 参照）。残高等の表示は
    # 公開原則どおり維持する。行データは status_panel_content が真実で、
    # ここはそのテキスト版への整形だけを行う。
    next_step = _next_step_line(status)
    if next_step is not None:
        embed.description = next_step
    hero, _banner, sections = status_panel_content(status)
    embed.add_field(name="AGOコイン", value=f"**{hero.value}**", inline=True)
    if hero.sub:
        embed.add_field(
            name="総資産",
            value=f"**{hero.sub.removeprefix('総資産 ')}**", inline=True)
    for section_title, rows in sections:
        if section_title is None:
            for row in rows:
                embed.add_field(
                    name=row.label, value=_status_field_value(row),
                    inline=row.label != "工房")
        else:
            lines = [f"・{row.label}（{row.value}）" for row in rows]
            embed.add_field(name=section_title, value="\n".join(lines), inline=False)
    return embed


def _status_field_value(row) -> str:
    """ステータス行のテキスト版の値（画像行と同じ値・並び）。"""
    if row.label == market_core.TOKEN_NAME:
        return f"**{row.value}**（{row.sub}）"
    if row.label == "編成":
        return f"**{row.value}**"
    if row.label == "アイテム":
        text = f"{row.value}／{row.sub}" if row.sub else row.value
        return re.sub(r"(\d[\d,]*) 個", r"**\1 個**", text)
    if row.sub:
        return f"{row.value}／{row.sub}"
    return row.value


# 画像内バナーではカラー絵文字が同梱フォントに無く豆腐化するため、
# 先頭の絵文字だけ落として文字情報だけを残す（embed 側の文言は不変）。
_BANNER_EMOJI_RE = re.compile(
    r"^[\U0001F000-\U0001FAFF☀-➿️]+\s*")


def status_panel_content(status: dict, *, user_id: int | None = None,
                         name: str = ""):
    """ステータスカード画像の (hero, banner, sections) を組み立てる。

    行の内容は status_embed のフィールドと同一の値・並びにする
    （表示層の置き換えであり、数値の意味は変えない）。
    """
    next_step = _next_step_line(status)
    banner = _BANNER_EMOJI_RE.sub("", next_step) if next_step else ""
    hero = PanelHero(
        label="AGOコイン",
        value=f"{status['balance']:,} AGO",
        sub=(f"総資産 {status['total_assets']:,} AGO"
             if status.get("total_assets") is not None else ""),
        user_id=user_id, name=name)
    rows: list[PanelRow] = []
    if status.get("rate") is not None:
        rows.append(PanelRow(
            market_core.TOKEN_NAME, _fmt_tokens(status["tokens"]),
            sub=f"レート {status['rate']:,.2f} AGO"))
    if status.get("items_total") is not None:
        sub = f"宝箱 {status['boxes']} 個"
        if status["effects"]:
            sub += f"／効果発動中 {status['effects']} 件"
        rows.append(PanelRow(
            "アイテム",
            f"全 {status['items_total']} 個（{status['items_kinds']} 種）",
            sub=sub))
    if status.get("machines") is not None:
        if status["machines"]:
            sub = f"受け取り待ち {status['pending_cycles']} サイクル分"
            if status["min_cycles_left"] is not None:
                sub += f"／最短の残り寿命 {status['min_cycles_left']} サイクル"
            if status["commissions_total"]:
                sub += (f"／委託 {status['commissions_total']} 件"
                        f"（受け取り可能 {status['commissions_ready']} 件）")
            value = f"{status['machines']} 台"
        else:
            sub = ""
            value = "加工機なし"
        if status["streak_days"]:
            sub += (f"{'／' if sub else ''}ストリーク "
                    f"{status['streak_days']} 日（生産ボーナスあり）")
        rows.append(PanelRow("工房", value, sub=sub))
    if status.get("lottery_pool") is not None:
        rows.append(PanelRow(
            "宝くじ", f"プール {status['lottery_pool']:,} AGO",
            sub=(f"自分のチケット {status['lottery_tickets']} 枚"
                 f"（締切 {status['lottery_closes']}）")))
    if status.get("mining_session_left") is not None:
        if status["mining_session_left"] > 0:
            state = f"掘れます（セッション残り {status['mining_session_left']} 回）"
        elif status["mining_ready"]:
            state = "いま掘れます"
        else:
            state = f"次まで {_fmt_minutes(status['mining_remaining'])}"
        rows.append(PanelRow(
            "採掘", state, sub=f"プール {status['mining_pool']:,} AGO"))
    if status.get("session_kind"):
        label = _SESSION_LABELS.get(
            status["session_kind"], status["session_kind"])
        rows.append(PanelRow("ギャンブル", f"{label} のセッション進行中"))
    if status.get("party_count") is not None:
        rows.append(PanelRow("編成", f"{status['party_count']} 体"))
    sections: list = [(None, rows)]
    if status.get("active_effect_details"):
        effect_rows = [
            PanelRow(detail["name"],
                     f"あと{_fmt_minutes(detail['remaining'])}")
            for detail in status["active_effect_details"]
        ]
        sections.append(("発動中の効果", effect_rows))
    return hero, banner, sections


def status_panel_png(status: dict, *, user_id: int | None = None,
                     name: str = "", avatar_bytes: bytes | None = None
                     ) -> bytes:
    """ステータス dict から白基調のステータスカード画像を描く。"""
    hero, banner, sections = status_panel_content(
        status, user_id=user_id, name=name)
    avatars = {user_id: avatar_bytes} if user_id is not None else {}
    return render_panel_png(
        title="マネーパネル", accent=MONEY_ACCENT, banner=banner,
        hero=hero, sections=sections, avatars=avatars,
        cache_namespace="money-status")


class MoneyPanelView(discord.ui.View):
    """カテゴリ切替つきの統合パネル。ボタンは既存の実行部へ委譲する。"""

    def __init__(self, cog: "MoneyPanelCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.category = "home"
        self.message: discord.Message | None = None
        self._v2 = None
        self._cached_embed: discord.Embed | None = None
        self._status_png: bytes | None = None
        # 逮捕中だけ概要に脱獄ボタンを出す（build_embed で状態が入る）。
        self._prison = False
        # 未受け取りの間だけ概要にスターターボタンを出す（同上）。
        self._starter = False
        # デイリーボーナスも未受取の間だけ概要に出す（S6-1、同上）。
        self._daily = False
        self.refresh()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        """V2 ラッパー用の同期的 embed（実体は非同期ビルドのキャッシュ）。"""
        if self._cached_embed is not None:
            return self._cached_embed
        return discord.Embed(title="マネーパネル", color=MONEY_PANEL_COLOR)

    # ------------------------------------------------------------------ 構築
    def refresh(self) -> None:
        self.clear_items()
        select = discord.ui.Select(
            placeholder="カテゴリを選択してください",
            options=[
                discord.SelectOption(
                    label=label, value=value, default=value == self.category)
                for value, label in CATEGORIES
            ],
            row=0,
        )
        select.callback = self._on_category
        self.add_item(select)
        for label, style, handler in self._buttons_for(self.category):
            self._add_button(label, style, handler)
        if self.category == "home" and getattr(self, "_starter", False):
            self._add_button(
                "スターターを受け取る", discord.ButtonStyle.success,
                self._claim_starter)
        if self.category == "home" and getattr(self, "_daily", False):
            self._add_button(
                "今日のボーナスを受け取る", discord.ButtonStyle.success,
                self._claim_daily)
        if self.category == "home" and getattr(self, "_prison", False):
            self._add_button(
                "脱獄を試みる", discord.ButtonStyle.danger, self._jailbreak)

    def _add_button(self, label: str, style: discord.ButtonStyle, handler) -> None:
        # ボタンは最大5個で自動的に次の行へ回す（Select が row 0 を使う）。
        index = len(self.children) - 1  # Select 分を引いたボタン数
        button = discord.ui.Button(
            label=label, style=style, row=1 + index // 5)
        button.callback = handler
        self.add_item(button)

    def _buttons_for(self, category: str):
        """(ラベル, スタイル, ハンドラ) の並び。ハンドラはこのビューのメソッド。"""
        primary = discord.ButtonStyle.primary
        success = discord.ButtonStyle.success
        danger = discord.ButtonStyle.danger
        secondary = discord.ButtonStyle.secondary
        if category == "market":
            return [
                ("買う", success, self._dispatch("token_buy")),
                ("売る", danger, self._dispatch("token_sell")),
                ("市場パネル", primary, self._dispatch("market")),
            ]
        if category == "items":
            return [
                ("買う", success, self._dispatch("item_buy")),
                ("売る", primary, self._item_sell),
                ("使う", primary, self._dispatch("item_use")),
                ("宝箱を開ける", danger, self._open_boxes),
                ("アイテムパネル", secondary, self._dispatch("items")),
                ("ロールショップ", secondary, self._dispatch("role_shop")),
            ]
        if category == "craft":
            return [
                ("合成する", success, self._dispatch("craft")),
                ("生産物を受け取る", primary, self._claim_production),
                ("委託を受け取る", primary, self._claim_commissions),
                ("加工機を買う", success, self._dispatch("machine_buy")),
                ("工房パネル", secondary, self._dispatch("workshop")),
            ]
        if category == "play":
            return [
                ("採掘する", success, self._dig),
                ("宝くじを買う", primary, self._dispatch("lottery_buy")),
                ("宝くじパネル", secondary, self._dispatch("lottery")),
                ("盗む", danger, self._dispatch("steal")),
                ("スロット", primary, self._dispatch("slot")),
                ("ダブルアップ", primary, self._dispatch("double")),
                ("ブラックジャック", primary, self._dispatch("blackjack")),
                ("ブラックジャック対決", primary, self._dispatch("bj_duel")),
                ("ダイスベット", primary, self._dispatch("dice")),
                ("ガチャ", primary, self._dispatch("gacha")),
            ]
        if category == "more":
            return [
                ("送金", primary, self._dispatch("pay")),
                ("プレイヤー状況", secondary, self._dispatch("status")),
                ("コイン保有ランキング", secondary, self._dispatch("coin_leaderboard")),
                ("日報DMを設定", secondary, self._dispatch("daily_report")),
                ("クラン", secondary, self._dispatch("clan")),
            ]
        # home: よく使う即時操作をその場で完結させる。
        return [
            ("採掘する", success, self._dig),
            ("生産物を受け取る", primary, self._claim_production),
            ("委託を受け取る", primary, self._claim_commissions),
            ("宝箱を開ける", danger, self._open_boxes),
        ]

    # ------------------------------------------------------------------ 共通動作
    async def build_embed(self) -> discord.Embed:
        status = await self.cog.collect_status(self.user_id)
        self._prison = bool(status.get("prison_remaining"))
        self._starter = status.get("starter_claimed") is False
        self._daily = status.get("daily_claimed") is False
        # 概要の数値表示は白基調のステータスカード画像に寄せる。描画に
        # 失敗したら従来のフィールド表示へ落とす（パネル自体は落とさない）。
        self._status_png = None
        try:
            names = await resolve_display_names(
                self.cog.bot, [self.user_id])
            avatars = await fetch_avatar_bytes(
                self.cog.bot, [self.user_id])
            self._status_png = await asyncio.to_thread(
                status_panel_png, status, user_id=self.user_id,
                name=names.get(self.user_id, ""),
                avatar_bytes=avatars.get(self.user_id))
        except Exception:
            logger.exception("money_panel: ステータス画像の生成に失敗しました")
            self._status_png = None
        return status_embed(status, image=self._status_png is not None)

    def panel_files(self) -> list[discord.File] | None:
        if self._status_png is None:
            return None
        return [discord.File(io.BytesIO(self._status_png),
                             filename=STATUS_FILENAME)]

    async def _on_category(self, interaction: discord.Interaction):
        values = getattr(interaction, "data", {}).get("values") or self._select_values()
        if values:
            self.category = values[0]
        self._cached_embed = await self.build_embed()
        self.refresh()
        container = getattr(self, "_v2", None)
        if container is not None:
            container._sync()
            await edit_panel_v2(interaction, container,
                                files=self.panel_files())
        else:
            await interaction.response.edit_message(
                embed=self._cached_embed, view=self)

    def _select_values(self) -> list:
        for child in self.children:
            if isinstance(child, discord.ui.Select):
                return list(child.values)
        return []

    async def refresh_panel(self) -> None:
        """直接実行のあとにパネル本体を最新ステータスへ差し替える。"""
        if self.message is None:
            return
        self._cached_embed = await self.build_embed()
        self.refresh()
        container = getattr(self, "_v2", None)
        try:
            if container is not None:
                container._sync()
                await edit_message_v2(self.message, container,
                                      files=self.panel_files())
            else:
                await self.message.edit(embed=self._cached_embed, view=self)
        except Exception:
            logger.exception("money_panel: パネルの更新に失敗しました")

    def _dispatch(self, value: str):
        """既存アクションへ委譲するボタンのコールバックを作る。

        GeneralCog.dispatch_general がモーダル送信・別ビューの表示・
        未読込時の案内まで面倒を見るので、ここでは受け渡すだけにする。
        利用履歴・総量統計の記録も dispatch 側の入口に集約されたまま。
        """
        async def callback(interaction: discord.Interaction):
            general = self.cog.bot.get_cog("GeneralCog")
            if general is None:
                return await interaction.response.send_message(
                    "この機能は現在利用できません。", ephemeral=True)
            await general.dispatch_general(interaction, value)

        return callback

    async def _run_direct(self, interaction: discord.Interaction, factory,
                          *, ephemeral: bool = False) -> None:
        """その場で完結する実行部を呼び、結果表示後にパネルを更新する。"""
        await interaction.response.defer(ephemeral=ephemeral)
        try:
            result = factory()
            if inspect.isawaitable(result):
                result = await result
        except Exception:
            logger.exception("money_panel: 直接実行に失敗しました")
            result = ACTION_FAILED_RETRY
        await interaction.followup.send(result, ephemeral=ephemeral)
        await self.refresh_panel()

    # ------------------------------------------------------------------ 直接実行
    async def _claim_starter(self, interaction: discord.Interaction):
        await self._run_direct(
            interaction, lambda: self.cog.claim_starter(interaction.user.id))

    async def _claim_daily(self, interaction: discord.Interaction):
        await self._run_direct(
            interaction, lambda: self.cog.claim_daily_bonus(interaction.user.id))

    async def _jailbreak(self, interaction: discord.Interaction):
        # 脱獄は逮捕中の本人だけ（interaction_check で本人に限定済み、
        # ストア側でも逮捕中でなければ何も起きない）。結果は公開
        # ポリシー（S4-2）で本人だけに返す。
        await self._run_direct(
            interaction, lambda: self.cog.attempt_jailbreak(interaction.user.id),
            ephemeral=True)

    async def _dig(self, interaction: discord.Interaction):
        circulation = self.cog.bot.get_cog("CirculationCog")
        if circulation is None:
            return await interaction.response.send_message(
                feature_not_loaded("採掘機能"), ephemeral=True)
        await self._run_direct(
            interaction, lambda: circulation.execute_mining(interaction.user.id))

    async def _item_sell(self, interaction: discord.Interaction):
        # 売却は個別アクションが無く ItemsView のモーダルが正なので、それを流用する。
        items_cog = self.cog.bot.get_cog("ItemsCog")
        if items_cog is None:
            return await interaction.response.send_message(
                ITEMS_NOT_LOADED, ephemeral=True)
        from cogs.general import ItemAmountModal

        await interaction.response.send_modal(ItemAmountModal(items_cog, "sell"))

    async def _open_boxes(self, interaction: discord.Interaction):
        items_cog = self.cog.bot.get_cog("ItemsCog")
        if items_cog is None:
            return await interaction.response.send_message(
                ITEMS_NOT_LOADED, ephemeral=True)
        await self._run_direct(
            interaction, lambda: items_cog.execute_open_boxes(interaction.user.id))

    async def _claim_production(self, interaction: discord.Interaction):
        workshop = self.cog.bot.get_cog("WorkshopCog")
        if workshop is None:
            return await interaction.response.send_message(
                WORKSHOP_NOT_LOADED, ephemeral=True)
        await self._run_direct(
            interaction, lambda: workshop.execute_claim(interaction.user.id))

    async def _claim_commissions(self, interaction: discord.Interaction):
        workshop = self.cog.bot.get_cog("WorkshopCog")
        if workshop is None:
            return await interaction.response.send_message(
                WORKSHOP_NOT_LOADED, ephemeral=True)
        await self._run_direct(
            interaction, lambda: workshop.execute_claim_commissions(interaction.user.id))


class MoneyPanelCog(commands.Cog):
    def __init__(self, bot: commands.Bot,
                 balance_reader: Callable[[str], int] | None = None,
                 starter_store: starter_core.StarterStore | None = None,
                 daily_store: daily_core.DailyBonusStore | None = None,
                 rng: random.Random | None = None):
        self.bot = bot
        self._balance_reader = balance_reader
        self.starter_store = (
            starter_store if starter_store is not None
            else starter_core.StarterStore())
        self.daily_store = (
            daily_store if daily_store is not None
            else daily_core.shared_store())
        self._rng = rng if rng is not None else random.Random()

    # ------------------------------------------------------------------ 残高
    async def _balance(self, user_id: str) -> int:
        """残高の読み取り（行が無いユーザーは新規残高として表示する）。"""
        return await wallet_module.read_user_balance(
            user_id, self._balance_reader,
            missing_balance=wallet_module.NEW_USER_BALANCE)

    # ------------------------------------------------------------------ 集約
    async def collect_status(self, user_id: int) -> dict:
        """各ストアからパネル表示用のステータスを集める（読み取りのみ）。

        cog が未読込のセクションは None にして、表示側で省略する。
        1セクションの失敗でパネル全体を落とさない。
        """
        uid = str(user_id)
        now = datetime.now(config.JST)
        status: dict = {"balance": await self._balance(uid)}

        market_cog = self.bot.get_cog("MarketCog")
        if market_cog is not None:
            try:
                store = market_cog.store
                status["rate"] = float(store.snapshot()["rate"])
                status["tokens"] = float(store.token_balance(uid))
            except Exception:
                logger.exception("money_panel: 市場ステータスの取得に失敗 user=%s", uid)
                status["rate"] = None
        # 総資産は総合資産ランキング（wallet.compute_asset_ranking）と
        # 同じ定義（残高＋トークン時価、時価は小数切り捨て）の表示用導出。
        # 既に取得済みの値からの計算のみで、経済ロジックは変えない。
        if status.get("rate") is not None:
            status["total_assets"] = (
                int(status["balance"])
                + int(float(status["tokens"]) * float(status["rate"])))
        else:
            status["total_assets"] = None

        items_cog = self.bot.get_cog("ItemsCog")
        if items_cog is not None:
            try:
                store = items_cog.store
                inventory = store.inventory(uid)
                status["items_total"] = sum(inventory.values())
                status["items_kinds"] = len(inventory)
                status["boxes"] = int(inventory.get("treasure_box", 0))
                active = store.active_effects(uid)
                status["effects"] = len(active)
                # 状態行の統一表記（S4-1）: 効果名＋残り時間まで出す。
                effect_names = {
                    definition["effect"]: definition["name"]
                    for definition in items_core.ITEM_DEFS.values()
                    if definition.get("effect")
                }
                status["active_effect_details"] = [
                    {
                        "name": effect_names.get(effect_id, effect_id),
                        "remaining": max(
                            0.0, (expires - now).total_seconds()),
                    }
                    for effect_id, expires in sorted(
                        active.items(), key=lambda pair: pair[1])
                ]
            except Exception:
                logger.exception("money_panel: アイテムステータスの取得に失敗 user=%s", uid)
                status["items_total"] = None

        workshop_cog = self.bot.get_cog("WorkshopCog")
        if workshop_cog is not None:
            try:
                store = workshop_cog.workshop_store
                machines = store.machines(uid)
                status["machines"] = len(machines)
                status["pending_cycles"] = int(store.total_pending(uid, now))
                status["min_cycles_left"] = (
                    min(int(m.get("cycles_left", 0)) for m in machines)
                    if machines else None)
                streak = store.streak_status(uid, now)
                status["streak_days"] = int(streak["days"])
                status["streak_bonus"] = float(streak["bonus_rate"])
                jobs = store.commissions(uid)
                status["commissions_total"] = len(jobs)
                status["commissions_ready"] = sum(
                    1 for job in jobs
                    if datetime.fromisoformat(job["ready_at"]) <= now)
                # 「次の1手」用: 受け取れるものがあるかだけを見る（S4-1）。
                status["workshop_ready"] = bool(
                    status["pending_cycles"] > 0
                    or status["commissions_ready"] > 0)
            except Exception:
                logger.exception("money_panel: 工房ステータスの取得に失敗 user=%s", uid)
                status["machines"] = None

        circulation = self.bot.get_cog("CirculationCog")
        if circulation is not None:
            try:
                current = circulation.lottery_store.current_round()
                status["lottery_pool"] = int(current["pool"])
                status["lottery_tickets"] = int(
                    circulation.lottery_store.tickets_of(uid))
                status["lottery_closes"] = datetime.fromisoformat(
                    current["closes_at"]).strftime("%m/%d %H:%M")
            except Exception:
                logger.exception("money_panel: 宝くじステータスの取得に失敗 user=%s", uid)
                status["lottery_pool"] = None
            try:
                mining_status = circulation.mining_store.status(uid)
                status["mining_ready"] = mining_status["cooldown_remaining"] <= 0
                status["mining_remaining"] = float(mining_status["cooldown_remaining"])
                status["mining_session_left"] = int(mining_status["session_left"])
                status["mining_pool"] = int(
                    circulation.economy_store.pool_balance())
            except Exception:
                logger.exception("money_panel: 採掘ステータスの取得に失敗 user=%s", uid)
                status["mining_session_left"] = None

        gambling_cog = self.bot.get_cog("GamblingCog")
        if gambling_cog is not None:
            try:
                session = gambling_cog.store.session(uid)
                status["session_kind"] = session["kind"] if session else None
            except Exception:
                logger.exception("money_panel: ギャンブルステータスの取得に失敗 user=%s", uid)
                status["session_kind"] = None

        try:
            pstatus = self._prison_store().status(uid, now)
            status["prison_remaining"] = (
                float(pstatus["remaining"]) if pstatus["imprisoned"] else None)
        except Exception:
            logger.exception("money_panel: 逮捕ステータスの取得に失敗 user=%s", uid)
            status["prison_remaining"] = None

        try:
            status["starter_claimed"] = self.starter_store.has_claimed(uid)
        except Exception:
            logger.exception("money_panel: スターター状態の取得に失敗 user=%s", uid)
            status["starter_claimed"] = None

        try:
            status["daily_claimed"] = self.daily_store.claimed_today(uid, now)
        except Exception:
            logger.exception("money_panel: デイリーボーナス状態の取得に失敗 user=%s", uid)
            status["daily_claimed"] = None

        gacha_cog = self.bot.get_cog("GachaCog")
        if gacha_cog is not None:
            try:
                status["party_count"] = len(gacha_cog.store.party(uid))
            except Exception:
                logger.exception("money_panel: 編成ステータスの取得に失敗 user=%s", uid)
                status["party_count"] = None

        return status

    async def cog_unload(self) -> None:
        # E-2: 通常再起動でも受け取り記録が消えないよう、終了時に
        # スターター／デイリー両ストアを明示的に flush する
        # （claim_daily_bonus の成功後 flush と同じ永続化方針）。
        self.starter_store.flush()
        self.daily_store.flush()

    # ------------------------------------------------------------------ スターター
    async def claim_starter(self, user_id: int) -> str:
        """スターター一式を1回だけ付与する（受け取り判定はストアで原子的に）。"""
        uid = str(user_id)
        # E-6: claim_daily_bonus と同型に、try_claim の前に prison
        # チェックを入れる（チェック→claim の順序。逮捕中に受け取り
        # 済みにしてしまうと、釈放後に再受取できなくなるため）。
        blocked = prison_core.block_message(uid, store=self._prison_store())
        if blocked:
            return blocked
        if not self.starter_store.try_claim(uid):
            return "スターターは受け取り済みです。"
        wallet = self.bot.get_cog("WalletCog")
        items_cog = self.bot.get_cog("ItemsCog")
        try:
            if wallet is not None:
                result = await wallet._change_balance(
                    uid, starter_core.STARTER_COINS,
                    create_with=wallet_module.NEW_USER_BALANCE)
                if result is None:
                    raise RuntimeError("balance update failed")
            if items_cog is not None:
                items_cog.store.add(
                    uid, starter_core.STARTER_SCRAP_ITEM,
                    starter_core.STARTER_SCRAPS)
        except Exception:
            logger.exception("money_panel: スターター付与に失敗 user=%s", uid)
            self.starter_store.unclaim(uid)
            return CLAIM_FAILED_RETRY
        # E-2: コインは DB へ即時コミットされるため、受け取り記録も
        # 成功直後に flush して永続化する（claim_daily_bonus と同型）。
        # これが無いと通常再起動で記録が巻き戻り再受取できてしまう。
        self.starter_store.flush()
        try:
            await asyncio.to_thread(lambda: config.db_api.table(
                "transaction_history").insert({
                    "sender_id": "starter",
                    "receiver_id": uid,
                    "amount": starter_core.STARTER_COINS,
                    "reason": "starter_grant",
                }).execute())
        except Exception:
            logger.exception("money_panel: スターターの履歴記録に失敗 user=%s", uid)
        return (
            f"🎁 **スターターを受け取りました！** "
            f"{starter_core.STARTER_COINS:,} AGO と "
            f"スクラップ×{starter_core.STARTER_SCRAPS} を付与しました。")

    # ------------------------------------------------------------------ デイリーボーナス（S6-1）
    async def claim_daily_bonus(self, user_id: int) -> str:
        """デイリーボーナスを1日1回（JST日次）だけ付与する。"""
        uid = str(user_id)
        blocked = prison_core.block_message(uid, store=self._prison_store())
        if blocked:
            return blocked
        if not self.daily_store.try_claim(uid):
            return "今日のボーナスは受け取り済みです。"
        wallet = self.bot.get_cog("WalletCog")
        items_cog = self.bot.get_cog("ItemsCog")
        box = False
        try:
            if wallet is not None:
                result = await wallet._change_balance(
                    uid, daily_core.DAILY_BONUS_COINS,
                    create_with=wallet_module.NEW_USER_BALANCE)
                if result is None:
                    raise RuntimeError("balance update failed")
            if items_cog is not None and (
                    self._rng.random() < daily_core.BOX_CHANCE):
                items_cog.store.add(uid, daily_core.BOX_ITEM_ID, 1)
                box = True
        except Exception:
            logger.exception("money_panel: デイリーボーナス付与に失敗 user=%s", uid)
            self.daily_store.unclaim(uid)
            return CLAIM_FAILED_RETRY
        self.daily_store.flush()
        try:
            await asyncio.to_thread(lambda: config.db_api.table(
                "transaction_history").insert({
                    "sender_id": "daily_bonus",
                    "receiver_id": uid,
                    "amount": daily_core.DAILY_BONUS_COINS,
                    "reason": daily_core.HISTORY_REASON,
                }).execute())
        except Exception:
            logger.exception("money_panel: デイリーボーナスの履歴記録に失敗 user=%s", uid)
        message = (
            f"🎁 **デイリーボーナスを受け取りました！** "
            f"{daily_core.DAILY_BONUS_COINS:,} AGO")
        if box:
            message += "＋宝箱×1"
        return message

    # ------------------------------------------------------------------ 逮捕・脱獄
    def _prison_store(self) -> prison_core.PrisonStore:
        """逮捕ストア（circulation の保持分を優先し、無ければ共有ストア）。"""
        circulation = self.bot.get_cog("CirculationCog")
        store = getattr(circulation, "prison_store", None)
        return store if store is not None else prison_core.shared_store()

    async def attempt_jailbreak(self, user_id: int) -> str:
        """脱獄を試み、結果文を返す（成否の抽選と状態更新はストア側）。"""
        result = self._prison_store().attempt_jailbreak(str(user_id))
        outcome = result.get("outcome")
        if outcome == "success":
            return "🔓 **脱獄成功！** 釈放されました。"
        if outcome == "failure":
            return (
                "🔒 脱獄に失敗しました…"
                f"（釈放まであと{prison_core.format_remaining(result['remaining'])}）")
        if outcome == "cooldown":
            return (
                "まだ脱獄を試みられません"
                f"（あと{prison_core.format_remaining(result['wait_seconds'])}）。")
        return "逮捕されていません。"

    # ------------------------------------------------------------------ 入口
    async def show_panel(self, interaction: discord.Interaction):
        view = MoneyPanelView(self, interaction.user.id)
        view._cached_embed = await view.build_embed()
        view.refresh()
        files = view.panel_files()
        if files:
            await interaction.response.send_message(
                view=_wrap(view), files=files)
        else:
            await interaction.response.send_message(view=_wrap(view))
        try:
            view.message = await interaction.original_response()
        except Exception:
            logger.exception("money_panel: パネルのメッセージ取得に失敗しました")
        # B-2: 逮捕状態は公開パネルに出さない代わりに、本人にだけ
        # ephemeral で知らせる（最小の本人確認経路。脱獄試行の結果も
        # 従来どおり ephemeral で返るため、そちらとも整合する）。
        try:
            pstatus = self._prison_store().status(str(interaction.user.id))
            if pstatus.get("imprisoned"):
                await interaction.followup.send(
                    f"🚔 **逮捕中**（釈放まであと"
                    f"{_fmt_minutes(pstatus['remaining'])}）。"
                    "マネー系の操作はできません。",
                    ephemeral=True)
        except Exception:
            logger.exception("money_panel: 逮捕状態の ephemeral 通知に失敗しました")


async def setup(bot: commands.Bot):
    await bot.add_cog(MoneyPanelCog(bot))
