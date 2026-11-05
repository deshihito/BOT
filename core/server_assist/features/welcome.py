"""Welcome and goodbye messages (ProBot-style join/leave notices)."""
from __future__ import annotations

import asyncio
import io
import logging
from pathlib import Path
from typing import Any

import discord

from core.server_assist import Feature, format_template, get_settings, update_settings
from core.server_assist.ui import AssistFeatureView, channel_label, notice_line

logger = logging.getLogger(__name__)

KEY = "welcome"
MAX_MESSAGE = 1500
DEFAULT_WELCOME = "**{user}** さん、{server} へようこそ！"
DEFAULT_GOODBYE = "**{name}** さんが退出しました。"

FEATURE = Feature(
    key=KEY,
    label="参加・退出メッセージ",
    description="メンバーの参加・退出を、選んだチャンネルへお知らせします。",
    order=10,
    module_name=__name__,
)

PLACEHOLDERS = "{user} / {name} / {server} / {count} / {id}"

# 画像カードのテーマ。レベルアップカードと同じ白基調の配色を基本にする。
CARD_THEMES: dict[str, dict[str, Any]] = {
    "white": {"label": "ホワイト", "bg": (255, 255, 255), "ink": (44, 52, 74), "mute": (150, 156, 170), "accent": (59, 91, 255), "ring": (127, 178, 201), "line": (228, 232, 240)},
    "blue": {"label": "ブルー", "bg": (233, 240, 255), "ink": (35, 48, 84), "mute": (120, 134, 168), "accent": (37, 99, 235), "ring": (96, 165, 250), "line": (203, 219, 250)},
    "pink": {"label": "ピンク", "bg": (255, 241, 246), "ink": (84, 40, 62), "mute": (178, 130, 152), "accent": (236, 72, 153), "ring": (249, 168, 212), "line": (251, 207, 232)},
    "green": {"label": "グリーン", "bg": (238, 250, 242), "ink": (36, 64, 48), "mute": (128, 160, 140), "accent": (22, 163, 74), "ring": (134, 239, 172), "line": (204, 238, 216)},
    "dark": {"label": "ダーク", "bg": (32, 36, 48), "ink": (238, 241, 248), "mute": (150, 158, 176), "accent": (129, 160, 255), "ring": (96, 118, 178), "line": (62, 70, 90)},
}
DEFAULT_CARD_THEME = "white"
CARD_W, CARD_H = 1000, 360
_CARD_SS = 2

_FONT_CANDIDATES = (
    str(Path(__file__).resolve().parents[3] / "assets" / "fonts" / "levelup.ttf"),
    str(Path(__file__).resolve().parents[3] / "assets" / "fonts" / "levelup.otf"),
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _card_font(size: int):
    from PIL import ImageFont

    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _card_safe_name(name: str) -> str:
    out = []
    for ch in str(name or ""):
        o = ord(ch)
        if o >= 0x1F000 or 0x2190 <= o <= 0x2BFF or o in (0x200D, 0xFE0F, 0xFE0E) or o < 0x20:
            continue
        out.append(ch)
    return "".join(out).strip() or "メンバー"


def render_welcome_card(
    avatar_bytes: bytes | None,
    name: str,
    guild_name: str,
    member_count: int | None,
    theme: str = DEFAULT_CARD_THEME,
) -> bytes:
    """参加メッセージ用画像カード(PNG)を生成して bytes で返す。CPU処理なので to_thread で呼ぶこと。

    レベルアップカード (cogs/general.py の render_levelup_card) と同じ白基調・
    アバター+リングのレイアウトを踏襲する。
    """
    from PIL import Image, ImageDraw

    palette = CARD_THEMES.get(theme) or CARD_THEMES[DEFAULT_CARD_THEME]
    S = _CARD_SS
    W, H = CARD_W * S, CARD_H * S

    def px(v: float) -> int:
        return int(round(v * S))

    bg = (*palette["bg"], 255)
    ink = (*palette["ink"], 255)
    mute = (*palette["mute"], 255)
    accent = (*palette["accent"], 255)
    ring = (*palette["ring"], 255)
    line = (*palette["line"], 255)

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=px(28), fill=bg, outline=line, width=px(2))

    # 左: アバター (レベルアップカードと同じリング付き円形)
    D = px(196)
    ax, ay = px(56), (H - D) // 2
    ring_w = px(4)
    R = D // 2 + px(8) + ring_w
    acx, acy = ax + D // 2, ay + D // 2
    d.ellipse([acx - R, acy - R, acx + R, acy + R], outline=ring, width=ring_w)
    avatar = None
    if avatar_bytes:
        try:
            avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA").resize((D, D), Image.LANCZOS)
        except Exception:
            logger.debug("ウェルカムカード: アバターの取得に失敗しました", exc_info=True)
            avatar = None
    if avatar is None:
        avatar = Image.new("RGBA", (D, D), (235, 238, 245, 255))
        ad = ImageDraw.Draw(avatar)
        ad.ellipse([D * 0.34, D * 0.20, D * 0.66, D * 0.52], fill=(255, 255, 255, 255))
        ad.ellipse([D * 0.18, D * 0.58, D * 0.82, D * 1.15], fill=(255, 255, 255, 255))
    amask = Image.new("L", (D, D), 0)
    ImageDraw.Draw(amask).ellipse([0, 0, D - 1, D - 1], fill=255)
    img.paste(avatar, (ax, ay), amask)

    # 右: 見出し + 名前 + サーバー情報
    TX = ax + D + px(52)
    right = W - px(56)
    shown = _card_safe_name(name)
    guild_shown = _card_safe_name(guild_name)

    head_font = _card_font(px(54))
    head = "WELCOME"
    while head_font.size > px(28) and d.textlength(head, font=head_font) > (right - TX) * 0.62:
        head_font = _card_font(head_font.size - px(2))
    d.text((TX, px(72)), head, font=head_font, fill=accent)

    name_font = _card_font(px(64))
    while name_font.size > px(30) and d.textlength(shown, font=name_font) > right - TX:
        name_font = _card_font(name_font.size - px(2))
    d.text((TX, px(148)), shown, font=name_font, fill=ink)

    sub = f"{guild_shown} へようこそ！"
    if isinstance(member_count, int) and member_count >= 0:
        sub += f" • メンバー {member_count}人"
    sub_font = _card_font(px(30))
    while sub_font.size > px(20) and d.textlength(sub, font=sub_font) > right - TX:
        sub_font = _card_font(sub_font.size - px(2))
    d.text((TX, px(248)), sub, font=sub_font, fill=mute)

    out = img.resize((CARD_W, CARD_H), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    theme = raw.get("welcome_image_theme")
    return {
        "welcome_enabled": bool(raw.get("welcome_enabled", False)),
        "goodbye_enabled": bool(raw.get("goodbye_enabled", False)),
        "welcome_channel_id": raw.get("welcome_channel_id") if isinstance(raw.get("welcome_channel_id"), int) else None,
        "goodbye_channel_id": raw.get("goodbye_channel_id") if isinstance(raw.get("goodbye_channel_id"), int) else None,
        "welcome_message": str(raw.get("welcome_message") or DEFAULT_WELCOME)[:MAX_MESSAGE],
        "goodbye_message": str(raw.get("goodbye_message") or DEFAULT_GOODBYE)[:MAX_MESSAGE],
        "welcome_image_enabled": bool(raw.get("welcome_image_enabled", False)),
        "welcome_image_theme": theme if theme in CARD_THEMES else DEFAULT_CARD_THEME,
    }


def _member_name(member: Any) -> str:
    return getattr(member, "display_name", None) or getattr(member, "name", "メンバー")


def _avatar_url(member: Any) -> str | None:
    avatar = getattr(member, "display_avatar", None)
    return getattr(avatar, "url", None)


def build_embed(member: Any, guild: Any, template: str, *, kind: str = "welcome") -> discord.Embed:
    embed = discord.Embed(
        description=format_template(template, member, guild),
        color=0xFFFFFF,
    )
    author = f"{_member_name(member)} さん"
    icon = _avatar_url(member)
    if icon:
        embed.set_author(name=author, icon_url=icon)
    else:
        embed.set_author(name=author)
    label = "参加" if kind == "welcome" else "退出"
    count = getattr(guild, "member_count", None)
    footer = f"{getattr(guild, 'name', 'サーバー')} • {label}"
    if isinstance(count, int) and count >= 0:
        footer += f" • {count}人"
    embed.set_footer(text=footer)
    embed.timestamp = discord.utils.utcnow()
    return embed


class WelcomeChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "WelcomeSettingsView", kind: str):
        self.parent_view = parent
        self.kind = kind
        current = parent.settings["welcome_channel_id" if kind == "welcome" else "goodbye_channel_id"]
        super().__init__(
            placeholder="参加メッセージの送信先" if kind == "welcome" else "退出メッセージの送信先",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=0,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=current, type=discord.SelectDefaultValueType.channel)]
                if current is not None else []
            ),
            row=0 if kind == "welcome" else 1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        channel = self.values[0] if self.values else None
        if channel is not None:
            me = getattr(self.parent_view.guild, "me", None)
            if me is not None and not getattr(channel.permissions_for(me), "send_messages", False):
                return await interaction.response.send_message(
                    "そのチャンネルにはBotがメッセージを送信できません。", ephemeral=True,
                )
        if channel is None and self.kind == "welcome":
            return await interaction.response.send_message(
                "Botがメッセージを送信できるテキストチャンネルがありません。", ephemeral=True,
            )
        channel_id = getattr(channel, "id", None)
        field = "welcome_channel_id" if self.kind == "welcome" else "goodbye_channel_id"
        await update_settings(self.parent_view.guild_id, KEY, **{field: channel_id})
        self.parent_view.settings[field] = channel_id
        label = "参加" if self.kind == "welcome" else "退出"
        await self.parent_view.refresh(interaction, f"{label}メッセージの送信先を設定しました。")


class WelcomeToggleButton(discord.ui.Button):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(
            label="参加メッセージ" if kind == "welcome" else "退出メッセージ",
            style=discord.ButtonStyle.secondary,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        field = "welcome_enabled" if self.kind == "welcome" else "goodbye_enabled"
        value = not bool(view.settings.get(field))
        await update_settings(view.guild_id, KEY, **{field: value})
        view.settings[field] = value
        label = "参加" if self.kind == "welcome" else "退出"
        await view.refresh(interaction, f"{label}メッセージを{'オン' if value else 'オフ'}にしました。")


class WelcomeMessageButton(discord.ui.Button):
    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(
            label="参加文を編集" if kind == "welcome" else "退出文を編集",
            style=discord.ButtonStyle.primary,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        return await interaction.response.send_modal(WelcomeMessageModal(view, self.kind))


class WelcomeTestButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="テスト送信", style=discord.ButtonStyle.success, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        channel_id = view.settings.get("welcome_channel_id")
        channel = interaction.guild.get_channel(channel_id) if channel_id else None
        if channel is None:
            return await interaction.response.send_message(
                "先に参加メッセージの送信先を選んでください。", ephemeral=True,
            )
        ok = await _send(interaction.guild, interaction.user, "welcome", view.settings)
        if not ok:
            return await interaction.response.send_message(
                "テスト送信に失敗しました。チャンネルの権限を確認してください。", ephemeral=True,
            )
        return await interaction.response.send_message("テストメッセージを送信しました。", ephemeral=True)


class WelcomeImageToggleButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="画像カード", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        value = not bool(view.settings.get("welcome_image_enabled"))
        await update_settings(view.guild_id, KEY, welcome_image_enabled=value)
        view.settings["welcome_image_enabled"] = value
        await view.refresh(interaction, f"画像カードを{'オン' if value else 'オフ'}にしました。")


class WelcomeImageThemeButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="画像テーマ切替", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: WelcomeSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        keys = list(CARD_THEMES)
        current = view.settings.get("welcome_image_theme") or DEFAULT_CARD_THEME
        nxt = keys[(keys.index(current) + 1) % len(keys)] if current in keys else DEFAULT_CARD_THEME
        await update_settings(view.guild_id, KEY, welcome_image_theme=nxt)
        view.settings["welcome_image_theme"] = nxt
        await view.refresh(interaction, f"画像テーマを「{CARD_THEMES[nxt]['label']}」にしました。")


class WelcomeMessageModal(discord.ui.Modal):
    def __init__(self, parent: "WelcomeSettingsView", kind: str):
        super().__init__(title="参加メッセージを編集" if kind == "welcome" else "退出メッセージを編集")
        self.parent_view = parent
        self.kind = kind
        field = "welcome_message" if kind == "welcome" else "goodbye_message"
        self.text = discord.ui.TextInput(
            label="メッセージ",
            style=discord.TextStyle.paragraph,
            default=parent.settings.get(field, "")[:MAX_MESSAGE],
            max_length=MAX_MESSAGE,
            required=True,
            placeholder="例: {user} さん、ようこそ！",
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        field = "welcome_message" if self.kind == "welcome" else "goodbye_message"
        value = str(self.text.value or "").strip() or (
            DEFAULT_WELCOME if self.kind == "welcome" else DEFAULT_GOODBYE
        )
        await update_settings(self.parent_view.guild_id, KEY, **{field: value[:MAX_MESSAGE]})
        self.parent_view.settings[field] = value[:MAX_MESSAGE]
        await self.parent_view.refresh(interaction, "メッセージを保存しました。")


class WelcomeSettingsView(AssistFeatureView):
    feature_key = KEY
    feature_title = "参加・退出メッセージ"

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        self.add_item(WelcomeChannelSelect(self, "welcome"))
        self.add_item(WelcomeChannelSelect(self, "goodbye"))
        self.add_item(WelcomeToggleButton("welcome"))
        self.add_item(WelcomeToggleButton("goodbye"))
        self.add_item(WelcomeMessageButton("welcome"))
        self.add_item(WelcomeMessageButton("goodbye"))
        self.add_item(WelcomeTestButton())
        self.add_item(WelcomeImageToggleButton())
        self.add_item(WelcomeImageThemeButton())

    def embed(self) -> discord.Embed:
        welcome = "オン" if self.settings["welcome_enabled"] else "オフ"
        goodbye = "オン" if self.settings["goodbye_enabled"] else "オフ"
        embed = discord.Embed(
            title="参加・退出メッセージ",
            description=(
                "メンバーが参加・退出したときに、設定したチャンネルへお知らせします。"
                f"\n\n**参加メッセージ**: {welcome} / 送信先: {channel_label(self.settings['welcome_channel_id'])}"
                f"\n**退出メッセージ**: {goodbye} / 送信先: {channel_label(self.settings['goodbye_channel_id'])}"
                f"\n**画像カード**: {'オン' if self.settings['welcome_image_enabled'] else 'オフ'}"
                f" / テーマ: {CARD_THEMES[self.settings['welcome_image_theme']]['label']}"
                f"\n\n使える置き換え: {PLACEHOLDERS}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )
        embed.add_field(
            name="参加メッセージの文面",
            value=self.settings["welcome_message"][:400],
            inline=False,
        )
        embed.add_field(
            name="退出メッセージの文面",
            value=self.settings["goodbye_message"][:400],
            inline=False,
        )
        return embed


async def _welcome_image_file(member: Any, guild: Any, settings_value: dict[str, Any]) -> discord.File | None:
    """画像カードを生成して File を返す。失敗時は None (テキストのみで送る)。"""
    avatar_bytes = None
    avatar = getattr(member, "display_avatar", None)
    if avatar is not None:
        try:
            avatar_bytes = await avatar.replace(size=256, format="png").read()
        except Exception:
            logger.debug("ウェルカムカード: アバターの取得に失敗しました", exc_info=True)
    try:
        png = await asyncio.to_thread(
            render_welcome_card,
            avatar_bytes,
            _member_name(member),
            getattr(guild, "name", "サーバー"),
            getattr(guild, "member_count", None),
            settings_value.get("welcome_image_theme") or DEFAULT_CARD_THEME,
        )
    except Exception:
        logger.exception("ウェルカムカードの生成に失敗しました: guild=%s", getattr(guild, "id", None))
        return None
    return discord.File(io.BytesIO(png), filename="welcome.png")


async def _send(guild: Any, member: Any, kind: str, settings_value: dict[str, Any]) -> bool:
    if kind == "welcome":
        channel_id = settings_value.get("welcome_channel_id")
        template = settings_value.get("welcome_message") or DEFAULT_WELCOME
    else:
        channel_id = settings_value.get("goodbye_channel_id") or settings_value.get("welcome_channel_id")
        template = settings_value.get("goodbye_message") or DEFAULT_GOODBYE
    if not channel_id:
        return False
    channel = guild.get_channel(channel_id)
    if channel is None:
        return False
    me = getattr(guild, "me", None)
    if me is not None:
        try:
            if not channel.permissions_for(me).send_messages:
                return False
        except Exception:
            pass
    embed = build_embed(member, guild, template, kind=kind)
    file = None
    if kind == "welcome" and settings_value.get("welcome_image_enabled"):
        file = await _welcome_image_file(member, guild, settings_value)
        if file is not None:
            embed.set_image(url="attachment://welcome.png")
    send_kwargs: dict[str, Any] = {
        "embed": embed,
        "allowed_mentions": discord.AllowedMentions(everyone=False, roles=False, users=True),
    }
    if file is not None:
        send_kwargs["file"] = file
    try:
        await channel.send(**send_kwargs)
    except discord.HTTPException:
        logger.exception("参加・退出メッセージを送信できませんでした: guild=%s", getattr(guild, "id", None))
        return False
    return True


async def on_member_join(cog: Any, member: Any) -> None:
    guild = getattr(member, "guild", None)
    if guild is None or getattr(member, "bot", False):
        return
    current = settings(guild.id)
    if current["welcome_enabled"]:
        await _send(guild, member, "welcome", current)


async def on_member_remove(cog: Any, member: Any) -> None:
    guild = getattr(member, "guild", None)
    if guild is None or getattr(member, "bot", False):
        return
    current = settings(guild.id)
    if current["goodbye_enabled"]:
        await _send(guild, member, "goodbye", current)


def build_view(cog: Any, guild_id: int) -> WelcomeSettingsView:
    return WelcomeSettingsView(cog, guild_id)
