"""Staff application form with a review workflow."""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "applications"

FEATURE = Feature(
    key=KEY,
    label="応募フォーム",
    description="スタッフ応募を受け付け、レビュー担当が承認・不承認を選べます。",
    order=150,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, dict[str, Any]] | None = None
_review_locks: dict[str, asyncio.Lock] = {}


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None
    _review_locks.clear()


def _review_lock(message_id: int) -> asyncio.Lock:
    return _review_locks.setdefault(str(message_id), asyncio.Lock())


def _store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_applications")
    return _entries


async def _cache_data() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is None:
        _cache = dict(await _store().load_all())
    return _cache


async def _put_entry(message_id: int, entry: dict[str, Any]) -> None:
    key = str(message_id)
    cache = await _cache_data()
    cache[key] = dict(entry)
    # 判定ボタンやモーダルの応答を Supabase 待ちにしない。ローカルと未送信ジャーナルには
    # すぐ残るので、再起動時に送り直せる。
    await _store().set(key, dict(entry), wait=False)


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "panel_channel_id": raw.get("panel_channel_id") if isinstance(raw.get("panel_channel_id"), int) else None,
        "review_channel_id": raw.get("review_channel_id") if isinstance(raw.get("review_channel_id"), int) else None,
    }


def _channels(guild: Any) -> list[Any]:
    me = getattr(guild, "me", None)
    channels = list(getattr(guild, "text_channels", []) or [])
    usable: list[Any] = []
    for channel in channels:
        if me is not None:
            try:
                if not channel.permissions_for(me).send_messages:
                    continue
            except Exception:
                pass
        usable.append(channel)
    return usable[:25]


def _status_label(status: str) -> str:
    return {
        "pending": "審査中",
        "accepted": "承認",
        "denied": "不承認",
        "on_hold": "保留",
    }.get(status, status)


def build_panel_embed() -> discord.Embed:
    return discord.Embed(
        title="スタッフ応募",
        description=(
            "スタッフ募集に応募する場合は、下の「応募する」ボタンから必要事項を入力してください。"
            "\n応募内容はレビュー担当だけが確認します。"
        ),
        color=0xFFFFFF,
    )


def build_application_embed(entry: dict[str, Any]) -> discord.Embed:
    embed = discord.Embed(
        title="スタッフ応募",
        description=f"応募者: <@{entry.get('applicant_id')}>",
        color=0xFFFFFF,
    )
    embed.add_field(name="名前 / 呼び名", value=str(entry.get("name") or "未記入")[:1024], inline=False)
    embed.add_field(name="応募理由", value=str(entry.get("reason") or "未記入")[:1024], inline=False)
    embed.add_field(name="経験・得意なこと", value=str(entry.get("experience") or "未記入")[:1024], inline=False)
    embed.add_field(name="状態", value=_status_label(str(entry.get("status") or "pending")), inline=True)
    if entry.get("decided_by"):
        embed.add_field(name="判定者", value=f"<@{entry['decided_by']}>", inline=True)
    embed.set_footer(text=f"Application ID: {entry.get('id', '')}"[:2048])
    return embed


class ApplicationPanelView(discord.ui.View):
    def __init__(self, cog: Any):
        self.cog = cog
        super().__init__(timeout=None)

    @discord.ui.button(label="応募する", style=discord.ButtonStyle.primary,
                       custom_id="assist:application:create", row=0)
    async def create(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_application_create(interaction)


class ApplicationReviewView(discord.ui.View):
    def __init__(self, cog: Any, *, disabled: bool = False):
        self.cog = cog
        super().__init__(timeout=None)
        if disabled:
            for item in self.children:
                item.disabled = True

    @discord.ui.button(label="承認", style=discord.ButtonStyle.success,
                       custom_id="assist:application:accept", row=0)
    async def accept(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_application_review(interaction, "accept")

    @discord.ui.button(label="保留", style=discord.ButtonStyle.secondary,
                       custom_id="assist:application:hold", row=0)
    async def hold(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_application_review(interaction, "hold")

    @discord.ui.button(label="不承認", style=discord.ButtonStyle.danger,
                       custom_id="assist:application:deny", row=0)
    async def deny(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_application_review(interaction, "deny")


def register_views(cog: Any) -> None:
    add_view = getattr(getattr(cog, "bot", None), "add_view", None)
    if not callable(add_view):
        return
    for view in (ApplicationPanelView(cog), ApplicationReviewView(cog)):
        try:
            add_view(view)
        except Exception:
            logger.exception("応募フォームの永続ビューを登録できませんでした")


class ApplicationModal(discord.ui.Modal, title="スタッフ応募"):
    def __init__(self, cog: Any, guild_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id
        self.name_input = discord.ui.TextInput(
            label="名前 / 呼び名",
            max_length=100,
            required=True,
        )
        self.reason_input = discord.ui.TextInput(
            label="応募理由",
            style=discord.TextStyle.paragraph,
            max_length=1000,
            required=True,
        )
        self.experience_input = discord.ui.TextInput(
            label="経験・得意なこと",
            style=discord.TextStyle.paragraph,
            max_length=1000,
            required=True,
        )
        self.add_item(self.name_input)
        self.add_item(self.reason_input)
        self.add_item(self.experience_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        current = settings(interaction.guild_id)
        if not current["enabled"] or current["review_channel_id"] is None:
            return await interaction.response.send_message("応募フォームは現在オフです。", ephemeral=True)
        review = interaction.guild.get_channel(current["review_channel_id"])
        if review is None:
            return await interaction.response.send_message("レビュー先チャンネルが見つかりません。", ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        entry = {
            "id": f"{interaction.user.id}-{uuid.uuid4().hex[:8]}",
            "guild_id": interaction.guild_id,
            "applicant_id": interaction.user.id,
            "applicant_name": getattr(interaction.user, "display_name", None) or getattr(interaction.user, "name", "メンバー"),
            "name": str(self.name_input.value or "")[:100],
            "reason": str(self.reason_input.value or "")[:1000],
            "experience": str(self.experience_input.value or "")[:1000],
            "status": "pending",
            "decided_by": None,
        }
        try:
            message = await review.send(
                embed=build_application_embed(entry),
                view=ApplicationReviewView(self.cog),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("応募を投稿できませんでした: guild=%s", interaction.guild_id)
            return await interaction.followup.send("応募を投稿できませんでした。", ephemeral=True)
        await _put_entry(message.id, entry)
        return await interaction.followup.send("応募を受け付けました。", ephemeral=True)


async def handle_create(cog: Any, interaction: discord.Interaction) -> None:
    if interaction.guild is None or interaction.guild_id is None:
        return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
    current = settings(interaction.guild_id)
    if not current["enabled"] or current["review_channel_id"] is None:
        return await interaction.response.send_message("応募フォームは現在オフです。", ephemeral=True)
    return await interaction.response.send_modal(ApplicationModal(cog, interaction.guild_id))


def _can_review(interaction: discord.Interaction) -> bool:
    permissions = getattr(interaction.user, "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_guild", False)
    )


async def handle_review(cog: Any, interaction: discord.Interaction, action: str) -> None:
    if not _can_review(interaction):
        return await interaction.response.send_message(
            "応募の判定には「サーバーの管理」権限が必要です。", ephemeral=True,
        )
    message = getattr(interaction, "message", None)
    if message is None:
        return await interaction.response.send_message("応募メッセージを取得できませんでした。", ephemeral=True)
    async with _review_lock(message.id):
        await _handle_review_locked(cog, interaction, action, message)


async def _handle_review_locked(
    cog: Any, interaction: discord.Interaction, action: str, message: Any,
) -> None:
    entry = (await _cache_data()).get(str(message.id))
    if entry is None:
        return await interaction.response.send_message("この応募は見つかりません。", ephemeral=True)
    if entry.get("status") != "pending":
        return await interaction.response.send_message("この応募はすでに判定済みです。", ephemeral=True)
    status = {"accept": "accepted", "deny": "denied", "hold": "on_hold"}.get(action)
    if status is None:
        return await interaction.response.send_message("不明な操作です。", ephemeral=True)
    entry["status"] = status
    entry["decided_by"] = interaction.user.id
    await _put_entry(message.id, entry)
    await interaction.response.edit_message(
        embed=build_application_embed(entry),
        view=ApplicationReviewView(cog, disabled=True),
    )
    applicant = None
    if interaction.guild is not None:
        applicant = interaction.guild.get_member(int(entry["applicant_id"]))
    if applicant is None:
        try:
            applicant = await interaction.client.fetch_user(int(entry["applicant_id"]))
        except (discord.NotFound, discord.HTTPException):
            applicant = None
    if applicant is not None:
        try:
            await applicant.send(f"スタッフ応募の結果: **{_status_label(status)}**")
        except (discord.Forbidden, discord.HTTPException):
            logger.debug("応募結果のDMを送信できませんでした: user=%s", entry.get("applicant_id"))


class ApplicationChannelSelect(discord.ui.Select):
    def __init__(self, parent: "ApplicationSettingsView", kind: str):
        self.parent_view = parent
        self.kind = kind
        current = parent.settings.get(f"{kind}_channel_id")
        options = [
            discord.SelectOption(
                label=str(getattr(channel, "name", "チャンネル"))[:100],
                value=str(channel.id),
                default=channel.id == current,
            )
            for channel in _channels(parent.guild)
        ]
        if not options:
            options = [discord.SelectOption(label="送信できるチャンネルがありません", value="__none__")]
        labels = {"panel": "応募パネルを置くチャンネル", "review": "応募をレビューするチャンネル"}
        super().__init__(placeholder=labels.get(kind, "チャンネル"), options=options[:25], row=0 if kind == "panel" else 1)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        field = f"{self.kind}_channel_id"
        await update_settings(self.parent_view.guild_id, KEY, **{field: channel_id})
        self.parent_view.settings[field] = channel_id
        await self.parent_view.refresh(interaction, "応募フォームのチャンネルを保存しました。")


class ApplicationToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="応募フォーム", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: ApplicationSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and view.settings["review_channel_id"] is None:
            return await interaction.response.send_message("先にレビュー先を選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"応募フォームを{'オン' if value else 'オフ'}にしました。")


class ApplicationPanelButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="パネルを送信", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: ApplicationSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel_id = view.settings["panel_channel_id"]
        channel = interaction.guild.get_channel(channel_id) if interaction.guild and channel_id else None
        if channel is None:
            return await interaction.response.send_message("先に応募パネルの送信先を選んでください。", ephemeral=True)
        try:
            await channel.send(embed=build_panel_embed(), view=ApplicationPanelView(view.cog))
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("パネルを送信できませんでした。", ephemeral=True)
        return await interaction.response.send_message("応募パネルを送信しました。", ephemeral=True)


class ApplicationSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "応募フォーム"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(ApplicationChannelSelect(self, "panel"))
            self.add_item(ApplicationChannelSelect(self, "review"))
        self.add_item(ApplicationToggleButton())
        self.add_item(ApplicationPanelButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="応募フォーム",
            description=(
                "スタッフ応募のパネルとレビュー導線を設定します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**応募パネル**: {channel_label(self.settings['panel_channel_id'])}"
                f"\n**レビュー先**: {channel_label(self.settings['review_channel_id'])}"
                "\n\n「パネルを送信」で応募ボタン付きパネルを投稿します。"
                "応募はレビュー先へ届き、承認・保留・不承認を選べます。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> ApplicationSettingsView:
    return ApplicationSettingsView(cog, guild_id)
