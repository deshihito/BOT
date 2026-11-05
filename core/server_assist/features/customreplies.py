"""Exact-match custom replies."""
from __future__ import annotations

import logging
import random
import time
import uuid
from typing import Any

import discord

from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.server_assist import Feature, format_template, get_settings, update_settings
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


def _normalize(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    trigger = str(raw.get("trigger") or "").strip()
    response = str(raw.get("response") or "").strip()
    if not trigger or not response:
        return None
    role_id = raw.get("role_id")
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:8]),
        "trigger": trigger[:100],
        "response": response[:1500],
        "role_id": role_id if isinstance(role_id, int) and not isinstance(role_id, bool) else None,
    }


def _trigger_key(value: str) -> str:
    return " ".join(str(value or "").split()).casefold()


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    replies = []
    seen_triggers: set[str] = set()
    for item in raw.get("replies") or []:
        normalized = _normalize(item)
        if normalized is None:
            continue
        trigger_key = _trigger_key(normalized["trigger"])
        # 旧データや同時保存の競合で同じトリガーが残っていても、最初の
        # 1件だけを有効にして、どの返信が選ばれるか不定にならないようにする。
        if trigger_key in seen_triggers:
            continue
        seen_triggers.add(trigger_key)
        replies.append(normalized)
    min_role_id = raw.get("min_role_id")
    return {
        "enabled": bool(raw.get("enabled", False)),
        "replies": replies[:MAX_REPLIES],
        "min_role_id": (
            min_role_id
            if isinstance(min_role_id, int) and not isinstance(min_role_id, bool)
            else None
        ),
    }


async def _save(guild_id: int, replies: list[dict[str, Any]]) -> None:
    await update_settings(guild_id, KEY, replies=replies[:MAX_REPLIES])


def match_reply(replies: list[dict[str, Any]], content: str) -> dict[str, Any] | None:
    text = _trigger_key(content)
    if not text:
        return None
    return next(
        (reply for reply in replies if _trigger_key(reply["trigger"]) == text),
        None,
    )


def choose_response(response: str) -> str:
    """選択記法がある返信から、送信する候補を1つ選ぶ。

    返信内容に ``:`` で始まる行がある場合だけ、各行を候補として扱う。
    ``:`` のない通常行も候補に含め、候補行の先頭の ``:`` は取り除く。
    記法がない既存の複数行返信は、従来どおり全文を返す。
    """
    lines = response.splitlines()
    if not any(line.startswith(":") for line in lines):
        return response
    candidates = [
        line[1:] if line.startswith(":") else line
        for line in lines
        if line.startswith(":") or line.strip()
    ]
    return random.choice(candidates) if candidates else response


def _has_min_role(author: Any, min_role_id: int) -> bool:
    permissions = getattr(author, "guild_permissions", None)
    if getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False):
        return True
    return any(getattr(role, "id", None) == min_role_id for role in getattr(author, "roles", []) or [])


async def _grant_role(guild: Any, author: Any, role_id: Any) -> None:
    """返信にロール付与アクションが設定されていれば付与する (失敗しても返信は続行)。"""
    if not isinstance(role_id, int):
        return
    if any(getattr(role, "id", None) == role_id for role in getattr(author, "roles", []) or []):
        return
    get_role = getattr(guild, "get_role", None)
    role = get_role(role_id) if callable(get_role) else None
    if role is None or not hasattr(author, "add_roles"):
        return
    me = getattr(guild, "me", None)
    permissions = getattr(me, "guild_permissions", None)
    if permissions is not None and not getattr(permissions, "manage_roles", False):
        return
    top_role = getattr(me, "top_role", None)
    if top_role is not None:
        try:
            if not role < top_role:
                return
        except TypeError:
            pass
    try:
        await author.add_roles(role, reason="カスタム返信")
    except (discord.Forbidden, discord.HTTPException, AttributeError):
        logger.debug("カスタム返信のロール付与に失敗しました: guild=%s", getattr(guild, "id", None))


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
    min_role_id = current.get("min_role_id")
    if min_role_id is not None and not _has_min_role(author, min_role_id):
        return
    reply = match_reply(current["replies"], content)
    if reply is None:
        return
    key = f"{guild.id}:{getattr(author, 'id', 0)}:{reply['id']}"
    now = time.time()
    if now - _last_sent.get(key, 0.0) < COOLDOWN_SECONDS:
        return
    _last_sent[key] = now
    response = format_template(choose_response(reply["response"]), author, guild)
    await _grant_role(guild, author, reply.get("role_id"))
    try:
        await message.reply(
            response,
            mention_author=False,
            allowed_mentions=discord.AllowedMentions.none(),
        )
    except (discord.Forbidden, discord.HTTPException, AttributeError):
        try:
            await message.channel.send(
                response,
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


class CustomReplyRoleSelect(discord.ui.RoleSelect):
    """選択中の返信に付与アクション (ロール) を設定する。"""

    def __init__(self, parent: "CustomReplySettingsView"):
        self.parent_view = parent
        selected = parent.selected_reply()
        current = (selected or {}).get("role_id")
        super().__init__(
            placeholder="選択中の返信で付与するロール（任意）",
            min_values=0,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.role)]
                if current else []
            ),
            row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if view.selected_id is None:
            return await interaction.response.send_message("先に返信を選んでください。", ephemeral=True)
        role = self.values[0] if self.values else None
        if role is not None and (role.is_default() or role.managed):
            return await interaction.response.send_message(
                "@everyone や連携サービス用のロールは指定できません。", ephemeral=True,
            )
        replies = list(settings(view.guild_id)["replies"])
        for item in replies:
            if item.get("id") == view.selected_id:
                item["role_id"] = role.id if role else None
                break
        else:
            return await interaction.response.send_message("その返信は既にありません。", ephemeral=True)
        await _save(view.guild_id, replies)
        await view.reopen(
            interaction,
            f"付与ロールを {'<' + '@&' + str(role.id) + '>' if role else 'なし'} にしました。",
        )


class CustomReplyMinRoleSelect(discord.ui.RoleSelect):
    """返信を発動できる最低ロール (未設定は全員)。"""

    def __init__(self, parent: "CustomReplySettingsView"):
        self.parent_view = parent
        current = parent.settings.get("min_role_id")
        super().__init__(
            placeholder="返信を使えるロール（任意・未設定は全員）",
            min_values=0,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.role)]
                if current else []
            ),
            row=3,
        )

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        role = self.values[0] if self.values else None
        if role is not None and (role.is_default() or role.managed):
            return await interaction.response.send_message(
                "@everyone や連携サービス用のロールは指定できません。", ephemeral=True,
            )
        await update_settings(view.guild_id, KEY, min_role_id=role.id if role else None)
        await view.reopen(
            interaction,
            f"使えるロールを {'<' + '@&' + str(role.id) + '>' if role else '全員'} にしました。",
        )


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
            label="返信内容（候補は各行の先頭に :）",
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
        trigger_key = _trigger_key(trigger)
        duplicate = next(
            (
                item for item in replies
                if item.get("id") != (self.reply or {}).get("id")
                and _trigger_key(item.get("trigger", "")) == trigger_key
            ),
            None,
        )
        if duplicate is not None:
            return await interaction.response.send_message(
                f"同じトリガー `{duplicate['trigger']}` は既に登録されています。別の言葉を指定してください。",
                ephemeral=True,
            )
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
                "role_id": None,
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
        self.add_item(CustomReplyRoleSelect(self))
        self.add_item(CustomReplyMinRoleSelect(self))
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
            suffix = f"（ロール付与: <@&{reply['role_id']}>）" if reply.get("role_id") else ""
            lines.append(f"{mark}{reply['trigger']} → {reply['response'][:60]}{suffix}")
        min_role = self.settings.get("min_role_id")
        return discord.Embed(
            title="カスタム返信",
            description=(
                "決まった言葉に、Botが決まった返信をします。"
                "返信では {user} {name} {id} {server} {count} が使えます。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**登録数**: {len(self.settings['replies'])}/{MAX_REPLIES}"
                f"\n**使える人**: {f'<@&{min_role}>' if min_role else '全員'}"
                f"\n\n{chr(10).join(lines) if lines else '返信はありません。'}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> CustomReplySettingsView:
    return CustomReplySettingsView(cog, guild_id)
