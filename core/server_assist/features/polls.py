"""Poll panel with persistent vote select and close button."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import discord

from core.server_assist import Feature, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.storage import KVStore

logger = logging.getLogger(__name__)

KEY = "polls"

MAX_OPTIONS = 10
MAX_VOTERS_PER_OPTION = 2000
CREATE_COOLDOWN = 60.0
VOTE_COOLDOWN = 2.0

FEATURE = Feature(
    key=KEY,
    label="投票",
    description="質問と選択肢から投票を作り、結果をその場で集計します。",
    order=70,
    module_name=__name__,
)

_entries: KVStore | None = None
_cache: dict[str, dict[str, Any]] | None = None
_locks: dict[str, asyncio.Lock] = {}
_last_create: dict[tuple[int, int], float] = {}
_last_vote: dict[tuple[int, int], float] = {}


def reset_cache() -> None:
    global _entries, _cache
    _entries = None
    _cache = None
    _locks.clear()
    _last_create.clear()
    _last_vote.clear()


def _store() -> KVStore:
    global _entries
    if _entries is None:
        _entries = KVStore("server_assist_polls")
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
    # 投票の応答を Supabase 待ちにしない。ローカルと未送信ジャーナルにはすぐ残る。
    await _store().set(key, dict(entry), wait=False)


def _lock(message_id: int) -> asyncio.Lock:
    return _locks.setdefault(str(message_id), asyncio.Lock())


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
        "multiple": bool(raw.get("multiple", False)),
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


def build_panel_embed() -> discord.Embed:
    return discord.Embed(
        title="投票",
        description=(
            "下の「投票を作成」ボタンから、質問と選択肢を入力して投票を作れます。"
            "\n作成した投票には、その場で投票できます。"
            "\n締め切りは作成者か「サーバーの管理」権限を持つ人が操作できます。"
        ),
        color=0xFFFFFF,
    )


def _normalized_votes(entry: dict[str, Any], count: int) -> list[list[int]]:
    raw = entry.get("votes")
    votes: list[list[int]] = []
    for index in range(count):
        users: Any = []
        if isinstance(raw, list) and index < len(raw) and isinstance(raw[index], list):
            users = raw[index]
        votes.append([int(user) for user in users if isinstance(user, int)])
    return votes


def _bar(count: int, maximum: int) -> str:
    if maximum <= 0:
        return ""
    filled = round(count / maximum * 10) if count else 0
    filled = max(0, min(10, filled))
    return "█" * filled + "░" * (10 - filled)


def build_embed(entry: dict[str, Any]) -> discord.Embed:
    options = list(entry.get("options") or [])
    votes = _normalized_votes(entry, len(options))
    maximum = max((len(users) for users in votes), default=0)
    total = len({user for users in votes for user in users})
    embed = discord.Embed(
        title="投票",
        description=str(entry.get("question") or "")[:4000],
        color=0xFFFFFF,
    )
    for index, option in enumerate(options[:MAX_OPTIONS]):
        count = len(votes[index])
        embed.add_field(
            name=f"{index + 1}. {str(option)}"[:256],
            value=f"{count}票 {_bar(count, maximum)}".strip()[:1024],
            inline=False,
        )
    state = "締め切り" if entry.get("status") == "closed" else "受付中"
    mode = "複数選択" if entry.get("multiple") else "1つ選択"
    embed.set_footer(
        text=(
            f"{state} / {mode} / 投票者 {total}人 / 作成: "
            f"{entry.get('author_name') or 'メンバー'}"
        )[:2048]
    )
    return embed


class PollPanelView(discord.ui.View):
    def __init__(self, cog: Any):
        self.cog = cog
        super().__init__(timeout=None)

    @discord.ui.button(label="投票を作成", style=discord.ButtonStyle.primary,
                       custom_id="assist:poll:create", row=0)
    async def create(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.handle_poll_create(interaction)


class PollVoteSelect(discord.ui.Select):
    def __init__(self, cog: Any, entry: dict[str, Any] | None = None, *, disabled: bool = False):
        self.cog = cog
        options: list[discord.SelectOption] = []
        if entry is not None:
            for index, label in enumerate(list(entry.get("options") or [])[:MAX_OPTIONS]):
                options.append(
                    discord.SelectOption(label=f"{index + 1}. {str(label)}"[:100], value=str(index))
                )
        if not options:
            options = [discord.SelectOption(label="投票", value="__none__")]
        multiple = bool(entry is not None and entry.get("multiple") and len(options) > 1)
        super().__init__(
            placeholder="選択肢を選んで投票" if entry is not None else "投票",
            options=options,
            min_values=0,
            max_values=len(options) if multiple else 1,
            custom_id="assist:poll:vote",
            disabled=disabled,
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        if self.disabled:
            return
        values = list((getattr(interaction, "data", None) or {}).get("values") or [])
        await self.cog.handle_poll_vote(interaction, values)


class PollCloseButton(discord.ui.Button):
    def __init__(self, cog: Any, *, disabled: bool = False):
        self.cog = cog
        super().__init__(label="締め切る", style=discord.ButtonStyle.secondary,
                         custom_id="assist:poll:close", disabled=disabled, row=1)

    async def callback(self, interaction: discord.Interaction):
        if self.disabled:
            return
        await self.cog.handle_poll_close(interaction)


class PollVoteView(discord.ui.View):
    def __init__(self, cog: Any, entry: dict[str, Any] | None = None, *, disabled: bool = False):
        self.cog = cog
        super().__init__(timeout=None)
        self.add_item(PollVoteSelect(cog, entry, disabled=disabled))
        self.add_item(PollCloseButton(cog, disabled=disabled))


def register_views(cog: Any) -> None:
    add_view = getattr(getattr(cog, "bot", None), "add_view", None)
    if not callable(add_view):
        return
    for view in (PollPanelView(cog), PollVoteView(cog)):
        try:
            add_view(view)
        except Exception:
            logger.exception("投票の永続ビューを登録できませんでした")


class PollCreateModal(discord.ui.Modal, title="投票を作成"):
    def __init__(self, cog: Any, guild_id: int):
        super().__init__()
        self.cog = cog
        self.guild_id = guild_id
        self.question_input = discord.ui.TextInput(
            label="質問",
            max_length=200,
            required=True,
            placeholder="例: 次のイベントはどれがいい？",
        )
        self.options_input = discord.ui.TextInput(
            label="選択肢（1行に1つ）",
            style=discord.TextStyle.paragraph,
            max_length=1000,
            required=True,
            placeholder="ラーメン\nカレー\n寿司",
        )
        self.add_item(self.question_input)
        self.add_item(self.options_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        current = settings(interaction.guild_id)
        if not current["enabled"] or current["channel_id"] is None:
            return await interaction.response.send_message("投票は現在オフです。", ephemeral=True)
        channel = interaction.guild.get_channel(current["channel_id"])
        if channel is None:
            return await interaction.response.send_message("投票先のチャンネルが見つかりません。", ephemeral=True)
        options: list[str] = []
        for line in str(self.options_input.value or "").splitlines():
            label = line.strip()[:80]
            if label and label not in options:
                options.append(label)
        if len(options) < 2:
            return await interaction.response.send_message("選択肢を2つ以上入力してください。", ephemeral=True)
        if len(options) > MAX_OPTIONS:
            return await interaction.response.send_message(
                f"選択肢は{MAX_OPTIONS}個までです。", ephemeral=True,
            )
        cooldown_key = (interaction.guild_id, interaction.user.id)
        now = time.monotonic()
        if now - _last_create.get(cooldown_key, 0.0) < CREATE_COOLDOWN:
            return await interaction.response.send_message(
                "連続で投票を作成できません。少し待ってください。", ephemeral=True,
            )
        _last_create[cooldown_key] = now
        await interaction.response.defer(ephemeral=True)
        entry: dict[str, Any] = {
            "guild_id": interaction.guild_id,
            "channel_id": channel.id,
            "author_id": interaction.user.id,
            "author_name": (
                getattr(interaction.user, "display_name", None)
                or getattr(interaction.user, "name", "メンバー")
            ),
            "question": str(self.question_input.value or "投票")[:200],
            "options": options,
            "votes": [[] for _ in options],
            "multiple": current["multiple"],
            "status": "open",
        }
        try:
            message = await channel.send(
                embed=build_embed(entry),
                view=PollVoteView(self.cog, entry),
            )
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("投票を投稿できませんでした: guild=%s", interaction.guild_id)
            return await interaction.followup.send("投票を投稿できませんでした。", ephemeral=True)
        await _put_entry(message.id, entry)
        return await interaction.followup.send("投票を作成しました。", ephemeral=True)


async def handle_create(cog: Any, interaction: discord.Interaction) -> None:
    if interaction.guild is None or interaction.guild_id is None:
        return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
    current = settings(interaction.guild_id)
    if not current["enabled"] or current["channel_id"] is None:
        return await interaction.response.send_message("投票は現在オフです。", ephemeral=True)
    return await interaction.response.send_modal(PollCreateModal(cog, interaction.guild_id))


async def handle_vote(cog: Any, interaction: discord.Interaction, values: list[str]) -> None:
    message = getattr(interaction, "message", None)
    if message is None:
        return await interaction.response.send_message("投票メッセージを取得できませんでした。", ephemeral=True)
    user_id = interaction.user.id
    cooldown_key = (message.id, user_id)
    now = time.monotonic()
    if now - _last_vote.get(cooldown_key, 0.0) < VOTE_COOLDOWN:
        return await interaction.response.send_message(
            "少し待ってから投票してください。", ephemeral=True,
        )
    _last_vote[cooldown_key] = now
    # ロック待ちや初回のKV読込みより先にACKする。
    await interaction.response.defer()
    async with _lock(message.id):
        entry = (await _cache_data()).get(str(message.id))
        if entry is None:
            return await interaction.followup.send("この投票は見つかりません。", ephemeral=True)
        if entry.get("status") != "open":
            return await interaction.followup.send("この投票は締め切られています。", ephemeral=True)
        options = list(entry.get("options") or [])
        votes = _normalized_votes(entry, len(options))
        chosen: set[int] = set()
        for value in values:
            try:
                index = int(value)
            except (TypeError, ValueError):
                continue
            if 0 <= index < len(options):
                chosen.add(index)

        if entry.get("multiple"):
            selected = chosen
        else:
            current = next((index for index, users in enumerate(votes) if user_id in users), None)
            selected = set() if current in chosen else chosen

        for index in range(len(options)):
            if index in selected and user_id not in votes[index]:
                if len(votes[index]) >= MAX_VOTERS_PER_OPTION:
                    return await interaction.followup.send(
                        "この選択肢は票の上限に達しています。", ephemeral=True,
                    )
        for index in range(len(options)):
            users = votes[index]
            if index in selected:
                if user_id not in users:
                    users.append(user_id)
            else:
                votes[index] = [user for user in users if user != user_id]

        entry["votes"] = votes
        await _put_entry(message.id, entry)
        # 編集もロック内で行い、同時投票で古い集計が最後に表示されるのを防ぐ。
        try:
            await message.edit(embed=build_embed(entry), view=PollVoteView(cog, entry))
        except Exception:
            logger.exception("投票の表示を更新できませんでした: message=%s", message.id)
            return await interaction.followup.send(
                "投票は保存しましたが、表示を更新できませんでした。もう一度選ぶと再表示します。",
                ephemeral=True,
            )


def _can_manage(interaction: discord.Interaction) -> bool:
    permissions = getattr(getattr(interaction, "user", None), "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_guild", False)
    )


async def handle_close(cog: Any, interaction: discord.Interaction) -> None:
    message = getattr(interaction, "message", None)
    if message is None:
        return await interaction.response.send_message("投票メッセージを取得できませんでした。", ephemeral=True)
    await interaction.response.defer()
    changed = False
    edited = False
    async with _lock(message.id):
        entry = (await _cache_data()).get(str(message.id))
        if entry is None:
            return await interaction.followup.send("この投票は見つかりません。", ephemeral=True)
        user = getattr(interaction, "user", None)
        user_id = getattr(user, "id", None)
        if user_id != entry.get("author_id") and not _can_manage(interaction):
            return await interaction.followup.send(
                "締め切れるのは作成者か「サーバーの管理」権限を持つ人だけです。", ephemeral=True,
            )
        if entry.get("status") != "closed":
            entry["status"] = "closed"
            entry["closed_by"] = user_id
            await _put_entry(message.id, entry)
            changed = True
        # 状態が締め切り済みでも、表示更新に失敗していたら再試行で直せるようにする。
        try:
            await message.edit(embed=build_embed(entry), view=PollVoteView(cog, entry, disabled=True))
            edited = True
        except Exception:
            logger.exception("投票の締め切り表示を更新できませんでした: message=%s", message.id)
    if not edited:
        return await interaction.followup.send(
            "締め切りは保存しましたが、表示を更新できませんでした。もう一度押してください。",
            ephemeral=True,
        )
    if changed:
        return await interaction.followup.send("投票を締め切りました。", ephemeral=True)


class PollChannelSelect(discord.ui.Select):
    def __init__(self, parent: "PollSettingsView"):
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
        super().__init__(placeholder="投票を投稿するチャンネル", options=options[:25], row=0)

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
        await self.parent_view.refresh(interaction, "投票の投稿先を保存しました。")


class PollMultipleButton(discord.ui.Button):
    def __init__(self, multiple: bool):
        super().__init__(
            label=f"複数選択: {'オン' if multiple else 'オフ'}",
            style=discord.ButtonStyle.secondary,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        view: PollSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["multiple"]
        await update_settings(view.guild_id, KEY, multiple=value)
        view.settings["multiple"] = value
        self.label = f"複数選択: {'オン' if value else 'オフ'}"
        await view.refresh(interaction, f"複数選択を{'オン' if value else 'オフ'}にしました。")


class PollToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="投票", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: PollSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if not view.settings["enabled"] and view.settings["channel_id"] is None:
            return await interaction.response.send_message("先に投稿先を選んでください。", ephemeral=True)
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        view.settings["enabled"] = value
        await view.refresh(interaction, f"投票を{'オン' if value else 'オフ'}にしました。")


class PollPanelButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="パネルを送信", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: PollSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel_id = view.settings["channel_id"]
        channel = interaction.guild.get_channel(channel_id) if interaction.guild and channel_id else None
        if channel is None:
            return await interaction.response.send_message("先に投稿先を選んでください。", ephemeral=True)
        try:
            await channel.send(embed=build_panel_embed(), view=PollPanelView(view.cog))
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.response.send_message("パネルを送信できませんでした。", ephemeral=True)
        return await interaction.response.send_message("投票パネルを送信しました。", ephemeral=True)


class PollSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "投票"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(PollChannelSelect(self))
        self.add_item(PollMultipleButton(self.settings["multiple"]))
        self.add_item(PollToggleButton())
        self.add_item(PollPanelButton())

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="投票",
            description=(
                "投票パネルを設置し、質問と選択肢から投票を作れるようにします。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**投稿先**: {channel_label(self.settings['channel_id'])}"
                f"\n**選択方式**: {'複数選択' if self.settings['multiple'] else '1つ選択'}"
                "\n\n「パネルを送信」で投票作成ボタン付きのパネルを投稿します。"
                "結果は投票メッセージにその場で表示されます。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> PollSettingsView:
    return PollSettingsView(cog, guild_id)

