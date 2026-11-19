"""Server stat voice-channel counters."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import discord

from core.support.server_assist import as_int, Feature, get_settings, update_settings
from core.support.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.support.server_assist.ui import AssistChannelSelect, AssistToggleButton, channel_permission_check, required_field
from core.support.messages import ASSIST_MANAGE_REQUIRED

logger = logging.getLogger(__name__)

KEY = "stats"
INTERVAL_SECONDS = 600
# Discord のチャンネル名変更は同一チャンネルにつき10分に2回まで。
# 超えると 429（retry_after 約600秒）が返り、discord.py が呼び出しの内側で
# 寝てリトライするため、定期ループごと長時間止まってしまう。
# 改名間隔をコード側で10分以上に保証し（前回改名時刻は設定ストアに残して
# 再起動をまたいでも効かせる）、踏んでしまった場合も EDIT_TIMEOUT で
# その周期は諦める。
MIN_RENAME_INTERVAL_SECONDS = 600
EDIT_TIMEOUT_SECONDS = 20
# それでも 429 を踏んだチャンネルは、改名を1時間止める（サーキットブレーカ）。
RATE_LIMIT_BLOCK_SECONDS = 3600

FEATURE = Feature(
    key=KEY,
    label="サーバースタッツ",
    description="メンバー数・オンライン数・ブースト数をVC名に反映します。",
    order=90,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    def channel_id(name: str) -> int | None:
        return as_int(raw.get(name))
    return {
        "enabled": bool(raw.get("enabled", False)),
        "member_channel_id": channel_id("member_channel_id"),
        "online_channel_id": channel_id("online_channel_id"),
        "boost_channel_id": channel_id("boost_channel_id"),
    }


def _counts(guild: Any) -> dict[str, int]:
    members = list(getattr(guild, "members", []) or [])
    member_count = getattr(guild, "member_count", None)
    if not isinstance(member_count, int):
        member_count = len(members)
    online = sum(
        1 for member in members
        if not getattr(member, "bot", False)
        and getattr(member, "status", None) != discord.Status.offline
    )
    boosts = getattr(guild, "premium_subscription_count", 0) or 0
    return {"member": member_count, "online": online, "boost": int(boosts)}


def _as_epoch(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value)


def _last_renames_by_channel(guild_id: int) -> dict[int, float]:
    """チャンネルID → 前回改名試行の epoch 秒。

    項目別（メンバー/オンライン等）ではなくチャンネル単位で持つ。
    同じVCを複数項目に設定しても、上限はチャンネル側の予算を共有するため。
    """
    raw = get_settings(guild_id, KEY)
    stored = raw.get("last_rename_channels")
    result: dict[int, float] = {}
    if isinstance(stored, dict):
        for raw_id, raw_ts in stored.items():
            try:
                channel_id = int(raw_id)
            except (TypeError, ValueError):
                continue
            epoch = _as_epoch(raw_ts)
            if epoch > 0:
                result[channel_id] = epoch
    return result


async def _record_renames(guild_id: int, renames: dict[int, float], now: float) -> None:
    """改名試行の記録を保存する（古い記録は落とす）。失敗しても改名は続行する。"""
    pruned = {
        str(channel_id): ts
        for channel_id, ts in renames.items()
        if ts > now - 86400
    }
    try:
        await update_settings(guild_id, KEY, last_rename_channels=pruned)
    except Exception:
        logger.debug("サーバースタッツの改名時刻を記録できませんでした: guild=%s", guild_id)


async def update_stats(guild: Any, current: dict[str, Any], *, force: bool = False) -> None:
    if not current["enabled"]:
        return
    guild_id = getattr(guild, "id", None)
    counts = _counts(guild)
    labels = {"member": "メンバー", "online": "オンライン", "boost": "ブースト"}
    renames = _last_renames_by_channel(guild_id) if isinstance(guild_id, int) else {}
    now = time.time()
    for key, label in labels.items():
        channel_id = current.get(f"{key}_channel_id")
        channel = guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            continue
        name = f"{label}: {counts[key]}"
        if getattr(channel, "name", None) == name:
            continue
        if not force and now - renames.get(channel_id, 0.0) < MIN_RENAME_INTERVAL_SECONDS:
            # 前回の改名（試行）から10分経っていない。Discord の上限
            # （同一チャンネル10分に2回）を踏まないよう、この周期は見送る。
            continue
        if isinstance(guild_id, int):
            # 試行自体を先に記録する（失敗・429でも間隔は空ける）。
            renames[channel_id] = now
            await _record_renames(guild_id, renames, now)
        try:
            await asyncio.wait_for(
                channel.edit(name=name, reason="Server stats"),
                timeout=EDIT_TIMEOUT_SECONDS,
            )
        except discord.RateLimited:
            # 上限に当たったチャンネルは1時間止める（サーキットブレーカ）。
            logger.warning(
                "サーバースタッツの改名がレートリミットに当たったため、このチャンネルの改名を1時間止めます: guild=%s channel=%s",
                guild_id, channel_id,
            )
            if isinstance(guild_id, int):
                renames[channel_id] = (
                    time.time() + RATE_LIMIT_BLOCK_SECONDS - MIN_RENAME_INTERVAL_SECONDS
                )
                await _record_renames(guild_id, renames, time.time())
        except TimeoutError:
            # edit がぶら下がった場合はこの周期は諦める。
            logger.debug("サーバースタッツの更新がタイムアウトしました: guild=%s channel=%s", guild_id, channel_id)
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("サーバースタッツを更新できませんでした: guild=%s channel=%s", guild_id, channel_id)


async def _runner(cog: Any) -> None:
    await cog.bot.wait_until_ready()
    while True:
        for guild in list(getattr(cog.bot, "guilds", []) or []):
            current = settings(guild.id)
            if current["enabled"]:
                await update_stats(guild, current)
        await asyncio.sleep(INTERVAL_SECONDS)


def start_tasks(cog: Any) -> None:
    task = asyncio.create_task(_runner(cog), name="server-assist-stats")
    getattr(cog, "_feature_tasks", []).append(task)


class StatsRefreshButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="今すぐ更新", style=discord.ButtonStyle.success, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: StatsSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        if not view.settings["enabled"]:
            return await interaction.response.send_message(
                "先にサーバースタッツをオンにしてください。", ephemeral=True,
            )
        await update_stats(interaction.guild, view.settings, force=True)
        return await interaction.response.send_message("スタッツを更新しました。")


class StatsSettingsView(AssistFeatureView):
    feature_key = KEY

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AssistChannelSelect(self, field="member_channel_id", placeholder="メンバー数を表示するVC", notice="スタッツの表示先を保存しました。", channel_types=[discord.ChannelType.voice, discord.ChannelType.stage_voice], min_values=0, row=0, check=channel_permission_check("manage_channels", "そのVCを管理する権限がありません。")))
            self.add_item(AssistChannelSelect(self, field="online_channel_id", placeholder="オンライン数を表示するVC", notice="スタッツの表示先を保存しました。", channel_types=[discord.ChannelType.voice, discord.ChannelType.stage_voice], min_values=0, row=1, check=channel_permission_check("manage_channels", "そのVCを管理する権限がありません。")))
            self.add_item(AssistChannelSelect(self, field="boost_channel_id", placeholder="ブースト数を表示するVC", notice="スタッツの表示先を保存しました。", channel_types=[discord.ChannelType.voice, discord.ChannelType.stage_voice], min_values=0, row=2, check=channel_permission_check("manage_channels", "そのVCを管理する権限がありません。")))
        self.add_item(AssistToggleButton("enabled", "サーバースタッツ", row=3, require=lambda view, interaction, value: "先に表示先のVCを選んでください。" if value and not any(view.settings[key] for key in ("member_channel_id", "online_channel_id", "boost_channel_id")) else None))
        self.add_item(StatsRefreshButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="サーバースタッツ",
            description=(
                "既存のボイスチャンネル名を、定期的にサーバー統計へ更新します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**メンバー数**: {channel_label(self.settings['member_channel_id'])}"
                f"\n**オンライン数**: {channel_label(self.settings['online_channel_id'])}"
                f"\n**ブースト数**: {channel_label(self.settings['boost_channel_id'])}"
                "\n\n更新間隔は10分です。チャンネル名の変更には「チャンネルの管理」権限が必要です。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> StatsSettingsView:
    return StatsSettingsView(cog, guild_id)
