"""Level role rewards, layered on the existing EXP and level-up notification."""
from __future__ import annotations

import logging
import re
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, notice_line

logger = logging.getLogger(__name__)

KEY = "leveling"
MAX_REWARDS = 10

FEATURE = Feature(
    key=KEY,
    label="レベル報酬",
    description="既存EXPのレベルに応じて、ロールを自動付与します。",
    order=40,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    rewards: dict[str, int] = {}
    raw_rewards = raw.get("role_rewards")
    if isinstance(raw_rewards, dict):
        for level, role_id in raw_rewards.items():
            try:
                level_int = int(level)
                role_int = int(role_id)
            except (TypeError, ValueError):
                continue
            if 2 <= level_int <= 1000 and role_int > 0:
                rewards[str(level_int)] = role_int
    return {
        "enabled": bool(raw.get("enabled", False)),
        "role_rewards": dict(sorted(rewards.items(), key=lambda item: int(item[0]))),
    }


def _reward_for_level(rewards: dict[str, int], level: int) -> int | None:
    chosen = None
    chosen_level = 0
    for raw_level, role_id in rewards.items():
        try:
            value = int(raw_level)
        except (TypeError, ValueError):
            continue
        if value <= level and value > chosen_level:
            chosen, chosen_level = role_id, value
    return chosen


async def _grant_reward(guild: Any, member: Any, level: int, current: dict[str, Any]) -> None:
    role_id = _reward_for_level(current.get("role_rewards") or {}, level)
    if not role_id:
        return
    role = guild.get_role(role_id)
    if role is None or getattr(role, "managed", False):
        return
    top_role = getattr(getattr(guild, "me", None), "top_role", None)
    if top_role is not None:
        try:
            if role >= top_role:
                return
        except TypeError:
            pass
    if role in (getattr(member, "roles", None) or []):
        return
    try:
        await member.add_roles(role, reason=f"Level {level} reward")
    except (discord.Forbidden, discord.HTTPException):
        logger.warning(
            "レベル報酬を付与できませんでした: guild=%s member=%s level=%s",
            getattr(guild, "id", None), getattr(member, "id", None), level,
        )


async def handle_level_rewards(
    cog: Any, guild: Any, member: Any, old_level: int, new_level: int,
) -> None:
    if new_level <= old_level:
        return
    current = settings(guild.id)
    if not current["enabled"]:
        return
    await _grant_reward(guild, member, new_level, current)


def _parse_rewards(value: str) -> dict[str, int]:
    rewards: dict[str, int] = {}
    for token in re.split(r"[\n,]+", value or ""):
        token = token.strip()
        if not token:
            continue
        separator = "=" if "=" in token else ":" if ":" in token else None
        if separator is None:
            raise ValueError("レベル=ロールID の形式で入力してください。")
        level_text, role_text = token.split(separator, 1)
        level = int(level_text.strip())
        role_id = int(role_text.strip())
        if not 2 <= level <= 1000 or role_id <= 0:
            raise ValueError("レベルは2〜1000、ロールIDは正の整数で入力してください。")
        rewards[str(level)] = role_id
    if len(rewards) > MAX_REWARDS:
        raise ValueError(f"レベル報酬は最大{MAX_REWARDS}件です。")
    return dict(sorted(rewards.items(), key=lambda item: int(item[0])))


class LevelingToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="レベル報酬", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: LevelingSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"レベル報酬を{'オン' if value else 'オフ'}にしました。")


class LevelingRewardsButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="レベル報酬を設定", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: LevelingSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await interaction.response.send_modal(LevelRewardsModal(view))


class LevelRewardsModal(discord.ui.Modal, title="レベル報酬"):
    def __init__(self, parent: "LevelingSettingsView"):
        super().__init__()
        self.parent_view = parent
        current = "\n".join(f"{level}={role_id}" for level, role_id in parent.settings["role_rewards"].items())
        self.text = discord.ui.TextInput(
            label="レベル=ロールID（1行1個・空欄で解除）",
            style=discord.TextStyle.paragraph,
            default=current[:1000],
            max_length=1000,
            required=False,
            placeholder="例:\n10=123456789012345678\n20=123456789012345679",
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        try:
            rewards = _parse_rewards(str(self.text.value or ""))
        except (TypeError, ValueError) as exc:
            return await interaction.response.send_message(
                f"保存できませんでした: {exc}", ephemeral=True,
            )
        await update_settings(self.parent_view.guild_id, KEY, role_rewards=rewards)
        self.parent_view.settings["role_rewards"] = rewards
        await self.parent_view.refresh(interaction, "レベル報酬を保存しました。")


class LevelingSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "レベル報酬"

    def __init__(self, cog: Any, guild_id: int):
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        self.add_item(LevelingToggleButton())
        self.add_item(LevelingRewardsButton())

    def embed(self) -> discord.Embed:
        rewards = self.settings["role_rewards"]
        reward_text = ", ".join(f"Lv.{level} → <@&{role_id}>" for level, role_id in rewards.items()) or "なし"
        embed = discord.Embed(
            title="レベル報酬",
            description=(
                "既存のEXPレベルアップに合わせて、ロールを自動付与します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**レベル報酬**: {reward_text}"
                "\n\n到達したレベル以下で一番高い報酬を1つ付与します。"
                "レベルアップ通知の送信先や画像は、/support の「レベルアップ通知（EXP）」で設定してください。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )
        return embed


def build_view(cog: Any, guild_id: int) -> LevelingSettingsView:
    return LevelingSettingsView(cog, guild_id)
