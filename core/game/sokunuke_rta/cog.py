"""即抜けRTAと、開始時のVC自動参加。"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import io
import logging

import discord
from discord import app_commands
from discord.ext import commands

from core import ads as partner_ads
from core.game.game.game_v2 import text_panel
from core.support import guild_settings
from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.general.user_names import resolve_display_names
from core.leaderboard_image import (
    BoardRow, fetch_avatar_bytes, render_leaderboard_png,
)

SOKUNUKE_BOARD_FILENAME = "sokunuke_leaderboard.png"
SOKUNUKE_ACCENT = (234, 88, 12)

logger = logging.getLogger(__name__)
SECTION = "sokunuke_rta"
LIMIT = timedelta(days=1)


def _settings(store, guild_id: int) -> dict:
    raw = store.get(guild_id, SECTION)
    return raw if isinstance(raw, dict) else {}


def _enabled(settings: dict, key: str) -> bool:
    value = settings.get(key)
    return value if isinstance(value, bool) else True


def _duration(seconds: float) -> str:
    total = max(0, int(seconds))
    return f"{total // 3600}時間{(total % 3600) // 60}分{total % 60}秒"


def _global_best_records(all_settings: dict) -> list[dict]:
    """全サーバー分の設定 {guild_id: sokunuke設定} から、ユーザーごとの最速記録を集める。

    各サーバーの records は実行ごとの記録なので、全サーバー横断では
    ユーザーごとに一番速い1件だけを残し、速い順に並べて返す。
    """
    best: dict[str, dict] = {}
    for settings in (all_settings or {}).values():
        if not isinstance(settings, dict):
            continue
        for row in settings.get("records") or []:
            if not isinstance(row, dict):
                continue
            user_id = row.get("user_id")
            try:
                elapsed = float(row.get("elapsed"))
            except (TypeError, ValueError):
                continue
            if user_id is None:
                continue
            key = str(user_id)
            current = best.get(key)
            if current is None or elapsed < float(current["elapsed"]):
                best[key] = {"user_id": key, "elapsed": elapsed}
    return sorted(best.values(), key=lambda row: float(row["elapsed"]))


def _global_worst_records(all_settings: dict) -> list[dict]:
    """全サーバー分の設定から、ユーザーごとの最遅記録（最大の elapsed）を集める。

    _global_best_records の最遅版。records は実行ごとの記録なので、横断集計では
    ユーザーごとに一番遅い1件だけを残し、遅い順に並べて返す。
    """
    worst: dict[str, dict] = {}
    for settings in (all_settings or {}).values():
        if not isinstance(settings, dict):
            continue
        for row in settings.get("records") or []:
            if not isinstance(row, dict):
                continue
            user_id = row.get("user_id")
            try:
                elapsed = float(row.get("elapsed"))
            except (TypeError, ValueError):
                continue
            if user_id is None:
                continue
            key = str(user_id)
            current = worst.get(key)
            if current is None or elapsed > float(current["elapsed"]):
                worst[key] = {"user_id": key, "elapsed": elapsed}
    return sorted(worst.values(), key=lambda row: float(row["elapsed"]), reverse=True)


def _elapsed_or_none(row) -> float | None:
    if not isinstance(row, dict):
        return None
    try:
        return float(row.get("elapsed"))
    except (TypeError, ValueError):
        return None


def _rank_of(elapsed: float, rows, *, slowest: bool = False) -> int:
    """elapsed がランキング rows（最速=昇順/最遅=降順の記録列）に入る順位。

    自分より上位の記録（最速なら速い記録、最遅なら遅い記録）の件数 + 1。
    同タイムの記録は同じ順位に数える（先に並ぶ側へ寄せる）。
    """
    if slowest:
        return 1 + sum(1 for row in rows
                       if (value := _elapsed_or_none(row)) is not None and value > elapsed)
    return 1 + sum(1 for row in rows
                   if (value := _elapsed_or_none(row)) is not None and value < elapsed)


def _human_voice_states(guild) -> list[object]:
    """Return human voice states across voice/stage channels.

    ``Guild.voice_states`` is not exposed by every supported discord.py build;
    channel-level ``voice_states`` is the portable source of truth.
    """
    channels = list(getattr(guild, "voice_channels", ()) or ())
    channels.extend(getattr(guild, "stage_channels", ()) or ())
    states = []
    seen_users = set()
    for channel in channels:
        for user_id, state in (getattr(channel, "voice_states", {}) or {}).items():
            if user_id in seen_users or getattr(state, "channel", None) is None:
                continue
            member = getattr(state, "member", None) or guild.get_member(user_id)
            if member is not None and not getattr(member, "bot", False):
                states.append(state)
                seen_users.add(user_id)
    return states


class SokuNukeRta(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._locks: dict[int, asyncio.Lock] = {}

    def _lock(self, guild_id: int) -> asyncio.Lock:
        return self._locks.setdefault(guild_id, asyncio.Lock())

    async def _get_settings(self, guild_id: int) -> dict:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        return _settings(store, guild_id)

    async def _save(self, guild_id: int, **values):
        return await guild_settings.get_store().update(guild_id, SECTION, **values)

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        if member.bot:
            return
        # joins は「読み取り→丸ごと書き戻し」のため、退出側と同じギルドロックを
        # 取らないと、同時参加した別メンバーの記録を古い写しで上書きして落とす。
        async with self._lock(member.guild.id):
            settings = await self._get_settings(member.guild.id)
            joins = dict(settings.get("joins") or {})
            joins[str(member.id)] = discord.utils.utcnow().isoformat()
            await self._save(member.guild.id, joins=joins)

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        if member.bot:
            return
        async with self._lock(member.guild.id):
            settings = await self._get_settings(member.guild.id)
            joins = dict(settings.get("joins") or {})
            joined = joins.pop(str(member.id), None)
            if not joined:
                return
            await self._save(member.guild.id, joins=joins)
            if not _enabled(settings, "measurement_enabled"):
                return
            try:
                joined_at = datetime.fromisoformat(joined)
                if joined_at.tzinfo is None:
                    joined_at = joined_at.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                return
            elapsed = discord.utils.utcnow() - joined_at
            if elapsed < timedelta(0) or elapsed > LIMIT:
                return
            records = list(settings.get("records") or [])
            records.append({"user_id": str(member.id), "elapsed": elapsed.total_seconds(), "at": discord.utils.utcnow().isoformat()})
            records = records[-1000:]
            await self._save(member.guild.id, records=records)
            try:
                await self._announce_record(member, elapsed.total_seconds(), records)
            except Exception:
                # 記録そのものは保存済み。通知の失敗で退出処理を壊さない。
                logger.exception("即抜けRTAの記録通知に失敗しました: guild=%s", member.guild.id)

    async def _announce_record(self, member, elapsed_seconds: float, guild_records: list):
        """即抜けが記録されたら、サーバーのシステムチャンネルへ embed で知らせる。

        順位は「その記録が入る位置」（最速ランキング）。名前はプレーン表記
        （退出済みユーザーのメンションは「不明のユーザー」になるため、
        ランキング表示の規約に合わせてメンションしない）。
        通知先が無ければ何もしない。
        """
        guild = member.guild
        channel = getattr(guild, "system_channel", None)
        if channel is None:
            return
        rank_text = f"このサーバー **{_rank_of(elapsed_seconds, guild_records)}位**"
        store = guild_settings.get_store()
        all_sections = getattr(store, "all_sections", None)
        if callable(all_sections):
            bests = _global_best_records(all_sections(SECTION))
            global_rank = _rank_of(elapsed_seconds, bests)
            rank_text += f" / 全サーバー **{global_rank}位**"
        name = (getattr(member, "display_name", None)
                or getattr(member, "name", None) or "誰か")
        embed = discord.Embed(
            title="即抜けRTA",
            description=(
                f"おっ、**{name}** さんが即抜け！\n"
                f"記録 **{_duration(elapsed_seconds)}**！\n"
                f"ランキング {rank_text}"),
            color=0xFFFFFF)
        # 連携広告枠（記録表示のみ。ギルド設定で OFF にできる）
        if await partner_ads.ads_enabled(guild.id):
            ad = partner_ads.next_ad_field()
            if ad is not None:
                embed.add_field(name=ad[0], value=ad[1], inline=False)
        await channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())

    @commands.Cog.listener()
    async def on_voice_state_update(self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
        if member.bot or before.channel is not None or after.channel is None:
            return
        settings = await self._get_settings(member.guild.id)
        if not _enabled(settings, "vc_auto_join_enabled"):
            return
        humans = _human_voice_states(member.guild)
        voice_client = member.guild.voice_client
        try:
            connected = voice_client is not None and voice_client.is_connected()
        except (AttributeError, TypeError):
            connected = voice_client is not None
        if len(humans) != 1 or connected:
            return
        try:
            await after.channel.connect(self_deaf=True)
        except (discord.ClientException, discord.Forbidden, discord.HTTPException):
            logger.exception("VC自動参加に失敗しました: guild=%s channel=%s", member.guild.id, after.channel.id)

    async def build_board(self, guild_id: int, user_id: int, *,
                          scope: str = "local", slowest: bool = False):
        """即抜けRTAボードの (embed, png) を組み立てる（boardNotify RTA と同方式）。

        png は画像ボードのときだけ返し、自分スコープ・記録なしはテキスト
        embed のみ（png=None）。最遅は「計測上限（1日）の中で最も抜けるのが
        遅かった記録」で、records が全実行を保持するため同じデータから出せる。
        """
        board_title = "即抜けRTA最遅ランキング" if slowest else "即抜けRTAランキング"
        settings = await self._get_settings(guild_id)
        records = list(settings.get("records") or [])
        if scope == "me":
            # 自分の記録一覧は個人の履歴表示なので、従来どおりテキストで出す。
            records = [row for row in records if str(row.get("user_id")) == str(user_id)]
            records.sort(key=lambda row: float(row.get("elapsed", 0)), reverse=slowest)
            names = await resolve_display_names(
                self.bot, [row["user_id"] for row in records[:10]])
            lines = [f"**{i}.** {names.get(int(row['user_id']), '')} — **{_duration(row['elapsed'])}**" for i, row in enumerate(records[:10], 1)]
            embed = discord.Embed(title=f"{board_title}（自分）", description="\n".join(lines) if lines else "まだ記録がありません。", color=0xFFFFFF)
            return embed, None
        if scope == "global":
            # 全サーバー: 各サーバーの記録を横断し、ユーザーごとの最速/最遅で並べる
            store = guild_settings.get_store()
            all_sections = getattr(store, "all_sections", None)
            all_settings = all_sections(SECTION) if callable(all_sections) else {}
            records = (_global_worst_records(all_settings) if slowest
                       else _global_best_records(all_settings))
            scope_label = "全サーバー"
            cache_namespace = "sokunuke-leaderboard-global" + ("-slow" if slowest else "")
        else:
            records.sort(key=lambda row: float(row.get("elapsed", 0)), reverse=slowest)
            scope_label = "このサーバー"
            cache_namespace = "sokunuke-leaderboard" + ("-slow" if slowest else "")
        # 氏名はメンションではなく通常表記（サーバー外だと「不明のユーザー」になる）
        names = await resolve_display_names(
            self.bot, [row["user_id"] for row in records[:10]])
        rows = [BoardRow(user_id=int(row["user_id"]),
                         name=names.get(int(row["user_id"]), ""),
                         value=_duration(row["elapsed"]))
                for row in records[:10]]
        if not rows:
            embed = discord.Embed(title=f"{board_title}（{scope_label}）", description="まだ記録がありません。", color=0xFFFFFF)
            return embed, None
        avatars = await fetch_avatar_bytes(
            self.bot, [row.user_id for row in rows])
        png = await asyncio.to_thread(
            render_leaderboard_png,
            title=board_title, sections=[(None, rows)],
            accent=SOKUNUKE_ACCENT, subtitle=scope_label, avatars=avatars,
            cache_namespace=cache_namespace)
        embed = discord.Embed(title=f"{board_title}（{scope_label}）", color=0xFFFFFF)
        embed.set_image(url=f"attachment://{SOKUNUKE_BOARD_FILENAME}")
        return embed, png

    async def leaderboard(self, interaction: discord.Interaction, scope: str = "local", slowest: bool = False):
        if interaction.guild_id is None:
            return await interaction.followup.send("この機能はサーバー内でのみ使えます。", ephemeral=True)
        view = SokunukeBoardView(
            self, interaction.guild_id, interaction.user.id,
            scope=scope, slowest=slowest)
        await view.load()
        await interaction.followup.send(
            view=as_panel_v2(view), files=view.files(),
            allowed_mentions=discord.AllowedMentions.none())

    async def sokunuke_command(self, interaction: discord.Interaction, action: app_commands.Choice[str]):
        if interaction.guild_id is None:
            return await interaction.response.send_message("この機能はサーバー内でのみ使えます。", ephemeral=True)
        settings = await self._get_settings(interaction.guild_id)
        if action.value == "status":
            # 状態確認は即抜けRTAの計測状態だけを示す（VC自動参加は別機能の
            # 設定であり、ここには混ぜない。切替は vc_on/vc_off で行う）。
            return await interaction.response.send_message(
                view=text_panel(
                    "即抜けRTA設定",
                    f"計測: {'オン' if _enabled(settings, 'measurement_enabled') else 'オフ'}"),
                ephemeral=True)
        key, enabled = {
            "on": ("measurement_enabled", True),
            "off": ("measurement_enabled", False),
            "vc_on": ("vc_auto_join_enabled", True),
            "vc_off": ("vc_auto_join_enabled", False),
        }[action.value]
        await self._save(interaction.guild_id, **{key: enabled})
        label = "計測" if key == "measurement_enabled" else "VC自動参加"
        await interaction.response.send_message(f"{label}を{'オン' if enabled else 'オフ'}にしました。", ephemeral=True)


class SokunukeBoardView(discord.ui.View):
    """即抜けRTAのボード（公開表示・誰でも切り替えできる）。

    boardNotify RTA の統合ボード（RtaBoardView）と同方式：最速/最遅 ×
    スコープ（このサーバー / 全サーバー / 自分）をボード内で切り替える。
    取得・描画は SokuNukeRta.build_board に委譲する。
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
                "sokunuke board load failed: scope=%s slowest=%s",
                self.scope, self.slowest)
            self._embed = discord.Embed(
                title="即抜けRTAランキング",
                description="ランキングの取得に失敗しました。", color=0xFFFFFF)
            self._png = None

    def embed(self):
        return self._embed

    def files(self):
        if self._png is None:
            return []
        return [discord.File(io.BytesIO(self._png), filename=SOKUNUKE_BOARD_FILENAME)]

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
        # 「自分」スコープは押した人の記録を出す（統合ボードと同じ）。
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
    await bot.add_cog(SokuNukeRta(bot))
