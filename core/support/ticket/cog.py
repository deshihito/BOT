"""/support から利用するチケットパネルとチケットルーム管理。"""
from __future__ import annotations

import asyncio
import io
import logging
import uuid
from datetime import timezone
from typing import Any

import discord
from discord.ext import commands

from core.support import guild_settings
from core.support.common import can_manage_guild
from core.support.messages import MANAGE_GUILD_REQUIRED
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

logger = logging.getLogger(__name__)

TICKET_SECTION = "ticket"
TICKET_MODE_THREAD = "thread"
TICKET_MODE_CHANNEL = "channel"
TICKET_DELETE_OPTIONS = (0, 3600, 86400, 3 * 86400, 7 * 86400)
TICKET_DELETE_LABELS = {0: "無効", 3600: "1時間", 86400: "1日", 3 * 86400: "3日", 7 * 86400: "7日"}
MAX_TICKET_TYPES = 5
TRANSCRIPT_LIMIT = 200


def _int_list(value: Any, limit: int = 25) -> list[int]:
    if not isinstance(value, list):
        return []
    result: list[int] = []
    for item in value:
        if isinstance(item, int) and not isinstance(item, bool) and item > 0 and item not in result:
            result.append(item)
        if len(result) >= limit:
            break
    return result


def _normalize_types(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:20]
        if not name or name.casefold() in seen_names:
            continue
        seen_names.add(name.casefold())
        category_id = item.get("category_id")
        result.append({
            "id": str(item.get("id") or uuid.uuid4().hex[:8]),
            "name": name,
            "category_id": (
                category_id
                if isinstance(category_id, int) and not isinstance(category_id, bool) and category_id > 0
                else None
            ),
            "operator_role_ids": _int_list(item.get("operator_role_ids")),
        })
        if len(result) >= MAX_TICKET_TYPES:
            break
    return result


def parse_ticket_types(text: str) -> list[dict[str, Any]]:
    """種別の一括編集テキストを解析する。1行1種別: 名前 | カテゴリID | 操作ロールID,カンマ区切り。"""
    parsed = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split("|")]
        name = parts[0]
        category_id = None
        role_ids: list[int] = []
        if len(parts) > 1 and parts[1].isdigit():
            category_id = int(parts[1])
        if len(parts) > 2:
            for token in parts[2].replace("、", ",").split(","):
                token = token.strip()
                if token.isdigit() and int(token) > 0 and int(token) not in role_ids:
                    role_ids.append(int(token))
        parsed.append({
            "id": uuid.uuid4().hex[:8],
            "name": name,
            "category_id": category_id,
            "operator_role_ids": role_ids,
        })
    return _normalize_types(parsed)


def format_ticket_types(types: list[dict[str, Any]]) -> str:
    lines = []
    for item in types:
        category = str(item["category_id"]) if item.get("category_id") else ""
        roles = ",".join(str(role_id) for role_id in item.get("operator_role_ids") or [])
        lines.append(" | ".join(part for part in (item["name"], category, roles)))
    return "\n".join(lines)


def _normalize_assignments(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int] = {}
    for key, user_id in value.items():
        if str(key).isdigit() and isinstance(user_id, int) and not isinstance(user_id, bool) and user_id > 0:
            result[str(key)] = user_id
        if len(result) >= 200:
            break
    return result


def build_transcript(messages: list[Any], room_id: int) -> str:
    """メッセージ一覧をテキストのトランスクリプトにする。"""
    lines = [f"チケット {room_id} の記録（{len(messages)}件）"]
    for message in messages:
        created = getattr(message, "created_at", None)
        stamp = created.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if created else "----"
        author = getattr(message, "author", None)
        name = (
            getattr(author, "display_name", None)
            or getattr(author, "name", None)
            or str(getattr(author, "id", "?"))
        )
        content = str(getattr(message, "content", "") or "")
        attachments = [
            str(getattr(attachment, "url", "") or "")
            for attachment in getattr(message, "attachments", []) or []
        ]
        attachments = [url for url in attachments if url]
        if attachments:
            content = (content + " " if content else "") + " ".join(f"[添付: {url}]" for url in attachments)
        lines.append(f"[{stamp}] {name}: {content}")
    return "\n".join(lines)


def get_ticket_settings(store, guild_id: int) -> dict[str, Any]:
    raw = store.get(guild_id, TICKET_SECTION)
    if not isinstance(raw, dict):
        raw = {}
    mode = raw.get("mode") if raw.get("mode") in {TICKET_MODE_THREAD, TICKET_MODE_CHANNEL} else TICKET_MODE_THREAD
    panel_channel_id = raw.get("panel_channel_id")
    category_id = raw.get("category_id")
    for key in ("panel_channel_id", "category_id"):
        value = raw.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            if key == "panel_channel_id":
                panel_channel_id = None
            else:
                category_id = None
    delete_after = raw.get("delete_after", 0)
    if delete_after not in TICKET_DELETE_OPTIONS:
        delete_after = 0
    transcript_channel_id = raw.get("transcript_channel_id")
    if not isinstance(transcript_channel_id, int) or isinstance(transcript_channel_id, bool) or transcript_channel_id <= 0:
        transcript_channel_id = None
    return {
        "enabled": bool(raw.get("enabled", False)),
        "panel_channel_id": panel_channel_id,
        "panel_message_id": raw.get("panel_message_id") if isinstance(raw.get("panel_message_id"), int) else None,
        "mode": mode,
        "category_id": category_id,
        "viewer_role_ids": _int_list(raw.get("viewer_role_ids")),
        "viewer_user_ids": _int_list(raw.get("viewer_user_ids")),
        "operator_role_ids": _int_list(raw.get("operator_role_ids")),
        "operator_user_ids": _int_list(raw.get("operator_user_ids")),
        "delete_after": delete_after,
        "user_manage": bool(raw.get("user_manage", False)),
        "types": _normalize_types(raw.get("types")),
        "transcript_channel_id": transcript_channel_id,
        "assignments": _normalize_assignments(raw.get("assignments")),
    }


def _ticket_embed(settings: dict[str, Any], notice: str | None = None) -> discord.Embed:
    mode = "プライベートスレッド" if settings["mode"] == TICKET_MODE_THREAD else "専用チャンネル"
    channel = f"<#{settings['panel_channel_id']}>" if settings.get("panel_channel_id") else "未設定"
    category = f"<#{settings['category_id']}>" if settings.get("category_id") else "未設定"
    viewer_roles = ", ".join(f"<@&{x}>" for x in settings["viewer_role_ids"]) or "なし"
    operator_roles = ", ".join(f"<@&{x}>" for x in settings["operator_role_ids"]) or "なし"
    description = (
        (f"{notice}\n\n" if notice else "")
        + f"状態: **{'オン' if settings['enabled'] else 'オフ'}**\n"
        + f"パネル設置先: {channel}\n"
        + f"設営タイプ: **{mode}**\n"
        + f"チャンネルカテゴリ: {category if settings['mode'] == TICKET_MODE_CHANNEL else '不要'}\n"
        + f"閲覧ロール: {viewer_roles}\n"
        + f"操作ロール: {operator_roles}\n"
        + f"自動削除: **{TICKET_DELETE_LABELS[settings['delete_after']]}**\n"
        + f"作成者のルーム操作: **{'許可' if settings['user_manage'] else '禁止'}**\n"
        + f"種別: {', '.join(item['name'] for item in settings.get('types') or []) or 'なし'}\n"
        + f"記録の保存先: {f'<#{settings['transcript_channel_id']}>' if settings.get('transcript_channel_id') else 'なし'}\n\n"
        + "チケット作成者には必ず閲覧・発言権限が付与されます。"
    )
    return discord.Embed(title="チケットツールの設定", description=description, color=0xFFFFFF)


class TicketPanelView(discord.ui.View):
    def __init__(self, types: list[dict[str, Any]] | None = None):
        super().__init__(timeout=None)
        if types:
            for item in types[:MAX_TICKET_TYPES]:
                self.add_item(discord.ui.Button(
                    label=f"チケットを作成（{item['name']}）"[:80],
                    style=discord.ButtonStyle.primary,
                    custom_id=f"support_ticket:create_type:{item['id']}",
                ))
        else:
            self.add_item(discord.ui.Button(
                label="チケットを作成",
                style=discord.ButtonStyle.primary,
                custom_id="support_ticket:create",
            ))


class TicketRoomView(discord.ui.View):
    def __init__(self, room_id: int, closed: bool = False, assignable: bool = False):
        super().__init__(timeout=None)
        self.add_item(discord.ui.Button(
            label="再開" if closed else "閉じる",
            style=discord.ButtonStyle.success if closed else discord.ButtonStyle.secondary,
            custom_id=f"support_ticket:{'reopen' if closed else 'close'}:{room_id}",
        ))
        if assignable and not closed:
            self.add_item(discord.ui.Button(
                label="担当を設定",
                style=discord.ButtonStyle.primary,
                custom_id=f"support_ticket:assign:{room_id}",
            ))
        self.add_item(discord.ui.Button(
            label="削除",
            style=discord.ButtonStyle.danger,
            custom_id=f"support_ticket:delete:{room_id}",
        ))


class TicketModeSelect(discord.ui.Select):
    def __init__(self, parent: "TicketSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="設営タイプを選択",
            options=[
                discord.SelectOption(label="プライベートスレッド", value=TICKET_MODE_THREAD, default=parent.settings["mode"] == TICKET_MODE_THREAD),
                discord.SelectOption(label="専用チャンネル", value=TICKET_MODE_CHANNEL, default=parent.settings["mode"] == TICKET_MODE_CHANNEL),
            ],
            row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.settings["mode"] = self.values[0]
        await self.parent_view.save_and_refresh(interaction, "設営タイプを更新しました。")


class TicketChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "TicketSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="公開パネルを設置するチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1, max_values=1, row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.settings["panel_channel_id"] = self.values[0].id
        await self.parent_view.save_and_refresh(interaction, "パネル設置先を更新しました。")


class TicketCategorySelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "TicketSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="チケットチャンネルのカテゴリを選択",
            channel_types=[discord.ChannelType.category],
            min_values=1, max_values=1, row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.settings["category_id"] = self.values[0].id
        await self.parent_view.save_and_refresh(interaction, "チケットカテゴリを更新しました。")


class TicketViewerRoleSelect(discord.ui.RoleSelect):
    def __init__(self, parent: "TicketSettingsView"):
        self.parent_view = parent
        super().__init__(placeholder="閲覧を許可するロールを選択", min_values=0, max_values=10, row=3)

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.settings["viewer_role_ids"] = [role.id for role in self.values]
        await self.parent_view.save_and_refresh(interaction, "閲覧ロールを更新しました。")


class TicketAdvancedButton(discord.ui.Button):
    def __init__(self, parent: "TicketSettingsView"):
        self.parent_view = parent
        super().__init__(label="詳細設定（ユーザー・期限・操作権限）", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(MANAGE_GUILD_REQUIRED, ephemeral=True)
        await edit_panel_v2(interaction, as_panel_v2(TicketAdvancedSettingsView(self.parent_view.cog, self.parent_view.settings)))


class TicketSettingsView(discord.ui.View):
    def __init__(self, cog: "TicketCog", settings: dict[str, Any], notice: str | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.notice = notice
        self.add_item(TicketChannelSelect(self))
        self.add_item(TicketModeSelect(self))
        self.add_item(TicketCategorySelect(self))
        self.add_item(TicketViewerRoleSelect(self))
        self.add_item(TicketAdvancedButton(self))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        return can_manage_guild(interaction)

    def embed(self):
        return _ticket_embed(self.settings, self.notice)

    async def save_and_refresh(self, interaction: discord.Interaction, notice: str | None = None):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(MANAGE_GUILD_REQUIRED, ephemeral=True)
        await interaction.response.defer()
        await self.cog.save_settings(interaction.guild_id, self.settings)
        self.notice = notice
        await edit_panel_v2(interaction, as_panel_v2(self))


class TicketIdsModal(discord.ui.Modal):
    def __init__(self, parent: "TicketAdvancedSettingsView", key: str, title: str, label: str):
        super().__init__(title=title)
        self.parent_view = parent
        self.key = key
        current = " ".join(str(x) for x in parent.settings[key])
        self.ids = discord.ui.TextInput(
            label=label,
            default=current[:400], max_length=400, required=False,
        )
        self.add_item(self.ids)

    async def on_submit(self, interaction: discord.Interaction):
        values: list[int] = []
        for token in self.ids.value.replace(",", " ").split():
            if not token.isdigit() or int(token) <= 0:
                return await interaction.response.send_message("ユーザーIDは数字で入力してください。", ephemeral=True)
            if int(token) not in values:
                values.append(int(token))
        if len(values) > 25:
            return await interaction.response.send_message("ユーザーは最大25人まで設定できます。", ephemeral=True)
        self.parent_view.settings[self.key] = values
        await self.parent_view.save_and_refresh(interaction, "ユーザー設定を更新しました。")


class TicketTypesModal(discord.ui.Modal):
    def __init__(self, parent: "TicketAdvancedSettingsView"):
        super().__init__(title="チケット種別を編集")
        self.parent_view = parent
        self.types_input = discord.ui.TextInput(
            label="種別（1行に1つ、最大5件）",
            style=discord.TextStyle.paragraph,
            default=format_ticket_types(parent.settings.get("types") or [])[:1000],
            max_length=1000,
            required=False,
            placeholder="例: 質問 | カテゴリID | 操作ロールID\n不具合報告\n（IDは開発者モードをオンにして右クリック→「IDをコピー」）",
        )
        self.add_item(self.types_input)

    async def on_submit(self, interaction: discord.Interaction):
        types = parse_ticket_types(str(self.types_input.value or ""))
        self.parent_view.settings["types"] = types
        await self.parent_view.save_and_refresh(interaction, "種別を更新しました。パネルは再送信すると反映されます。")


class TicketTranscriptChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "TicketAdvancedSettingsView"):
        self.parent_view = parent
        current = parent.settings.get("transcript_channel_id")
        super().__init__(
            placeholder="記録（トランスクリプト）の保存先",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=0, max_values=1, row=4,
            default_values=(
                [discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.channel)]
                if current else []
            ),
        )

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.settings["transcript_channel_id"] = self.values[0].id if self.values else None
        await self.parent_view.save_and_refresh(interaction, "記録の保存先を更新しました。")


class TicketAdvancedSettingsView(discord.ui.View):
    def __init__(self, cog: "TicketCog", settings: dict[str, Any]):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.add_item(discord.ui.Button(label="閲覧ユーザーを設定", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:viewers", row=0))
        self.add_item(discord.ui.Button(label="閲覧ロールを設定", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:viewer_roles", row=0))
        self.add_item(discord.ui.Button(label="操作ユーザーを設定", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:operators", row=1))
        self.add_item(discord.ui.Button(label="操作ロールを設定", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:operator_roles", row=1))
        self.add_item(discord.ui.Button(label="自動削除期限を変更", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:delete_cycle", row=2))
        self.add_item(discord.ui.Button(label="作成者の操作権限を切替", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:user_manage", row=2))
        self.add_item(discord.ui.Button(label="種別を編集", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:types", row=2))
        self.add_item(discord.ui.Button(label="公開パネルを送信", style=discord.ButtonStyle.primary, custom_id="ticket_adv:send_panel", row=3))
        self.add_item(discord.ui.Button(label="設定画面に戻る", style=discord.ButtonStyle.secondary, custom_id="ticket_adv:back", row=3))
        self.add_item(TicketTranscriptChannelSelect(self))

    def embed(self):
        return _ticket_embed(self.settings, "詳細設定")

    async def save_and_refresh(self, interaction: discord.Interaction, notice: str | None = None):
        await self.cog.save_settings(interaction.guild_id, self.settings)
        self.notice = notice
        await edit_panel_v2(interaction, as_panel_v2(self))


class TicketAssignView(discord.ui.View):
    def __init__(self, cog: "TicketCog", room_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.room_id = room_id
        select = discord.ui.UserSelect(placeholder="担当にするメンバー", min_values=1, max_values=1)
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction):
        member = self.children[0].values[0]
        await self.cog.set_assignee(interaction, self.room_id, member)


class TicketAssignGuideView(discord.ui.View):
    """担当アサインの案内（実表面はチケットルーム内のみ）。

    担当の指定は、開いているチケットルーム内の担当ボタン
    （TicketAssignView）から行う。ここではその案内と、閲覧/操作権限など
    担当まわりの詳細設定画面への導線を出す。
    """

    def __init__(self, cog: "TicketCog"):
        super().__init__(timeout=300)
        self.cog = cog
        button = discord.ui.Button(
            label="詳細設定を開く", style=discord.ButtonStyle.primary,
            custom_id="ticket_assign_guide:advanced", row=0)
        button.callback = self._open_advanced
        self.add_item(button)

    async def _open_advanced(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_ticket_settings(store, interaction.guild_id)
        await edit_panel_v2(interaction, as_panel_v2(TicketAdvancedSettingsView(self.cog, settings)))

    def embed(self):
        return discord.Embed(
            title="チケット担当アサイン",
            description=(
                "担当者の指定は、開いているチケットルーム内の「担当」ボタンから行います"
                "（アサイン画面はルームごとに開くため、設定画面からは直接開けません）。\n"
                "閲覧・操作できるユーザー/ロールや種別ごとの操作ロールは、詳細設定で変更できます。"
            ),
            color=0xFFFFFF,
        )


class TicketCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._delete_tasks: dict[int, asyncio.Task] = {}

    async def save_settings(self, guild_id: int, settings: dict[str, Any]):
        await guild_settings.get_store().update(guild_id, TICKET_SECTION, **settings)

    async def show_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("この設定はサーバー内で利用できます。", ephemeral=True)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_ticket_settings(store, interaction.guild.id)
        await interaction.response.send_message(view=as_panel_v2(TicketSettingsView(self, settings)), ephemeral=True)

    async def show_advanced(self, interaction: discord.Interaction, settings: dict[str, Any]):
        await edit_panel_v2(interaction, as_panel_v2(TicketAdvancedSettingsView(self, settings)))

    async def show_advanced_settings(self, interaction: discord.Interaction):
        """詳細設定画面を直接開く（チケット種別／トランスクリプト保存先の入口）。

        詳細設定には「種別を編集」ボタンとトランスクリプト保存先セレクトが
        含まれるため、種別・記録どちらの入口からもこの画面に着地させる。
        """
        if interaction.guild is None:
            return await interaction.response.send_message("この設定はサーバー内で利用できます。", ephemeral=True)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_ticket_settings(store, interaction.guild.id)
        await interaction.response.send_message(view=as_panel_v2(TicketAdvancedSettingsView(self, settings)), ephemeral=True)

    async def show_assign_guide(self, interaction: discord.Interaction):
        """担当アサインの案内を開く（実表面はルーム内 TicketAssignView のみ）。"""
        if interaction.guild is None:
            return await interaction.response.send_message("この設定はサーバー内で利用できます。", ephemeral=True)
        await interaction.response.send_message(view=as_panel_v2(TicketAssignGuideView(self)), ephemeral=True)

    async def send_settings_panel(self, interaction: discord.Interaction, settings: dict[str, Any]):
        channel_id = settings.get("panel_channel_id")
        if not channel_id:
            return await interaction.followup.send("先に公開パネルの設置先を選択してください。", ephemeral=True)
        if settings["mode"] == TICKET_MODE_CHANNEL and not settings.get("category_id"):
            return await interaction.followup.send("専用チャンネル型ではカテゴリを選択してください。", ephemeral=True)
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                return await interaction.followup.send("パネル設置先を取得できません。", ephemeral=True)
        old_id = settings.get("panel_message_id")
        if old_id:
            try:
                await (await channel.fetch_message(old_id)).delete()
            except discord.NotFound:
                pass
            except (discord.Forbidden, discord.HTTPException):
                logger.warning("旧チケットパネルを削除できません (guild=%s)", interaction.guild_id)
        try:
            message = await channel.send(
                embed=discord.Embed(
                    title="お問い合わせチケット",
                    description="お問い合わせやサポートが必要な場合はこちらから。",
                    color=0xFFFFFF,
                ),
                view=TicketPanelView(settings.get("types")),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("チケットパネルを送信できません (guild=%s channel=%s)", interaction.guild_id, channel_id)
            return await interaction.followup.send("チケットパネルの送信に失敗しました。", ephemeral=True)
        settings["panel_message_id"] = message.id
        settings["enabled"] = True
        await self.save_settings(interaction.guild_id, settings)
        await interaction.followup.send("チケットパネルを送信しました。", ephemeral=True)

    async def _members_for_roles(self, guild: discord.Guild, role_ids: list[int]) -> list[discord.Member]:
        role_set = set(role_ids)
        return [member for member in guild.members if any(role.id in role_set for role in getattr(member, "roles", []))]

    async def _allowed_ids(self, guild: discord.Guild, settings: dict[str, Any], extra_role_ids: list[int] | None = None) -> set[int]:
        members = await self._members_for_roles(
            guild, settings["viewer_role_ids"] + settings["operator_role_ids"] + list(extra_role_ids or []))
        return set(settings["viewer_user_ids"] + settings["operator_user_ids"]) | {member.id for member in members}

    async def create_ticket(self, interaction: discord.Interaction, type_id: str | None = None):
        guild = interaction.guild
        if guild is None:
            return await interaction.response.send_message("サーバー内でのみ利用できます。", ephemeral=True)
        await interaction.response.defer(ephemeral=True, thinking=True)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_ticket_settings(store, guild.id)
        if not settings["enabled"] or not settings.get("panel_channel_id"):
            return await interaction.followup.send("チケット機能が設定されていません。", ephemeral=True)
        ticket_type = next(
            (item for item in settings.get("types") or [] if item["id"] == type_id), None)
        type_role_ids = (ticket_type or {}).get("operator_role_ids") or []
        allowed_ids = await self._allowed_ids(guild, settings, type_role_ids)
        allowed_ids.add(interaction.user.id)
        room_prefix = f"ticket-{ticket_type['name']}-" if ticket_type else "ticket-"
        try:
            if settings["mode"] == TICKET_MODE_THREAD:
                parent = self.bot.get_channel(settings["panel_channel_id"])
                if parent is None:
                    parent = await self.bot.fetch_channel(settings["panel_channel_id"])
                room = await parent.create_thread(
                    name=f"{room_prefix}{interaction.user.display_name}"[:100],
                    type=discord.ChannelType.private_thread,
                    invitable=False,
                    reason="チケット作成",
                )
                for user_id in allowed_ids:
                    member = guild.get_member(user_id)
                    if member is not None and member.id != getattr(self.bot.user, "id", None):
                        try:
                            await room.add_user(member)
                        except (discord.Forbidden, discord.HTTPException):
                            logger.warning("チケットスレッドへユーザーを追加できません (user=%s)", user_id)
            else:
                category_id = (ticket_type or {}).get("category_id") or settings["category_id"]
                category = guild.get_channel(category_id)
                if not isinstance(category, discord.CategoryChannel):
                    return await interaction.followup.send("チケットカテゴリが見つかりません。", ephemeral=True)
                overwrites = {guild.default_role: discord.PermissionOverwrite(view_channel=False)}
                me = guild.me
                if me is not None:
                    overwrites[me] = discord.PermissionOverwrite(view_channel=True, send_messages=True, manage_channels=True, manage_threads=True)
                for user_id in allowed_ids:
                    member = guild.get_member(user_id)
                    if member is not None:
                        overwrites[member] = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True)
                for role_id in settings["viewer_role_ids"] + settings["operator_role_ids"] + type_role_ids:
                    role = guild.get_role(role_id)
                    if role is not None:
                        overwrites[role] = discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True)
                room = await guild.create_text_channel(
                    f"{room_prefix}{interaction.user.display_name}"[:100],
                    category=category,
                    overwrites=overwrites,
                    topic=f"support-ticket-owner:{interaction.user.id}",
                    reason="チケット作成",
                )
            type_line = f"\n種別: {ticket_type['name']}" if ticket_type else ""
            await room.send(
                embed=discord.Embed(
                    title="チケットルーム",
                    description="お問い合わせ内容を送信してください。下のパネルでルームを閉じる・再開・削除できます。" + type_line,
                    color=0xFFFFFF,
                ),
                view=TicketRoomView(room.id, assignable=True),
            )
            await interaction.followup.send(f"チケットを作成しました: {room.mention}", ephemeral=True)
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("チケット作成に失敗しました (guild=%s user=%s)", guild.id, interaction.user.id)
            await interaction.followup.send("チケットの作成に失敗しました。Botの権限を確認してください。", ephemeral=True)

    async def _room_owner_id(self, room: discord.abc.GuildChannel | discord.Thread) -> int | None:
        if isinstance(room, discord.Thread):
            return getattr(room, "owner_id", None)
        topic = getattr(room, "topic", "") or ""
        prefix = "support-ticket-owner:"
        if topic.startswith(prefix) and topic[len(prefix):].isdigit():
            return int(topic[len(prefix):])
        return None

    async def _can_operate(self, interaction: discord.Interaction, room: discord.abc.GuildChannel | discord.Thread, settings: dict[str, Any]) -> bool:
        member = interaction.user
        perms = getattr(member, "guild_permissions", None)
        if getattr(perms, "administrator", False) or getattr(perms, "manage_guild", False):
            return True
        role_ids = {role.id for role in getattr(member, "roles", [])}
        if role_ids.intersection(settings["operator_role_ids"]) or member.id in settings["operator_user_ids"]:
            return True
        owner_id = await self._room_owner_id(room)
        return bool(settings["user_manage"] and owner_id == member.id)

    async def _fetch_room(self, guild: discord.Guild, room_id: int):
        room = guild.get_channel_or_thread(room_id)
        if room is not None:
            return room
        try:
            return await self.bot.fetch_channel(room_id)
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            return None

    async def assign_room(self, interaction: discord.Interaction, room_id: int):
        guild = interaction.guild
        if guild is None:
            return
        room = await self._fetch_room(guild, room_id)
        if room is None:
            return await interaction.response.send_message("チケットルームが見つかりません。", ephemeral=True)
        settings = get_ticket_settings(guild_settings.get_store(), guild.id)
        if not await self._can_operate(interaction, room, settings):
            return await interaction.response.send_message("このチケットを操作する権限がありません。", ephemeral=True)
        current = (settings.get("assignments") or {}).get(str(room_id))
        note = f"現在の担当: <@{current}>" if current else "担当は未設定です。"
        return await interaction.response.send_message(
            f"{note}\n担当にするメンバーを選んでください。",
            view=TicketAssignView(self, room_id),
            ephemeral=True,
        )

    async def set_assignee(self, interaction: discord.Interaction, room_id: int, member: Any):
        guild = interaction.guild
        if guild is None:
            return
        room = await self._fetch_room(guild, room_id)
        if room is None:
            return await interaction.response.send_message("チケットルームが見つかりません。", ephemeral=True)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_ticket_settings(store, guild.id)
        if not await self._can_operate(interaction, room, settings):
            return await interaction.response.send_message("このチケットを操作する権限がありません。", ephemeral=True)
        assignments = dict(settings.get("assignments") or {})
        assignments[str(room_id)] = member.id
        settings["assignments"] = assignments
        await self.save_settings(guild.id, settings)
        await interaction.response.send_message(f"担当を <@{member.id}> に設定しました。", ephemeral=True)
        try:
            await room.send(f"担当が <@{member.id}> に設定されました。")
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("担当の通知を送信できませんでした (room=%s)", room_id)

    async def _save_transcript(self, guild: discord.Guild, room: Any, settings: dict[str, Any]) -> None:
        """クローズ/削除の前に、会話記録を設定済みチャンネルへ保存する。"""
        channel_id = settings.get("transcript_channel_id")
        if not channel_id:
            return
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                return
        try:
            messages = [message async for message in room.history(limit=TRANSCRIPT_LIMIT, oldest_first=True)]
        except (discord.Forbidden, discord.HTTPException, AttributeError):
            logger.debug("チケット記録を取得できませんでした (room=%s)", getattr(room, "id", None))
            return
        if not messages:
            return
        owner_id = await self._room_owner_id(room)
        assignee_id = (settings.get("assignments") or {}).get(str(room.id))
        summary = (
            f"チケット {room.id} の記録\n"
            f"作成者: {f'<@{owner_id}>' if owner_id else '不明'}\n"
            f"担当: {f'<@{assignee_id}>' if assignee_id else '未設定'}"
        )
        data = build_transcript(messages, room.id).encode("utf-8")
        try:
            await channel.send(
                content=summary,
                file=discord.File(io.BytesIO(data), filename=f"ticket-{room.id}.txt"),
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("チケット記録を保存できませんでした (room=%s)", getattr(room, "id", None))

    async def close_room(self, interaction: discord.Interaction, room_id: int):
        guild = interaction.guild
        if guild is None:
            return
        room = await self._fetch_room(guild, room_id)
        if room is None:
            return await interaction.response.send_message("チケットルームが見つかりません。", ephemeral=True)
        settings = get_ticket_settings(guild_settings.get_store(), guild.id)
        if not await self._can_operate(interaction, room, settings):
            return await interaction.response.send_message("このチケットを操作する権限がありません。", ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        try:
            if isinstance(room, discord.Thread):
                await room.edit(archived=True, locked=True, reason="チケットを閉じる")
            else:
                await room.edit(sync_permissions=False, reason="チケットを閉じる")
                overwrites = room.overwrites
                for target, overwrite in overwrites.items():
                    if isinstance(target, (discord.Member, discord.Role)) and target != guild.me:
                        overwrite.send_messages = False
                        await room.set_permissions(target, overwrite=overwrite)
            if interaction.message is not None:
                await interaction.message.edit(view=TicketRoomView(room.id, closed=True))
            await self._save_transcript(guild, room, settings)
            await interaction.followup.send("チケットを閉じました。", ephemeral=True)
            if settings["delete_after"]:
                task = asyncio.create_task(self._delete_later(room.id, settings["delete_after"]))
                self._delete_tasks[room.id] = task
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("チケットを閉じられません (room=%s)", room_id)
            await interaction.followup.send("チケットを閉じられませんでした。", ephemeral=True)

    async def reopen_room(self, interaction: discord.Interaction, room_id: int):
        guild = interaction.guild
        if guild is None:
            return
        room = await self._fetch_room(guild, room_id)
        if room is None:
            return await interaction.response.send_message("チケットルームが見つかりません。", ephemeral=True)
        settings = get_ticket_settings(guild_settings.get_store(), guild.id)
        if not await self._can_operate(interaction, room, settings):
            return await interaction.response.send_message("このチケットを操作する権限がありません。", ephemeral=True)
        task = self._delete_tasks.pop(room.id, None)
        if task is not None:
            task.cancel()
        await interaction.response.defer(ephemeral=True)
        try:
            if isinstance(room, discord.Thread):
                await room.edit(archived=False, locked=False, reason="チケットを再開")
            else:
                for target, overwrite in room.overwrites.items():
                    if isinstance(target, (discord.Member, discord.Role)) and target != guild.me:
                        overwrite.send_messages = True
                        await room.set_permissions(target, overwrite=overwrite)
            if interaction.message is not None:
                await interaction.message.edit(view=TicketRoomView(room.id, closed=False, assignable=True))
            await interaction.followup.send("チケットを再開しました。", ephemeral=True)
        except (discord.Forbidden, discord.HTTPException):
            await interaction.followup.send("チケットを再開できませんでした。", ephemeral=True)

    async def delete_room(self, interaction: discord.Interaction, room_id: int):
        guild = interaction.guild
        if guild is None:
            return
        room = await self._fetch_room(guild, room_id)
        if room is None:
            return await interaction.response.send_message("チケットルームが見つかりません。", ephemeral=True)
        settings = get_ticket_settings(guild_settings.get_store(), guild.id)
        if not await self._can_operate(interaction, room, settings):
            return await interaction.response.send_message("このチケットを操作する権限がありません。", ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        task = self._delete_tasks.pop(room.id, None)
        if task is not None:
            task.cancel()
        await self._save_transcript(guild, room, settings)
        try:
            await room.delete(reason="チケットを削除")
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.followup.send("チケットを削除できませんでした。", ephemeral=True)
        assignments = dict(settings.get("assignments") or {})
        if str(room_id) in assignments:
            del assignments[str(room_id)]
            settings["assignments"] = assignments
            await self.save_settings(guild.id, settings)

    async def _delete_later(self, room_id: int, delay: int):
        try:
            await asyncio.sleep(delay)
            room = self.bot.get_channel(room_id)
            if room is None:
                try:
                    room = await self.bot.fetch_channel(room_id)
                except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                    room = None
            if room is not None:
                await room.delete(reason="チケット自動削除")
        except asyncio.CancelledError:
            return
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("チケット自動削除に失敗しました (room=%s)", room_id)
        finally:
            self._delete_tasks.pop(room_id, None)

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return
        custom_id = (interaction.data or {}).get("custom_id", "")
        if custom_id == "support_ticket:create":
            return await self.create_ticket(interaction)
        if custom_id.startswith("support_ticket:create_type:"):
            return await self.create_ticket(interaction, custom_id.split(":", 2)[2])
        if custom_id.startswith("support_ticket:"):
            parts = custom_id.split(":")
            if len(parts) == 3 and parts[2].isdigit():
                action, room_id = parts[1], int(parts[2])
                if action == "close":
                    return await self.close_room(interaction, room_id)
                if action == "reopen":
                    return await self.reopen_room(interaction, room_id)
                if action == "delete":
                    return await self.delete_room(interaction, room_id)
                if action == "assign":
                    return await self.assign_room(interaction, room_id)
        if custom_id.startswith("ticket_adv:"):
            return await self.handle_advanced(interaction, custom_id.split(":", 1)[1])

    async def handle_advanced(self, interaction: discord.Interaction, action: str):
        if interaction.guild_id is None:
            return
        if not TicketSettingsView.can_manage(interaction):
            return await interaction.response.send_message(MANAGE_GUILD_REQUIRED, ephemeral=True)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_ticket_settings(store, interaction.guild_id)
        if action == "viewers":
            return await interaction.response.send_modal(TicketIdsModal(TicketAdvancedSettingsView(self, settings), "viewer_user_ids", "閲覧ユーザー設定", "ユーザーID（空白・カンマ区切り、最大25人）"))
        if action == "viewer_roles":
            return await interaction.response.send_modal(TicketIdsModal(TicketAdvancedSettingsView(self, settings), "viewer_role_ids", "閲覧ロール設定", "ロールID（空白・カンマ区切り、最大25個）"))
        if action == "operators":
            return await interaction.response.send_modal(TicketIdsModal(TicketAdvancedSettingsView(self, settings), "operator_user_ids", "操作ユーザー設定", "ユーザーID（空白・カンマ区切り、最大25人）"))
        if action == "operator_roles":
            return await interaction.response.send_modal(TicketIdsModal(TicketAdvancedSettingsView(self, settings), "operator_role_ids", "操作ロール設定", "ロールID（空白・カンマ区切り、最大25個）"))
        if action == "types":
            return await interaction.response.send_modal(TicketTypesModal(TicketAdvancedSettingsView(self, settings)))
        if action == "delete_cycle":
            current = settings["delete_after"]
            settings["delete_after"] = TICKET_DELETE_OPTIONS[(TICKET_DELETE_OPTIONS.index(current) + 1) % len(TICKET_DELETE_OPTIONS)]
            await self.save_settings(interaction.guild_id, settings)
            return await edit_panel_v2(interaction, as_panel_v2(TicketAdvancedSettingsView(self, settings)))
        if action == "user_manage":
            settings["user_manage"] = not settings["user_manage"]
            await self.save_settings(interaction.guild_id, settings)
            return await edit_panel_v2(interaction, as_panel_v2(TicketAdvancedSettingsView(self, settings)))
        if action == "send_panel":
            await interaction.response.defer(ephemeral=True)
            return await self.send_settings_panel(interaction, settings)
        if action == "back":
            return await edit_panel_v2(interaction, as_panel_v2(TicketSettingsView(self, settings)))

async def setup(bot: commands.Bot):
    await bot.add_cog(TicketCog(bot))
