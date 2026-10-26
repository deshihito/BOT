"""Event RSVP panel with persistent buttons."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "events"
CREATE_COOLDOWN = 60.0
RSVP_COOLDOWN = 2.0
REFRESH_COOLDOWN = 2.0
CHOICES = ("yes", "no", "maybe")

FEATURE = Feature(
    key=KEY,
    label="イベント",
    description="日時と場所を添えて、参加・不参加・未定を受け付けます。",
    order=120,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, dict[str, Any]] | None = None
_locks: dict[str, asyncio.Lock] = {}
_last_create: dict[tuple[int, int], float] = {}
_last_rsvp: dict[tuple[int, int], float] = {}
_last_refresh: dict[int, float] = {}


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None
    _locks.clear()
    _last_create.clear()
    _last_rsvp.clear()
    _last_refresh.clear()


def _store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_events")
    return _entries


async def _cache_data() -> dict[str, dict[str, Any]]:
    global _cache
    if _cache is None:
        _cache = dict(await _store().load_all())
    return _cache


async def _put_entry(message_id: int, entry: dict[str, Any]) -> None:
    cache = await _cache_data()
    cache[str(message_id)] = dict(entry)
    await _store().set(str(message_id), dict(entry), wait=False)


def _lock(message_id: int) -> asyncio.Lock:
    return _locks.setdefault(str(message_id), asyncio.Lock())


def _as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": _as_int(raw.get("channel_id")),
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


def _users(entry: dict[str, Any], field: str) -> list[int]:
    raw = entry.get(field)
    if not isinstance(raw, list):
        return []
    return [int(user) for user in raw if isinstance(user, int)]


def _status_label(entry: dict[str, Any]) -> str:
    return "終了" if entry.get("status") == "closed" else "受付中"


def build_panel_embed() -> discord.Embed:
    return discord.Embed(
        title="イベント",
        description=(
            "下の「イベントを作成」から、タイトル・説明・日時・場所を入力してください。"
            "\n投稿されたイベントには「参加 / 不参加 / 未定」で回答できます。"
            "\n終了できるのは作成者か「サーバーの管理」権限を持つ人だけです。"
        ),
        color=0xFFFFFF,
    )


def build_embed(entry: dict[str, Any]) -> discord.Embed:
    when_text = str(entry.get("when_text") or "未設定")
    location = str(entry.get("location") or "未設定")
    embed = discord.Embed(
        title=str(entry.get("title") or "イベント")[:256],
        description=(
            f"{str(entry.get('description') or '')[:3500]}\n\n"
            f"**日時**: {when_text[:200]}\n"
            f"**場所**: {location[:200]}"
        )[:4096],
        color=0xFFFFFF,
    )
    embed.add_field(name="参加", value=str(len(_users(entry, "yes"))), inline=True)
    embed.add_field(name="不参加", value=str(len(_users(entry, "no"))), inline=True)
    embed.add_field(name="未定", value=str(len(_users(entry, "maybe"))), inline=True)
    embed.add_field(name="状態", value=_status_label(entry), inline=True)
    embed.set_footer(
        text=f"作成: {entry.get('author_name') or 'メンバー'}"[:2048]
    )
    return embed


class EventPanelView(discord.ui.View):
    def __init__(self, cog: Any):
        self.cog = cog
        super().__init__(timeout=None)

    @discord.ui.button(label="イベントを作成", style=discord.ButtonStyle.primary,
                       custom_id="assist:event:create", row=0)
    async def create(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_event_create(interaction)


class EventRsvpButton(discord.ui.Button):
    def __init__(self, cog: Any, action: str, label: str, style: discord.ButtonStyle,
                 row: int = 0, *, disabled: bool = False):
        self.cog = cog
        self.action = action
        super().__init__(label=label, style=style, row=row, disabled=disabled,
                         custom_id=f"assist:event:{action}")

    async def callback(self, interaction: discord.Interaction):
        if self.disabled:
            return
        if self.action == "close":
            return await self.cog.handle_event_close(interaction)
        if self.action == "refresh":
            return await self.cog.handle_event_refresh(interaction)
        return await self.cog.handle_event_rsvp(interaction, self.action)


class EventRsvpView(discord.ui.View):
    def __init__(self, cog: Any, entry: dict[str, Any] | None = None, *, disabled: bool = False):
        self.cog = cog
        super().__init__(timeout=None)
        self.add_item(EventRsvpButton(cog, "yes", "参加", discord.ButtonStyle.success, 0, disabled=disabled))
        self.add_item(EventRsvpButton(cog, "no", "不参加", discord.ButtonStyle.danger, 0, disabled=disabled))
        self.add_item(EventRsvpButton(cog, "maybe", "未定", discord.ButtonStyle.secondary, 0, disabled=disabled))
        self.add_item(EventRsvpButton(cog, "close", "終了", discord.ButtonStyle.secondary, 1, disabled=disabled))
        self.add_item(EventRsvpButton(cog, "refresh", "表示を更新", discord.ButtonStyle.secondary, 1, disabled=disabled))


def register_views(cog: Any) -> None:
    add_view = getattr(getattr(cog, "bot", None), "add_view", None)
    if not callable(add_view):
        return
    for view in (EventPanelView(cog), EventRsvpView(cog)):
        try:
            add_view(view)
        except Exception:
            logger.exception("イベントの永続ビューを登録できませんでした")


class EventCreateModal(discord.ui.Modal, title="イベントを作成"):
    def __init__(self, cog: Any, guild_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id
        self.title_input = discord.ui.TextInput(label="タイトル", max_length=100, required=True)
        self.description_input = discord.ui.TextInput(
            label="説明", style=discord.TextStyle.paragraph, max_length=1000, required=True,
        )
        self.when_input = discord.ui.TextInput(
            label="日時", max_length=100, required=True, placeholder="例: 10月30日 20:00〜",
        )
        self.location_input = discord.ui.TextInput(
            label="場所", max_length=100, required=False, placeholder="例: ボイスチャンネル「雑談」",
        )
        self.add_item(self.title_input)
        self.add_item(self.description_input)
        self.add_item(self.when_input)
        self.add_item(self.location_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        current = settings(interaction.guild_id)
        if not current["enabled"] or current["channel_id"] is None:
            return await interaction.response.send_message("イベント機能は現在オフです。", ephemeral=True)
        channel = interaction.guild.get_channel(current["channel_id"])
        if channel is None:
            return await interaction.response.send_message("投稿先のチャンネルが見つかりません。", ephemeral=True)
        key = (interaction.guild_id, interaction.user.id)
        now = time.monotonic()
        if now - _last_create.get(key, 0.0) < CREATE_COOLDOWN:
            return await interaction.response.send_message(
                "連続でイベントを作成できません。少し待ってください。", ephemeral=True,
            )
        _last_create[key] = now
        await interaction.response.defer(ephemeral=True)
        entry = {
            "id": uuid.uuid4().hex[:12],
            "guild_id": interaction.guild_id,
            "channel_id": channel.id,
            "author_id": interaction.user.id,
            "author_name": (
                getattr(interaction.user, "display_name", None)
                or getattr(interaction.user, "name", "メンバー")
            ),
            "title": str(self.title_input.value or "イベント")[:100],
            "description": str(self.description_input.value or "")[:1000],
            "when_text": str(self.when_input.value or "")[:100],
            "location": str(self.location_input.value or "")[:100],
            "yes": [],
            "no": [],
            "maybe": [],
            "status": "open",
        }
        try:
            message = await channel.send(embed=build_embed(entry), view=EventRsvpView(self.cog, entry))
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("イベントを投稿できませんでした: guild=%s", interaction.guild_id)
            return await interaction.followup.send("イベントを投稿できませんでした。", ephemeral=True)
        await _put_entry(message.id, entry)
        return await interaction.followup.send("イベントを作成しました。", ephemeral=True)


async def handle_create(cog: Any, interaction: discord.Interaction) -> None:
    if interaction.guild is None or interaction.guild_id is None:
        return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
    current = settings(interaction.guild_id)
    if not current["enabled"] or current["channel_id"] is None:
        return await interaction.response.send_message("イベント機能は現在オフです。", ephemeral=True)
    return await interaction.response.send_modal(EventCreateModal(cog, interaction.guild_id))


async def _handle_rsvp(cog: Any, interaction: discord.Interaction, choice: str) -> None:
    message = getattr(interaction, "message", None)
    if message is None:
        return await interaction.response.send_message("イベントメッセージを取得できませんでした。", ephemeral=True)
    user_id = interaction.user.id
    cooldown_key = (message.id, user_id)
    now = time.monotonic()
    if now - _last_rsvp.get(cooldown_key, 0.0) < RSVP_COOLDOWN:
        return await interaction.response.send_message(
            "少し待ってから回答してください。", ephemeral=True,
        )
    _last_rsvp[cooldown_key] = now
    await interaction.response.defer()
    async with _lock(message.id):
        entry = (await _cache_data()).get(str(message.id))
        if entry is None:
            return await interaction.followup.send("このイベントは見つかりません。", ephemeral=True)
        if entry.get("status") == "closed":
            return await interaction.followup.send("このイベントは終了しています。", ephemeral=True)
        if choice not in CHOICES:
            return await interaction.followup.send("不明な回答です。", ephemeral=True)
        already = user_id in _users(entry, choice)
        for field in CHOICES:
            entry[field] = [user for user in _users(entry, field) if user != user_id]
        if not already:
            entry[choice] = _users(entry, choice) + [user_id]
        await _put_entry(message.id, entry)
        try:
            await message.edit(embed=build_embed(entry), view=EventRsvpView(cog, entry))
        except Exception:
            logger.exception("イベントの表示を更新できませんでした: message=%s", message.id)
            return await interaction.followup.send(
                "回答は保存しましたが、表示を更新できませんでした。「表示を更新」を押してください。",
                ephemeral=True,
            )


async def handle_rsvp(cog: Any, interaction: discord.Interaction, choice: str) -> None:
    await _handle_rsvp(cog, interaction, choice)


def _can_manage(interaction: discord.Interaction) -> bool:
    permissions = getattr(getattr(interaction, "user", None), "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_guild", False)
    )


async def handle_close(cog: Any, interaction: discord.Interaction) -> None:
    message = getattr(interaction, "message", None)
    if message is None:
        return await interaction.response.send_message("イベントメッセージを取得できませんでした。", ephemeral=True)
    await interaction.response.defer()
    changed = False
    edited = False
    async with _lock(message.id):
        entry = (await _cache_data()).get(str(message.id))
        if entry is None:
            return await interaction.followup.send("このイベントは見つかりません。", ephemeral=True)
        user_id = getattr(interaction.user, "id", None)
        if user_id != entry.get("author_id") and not _can_manage(interaction):
            return await interaction.followup.send(
                "終了できるのは作成者か「サーバーの管理」権限を持つ人だけです。", ephemeral=True,
            )
        if entry.get("status") != "closed":
            entry["status"] = "closed"
            entry["closed_by"] = user_id
            await _put_entry(message.id, entry)
            changed = True
        try:
            await message.edit(embed=build_embed(entry), view=EventRsvpView(cog, entry, disabled=True))
            edited = True
        except Exception:
            logger.exception("イベントの終了表示を更新できませんでした: message=%s", message.id)
    if not edited:
        return await interaction.followup.send(
            "終了は保存しましたが、表示を更新できませんでした。もう一度押してください。", ephemeral=True,
        )
    if changed:
        return await interaction.followup.send("イベントを終了しました。", ephemeral=True)


async def handle_refresh(cog: Any, interaction: discord.Interaction) -> None:
    message = getattr(interaction, "message", None)
    if message is None:
        return await interaction.response.send_message("イベントメッセージを取得できませんでした。", ephemeral=True)
    now = time.monotonic()
    if now - _last_refresh.get(message.id, 0.0) < REFRESH_COOLDOWN:
        return await interaction.response.send_message("少し待ってから更新してください。", ephemeral=True)
    _last_refresh[message.id] = now
    await interaction.response.defer()
    async with _lock(message.id):
        entry = (await _cache_data()).get(str(message.id))
        if entry is None:
            return await interaction.followup.send("このイベントは見つかりません。", ephemeral=True)
        try:
            await message.edit(
                embed=build_embed(entry),
                view=EventRsvpView(cog, entry, disabled=entry.get("status") == "closed"),
            )
        except Exception:
            logger.exception("イベントの表示を更新できませんでした: message=%s", message.id)
            return await interaction.followup.send("表示を更新できませんでした。", ephemeral=True)


class EventChannelSelect(discord.ui.Select):
    def __init__(self, parent: "EventSettingsView"):
        self.parent_view = parent
        current = parent.settings["channel_id"]
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
        super().__init__(placeholder="イベントを投稿するチャンネル", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if self.values[0] == "__none__":
            return await interaction.response.send_message("送信できるチャンネルがありません。", ephemeral=True)
        channel_id = int(self.values[0])
        await update_settings(self.parent_view.guild_id, KEY, channel_id=channel_id)
        self.parent_view.settings["channel_id"] = channel_id
        await self.parent_view.refresh(interaction, "イベントの投稿先を保存しました。")


class EventToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="イベント", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: EventSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and view.settings["channel_id"] is None:
            return await interaction.response.send_message("先に投稿先を選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"イベントを{'オン' if value else 'オフ'}にしました。")


class EventPanelButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="パネルを送信", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: EventSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel_id = view.settings["channel_id"]
        channel = interaction.guild.get_channel(channel_id) if interaction.guild and channel_id else None
        if channel is None:
            return await interaction.response.send_message("先に投稿先を選んでください。", ephemeral=True)
        try:
            await channel.send(embed=build_panel_embed(), view=EventPanelView(view.cog))
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("パネルを送信できませんでした。", ephemeral=True)
        return await interaction.response.send_message("イベントパネルを送信しました。", ephemeral=True)


class EventSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "イベント"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(EventChannelSelect(self))
        self.add_item(EventToggleButton())
        self.add_item(EventPanelButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="イベント",
            description=(
                "イベントパネルを設置し、参加・不参加・未定を受け付けます。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**投稿先**: {channel_label(self.settings['channel_id'])}"
                "\n\n「パネルを送信」でイベント作成ボタン付きのパネルを投稿します。"
                "終了は作成者か「サーバーの管理」権限を持つ人が操作できます。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> EventSettingsView:
    return EventSettingsView(cog, guild_id)

