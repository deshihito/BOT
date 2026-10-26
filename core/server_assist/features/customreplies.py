"""Exact-match custom replies."""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any

import discord

from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, notice_line

logger = logging.getLogger(__name__)

KEY = "customreplies"
MAX_REPLIES = 25
COOLDOWN_SECONDS = 3

FEATURE = Feature(
    key=KEY,
    label="カスタム返信",
    description="決まった言葉に、Botが決まった返信をします。",
    order=140,
    module_name=__name__,
)

_last_sent: dict[str, float] = {}


def reset_cache() -> None:
    _last_sent.clear()


def _normalize(raw: Any) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    trigger = str(raw.get("trigger") or "").strip()
    response = str(raw.get("response") or "").strip()
    if not trigger or not response:
        return None
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:8]),
        "trigger": trigger[:100],
        "response": response[:1500],
    }


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    replies = []
    for item in raw.get("replies") or []:
        normalized = _normalize(item)
        if normalized is not None:
            replies.append(normalized)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "replies": replies[:MAX_REPLIES],
    }


async def _save(guild_id: int, replies: list[dict[str, str]]) -> None:
    await update_settings(guild_id, KEY, replies=replies[:MAX_REPLIES])


def match_reply(replies: list[dict[str, str]], content: str) -> dict[str, str] | None:
    text = (content or "").strip().casefold()
    if not text:
        return None
    return next(
        (reply for reply in replies if reply["trigger"].strip().casefold() == text),
        None,
    )


async def on_message(cog: Any, message: Any) -> None:
    guild = getattr(message, "guild", None)
    author = getattr(message, "author", None)
    content = getattr(message, "content", "") or ""
    if guild is None or author is None or getattr(author, "bot", False):
        return
    if content.lstrip().startswith(("/", "!")):
        return
    current = settings(guild.id)
    if not current["enabled"]:
        return
    reply = match_reply(current["replies"], content)
    if reply is None:
        return
    key = f"{guild.id}:{getattr(author, 'id', 0)}:{reply['id']}"
    now = time.time()
    if now - _last_sent.get(key, 0.0) < COOLDOWN_SECONDS:
        return
    _last_sent[key] = now
    try:
        await message.reply(
            reply["response"],
            mention_author=False,
            allowed_mentions=discord.AllowedMentions.none(),
        )
    except (discord.Forbidden, discord.HTTPException, AttributeError):
        try:
            await message.channel.send(
                reply["response"],
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("カスタム返信を送信できませんでした: guild=%s", guild.id)


class CustomReplySelect(discord.ui.Select):
    def __init__(self, parent: "CustomReplySettingsView"):
        self.parent_view = parent
        options = [
            discord.SelectOption(
                label=reply["trigger"][:100],
                value=reply["id"],
                default=reply["id"] == parent.selected_id,
            )
            for reply in parent.settings["replies"]
        ]
        if not options:
            options = [discord.SelectOption(label="返信はありません", value="__none__")]
        super().__init__(placeholder="編集・削除する返信を選択", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            self.parent_view.selected_id = None
            return await interaction.response.send_message("返信がありません。", ephemeral=True)
        self.parent_view.selected_id = self.values[0]
        await self.parent_view.reopen(interaction, "返信を選択しました。")


class CustomReplyAddButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="返信を追加", style=discord.ButtonStyle.success, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: CustomReplySettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if len(view.settings["replies"]) >= MAX_REPLIES:
            return await interaction.response.send_message(
                f"返信は最大{MAX_REPLIES}件です。", ephemeral=True,
            )
        return await interaction.response.send_modal(CustomReplyModal(view))


class CustomReplyEditButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="編集", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: CustomReplySettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        reply = view.selected_reply()
        if reply is None:
            return await interaction.response.send_message("先に返信を選んでください。", ephemeral=True)
        return await interaction.response.send_modal(CustomReplyModal(view, reply))


class CustomReplyDeleteButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="削除", style=discord.ButtonStyle.danger, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: CustomReplySettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if view.selected_id is None:
            return await interaction.response.send_message("先に返信を選んでください。", ephemeral=True)
        replies = [
            reply for reply in settings(view.guild_id)["replies"]
            if reply.get("id") != view.selected_id
        ]
        await _save(view.guild_id, replies)
        view.selected_id = None
        await view.reopen(interaction, "返信を削除しました。")


class CustomReplyToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="カスタム返信", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: CustomReplySettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        await view.reopen(interaction, f"カスタム返信を{'オン' if value else 'オフ'}にしました。")


class CustomReplyModal(discord.ui.Modal):
    def __init__(self, parent: "CustomReplySettingsView", reply: dict[str, str] | None = None):
        super().__init__(title="カスタム返信を編集" if reply else "カスタム返信を追加")
        self.parent_view = parent
        self.reply = reply
        self.trigger_input = discord.ui.TextInput(
            label="反応する言葉（完全一致）",
            default=str((reply or {}).get("trigger") or "")[:100],
            max_length=100,
            required=True,
        )
        self.response_input = discord.ui.TextInput(
            label="返信内容",
            style=discord.TextStyle.paragraph,
            default=str((reply or {}).get("response") or "")[:1500],
            max_length=1500,
            required=True,
        )
        self.add_item(self.trigger_input)
        self.add_item(self.response_input)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        trigger = str(self.trigger_input.value or "").strip()
        response = str(self.response_input.value or "").strip()
        if not trigger or not response:
            return await interaction.response.send_message("言葉と返信内容を入力してください。", ephemeral=True)
        replies = list(settings(self.parent_view.guild_id)["replies"])
        if self.reply:
            found = False
            for item in replies:
                if item.get("id") == self.reply.get("id"):
                    item.update({"trigger": trigger[:100], "response": response[:1500]})
                    found = True
                    break
            if not found:
                return await interaction.response.send_message(
                    "この返信はすでに削除されています。", ephemeral=True,
                )
            selected = self.reply.get("id")
        else:
            selected = uuid.uuid4().hex[:8]
            replies.append({
                "id": selected,
                "trigger": trigger[:100],
                "response": response[:1500],
            })
        await _save(self.parent_view.guild_id, replies)
        self.parent_view.selected_id = selected
        await self.parent_view.reopen(interaction, "カスタム返信を保存しました。")


class CustomReplySettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "カスタム返信"

    def __init__(self, cog: Any, guild_id: int):
        self.settings = settings(guild_id)
        self.selected_id: str | None = None
        super().__init__(cog, guild_id)
        self.add_item(CustomReplySelect(self))
        self.add_item(CustomReplyAddButton())
        self.add_item(CustomReplyEditButton())
        self.add_item(CustomReplyDeleteButton())
        self.add_item(CustomReplyToggleButton())

    def selected_reply(self) -> dict[str, str] | None:
        if self.selected_id is None:
            return None
        return next(
            (reply for reply in self.settings["replies"] if reply.get("id") == self.selected_id),
            None,
        )

    async def reopen(self, interaction: discord.Interaction, notice: str | None = None):
        view = CustomReplySettingsView(self.cog, self.guild_id)
        view.selected_id = self.selected_id
        view.notice = notice
        return await edit_panel_v2(interaction, as_panel_v2(view))

    def embed(self) -> discord.Embed:
        lines = []
        for reply in self.settings["replies"]:
            mark = "▶ " if reply.get("id") == self.selected_id else ""
            lines.append(f"{mark}{reply['trigger']} → {reply['response'][:60]}")
        return discord.Embed(
            title="カスタム返信",
            description=(
                "決まった言葉に、Botが決まった返信をします。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**登録数**: {len(self.settings['replies'])}/{MAX_REPLIES}"
                f"\n\n{chr(10).join(lines) if lines else '返信はありません。'}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> CustomReplySettingsView:
    return CustomReplySettingsView(cog, guild_id)
