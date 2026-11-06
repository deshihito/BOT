"""Resident shiritori: in a designated channel, every kana message is a move.

Unlike the session-based /game shiritori, there is no lobby or turn order:
the bot silently tracks the chain behind ordinary conversation and only
posts when the chain breaks.  Word judgement reuses the session game's
pure helpers (``core.game.shiritori.cog``).
"""
from __future__ import annotations

import logging
from typing import Any

import discord

from core.game.shiritori.cog import check_answer, is_kana_word, normalize
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.server_assist import Feature, get_settings, update_settings
from core.support.server_assist.ui import AssistFeatureView, notice_line

logger = logging.getLogger(__name__)

KEY = "shiritori_resident"
MAX_CHANNELS = 5

FEATURE = Feature(
    key=KEY,
    label="常駐しりとり",
    description="指定チャンネルの発言がそのまましりとりの手になる常駐モードです。",
    order=145,
    module_name=__name__,
)


def _empty_state() -> dict[str, Any]:
    return {
        "last_word": None,
        "used": [],
        "chain": 0,
        "best": 0,
        "breaks": 0,
        "players": {},
    }


def _normalize_state(raw: Any) -> dict[str, Any]:
    state = _empty_state()
    if not isinstance(raw, dict):
        return state
    last_word = raw.get("last_word")
    state["last_word"] = str(last_word) if isinstance(last_word, str) and last_word else None
    used = raw.get("used")
    if isinstance(used, list):
        state["used"] = [str(word) for word in used if isinstance(word, str)]
    for field in ("chain", "best", "breaks"):
        value = raw.get(field)
        state[field] = value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0
    players = raw.get("players")
    if isinstance(players, dict):
        state["players"] = {
            str(user_id): count
            for user_id, count in players.items()
            if isinstance(count, int) and not isinstance(count, bool) and count > 0
        }
    return state


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    channels: dict[int, dict[str, Any]] = {}
    raw_channels = raw.get("channels")
    if isinstance(raw_channels, dict):
        for channel_id, state in raw_channels.items():
            try:
                channels[int(channel_id)] = _normalize_state(state)
            except (TypeError, ValueError):
                continue
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channels": dict(list(channels.items())[:MAX_CHANNELS]),
    }


def _serialize(channels: dict[int, dict[str, Any]]) -> dict[str, Any]:
    return {str(channel_id): state for channel_id, state in channels.items()}


async def _save_channels(guild_id: int, channels: dict[int, dict[str, Any]]) -> None:
    await update_settings(guild_id, KEY, channels=_serialize(channels))


def apply_word(state: dict[str, Any], word: Any, user_id: Any) -> tuple[str, str, int]:
    """Apply one message to a channel chain.

    Returns ``(kind, reason, achieved)`` where kind is one of:
    ``ignore`` (not a kana word — ordinary conversation), ``start``,
    ``accept`` (chain continues silently), ``break`` (chain ended;
    ``achieved`` is the chain length that was lost).  ``state`` is mutated
    in place for every kind except ``ignore``.
    """
    text = str(word or "").strip()
    if not is_kana_word(text):
        return "ignore", "", 0
    norm = normalize(text)
    if state["last_word"] is None:
        if norm.endswith("ん"):
            state["breaks"] += 1
            return "break", "「ん」で終わる言葉では始められません", 0
        state["last_word"] = text
        state["used"] = [norm]
        state["chain"] = 1
        state["best"] = max(state["best"], 1)
        _count_player(state, user_id)
        return "start", "", 1
    result, reason = check_answer(state["last_word"], text, set(state["used"]))
    if result == "ok":
        state["last_word"] = text
        state["used"].append(norm)
        state["chain"] += 1
        state["best"] = max(state["best"], state["chain"])
        _count_player(state, user_id)
        return "accept", "", state["chain"]
    achieved = state["chain"]
    state["best"] = max(state["best"], achieved)
    state["last_word"] = None
    state["used"] = []
    state["chain"] = 0
    state["breaks"] += 1
    return "break", reason, achieved


def _count_player(state: dict[str, Any], user_id: Any) -> None:
    key = str(user_id)
    state["players"][key] = int(state["players"].get(key, 0)) + 1


async def on_message(cog: Any, message: Any) -> None:
    guild = getattr(message, "guild", None)
    author = getattr(message, "author", None)
    channel = getattr(message, "channel", None)
    if guild is None or author is None or channel is None:
        return
    if getattr(author, "bot", False) or getattr(author, "webhook_id", None):
        return
    current = settings(guild.id)
    if not current["enabled"]:
        return
    state = current["channels"].get(getattr(channel, "id", None))
    if state is None:
        return
    kind, reason, achieved = apply_word(state, getattr(message, "content", ""), getattr(author, "id", 0))
    if kind == "ignore":
        return
    await _save_channels(guild.id, current["channels"])
    if kind != "break":
        return
    if achieved > 0:
        text = (
            f"しりとりが途切れました（{reason}）。**{achieved} 連**で終了です。"
            f"最長記録は {state['best']} 連。かなの言葉を送ると新しいチェーンが始まります。"
        )
    else:
        text = f"{reason}。かなの言葉を送るとチェーンが始まります。"
    try:
        await channel.send(text, allowed_mentions=discord.AllowedMentions.none())
    except (discord.Forbidden, discord.HTTPException):
        logger.debug("常駐しりとりの通知を送信できませんでした: guild=%s", guild.id)


class ShiritoriChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "ShiritoriResidentSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="対象チャンネルを選ぶ",
            channel_types=[discord.ChannelType.text],
            min_values=1,
            max_values=1,
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        selected = self.values[0] if self.values else None
        view.selected_channel_id = getattr(selected, "id", None)
        await view.reopen(interaction)


class ShiritoriRegisterButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="登録 / 解除", style=discord.ButtonStyle.primary, row=1)

    async def callback(self, interaction: discord.Interaction):
        view: ShiritoriResidentSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if view.selected_channel_id is None:
            return await interaction.response.send_message("先にチャンネルを選んでください。", ephemeral=True)
        channels = dict(settings(view.guild_id)["channels"])
        channel_id = view.selected_channel_id
        if channel_id in channels:
            del channels[channel_id]
            notice = f"<#{channel_id}> の常駐しりとりを解除しました。"
        else:
            if len(channels) >= MAX_CHANNELS:
                return await interaction.response.send_message(
                    f"対象チャンネルは最大{MAX_CHANNELS}件です。", ephemeral=True,
                )
            channels[channel_id] = _empty_state()
            notice = f"<#{channel_id}> を常駐しりとりの対象にしました。"
        await _save_channels(view.guild_id, channels)
        await view.reopen(interaction, notice)


class ShiritoriResetButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="チェーンをリセット", style=discord.ButtonStyle.secondary, row=1)

    async def callback(self, interaction: discord.Interaction):
        view: ShiritoriResidentSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if view.selected_channel_id is None:
            return await interaction.response.send_message("先にチャンネルを選んでください。", ephemeral=True)
        channels = dict(settings(view.guild_id)["channels"])
        state = channels.get(view.selected_channel_id)
        if state is None:
            return await interaction.response.send_message("そのチャンネルは登録されていません。", ephemeral=True)
        state["last_word"] = None
        state["used"] = []
        state["chain"] = 0
        await _save_channels(view.guild_id, channels)
        await view.reopen(interaction, "チェーンをリセットしました（記録と参加者数は残ります）。")


class ShiritoriToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="常駐しりとり", style=discord.ButtonStyle.secondary, row=1)

    async def callback(self, interaction: discord.Interaction):
        view: ShiritoriResidentSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not view.settings["enabled"]
        await update_settings(view.guild_id, KEY, enabled=value)
        await view.reopen(interaction, f"常駐しりとりを{'オン' if value else 'オフ'}にしました。")


class ShiritoriResidentSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "常駐しりとり"

    def __init__(self, cog: Any, guild_id: int):
        self.settings = settings(guild_id)
        self.selected_channel_id: int | None = None
        super().__init__(cog, guild_id)
        self.add_item(ShiritoriChannelSelect(self))
        self.add_item(ShiritoriRegisterButton())
        self.add_item(ShiritoriResetButton())
        self.add_item(ShiritoriToggleButton())

    async def reopen(self, interaction: discord.Interaction, notice: str | None = None):
        view = ShiritoriResidentSettingsView(self.cog, self.guild_id)
        view.selected_channel_id = self.selected_channel_id
        view.notice = notice
        return await edit_panel_v2(interaction, as_panel_v2(view))

    def embed(self) -> discord.Embed:
        lines = []
        for channel_id, state in self.settings["channels"].items():
            mark = "▶ " if channel_id == self.selected_channel_id else ""
            last = f"最終: 「{state['last_word']}」" if state["last_word"] else "チェーン未開始"
            lines.append(
                f"{mark}<#{channel_id}> — {last} / 現在 {state['chain']} 連 / 最長 {state['best']} 連"
            )
        ranking = ""
        selected = self.settings["channels"].get(self.selected_channel_id or 0)
        if selected and selected["players"]:
            top = sorted(selected["players"].items(), key=lambda item: -item[1])[:5]
            ranking = "\n\n**参加者ランキング（選択中チャンネル）**\n" + "\n".join(
                f"{index}. <@{user_id}> — {count}回"
                for index, (user_id, count) in enumerate(top, start=1)
            )
        return discord.Embed(
            title="常駐しりとり",
            description=(
                "指定チャンネルでは、かなの言葉の発言がそのまましりとりの手になります。"
                "つながっている間は静かに記録し、途切れた時だけお知らせします。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**対象チャンネル**: {len(self.settings['channels'])}/{MAX_CHANNELS}"
                f"\n\n{chr(10).join(lines) if lines else '対象チャンネルは未登録です。'}"
                f"{ranking}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> ShiritoriResidentSettingsView:
    return ShiritoriResidentSettingsView(cog, guild_id)
