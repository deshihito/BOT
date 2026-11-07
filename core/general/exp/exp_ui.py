# -*- coding: utf-8 -*-
"""EXP ステータス/ランキングの UI。元 cogs/general.py から分割。

ランキングは対話型ボード（軸タブ・範囲切替・ページング・表彰台つき
盤面画像）、ステータスは個人ランクカード画像、加えて各軸の王者を
並べるサーバー活動ボードを提供する。盤面/カードの描画と集計は
exp_board.py の純関数に寄せ、ここは View と非同期の名前/アバター
解決・他機能からの集計だけを持つ。
"""
from __future__ import annotations

import asyncio
import io
import logging

from ..common import *
from .exp import (
    _as_int, _exp_ensure, _exp_load, _exp_root, general_level, level_from_exp,
)
from .exp_board import (
    AXIS_LABELS, PAGE_SIZE, build_rows, find_rank, paginate, render_board_png,
    render_card_png, rival_info, top_clan,
)
from core.support import emojis
from core.general.user_names import cached_display_name, resolve_display_names

logger = logging.getLogger(__name__)

BOARD_FILENAME = "exp_board.png"
CARD_FILENAME = "exp_card.png"


async def _fetch_avatar_bytes(bot, user_ids) -> dict:
    """表示名解決と同じ方針でアバター画像を取得する（失敗は None=代替表示）。"""
    result: dict[int, bytes | None] = {}
    if bot is None:
        return {uid: None for uid in user_ids}
    for uid in user_ids:
        data = None
        try:
            user = bot.get_user(uid)
            if user is None and hasattr(bot, "fetch_user"):
                user = await bot.fetch_user(uid)
            if user is not None:
                data = await user.display_avatar.replace(size=128, format="png").read()
        except Exception:
            data = None
        result[uid] = data
    return result


class ExpStatusView(discord.ui.View):
    def __init__(self, author_id: int, guild_id: int, bot=None):
        super().__init__(timeout=300)
        self.author_id, self.guild_id = author_id, guild_id
        self.bot = bot
        self._user_cache = _exp_ensure(_exp_root(), self.guild_id, self.author_id)
        self._card_png: bytes | None = None
        self._avatar_bytes: bytes | None = None
        self._name: str | None = None
        self._server_rank: int | None = None
        self._global_rank: int | None = None

    async def _load_latest(self):
        data = await _exp_load()
        self._user_cache = _exp_ensure(data, self.guild_id, self.author_id)
        chat_exp = _as_int(self._user_cache.get("chat_exp"))
        vc_exp = _as_int(self._user_cache.get("vc_exp"))
        # カードには対象サーバーのデータで順位を出す（DM等で guild が
        # 無い場合はサーバー内順位は圏外扱い）。
        if self.guild_id:
            server_rows = build_rows(data, "general", self.guild_id)
            self._server_rank = find_rank(server_rows, self.author_id)
        global_rows = build_rows(data, "general", None)
        self._global_rank = find_rank(global_rows, self.author_id)
        names = await resolve_display_names(self.bot, [self.author_id])
        self._name = names.get(self.author_id)
        avatars = await _fetch_avatar_bytes(self.bot, [self.author_id])
        self._avatar_bytes = avatars.get(self.author_id)
        self._card_png = await asyncio.to_thread(
            render_card_png, user_id=self.author_id,
            name=self._name or "ユーザー", avatar_bytes=self._avatar_bytes,
            chat_exp=chat_exp, vc_exp=vc_exp,
            server_rank=self._server_rank, global_rank=self._global_rank)

    async def interaction_check(self, interaction) -> bool:
        # 自分のステータス画面。公開ボタンも含め本人だけが操作できる。
        return interaction.user.id == self.author_id

    def card_file(self) -> discord.File:
        if self._card_png is None:
            # _load_latest 前に呼ばれた場合はアバターなしでその場描画する。
            chat_exp = _as_int(self._user_cache.get("chat_exp"))
            vc_exp = _as_int(self._user_cache.get("vc_exp"))
            name = self._name or cached_display_name(self.bot, self.author_id)
            self._card_png = render_card_png(
                user_id=self.author_id, name=name, avatar_bytes=None,
                chat_exp=chat_exp, vc_exp=vc_exp,
                server_rank=self._server_rank, global_rank=self._global_rank)
        return discord.File(io.BytesIO(self._card_png), filename=CARD_FILENAME)

    @discord.ui.button(label="公開で出す", style=discord.ButtonStyle.primary, row=0)
    async def share_btn(self, interaction, button):
        # 選択式（C）: 既定は本人のみ表示のまま、本人の意思で同じ内容を公開する。
        if interaction.channel is None:
            return await interaction.response.send_message(
                "公開できるチャンネルがありません。", ephemeral=True)
        await interaction.channel.send(embed=self.embed(), file=self.card_file())
        await interaction.response.send_message("EXP状況をチャンネルに公開しました。", ephemeral=True)

    @staticmethod
    def _bar(cur: int, need: int, width: int = 12) -> str:
        if need <= 0:
            return "█" * width
        filled = min(width, int(width * cur / need))
        return "█" * filled + "░" * (width - filled)

    def embed(self) -> discord.Embed:
        chat_exp = _as_int(self._user_cache.get("chat_exp"))
        vc_exp = _as_int(self._user_cache.get("vc_exp"))
        cl, ccur, cneed = level_from_exp(chat_exp, CHAT_EXP_BASE, CHAT_EXP_RATIO)
        vl, vcur, vneed = level_from_exp(vc_exp, VC_EXP_BASE, VC_EXP_RATIO)
        gl = general_level(chat_exp, vc_exp)
        embed = discord.Embed(
            title="EXP状況",
            description=(
                f"**general Lv.{gl}**\n\n"
                f"**チャット** Lv.{cl} — {ccur}/{cneed} EXP\n"
                f"`{self._bar(ccur, cneed)}`\n\n"
                f"**VC** Lv.{vl} — {vcur}/{vneed} EXP\n"
                f"`{self._bar(vcur, vneed)}`"
            ),
            color=0x3498DB,
        )
        embed.set_image(url=f"attachment://{CARD_FILENAME}")
        return embed


class ExpRankingView(discord.ui.View):
    """対話型EXPランキングボード（公開表示・誰でも操作できる）。"""

    def __init__(self, guild_id: int, bot=None):
        super().__init__(timeout=300)
        self.guild_id = guild_id
        self.bot = bot
        self.axis = "general"
        self.scope = "guild"
        self.page = 0
        self._data_cache = _exp_root()
        self._rows: list[dict] = []
        self._total_pages = 1
        self._names: dict[int, str] = {}
        self._avatars: dict[int, bytes | None] = {}
        self._board_png: bytes | None = None
        self._highlight_user_id: int | None = None
        self._rival_text: str | None = None
        self._sync_buttons()

    # --------------------------------------------------------------
    # データ
    # --------------------------------------------------------------
    def _scope_guild_id(self):
        return self.guild_id if self.scope == "guild" else None

    def _page_rows(self) -> list[dict]:
        self._rows = build_rows(self._data_cache, self.axis, self._scope_guild_id())
        page_rows, total, page = paginate(self._rows, self.page)
        self._total_pages = total
        self.page = page
        return page_rows

    async def _load_latest(self):
        self._data_cache = await _exp_load()
        page_rows = self._page_rows()
        ids = [row["user_id"] for row in page_rows]
        if self._highlight_user_id is not None:
            info = rival_info(self._rows, self._highlight_user_id)
            if info and info.get("above_user_id") is not None:
                ids.append(info["above_user_id"])
        # ランキングの氏名はメンションではなく通常表記にする（サーバー外・
        # 退室済みユーザーのメンションは「不明のユーザー」になるため）。
        self._names = await resolve_display_names(self.bot, ids)
        page_ids = [row["user_id"] for row in page_rows]
        self._avatars = await _fetch_avatar_bytes(self.bot, page_ids)
        scope_label = "サーバー内" if self.scope == "guild" else "全体"
        self._board_png = await asyncio.to_thread(
            render_board_png, page_rows, axis=self.axis,
            scope_label=scope_label, page=self.page,
            total_pages=self._total_pages, names=self._names,
            avatars=self._avatars, highlight_user_id=self._highlight_user_id)
        self._sync_buttons()

    def board_file(self) -> discord.File:
        if self._board_png is None:
            page_rows = self._page_rows()
            scope_label = "サーバー内" if self.scope == "guild" else "全体"
            self._board_png = render_board_png(
                page_rows, axis=self.axis, scope_label=scope_label,
                page=self.page, total_pages=self._total_pages,
                names=self._names, avatars=self._avatars,
                highlight_user_id=self._highlight_user_id)
            self._sync_buttons()
        return discord.File(io.BytesIO(self._board_png), filename=BOARD_FILENAME)

    # --------------------------------------------------------------
    # 表示
    # --------------------------------------------------------------
    def embed(self) -> discord.Embed:
        lines = [
            f"{AXIS_LABELS.get(self.axis, '総合')}ランキング／"
            f"{'サーバー内' if self.scope == 'guild' else '全体'}"
            f"（全{len(self._rows)}人）",
        ]
        if self._rival_text:
            lines.append(self._rival_text)
        embed = discord.Embed(
            title="EXPランキング",
            description="\n".join(lines),
            color=0x9B59B6,
        )
        embed.set_image(url=f"attachment://{BOARD_FILENAME}")
        return embed

    # --------------------------------------------------------------
    # ボタン
    # --------------------------------------------------------------
    def _sync_buttons(self):
        self.clear_items()

        def add(label, row, active, callback, disabled=False):
            button = discord.ui.Button(
                label=label, row=row, disabled=disabled,
                style=(discord.ButtonStyle.primary if active
                       else discord.ButtonStyle.secondary))
            button.callback = callback
            self.add_item(button)

        for axis, label in (("general", "総合"), ("chat", "チャット"), ("vc", "VC")):
            add(label, 0, self.axis == axis, self._make_axis(axis))
        add("サーバー内", 1, self.scope == "guild", self._make_scope("guild"))
        add("全体", 1, self.scope == "all", self._make_scope("all"))
        add("更新", 1, False, self._refresh)
        add("◀", 2, False, self._make_page(-1), disabled=self.page <= 0)
        add("▶", 2, False, self._make_page(1),
            disabled=self.page >= self._total_pages - 1)
        add("自分の順位", 2, False, self._my_rank)
        add("活動ボード", 2, False, self._open_activity)

    async def _edit(self, interaction):
        await edit_panel_v2(interaction, as_panel_v2(self),
                            files=[self.board_file()])

    async def _reload_and_edit(self, interaction):
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self._load_latest()
        await self._edit(interaction)

    def _make_axis(self, axis):
        async def callback(interaction: discord.Interaction):
            self.axis = axis
            self.page = 0
            self._highlight_user_id = None
            self._rival_text = None
            await self._reload_and_edit(interaction)
        return callback

    def _make_scope(self, scope):
        async def callback(interaction: discord.Interaction):
            self.scope = scope
            self.page = 0
            self._highlight_user_id = None
            self._rival_text = None
            await self._reload_and_edit(interaction)
        return callback

    def _make_page(self, delta):
        async def callback(interaction: discord.Interaction):
            self.page += delta
            await self._reload_and_edit(interaction)
        return callback

    async def _refresh(self, interaction: discord.Interaction):
        await self._reload_and_edit(interaction)

    async def _my_rank(self, interaction: discord.Interaction):
        uid = interaction.user.id
        self._highlight_user_id = uid
        info = rival_info(self._rows, uid)
        if info is None:
            self._rival_text = (
                "あなたはまだこのランキングにデータがありません。"
                "チャットやVCで活動するとEXPが貯まります。")
        elif info["above_user_id"] is None:
            self._rival_text = f"あなたは {info['rank']} 位で首位です。"
        else:
            above_name = self._names.get(info["above_user_id"])
            self._rival_text = (
                f"あなたは {info['rank']} 位。真上の "
                f"{above_name or 'ライバル'} まであと {info['gap']:,} EXP です。")
            if above_name is None:
                # 真上の名前が未解決なら取り直してから表示する。
                if not interaction.response.is_done():
                    await interaction.response.defer()
                names = await resolve_display_names(self.bot, [info["above_user_id"]])
                self._names.update(names)
                above_name = names.get(info["above_user_id"])
                self._rival_text = (
                    f"あなたは {info['rank']} 位。真上の "
                    f"{above_name or 'ライバル'} まであと {info['gap']:,} EXP です。")
        if info is not None:
            self.page = (info["rank"] - 1) // PAGE_SIZE
        await self._reload_and_edit(interaction)

    async def _open_activity(self, interaction: discord.Interaction):
        if not interaction.response.is_done():
            await interaction.response.defer()
        view = ActivityBoardView(self.guild_id, bot=self.bot,
                                 guild=interaction.guild)
        await view.refresh_data()
        await edit_panel_v2(interaction, as_panel_v2(view))


class ActivityBoardView(discord.ui.View):
    """サーバー活動ボード: 各軸の「王者」を並べる表示（公開）。"""

    def __init__(self, guild_id: int, bot=None, guild=None):
        super().__init__(timeout=300)
        self.guild_id = guild_id
        self.bot = bot
        self.guild = guild
        self._server_entries: list[tuple[str, str, str]] = []
        self._global_entries: list[tuple[str, str, str]] = []

    # --------------------------------------------------------------
    # 集計（各軸は既存の集計/ランキングを再利用し、取れない軸は落とす）
    # --------------------------------------------------------------
    async def refresh_data(self):
        data = await _exp_load()
        server: list[tuple[str, str, str]] = []
        global_: list[tuple[str, str, str]] = []

        rows = build_rows(data, "general", self.guild_id)
        if rows:
            top = rows[0]
            name = (await resolve_display_names(self.bot, [top["user_id"]])
                    ).get(top["user_id"], "")
            server.append(("EXP総合", name,
                           f"general Lv.{top['general_level']}"))
        rows_all = build_rows(data, "general", None)
        if rows_all:
            top = rows_all[0]
            name = (await resolve_display_names(self.bot, [top["user_id"]])
                    ).get(top["user_id"], "")
            global_.append(("EXP総合", name,
                            f"general Lv.{top['general_level']}"))

        entry = await self._game_king()
        if entry:
            server.append(entry)
        entry = await self._altitude_top()
        if entry:
            server.append(entry)
        entry = await self._coin_top()
        if entry:
            global_.append(entry)
        entry = await self._asset_top()
        if entry:
            global_.append(entry)
        entry = self._clan_top()
        if entry:
            global_.append(entry)

        self._server_entries = server
        self._global_entries = global_

    async def _game_king(self):
        try:
            from core.game import party_ranking
            rows = await party_ranking.shared().monthly_top(
                self.guild_id, limit=1) if self.guild_id else []
            if not rows:
                return None
            uid, wins = rows[0]
            name = (await resolve_display_names(self.bot, [int(uid)])
                    ).get(int(uid), "")
            return ("今月のゲーム王", name, f"{int(wins)}勝")
        except Exception:
            logger.debug("活動ボード: ゲーム王の取得に失敗", exc_info=True)
            return None

    async def _altitude_top(self):
        try:
            fujo = self.bot.get_cog("FujoSurvival") if self.bot else None
            if fujo is None or not hasattr(fujo, "altitude_top"):
                return None
            top = await fujo.altitude_top(self.guild)
            if not top:
                return None
            uid, altitude = top
            from core.game.seizon.cog import altitude_band
            band, _color = altitude_band(altitude)
            name = (await resolve_display_names(self.bot, [int(uid)])
                    ).get(int(uid), "")
            return ("生存確認・現在の高度", name,
                    f"{altitude:,.0f} m（{band}）")
        except Exception:
            logger.debug("活動ボード: 高度の取得に失敗", exc_info=True)
            return None

    async def _coin_top(self):
        try:
            import config

            def _fetch():
                response = (config.db_api.table("users")
                            .select("user_id, balance")
                            .order("balance", desc=True).limit(1).execute())
                return response.data or []

            rows = await asyncio.to_thread(_fetch)
            if not rows:
                return None
            uid = int(rows[0]["user_id"])
            balance = _as_int(rows[0].get("balance"))
            name = (await resolve_display_names(self.bot, [uid])).get(uid, "")
            return ("コイン保有", name, f"{balance:,} AGO")
        except Exception:
            logger.debug("活動ボード: コイン保有の取得に失敗", exc_info=True)
            return None

    async def _asset_top(self):
        try:
            import config
            from core.general.wallet.cog import compute_asset_ranking

            def _fetch_balances() -> dict:
                balances: dict[str, int] = {}
                offset = 0
                while True:
                    response = (config.db_api.table("users")
                                .select("user_id, balance")
                                .range(offset, offset + 999).execute())
                    rows = response.data or []
                    for row in rows:
                        balances[str(row["user_id"])] = _as_int(row.get("balance"))
                    if len(rows) < 1000:
                        return balances
                    offset += 1000

            balances = await asyncio.to_thread(_fetch_balances)
            token_balances: dict[str, float] = {}
            rate = 0.0
            market_cog = self.bot.get_cog("MarketCog") if self.bot else None
            if market_cog is not None:
                snapshot = market_cog.store.snapshot()
                rate = float(snapshot.get("rate") or 0.0)
                token_balances = {
                    str(uid): float(amount)
                    for uid, amount in (snapshot.get("balances") or {}).items()
                }
            ranking = compute_asset_ranking(balances, token_balances, rate)
            if not ranking:
                return None
            top = ranking[0]
            uid = int(top["user_id"])
            name = (await resolve_display_names(self.bot, [uid])).get(uid, "")
            return ("総合資産", name, f"{top['total']:,} AGO")
        except Exception:
            logger.debug("活動ボード: 総合資産の取得に失敗", exc_info=True)
            return None

    def _clan_top(self):
        try:
            from core.game import clan as clan_core
            best = top_clan(clan_core.shared_store().list_clans())
            if not best:
                return None
            detail = (f"Lv{best.get('level', 1)}／{best.get('member_count', 0)}人"
                      f"／累計貢献 {_as_int(best.get('total_points')):,}")
            return ("トップクラン", str(best.get("name") or "（無名）"), detail)
        except Exception:
            logger.debug("活動ボード: クランの取得に失敗", exc_info=True)
            return None

    # --------------------------------------------------------------
    # 表示
    # --------------------------------------------------------------
    def embed(self) -> discord.Embed:
        def section(title: str, entries) -> str:
            if not entries:
                return f"**{title}**\nまだ記録がありません。"
            lines = [f"**{title}**"]
            for label, name, detail in entries:
                lines.append(f"・{label}: **{name}**（{detail}）")
            return "\n".join(lines)

        description = "\n\n".join([
            section("サーバー内の王者", self._server_entries),
            section("全体の王者", self._global_entries),
        ])
        embed = discord.Embed(
            title=f"{emojis.AGOMUNI} サーバー活動ボード",
            description=description,
            color=0xF1C40F,
        )
        return embed

    @discord.ui.button(label="EXPランキング", style=discord.ButtonStyle.primary, row=0)
    async def open_ranking(self, interaction: discord.Interaction, button):
        if not interaction.response.is_done():
            await interaction.response.defer()
        view = ExpRankingView(self.guild_id, bot=self.bot)
        await view._load_latest()
        await edit_panel_v2(interaction, as_panel_v2(view),
                            files=[view.board_file()])

    @discord.ui.button(label="更新", style=discord.ButtonStyle.secondary, row=0)
    async def refresh_btn(self, interaction: discord.Interaction, button):
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self.refresh_data()
        await edit_panel_v2(interaction, as_panel_v2(self))
