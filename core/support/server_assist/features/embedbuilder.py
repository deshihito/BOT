"""Admin embed builder: compose an embed and post it to a configured channel."""
from __future__ import annotations

import logging
import re
import time
from typing import Any

import discord

from core.support.server_assist import Feature, get_settings, update_settings, has_manage_permission as _can_manage
from core.support.server_assist.ui import AssistFeatureView, channel_label, notice_line
from core.support.server_assist.ui import AssistChannelSelect, AssistToggleButton, required_field
from core.support.messages import ASSIST_MANAGE_REQUIRED

logger = logging.getLogger(__name__)

KEY = "embed"
COLOR_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")
CREATE_COOLDOWN = 3.0
POST_COOLDOWN = 3.0

_last_create: dict[tuple[int, int], float] = {}
_last_post: dict[tuple[int, int], float] = {}

FEATURE = Feature(
    key=KEY,
    label="埋め込みビルダー",
    description="タイトル・本文・色・フッター・画像・フィールドを指定してEmbedを投稿します。",
    order=90,
    module_name=__name__,
)

MAX_TEMPLATES = 5
MAX_FIELDS = 10

# 直近に投稿した下書き (テンプレ保存用、メモリ内のみ)
_last_spec: dict[tuple[int, int], dict[str, Any]] = {}


def _clean_spec(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or "")[:256]
    description = str(raw.get("description") or "")[:4000]
    if not title and not description:
        return None
    try:
        color = parse_color(raw.get("color"))
    except ValueError:
        color = None
    fields = []
    for item in raw.get("fields") if isinstance(raw.get("fields"), list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")[:256]
        value = str(item.get("value") or "")[:1024]
        if name and value:
            fields.append({"name": name, "value": value, "inline": bool(item.get("inline"))})
        if len(fields) >= MAX_FIELDS:
            break
    image_url = str(raw.get("image_url") or "")[:1000]
    thumbnail_url = str(raw.get("thumbnail_url") or "")[:1000]
    return {
        "title": title,
        "description": description,
        "color": color,
        "footer": str(raw.get("footer") or "")[:2048],
        "image_url": image_url if _is_http_url(image_url) else "",
        "thumbnail_url": thumbnail_url if _is_http_url(thumbnail_url) else "",
        "fields": fields,
    }


def _is_http_url(value: str) -> bool:
    return value.startswith(("http://", "https://")) and len(value) > 10


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    channel_id = raw.get("channel_id")
    templates: dict[str, dict[str, Any]] = {}
    raw_templates = raw.get("templates")
    if isinstance(raw_templates, dict):
        for name, spec in list(raw_templates.items())[:MAX_TEMPLATES]:
            cleaned = _clean_spec(spec)
            if cleaned is not None and str(name).strip():
                templates[str(name)[:30]] = cleaned
    return {
        "enabled": bool(raw.get("enabled", False)),
        "channel_id": (
            channel_id
            if isinstance(channel_id, int) and not isinstance(channel_id, bool)
            else None
        ),
        "templates": templates,
    }


def parse_extra_lines(text: str) -> dict[str, Any]:
    """追加要素のミニ記法を解析する。

    画像: <URL> / サムネ: <URL> / F: <見出し> | <内容> (| inline)
    """
    extra: dict[str, Any] = {"image_url": "", "thumbnail_url": "", "fields": []}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("画像:") or line.startswith("画像："):
            extra["image_url"] = line[3:].strip()
        elif line.startswith("サムネ:") or line.startswith("サムネ："):
            extra["thumbnail_url"] = line[4:].strip()
        elif line.startswith(("F:", "F：")):
            parts = [part.strip() for part in line[2:].split("|")]
            if len(parts) >= 2 and parts[0] and parts[1]:
                extra["fields"].append({
                    "name": parts[0][:256],
                    "value": parts[1][:1024],
                    "inline": len(parts) >= 3 and parts[2].lower() in ("inline", "横並び"),
                })
    extra["fields"] = extra["fields"][:MAX_FIELDS]
    return extra


def build_embed_from_spec(spec: dict[str, Any]) -> discord.Embed:
    """下書きスペックから Embed を作る。URL形式が不正なら ValueError。"""
    for key_name, label in (("image_url", "画像URL"), ("thumbnail_url", "サムネイルURL")):
        url = str(spec.get(key_name) or "")
        if url and not _is_http_url(url):
            raise ValueError(f"{label}は http/https のURLで指定してください。")
    embed = discord.Embed(
        title=str(spec.get("title") or "")[:256] or None,
        description=str(spec.get("description") or "")[:4000] or None,
        color=spec.get("color") if isinstance(spec.get("color"), int) else 0xFFFFFF,
    )
    footer = str(spec.get("footer") or "").strip()
    if footer:
        embed.set_footer(text=footer[:2048])
    if spec.get("image_url"):
        embed.set_image(url=str(spec["image_url"]))
    if spec.get("thumbnail_url"):
        embed.set_thumbnail(url=str(spec["thumbnail_url"]))
    for field in spec.get("fields") or []:
        embed.add_field(name=field["name"], value=field["value"], inline=bool(field.get("inline")))
    if len(embed) > 6000:
        raise ValueError(f"Embedの合計が6000文字を超えています（{len(embed)}文字）。")
    return embed


def parse_color(value: Any) -> int | None:
    """#RRGGBB / RRGGBB を色へ。空なら None、形式違いは ValueError。"""
    text = str(value or "").strip()
    if not text:
        return None
    match = COLOR_RE.match(text)
    if match is None:
        raise ValueError("invalid color")
    return int(match.group(1), 16)


class EmbedCreateModal(discord.ui.Modal, title="埋め込みを作成"):
    def __init__(self, guild_id: int):
        super().__init__()
        self.guild_id = guild_id
        self.title_input = discord.ui.TextInput(
            label="タイトル",
            max_length=256,
            required=True,
        )
        self.body_input = discord.ui.TextInput(
            label="本文",
            style=discord.TextStyle.paragraph,
            max_length=4000,
            required=True,
        )
        self.color_input = discord.ui.TextInput(
            label="色（#RRGGBB）",
            max_length=7,
            required=False,
            placeholder="#5865F2",
        )
        self.footer_input = discord.ui.TextInput(
            label="フッター",
            max_length=2048,
            required=False,
        )
        self.extra_input = discord.ui.TextInput(
            label="追加要素（任意・1行1個）",
            style=discord.TextStyle.paragraph,
            max_length=1500,
            required=False,
            placeholder="画像: https://…\nサムネ: https://…\nF: 見出し | 内容 | inline",
        )
        self.add_item(self.title_input)
        self.add_item(self.body_input)
        self.add_item(self.color_input)
        self.add_item(self.footer_input)
        self.add_item(self.extra_input)

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
        if not _can_manage(interaction):
            return await interaction.response.send_message(
                "この操作には「サーバーの管理」権限が必要です。", ephemeral=True,
            )
        current = settings(interaction.guild_id)
        if not current["enabled"] or current["channel_id"] is None:
            return await interaction.response.send_message("埋め込みビルダーは現在オフです。", ephemeral=True)
        channel = interaction.guild.get_channel(current["channel_id"])
        if channel is None:
            return await interaction.response.send_message("投稿先のチャンネルが見つかりません。", ephemeral=True)
        try:
            color = parse_color(self.color_input.value)
        except ValueError:
            return await interaction.response.send_message(
                "色は #RRGGBB の形式で指定してください。", ephemeral=True,
            )
        extra = parse_extra_lines(str(self.extra_input.value or ""))
        spec = {
            "title": str(self.title_input.value or "")[:256],
            "description": str(self.body_input.value or "")[:4000],
            "color": color,
            "footer": str(self.footer_input.value or "").strip(),
            **extra,
        }
        try:
            embed = build_embed_from_spec(spec)
        except ValueError as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        _last_spec[(interaction.guild_id, interaction.user.id)] = _clean_spec(spec) or spec
        post_key = (interaction.guild_id, interaction.user.id)
        now = time.monotonic()
        if now - _last_post.get(post_key, 0.0) < POST_COOLDOWN:
            return await interaction.response.send_message(
                "連続で投稿できません。少し待ってください。", ephemeral=True,
            )
        _last_post[post_key] = now
        await interaction.response.defer(ephemeral=True)
        try:
            await channel.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("Embedを送信できませんでした: guild=%s", interaction.guild_id)
            return await interaction.followup.send("Embedを送信できませんでした。", ephemeral=True)
        return await interaction.followup.send(f"{channel.mention} に送信しました。", ephemeral=True)


async def handle_create(interaction: discord.Interaction) -> None:
    if interaction.guild is None or interaction.guild_id is None:
        return await interaction.response.send_message("サーバー内で実行してください。", ephemeral=True)
    if not _can_manage(interaction):
        return await interaction.response.send_message(
            "この操作には「サーバーの管理」権限が必要です。", ephemeral=True,
        )
    current = settings(interaction.guild_id)
    if not current["enabled"] or current["channel_id"] is None:
        return await interaction.response.send_message("埋め込みビルダーは現在オフです。", ephemeral=True)
    key = (interaction.guild_id, interaction.user.id)
    now = time.monotonic()
    if now - _last_create.get(key, 0.0) < CREATE_COOLDOWN:
        return await interaction.response.send_message(
            "連続で作成できません。少し待ってください。", ephemeral=True,
        )
    _last_create[key] = now
    return await interaction.response.send_modal(EmbedCreateModal(interaction.guild_id))


class EmbedCreateButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="埋め込みを作成", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: EmbedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        return await handle_create(interaction)


class EmbedTemplateSaveModal(discord.ui.Modal, title="テンプレとして保存"):
    def __init__(self, parent: "EmbedSettingsView", spec: dict[str, Any]):
        super().__init__()
        self.parent_view = parent
        self.spec = spec
        self.name_input = discord.ui.TextInput(label="テンプレ名", max_length=30, required=True)
        self.add_item(self.name_input)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        name = str(self.name_input.value or "").strip()[:30]
        if not name:
            return await interaction.response.send_message("テンプレ名を入力してください。", ephemeral=True)
        templates = dict(self.parent_view.settings.get("templates") or {})
        if name not in templates and len(templates) >= MAX_TEMPLATES:
            return await interaction.response.send_message(
                f"テンプレは最大{MAX_TEMPLATES}件です。先に削除してください。", ephemeral=True,
            )
        templates[name] = self.spec
        await update_settings(self.parent_view.guild_id, KEY, templates=templates)
        self.parent_view.settings["templates"] = templates
        await self.parent_view.refresh(interaction, f"テンプレ「{name}」を保存しました。")


class EmbedTemplateSaveButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="テンプレとして保存", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: EmbedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        spec = _last_spec.get((view.guild_id, interaction.user.id))
        if spec is None:
            return await interaction.response.send_message(
                "このセッションでまだEmbedを作成していません。先に「埋め込みを作成」で投稿してください。",
                ephemeral=True,
            )
        return await interaction.response.send_modal(EmbedTemplateSaveModal(view, spec))


class EmbedTemplateSelect(discord.ui.Select):
    def __init__(self, parent: "EmbedSettingsView"):
        self.parent_view = parent
        options = [
            discord.SelectOption(label=name[:100], value=name[:100])
            for name in list(parent.settings.get("templates") or {})[:25]
        ]
        super().__init__(placeholder="保存済みテンプレを投稿", options=options, row=1)

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        current = self.parent_view.settings
        if not current["enabled"] or current["channel_id"] is None:
            return await interaction.response.send_message("埋め込みビルダーは現在オフです。", ephemeral=True)
        spec = (current.get("templates") or {}).get(self.values[0])
        if spec is None:
            return await interaction.response.send_message("そのテンプレは削除されています。", ephemeral=True)
        channel = interaction.guild.get_channel(current["channel_id"]) if interaction.guild else None
        if channel is None:
            return await interaction.response.send_message("投稿先のチャンネルが見つかりません。", ephemeral=True)
        post_key = (interaction.guild_id, interaction.user.id)
        now = time.monotonic()
        if now - _last_post.get(post_key, 0.0) < POST_COOLDOWN:
            return await interaction.response.send_message(
                "連続で投稿できません。少し待ってください。", ephemeral=True,
            )
        _last_post[post_key] = now
        try:
            embed = build_embed_from_spec(spec)
        except ValueError as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        await interaction.response.defer(ephemeral=True)
        try:
            await channel.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            return await interaction.followup.send("Embedを送信できませんでした。", ephemeral=True)
        return await interaction.followup.send(f"{channel.mention} に送信しました。", ephemeral=True)


class EmbedTemplateDeleteButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="テンプレを削除", style=discord.ButtonStyle.secondary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: EmbedSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        templates = dict(view.settings.get("templates") or {})
        if not templates:
            return await interaction.response.send_message("テンプレがありません。", ephemeral=True)
        name = sorted(templates)[0]
        del templates[name]
        await update_settings(view.guild_id, KEY, templates=templates)
        view.settings["templates"] = templates
        await view.refresh(interaction, f"テンプレ「{name}」を削除しました。")


class EmbedSettingsView(AssistFeatureView):
    feature_key = KEY

    def __init__(self, cog: Any, guild_id: int):
        self.guild = getattr(cog.bot, "get_guild", lambda _id: None)(guild_id)
        self.settings = settings(guild_id)
        super().__init__(cog, guild_id)
        if self.guild is not None:
            self.add_item(AssistChannelSelect(self, field="channel_id", placeholder="Embedを投稿するチャンネル", notice="投稿先のチャンネルを保存しました。", check="send"))
        if self.settings.get("templates"):
            self.add_item(EmbedTemplateSelect(self))
        self.add_item(AssistToggleButton("enabled", "埋め込みビルダー", require=required_field("channel_id", "先に投稿先を選んでください。")))
        self.add_item(EmbedCreateButton())
        self.add_item(EmbedTemplateSaveButton())
        self.add_item(EmbedTemplateDeleteButton())

    def embed(self) -> discord.Embed:
        template_names = "、".join(self.settings.get("templates") or {}) or "なし"
        return discord.Embed(
            title="埋め込みビルダー",
            description=(
                "タイトル・本文・色・フッター・画像・フィールドを指定して、Embedを投稿します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**投稿先**: {channel_label(self.settings['channel_id'])}"
                f"\n**テンプレ**: {template_names}"
                "\n\n色は #RRGGBB 形式（空欄は白）です。"
                "追加要素: 「画像: URL」「サムネ: URL」「F: 見出し | 内容 | inline」を1行ずつ書けます。"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> EmbedSettingsView:
    return EmbedSettingsView(cog, guild_id)

