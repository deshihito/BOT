"""ぬるぽRTA：「ぬるぽ」→「ｶﾞｯ」のコンビ応答速度を競う。

- 誰かが「ぬるぽ」と発言したら計測開始。別の誰かが「ｶﾞｯ」と返した
  時点までの時間が記録になる。記録は個人ではなくコンビ（ぬるぽ側 ×
  ｶﾞｯ側の順序付きペア）単位で持つ。
- ｶﾞｯ のバリエーションが多いため、厳密一致ではなく「ぬるぽから60秒
  以内・NFKC 正規化後 5 文字以内・ガ/カ/が/か を含む」で判定する。
- 対象は日本語設定（locale=ja）のサーバーでの通常発言のみ。Bot・
  Webhook・DM は対象外（おみくじのメッセージ発動と同じ作法）。
- 保存は即抜けRTA と同じ guild_settings（セクション "nurupo_rta"）に
  全実行を残し、ペアごとの最速/最遅と全サーバー集計は都度導出する。
- 経済には接続しない。ギルド設定トグルは v1 では持たない（常時有効）。
"""
from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone
import io
import logging
import unicodedata

import discord
from discord.ext import commands

from core import ads as partner_ads
from core.support import guild_settings
from core.support.localization.localization import guild_locale
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.general.user_names import resolve_display_names
from core.leaderboard_image import (
    BoardRow, fetch_avatar_bytes, render_leaderboard_png,
)

NURUPO_BOARD_FILENAME = "nurupo_leaderboard.png"
NURUPO_ACCENT = (14, 165, 233)

logger = logging.getLogger(__name__)
SECTION = "nurupo_rta"
WINDOW_SECONDS = 60.0
GA_MAX_CHARS = 5
GA_CHARS = ("ガ", "カ", "が", "か")
NURUPO_PHRASES = ("ぬるぽ", "ヌルポ")
RECORDS_CAP = 1000


def _normalize(content) -> str:
    """判定用に NFKC 正規化して前後空白を除く（半角 ｶﾞｯ → ガッ）。"""
    return unicodedata.normalize("NFKC", content or "").strip()


def is_nurupo(content) -> bool:
    """「ぬるぽ」を含む発言か。長文の一部でもよく、文字数制限はない。"""
    text = _normalize(content)
    return any(phrase in text for phrase in NURUPO_PHRASES)


def is_ga(content) -> bool:
    """ｶﾞｯ 候補か：正規化後 5 文字以内で、ガ/カ/が/か のいずれかを含む。"""
    text = _normalize(content)
    return 0 < len(text) <= GA_MAX_CHARS and any(c in text for c in GA_CHARS)


def _fmt_time(elapsed_ms) -> str:
    """ミリ秒を boardNotify RTA ボードと同じ「X.XX秒」表記にする。"""
    try:
        ms = int(elapsed_ms)
    except (TypeError, ValueError):
        ms = 0
    return f"{ms / 1000:.2f}秒"


class PendingNurupo:
    """チャンネルごとの未確定ぬるぽを FIFO で保持し、ｶﾞｯ と付ける。

    ぬるぽは発言から WINDOW_SECONDS を過ぎたら失効する。ｶﾞｯ は最も
    古い未確定ぬるぽとペアになるが、自分のぬるぽは飛ばす（自作自演の
    防止）。状態はインメモリのみ（窓が60秒なので再起動で消えてよい）。
    """

    def __init__(self, window_seconds: float = WINDOW_SECONDS):
        self.window = float(window_seconds)
        self._queues: dict[int, deque] = {}

    def _prune(self, queue: deque, now: datetime) -> None:
        while queue and (now - queue[0][1]).total_seconds() > self.window:
            queue.popleft()

    def add(self, channel_id: int, user_id: int, at: datetime) -> None:
        queue = self._queues.setdefault(channel_id, deque())
        self._prune(queue, at)
        queue.append((user_id, at))

    def match(self, channel_id: int, ga_user_id: int, at: datetime):
        """成立すれば (ぬるぽ側 user_id, 経過ミリ秒)、しなければ None。"""
        queue = self._queues.get(channel_id)
        if not queue:
            return None
        self._prune(queue, at)
        for entry in list(queue):
            user_id, started = entry
            if user_id == ga_user_id:
                continue
            elapsed_ms = int((at - started).total_seconds() * 1000)
            if elapsed_ms < 0:
                continue
            queue.remove(entry)
            return user_id, elapsed_ms
        return None


def _settings(store, guild_id: int) -> dict:
    raw = store.get(guild_id, SECTION)
    return raw if isinstance(raw, dict) else {}


def _elapsed_ms_or_none(row):
    if not isinstance(row, dict):
        return None
    try:
        return int(row.get("elapsed_ms"))
    except (TypeError, ValueError):
        return None


def _pair_of(row):
    """記録行のペア (ぬるぽ側, ｶﾞｯ側)。壊れた行は None。"""
    if not isinstance(row, dict):
        return None
    nurupo_id = row.get("nurupo_user_id")
    ga_id = row.get("ga_user_id")
    if nurupo_id is None or ga_id is None:
        return None
    return str(nurupo_id), str(ga_id)


def _pair_records(records, *, slowest: bool = False) -> list[dict]:
    """全実行からペアごとの代表記録（最速 or 最遅）を並べて返す。

    ペアは順序付き：Aぬるぽ/Bｶﾞｯ と Bぬるぽ/Aｶﾞｯ は別コンビ。
    """
    best: dict[tuple[str, str], dict] = {}
    for row in records or []:
        pair = _pair_of(row)
        elapsed = _elapsed_ms_or_none(row)
        if pair is None or elapsed is None:
            continue
        current = best.get(pair)
        if current is None or (elapsed > current["elapsed_ms"] if slowest
                               else elapsed < current["elapsed_ms"]):
            best[pair] = {
                "nurupo_user_id": pair[0],
                "ga_user_id": pair[1],
                "elapsed_ms": elapsed,
            }
    return sorted(best.values(), key=lambda r: r["elapsed_ms"],
                  reverse=slowest)


def _global_pair_records(all_settings: dict, *, slowest: bool = False) -> list[dict]:
    """全サーバー分の設定からペアごとの代表記録を集める（_pair_records の横断版）。"""
    merged: list = []
    for settings in (all_settings or {}).values():
        if isinstance(settings, dict):
            merged.extend(settings.get("records") or [])
    return _pair_records(merged, slowest=slowest)


def _pair_best_ms(records, pair: tuple[str, str]):
    """そのペアの現時点の最速（ミリ秒）。記録が無ければ None。"""
    best = None
    for row in records or []:
        if _pair_of(row) != pair:
            continue
        elapsed = _elapsed_ms_or_none(row)
        if elapsed is not None and (best is None or elapsed < best):
            best = elapsed
    return best


def _rank_of(elapsed_ms: int, rows, *, slowest: bool = False) -> int:
    """elapsed_ms がペア代表記録 rows の中で占める順位（同タイムは同順位）。"""
    if slowest:
        return 1 + sum(1 for row in rows
                       if (value := _elapsed_ms_or_none(row)) is not None
                       and value > elapsed_ms)
    return 1 + sum(1 for row in rows
                   if (value := _elapsed_ms_or_none(row)) is not None
                   and value < elapsed_ms)


class NurupoRta(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._pending = PendingNurupo()
        self._locks: dict[int, asyncio.Lock] = {}

    def _lock(self, guild_id: int) -> asyncio.Lock:
        return self._locks.setdefault(guild_id, asyncio.Lock())

    async def _get_settings(self, guild_id: int) -> dict:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        return _settings(store, guild_id)

    async def _save(self, guild_id: int, **values):
        return await guild_settings.get_store().update(guild_id, SECTION, **values)

    # --------------------------------------------------------------
    # メッセージ発動（ぬるぽ検知と ｶﾞｯ のペアリング）
    # --------------------------------------------------------------
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        guild = getattr(message, "guild", None)
        if guild is None:
            return
        author = getattr(message, "author", None)
        if getattr(author, "bot", False):
            return
        if getattr(message, "webhook_id", None) is not None:
            return
        content = getattr(message, "content", "") or ""
        ga = is_ga(content)
        nurupo = is_nurupo(content)
        if not ga and not nurupo:
            return
        # 文面が日本語の遊びのため、日本語設定のサーバーでのみ発動する
        # （おみくじと同じ判定）。
        if guild_locale(guild.id) != "ja":
            return
        now = getattr(message, "created_at", None)
        if now is None:
            return
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        channel_id = message.channel.id
        if ga:
            matched = self._pending.match(channel_id, author.id, now)
            if matched is not None:
                nurupo_user_id, elapsed_ms = matched
                try:
                    await self._record(message, nurupo_user_id, elapsed_ms)
                except Exception:
                    # 記録の失敗でメッセージ処理全体を壊さない。
                    logger.exception(
                        "ぬるぽRTAの記録に失敗しました: guild=%s", guild.id)
                return
        if nurupo:
            self._pending.add(channel_id, author.id, now)

    async def _record(self, message, nurupo_user_id: int, elapsed_ms: int):
        """成立した記録を保存し、そのチャンネルへ結果を公開する。"""
        guild_id = message.guild.id
        ga_user_id = message.author.id
        pair = (str(nurupo_user_id), str(ga_user_id))
        # 記録は「読み取り→追記→書き戻し」のため、ギルド単位で直列化する
        # （即抜けRTA と同じ作法。同時成立で互いの記録を落とさない）。
        async with self._lock(guild_id):
            settings = await self._get_settings(guild_id)
            records = list(settings.get("records") or [])
            previous_best = _pair_best_ms(records, pair)
            is_new_record = (previous_best is not None
                             and elapsed_ms < previous_best)
            records.append({
                "nurupo_user_id": pair[0],
                "ga_user_id": pair[1],
                "elapsed_ms": int(elapsed_ms),
                "at": message.created_at.isoformat(),
            })
            records = records[-RECORDS_CAP:]
            await self._save(guild_id, records=records)
            try:
                await self._announce(
                    message, pair, elapsed_ms, records, is_new_record)
            except Exception:
                # 記録そのものは保存済み。通知の失敗で処理を壊さない。
                logger.exception(
                    "ぬるぽRTAの記録通知に失敗しました: guild=%s", guild_id)

    async def _announce(self, message, pair: tuple[str, str], elapsed_ms: int,
                        guild_records: list, is_new_record: bool):
        """記録成立をそのチャンネルへ embed で知らせる。

        順位はコンビの順位（ペアベスト基準・最速側）。名前はプレーン
        表記（ランキング表示の規約に合わせてメンションしない）。
        """
        pair_best = _pair_best_ms(guild_records, pair)
        local_rank = _rank_of(pair_best, _pair_records(guild_records))
        rank_text = f"このサーバー **{local_rank}位**"
        store = guild_settings.get_store()
        all_sections = getattr(store, "all_sections", None)
        if callable(all_sections):
            all_settings = all_sections(SECTION)
            merged = [row for settings in (all_settings or {}).values()
                      if isinstance(settings, dict)
                      for row in (settings.get("records") or [])]
            global_best = _pair_best_ms(merged, pair)
            if global_best is None:
                global_best = pair_best
            global_rank = _rank_of(
                global_best, _global_pair_records(all_settings))
            rank_text += f" / 全サーバー **{global_rank}位**"
        names = await resolve_display_names(
            self.bot, [int(pair[0]), int(pair[1])])
        nurupo_name = names.get(int(pair[0]), "")
        ga_name = names.get(int(pair[1]), "")
        description = (
            f"**{nurupo_name}** のぬるぽに **{ga_name}** がｶﾞｯ！\n"
            f"記録 **{_fmt_time(elapsed_ms)}**！"
        )
        if is_new_record:
            description += " コンビ新記録！"
        description += f"\nランキング {rank_text}"
        embed = discord.Embed(
            title="ぬるぽRTA", description=description, color=0xFFFFFF)
        # 連携広告枠（記録表示のみ。強制表示）
        ad = partner_ads.next_ad_field()
        if ad is not None:
            embed.add_field(name=ad[0], value=ad[1], inline=False)
        await message.channel.send(
            embed=embed, allowed_mentions=discord.AllowedMentions.none())

    # --------------------------------------------------------------
    # ボード（/general の boardNotify RTA ジャンルから開く）
    # --------------------------------------------------------------
    async def build_board(self, guild_id: int, user_id: int, *,
                          scope: str = "local", slowest: bool = False):
        """ぬるぽRTAボードの (embed, png) を組み立てる（即抜けRTA と同方式）。

        png は画像ボードのときだけ返し、自分スコープ・記録なしはテキスト
        embed のみ（png=None）。行はペアごとの最速/最遅の代表記録。
        """
        board_title = "ぬるぽRTA最遅ランキング" if slowest else "ぬるぽRTAランキング"
        settings = await self._get_settings(guild_id)
        records = list(settings.get("records") or [])
        if scope == "me":
            # 自分がどちらかの役で入っているペアだけを、このサーバー分から出す。
            mine = [row for row in _pair_records(records, slowest=slowest)
                    if str(user_id) in (row["nurupo_user_id"], row["ga_user_id"])]
            names = await resolve_display_names(
                self.bot,
                [row[key] for row in mine[:10]
                 for key in ("nurupo_user_id", "ga_user_id")])
            lines = [
                f"**{i}.** {names.get(int(row['nurupo_user_id']), '')} × "
                f"{names.get(int(row['ga_user_id']), '')} — "
                f"**{_fmt_time(row['elapsed_ms'])}**"
                for i, row in enumerate(mine[:10], 1)]
            embed = discord.Embed(
                title=f"{board_title}（自分）",
                description="\n".join(lines) if lines else "まだ記録がありません。",
                color=0xFFFFFF)
            return embed, None
        if scope == "global":
            store = guild_settings.get_store()
            all_sections = getattr(store, "all_sections", None)
            all_settings = all_sections(SECTION) if callable(all_sections) else {}
            pair_rows = _global_pair_records(all_settings, slowest=slowest)
            scope_label = "全サーバー"
            cache_namespace = "nurupo-leaderboard-global" + ("-slow" if slowest else "")
        else:
            pair_rows = _pair_records(records, slowest=slowest)
            scope_label = "このサーバー"
            cache_namespace = "nurupo-leaderboard" + ("-slow" if slowest else "")
        top = pair_rows[:10]
        # 氏名はメンションではなく通常表記（サーバー外だと「不明のユーザー」になる）
        names = await resolve_display_names(
            self.bot,
            [row[key] for row in top for key in ("nurupo_user_id", "ga_user_id")])
        rows = [BoardRow(
                    user_id=int(row["nurupo_user_id"]),
                    name=(f"{names.get(int(row['nurupo_user_id']), '')} × "
                          f"{names.get(int(row['ga_user_id']), '')}"),
                    value=_fmt_time(row["elapsed_ms"]))
                for row in top]
        if not rows:
            embed = discord.Embed(
                title=f"{board_title}（{scope_label}）",
                description="まだ記録がありません。", color=0xFFFFFF)
            return embed, None
        avatars = await fetch_avatar_bytes(
            self.bot, [row.user_id for row in rows])
        png = await asyncio.to_thread(
            render_leaderboard_png,
            title=board_title, sections=[(None, rows)],
            accent=NURUPO_ACCENT, subtitle=scope_label, avatars=avatars,
            cache_namespace=cache_namespace)
        embed = discord.Embed(title=f"{board_title}（{scope_label}）", color=0xFFFFFF)
        embed.set_image(url=f"attachment://{NURUPO_BOARD_FILENAME}")
        return embed, png

    async def leaderboard(self, interaction: discord.Interaction,
                          scope: str = "local", slowest: bool = False):
        if interaction.guild_id is None:
            return await interaction.followup.send(
                "この機能はサーバー内でのみ使えます。", ephemeral=True)
        view = NurupoBoardView(
            self, interaction.guild_id, interaction.user.id,
            scope=scope, slowest=slowest)
        await view.load()
        await interaction.followup.send(
            view=as_panel_v2(view), files=view.files(),
            allowed_mentions=discord.AllowedMentions.none())


class NurupoBoardView(discord.ui.View):
    """ぬるぽRTAのボード（公開表示・誰でも切り替えできる）。

    即抜けRTA のボード（SokunukeBoardView）と同方式：最速/最遅 ×
    スコープ（このサーバー / 全サーバー / 自分）をボード内で切り替える。
    取得・描画は NurupoRta.build_board に委譲する。
    """

    def __init__(self, cog, guild_id, user_id, *,
                 scope: str = "local", slowest: bool = False):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild_id = guild_id
        self.user_id = user_id
        self.scope = scope
        self.slowest = slowest
        self._embed = None
        self._png = None
        self._sync()

    async def load(self):
        """現在の状態でボードを取得する（失敗時は失敗文面のみの embed）。"""
        try:
            self._embed, self._png = await self.cog.build_board(
                self.guild_id, self.user_id,
                scope=self.scope, slowest=self.slowest)
        except Exception:
            logger.exception(
                "nurupo board load failed: scope=%s slowest=%s",
                self.scope, self.slowest)
            self._embed = discord.Embed(
                title="ぬるぽRTAランキング",
                description="ランキングの取得に失敗しました。", color=0xFFFFFF)
            self._png = None

    def embed(self):
        return self._embed

    def files(self):
        if self._png is None:
            return []
        return [discord.File(io.BytesIO(self._png), filename=NURUPO_BOARD_FILENAME)]

    def _sync(self):
        self.clear_items()

        def add(label, row, active, callback):
            button = discord.ui.Button(
                label=label, row=row,
                style=(discord.ButtonStyle.primary if active
                       else discord.ButtonStyle.secondary))
            button.callback = callback
            self.add_item(button)

        add("最速", 0, not self.slowest, self._make_speed(False))
        add("最遅", 0, self.slowest, self._make_speed(True))
        add("このサーバー", 1, self.scope == "local", self._make_scope("local"))
        add("全サーバー", 1, self.scope == "global", self._make_scope("global"))
        add("自分", 1, self.scope == "me", self._make_scope("me"))

    async def _reload(self, interaction: discord.Interaction):
        # 「自分」スコープは押した人の記録を出す（即抜けRTA と同じ）。
        self.user_id = interaction.user.id
        if not interaction.response.is_done():
            await interaction.response.defer()
        await self.load()
        self._sync()
        await edit_panel_v2(interaction, as_panel_v2(self), files=self.files())

    def _make_speed(self, slowest: bool):
        async def callback(interaction: discord.Interaction):
            self.slowest = slowest
            await self._reload(interaction)
        return callback

    def _make_scope(self, scope: str):
        async def callback(interaction: discord.Interaction):
            self.scope = scope
            await self._reload(interaction)
        return callback


async def setup(bot: commands.Bot):
    await bot.add_cog(NurupoRta(bot))
