"""Webhook builder: post a message through a bot-owned webhook with a custom name/avatar."""
from __future__ import annotations

import logging
import re
import time
from typing import Any

import discord

from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.server_assist import Feature, get_settings, update_settings
from core.support.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.support.server_assist.ui import AssistChannelSelect, AssistToggleButton, channel_permission_check, required_field
from core.support.messages import ASSIST_MANAGE_REQUIRED

logger = logging.getLogger(__name__)

KEY = "webhook"
WEBHOOK_NAME = "AGOBOT-Webhook"
POST_COOLDOWN = 3.0

_last_post: dict[tuple[int, int], float] = {}
_webhook_cache: dict[int, Any] = {}

FEATURE = Feature(
    key=KEY,
    label="Webhookビルダー",
    description="Webhookを使って、名前とアイコンを変えたメッセージを投稿します。",
    order=95,
    module_name=__name__,
)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    channel_id = raw.get("channel_id")
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": (
            channel_id
            if isinstance(channel_id, int) and not isinstance(channel_id, bool)
            else None
        ),
    }


def sanitize_username(name: str | None) -> str | None:
    """Webhook の表示名に使えない文字列を避ける (auth 機能と同じ方針)。"""
    text = (name or "").strip()
    if not text:
        return None
    text = re.sub(r"(?i)discord", lambda m: m.group(0)[:4] + "​" + m.group(0)[4:], text)
    text = re.sub(r"(?i)clyde", lambda m: m.group(0)[:3] + "​" + m.group(0)[3:], text)
    if text.lower() in ("everyone", "here"):
        text = f"{text}さん"
    return text[:80].strip() or None


def valid_avatar_url(value: str | None) -> str | None:
    text = (value or "").strip()
    if text.startswith(("http://", "https://")) and len(text) > 10:
        return text[:1000]
    return None


async def get_or_create_webhook(channel: Any, bot_user_id: int | None) -> Any:
    """この機能専用の Webhook を返す (Bot所有・同名のものを再利用し、なければ作る)。"""
    cached = _webhook_cache.get(channel.id)
    if cached is not None:
        return cached
    for webhook in await channel.webhooks():
        owner = getattr(webhook, "user", None)
        if (
            getattr(webhook, "name", None) == WEBHOOK_NAME
            and (bot_user_id is None or (owner is not None and owner.id == bot_user_id))
            and getattr(webhook, "token", None)
        ):
            _webhook_cache[channel.id] = webhook
            return webhook
    webhook = await channel.create_webhook(name=WEBHOOK_NAME)
    _webhook_cache[channel.id] = webhook
    return webhook


async def post_via_webhook(channel: Any, bot_user_id: int | None, *, content: str,
                           username: str | None, avatar_url: str | None) -> None:
    try:
        webhook = await get_or_create_webhook(channel, bot_user_id)
        await webhook.send(
            content=content,
            username=username,
            avatar_url=avatar_url,
            allowed_mentions=discord.AllowedMentions.none(),
        )
    except discord.NotFound:
        _webhook_cache.pop(channel.id, None)
        webhook = await get_or_create_webhook(channel, bot_user_id)
        await webhook.send(
            content=content,
            username=username,
            avatar_url=avatar_url,
            allowed_mentions=discord.AllowedMentions.none(),
        )


class WebhookPostButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="Webhookで投稿", style=discord.ButtonStyle.success, row=1)

    async def callback(self, interaction: discord.Interaction):
        view: WebhookSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        if not view.settings["enabled"] or view.settings["channel_id"] is None:
            return await interaction.response.send_message("Webhookビルダーは現在オフです。", ephemeral=True)
        return await interaction.response.send_modal(WebhookPostModal(view))


class WebhookPostModal(discord.ui.Modal):
    def __init__(self, parent: "WebhookSettingsView"):
        super().__init__(title="Webhookで投稿")
        self.parent_view = parent
        self.username_input = discord.ui.TextInput(
            label="表示名（任意）",
            max_length=80,
            required=False,
            placeholder="空欄なら Webhook の既定名",
        )
        self.avatar_input = discord.ui.TextInput(
            label="アイコン画像URL（任意）",
            max_length=1000,
            required=False,
            placeholder="https://...",
        )
        self.content_input = discord.ui.TextInput(
            label="本文",
            style=discord.TextStyle.paragraph,
            max_length=2000,
            required=True,
        )
        self.add_item(self.username_input)
        self.add_item(self.avatar_input)
        self.add_item(self.content_input)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        current = settings(self.parent_view.guild_id)
        if not current["enabled"] or current["channel_id"] is None:
            return await interaction.response.send_message("Webhookビルダーは現在オフです。", ephemeral=True)
        content = str(self.content_input.value or "").strip()
        if not content:
            return await interaction.response.send_message("本文を入力してください。", ephemeral=True)
        post_key = (interaction.guild_id, interaction.user.id)
        now = time.monotonic()
        if now - _last_post.get(post_key, 0.0) < POST_COOLDOWN:
            return await interaction.response.send_message(
                "連続で投稿できません。少し待ってください。", ephemeral=True,
            )
        channel = interaction.guild.get_channel(current["channel_id"]) if interaction.guild else None
        if channel is None:
            return await interaction.response.send_message("投稿先のチャンネルが見つかりません。", ephemeral=True)
        _last_post[post_key] = now
        await interaction.response.defer(ephemeral=True)
        bot_user_id = getattr(getattr(interaction.client, "user", None), "id", None)
        try:
            await post_via_webhook(
                channel,
                bot_user_id,
                content=content,
                username=sanitize_username(str(self.username_input.value or "")),
                avatar_url=valid_avatar_url(str(self.avatar_input.value or "")),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("Webhook投稿に失敗しました: guild=%s", interaction.guild_id)
            return await interaction.followup.send("Webhookで投稿できませんでした。", ephemeral=True)
        return await interaction.followup.send(f"{channel.mention} に投稿しました。", ephemeral=True)


class WebhookSettingsView(AssistFeatureView):
    feature_key = KEY

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AssistChannelSelect(self, field="channel_id", placeholder="Webhook投稿先", notice="Webhook投稿先を保存しました。", min_values=0, empty_message="送信できるチャンネルがありません。", check=channel_permission_check("manage_webhooks", "そのチャンネルではBotに「ウェブフックの管理」権限がありません。"), reopen=True))
        self.add_item(AssistToggleButton("enabled", "Webhookビルダー", row=1, reopen=True, require=required_field("channel_id", "先に投稿先を選んでください。")))
        self.add_item(WebhookPostButton())

    async def reopen(self, interaction: discord.Interaction, notice: str | None = None):
        view = WebhookSettingsView(self.cog, self.guild_id)
        view.notice = notice
        return await edit_panel_v2(interaction, as_panel_v2(view))

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="Webhookビルダー",
            description=(
                "Webhookを使って、名前とアイコンを変えたメッセージを投稿します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**投稿先**: {channel_label(self.settings['channel_id'])}"
                "\n\n投稿にはBotの「ウェブフックの管理」権限が必要です。メンションは無効化されます。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> WebhookSettingsView:
    return WebhookSettingsView(cog, guild_id)
