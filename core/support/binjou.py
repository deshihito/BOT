# -*- coding: utf-8 -*-
"""便乗 (binjou) の UI と設定取得。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *


def get_binjou_settings(store, guild_id: int) -> dict:
    """binjou設定を既定値と旧thinking設定で補完する。"""
    raw = store.get(guild_id, BINJOU_SECTION)

    old_thinking = store.get(guild_id, THINKING_SECTION).get("enabled")

    thinking = raw.get("thinking")
    if not isinstance(thinking, bool):
        thinking = old_thinking if isinstance(old_thinking, bool) else BINJOU_DEFAULTS["thinking"]

    thumbsup = raw.get("thumbsup")
    if not isinstance(thumbsup, bool):
        thumbsup = BINJOU_DEFAULTS["thumbsup"]

    custom = raw.get("custom", [])
    if not isinstance(custom, list):
        custom = []
    return {"thinking": thinking, "thumbsup": thumbsup, "custom": [r for r in custom if isinstance(r, dict)]}


def normalize_binjou_emoji(value: str):
    """Unicode絵文字、カスタム絵文字表記またはIDをDiscordのリアクションに変換する。"""
    value = str(value or "").strip()
    if value.isdecimal():
        return discord.PartialEmoji(name="emoji", id=int(value))
    if value.startswith("<") and value.endswith(">"):
        parsed = discord.PartialEmoji.from_str(value)
        if parsed.id is not None:
            return parsed
    if not value or len(value) > 32:
        raise ValueError("絵文字またはカスタム絵文字IDを入力してください。")
    return value


def binjou_emoji_key(value: str) -> str:
    value = str(value or "").strip()
    if value.isdecimal():
        return f"id:{value}"
    parsed = discord.PartialEmoji.from_str(value) if value.startswith("<") else None
    if parsed is not None and parsed.id is not None:
        return f"id:{parsed.id}"
    return value


class EmojiBinjouView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict[str, bool]):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings

    def embed(self):
        return self.cog.binjou_embed(self.settings)

    async def manage_custom(self, interaction, source, target, remove=False):
        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (getattr(permissions, "manage_guild", False) or getattr(permissions, "administrator", False)):
            return await interaction.response.send_message("この設定にはサーバー管理権限が必要です。", ephemeral=True)
        try:
            source_emoji = normalize_binjou_emoji(source)
            source_key = str(source_emoji)
            source_identity = binjou_emoji_key(source_key)
            rows = list(self.settings.get("custom", []))
            rows = [row for row in rows if binjou_emoji_key(row.get("source", "")) != source_identity]
            if not remove:
                target_emoji = normalize_binjou_emoji(target)
                if len(rows) >= 20:
                    raise ValueError("カスタム便乗は20件まで登録できます。")
                rows.append({"source": source_key, "target": str(target_emoji)})
            await guild_settings.get_store().update(interaction.guild_id, BINJOU_SECTION, custom=rows)
            self.settings["custom"] = rows
            await interaction.response.send_message("カスタム便乗設定を更新しました。", ephemeral=True)
        except ValueError as exc:
            await interaction.response.send_message(str(exc), ephemeral=True)

    async def set_enabled(self, interaction: discord.Interaction, key: str, enabled: bool):
        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        ):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                BINJOU_SECTION,
                **{key: enabled},
            )
            self.settings[key] = enabled
            await edit_panel_v2(interaction, as_panel_v2(self))
        except Exception:
            logger.exception("binjou設定の更新に失敗しました (key=%s)", key)
            await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    @discord.ui.button(label="<:thinking:1561695212814995596> オン", style=discord.ButtonStyle.success, row=0)
    async def thinking_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, "thinking", True)

    @discord.ui.button(label="<:thinking:1561695212814995596> オフ", style=discord.ButtonStyle.secondary, row=0)
    async def thinking_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, "thinking", False)

    @discord.ui.button(label="👍 オン", style=discord.ButtonStyle.success, row=1)
    async def thumbsup_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, "thumbsup", True)

    @discord.ui.button(label="👍 オフ", style=discord.ButtonStyle.secondary, row=1)
    async def thumbsup_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, "thumbsup", False)

    @discord.ui.button(label="カスタム追加・編集", style=discord.ButtonStyle.primary, row=2)
    async def custom_upsert(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BinjouRuleModal(self))

    @discord.ui.button(label="カスタム削除", style=discord.ButtonStyle.danger, row=2)
    async def custom_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BinjouDeleteModal(self))


class BinjouRuleModal(discord.ui.Modal, title="カスタム便乗を追加・編集"):
    source = discord.ui.TextInput(label="反応する絵文字または絵文字ID", max_length=100)
    target = discord.ui.TextInput(label="付加する絵文字または絵文字ID", max_length=100)

    def __init__(self, view):
        super().__init__()
        self.view_ref = view

    async def on_submit(self, interaction):
        await self.view_ref.manage_custom(interaction, self.source.value, self.target.value)


class BinjouDeleteModal(discord.ui.Modal, title="カスタム便乗を削除"):
    source = discord.ui.TextInput(label="削除する反応絵文字または絵文字ID", max_length=100)

    def __init__(self, view):
        super().__init__()
        self.view_ref = view

    async def on_submit(self, interaction):
        await self.view_ref.manage_custom(interaction, self.source.value, "", remove=True)


class BinjouSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    @staticmethod
    def binjou_embed(settings: dict) -> discord.Embed:
        rules = settings.get("custom", [])
        lines = [f"{r.get('source')} → {r.get('target')}" for r in rules]
        custom_text = "\n".join(lines) if lines else "登録なし"
        return discord.Embed(
            title="絵文字便乗設定（binjou）",
            description=(
                f"<:thinking:1561695212814995596> → {THINKING_EMOJI}: **{'オン' if settings['thinking'] else 'オフ'}**\n"
                f"👍 → 👍: **{'オン' if settings['thumbsup'] else 'オフ'}**\n\n"
                f"カスタム便乗（{len(rules)}/20）\n{custom_text}\n\n"
                "同じ絵文字ならその絵文字を付加し、異なる場合は追加リアクションとして動作します。"
            ),
            color=0xFFFFFF,
        )


    async def _missing(self, interaction: discord.Interaction, name: str):
        message = f"{name}機能が読み込まれていません。"
        if interaction.response.is_done():
            return await interaction.followup.send(message, ephemeral=True)
        await interaction.response.send_message(message, ephemeral=True)


    @commands.Cog.listener()
    async def on_raw_reaction_add(self, payload: discord.RawReactionActionEvent):
        if payload.guild_id is None or payload.user_id == getattr(self.bot.user, "id", None):
            return

        source_emoji = str(payload.emoji)
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_binjou_settings(store, payload.guild_id)

        key = "thinking" if source_emoji in {"<:thinking:1561695212814995596>", "🤔"} else ("thumbsup" if source_emoji in {"👍", "👍️"} else None)
        target = None
        if key is not None:
            if not settings[key]:
                return
            target = THINKING_EMOJI if key == "thinking" else "👍"
        else:
            rule = next((r for r in settings.get("custom", []) if binjou_emoji_key(r.get("source", "")) == binjou_emoji_key(source_emoji)), None)
            if rule is None:
                return
            try:
                target = normalize_binjou_emoji(rule.get("target", ""))
            except ValueError:
                return

        member = getattr(payload, "member", None)
        if member is not None and member.bot:
            return

        channel = self.bot.get_channel(payload.channel_id)
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(payload.channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.debug("自動リアクション: チャンネルの取得に失敗しました", exc_info=True)
                return

        try:
            message = await channel.fetch_message(payload.message_id)
            mirror_emoji = target

            if any(
                str(reaction.emoji) == str(mirror_emoji) and reaction.me
                for reaction in message.reactions
            ):
                return

            await message.add_reaction(mirror_emoji)
        except discord.HTTPException as exc:
            logger.warning(
                "binjou reaction mirror failed (guild=%s channel=%s message=%s emoji=%s): %s",
                payload.guild_id,
                payload.channel_id,
                payload.message_id,
                target,
                exc,
            )
            return
