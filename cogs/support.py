"""サポート系機能を /support に統合する入口。"""
from __future__ import annotations

import asyncio
import logging

import discord
from discord import app_commands
from discord.ext import commands

from cogs.clear import MAX_CLEAR
from cogs.auth import get_intro_webhook, sanitize_webhook_name, role_failure_reason
from core import guild_settings
from core.panel_v2 import as_embed_v2, as_panel_v2, edit_panel_v2

logger = logging.getLogger(__name__)


async def edit_interaction_message(interaction: discord.Interaction, **kwargs):
    """未応答なら初回応答で、defer済みなら元の応答を編集する。"""
    if interaction.response.is_done():
        return await interaction.edit_original_response(**kwargs)
    return await interaction.response.edit_message(**kwargs)


async def report_callback_error(interaction: discord.Interaction, context: str):
    """コールバック例外をログに残し、可能ならユーザーにも通知する。"""
    logger.exception("%s", context)
    try:
        if interaction.response.is_done():
            await interaction.followup.send(
                "処理中にエラーが発生しました。Botのログを確認してください。",
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                "処理中にエラーが発生しました。Botのログを確認してください。",
                ephemeral=True,
            )
    except discord.HTTPException:
        logger.exception("コールバックのエラー通知にも失敗しました: %s", context)


SUPPORT_ACTIONS = [
    app_commands.Choice(name="Muted設定", value="muted"),
    app_commands.Choice(name="匿名つぶやきパネル", value="whisper"),
    app_commands.Choice(name="Stickyパネル", value="sticky"),
    app_commands.Choice(name="メッセージ削除", value="clear"),
    app_commands.Choice(name="一括ロール付与・剥奪", value="role_bulk"),
    app_commands.Choice(name="bump/up通知・RTA状態", value="bumprta_status"),
    app_commands.Choice(name="bump/up通知・RTAオン", value="bumprta_on"),
    app_commands.Choice(name="bump/up通知・RTAオフ", value="bumprta_off"),
    app_commands.Choice(name="絵文字便乗設定（binjou）", value="binjou"),
    app_commands.Choice(name="抽選（giveaway）", value="giveaway"),
    app_commands.Choice(name="VC入退室履歴", value="vc_log"),
    app_commands.Choice(name="メッセージ編集履歴", value="message_log"),
    app_commands.Choice(name="モデレート履歴（TO/KICK/BAN）", value="moderation_log"),
    app_commands.Choice(name="ハニーポット", value="honeypot"),
    app_commands.Choice(name="チケットツール", value="ticket"),
    app_commands.Choice(name="認証パネル作成", value="auth_panel"),
    app_commands.Choice(name="ロールパネル作成", value="role_panel"),
    app_commands.Choice(name="Auto react設定", value="auto_react"),
]

SUPPORT_GENRES = {
    "moderation": (
        "モデレーション",
        "Muted、匿名つぶやき、Stickyパネル、メッセージ削除、モデレート履歴、ハニーポット、チケット",
    ),
    "server": (
        "サーバー管理",
        "ロール操作、絵文字便乗、VC履歴、メッセージ編集履歴、認証パネル、ロールパネル",
    ),
    "bumprta": ("bump/up・RTA", "通知設定と RTA 状態・ランキング"),
    "event": ("イベント", "抽選の作成"),
}

SUPPORT_ACTIONS_BY_GENRE = {
    "moderation": [
        (c.name, c.value)
        for c in (
            SUPPORT_ACTIONS[0],
            SUPPORT_ACTIONS[1],
            SUPPORT_ACTIONS[2],
            SUPPORT_ACTIONS[3],
            SUPPORT_ACTIONS[12],
            SUPPORT_ACTIONS[13],
            SUPPORT_ACTIONS[14],
        )
    ],
    "server": [
        (c.name, c.value)
        for c in (
            SUPPORT_ACTIONS[4],
            SUPPORT_ACTIONS[8],
            SUPPORT_ACTIONS[10],
            SUPPORT_ACTIONS[11],
            SUPPORT_ACTIONS[15],
            SUPPORT_ACTIONS[16],
        )
    ],
    "bumprta": [(c.name, c.value) for c in SUPPORT_ACTIONS[5:8]],
    "event": [(SUPPORT_ACTIONS[9].name, SUPPORT_ACTIONS[9].value)],
}
SUPPORT_ACTIONS_BY_GENRE["server"].append((SUPPORT_ACTIONS[17].name, SUPPORT_ACTIONS[17].value))

THINKING_SECTION = "thinking_reaction"
BINJOU_SECTION = "binjou"
VC_LOG_SECTION = "vc_log"
MESSAGE_LOG_SECTION = "message_log"
MODERATION_LOG_SECTION = "moderation_log"
STICKY_SECTION = "sticky"
AUTH_SECTION = "auth"
ROLE_PANEL_SECTION = "role_panel"
HONEYPOT_SECTION = "honeypot"
AUTO_REACT_SECTION = "auto_react"

AUTH_MODE_SIMPLE = "simple"
AUTH_MODE_FORM = "form"
AUTH_MAX_QUESTIONS = 5
ROLE_PANEL_MAX_ROLES = 25

THINKING_EMOJI = discord.PartialEmoji(name="thinking", id=1561695212814995596)
BINJOU_DEFAULTS = {"thinking": True, "thumbsup": True}

AUTH_DEFAULT_QUESTIONS = [
    {
        "label": "あだ名はなんですか？(20文字以内)",
        "placeholder": "20文字以内で入力",
        "max_length": 20,
        "style": "short",
        "required": True,
    },
]


def _support_int(value) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def normalize_auth_questions(value) -> list[dict]:
    if not isinstance(value, list):
        return []

    result: list[dict] = []
    for item in value[:AUTH_MAX_QUESTIONS]:
        if not isinstance(item, dict):
            continue

        label = str(item.get("label") or "").strip()
        if not label:
            continue

        placeholder = str(item.get("placeholder") or "").strip()
        max_length = _support_int(item.get("max_length")) or 200
        max_length = max(1, min(1000, max_length))

        style_raw = str(item.get("style") or "short").strip().lower()
        style = "paragraph" if style_raw in {"paragraph", "long", "長い"} else "short"

        required = item.get("required", True)
        if not isinstance(required, bool):
            required = True

        result.append(
            {
                "label": label[:45],
                "placeholder": placeholder[:100],
                "max_length": max_length,
                "style": style,
                "required": required,
            }
        )

    return result


def get_auth_settings(store, guild_id: int) -> dict:
    raw = store.get(guild_id, AUTH_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else True

    mode = raw.get("mode")
    if mode not in {AUTH_MODE_SIMPLE, AUTH_MODE_FORM}:
        mode = AUTH_MODE_FORM

    role_id = _support_int(raw.get("role_id"))
    intro_channel_id = _support_int(raw.get("intro_channel_id"))
    panel_channel_id = _support_int(raw.get("panel_channel_id"))

    raw_questions = raw.get("questions")
    if raw_questions is None:
        questions = normalize_auth_questions(AUTH_DEFAULT_QUESTIONS)
    else:
        questions = normalize_auth_questions(raw_questions)

    return {
        "enabled": enabled,
        "mode": mode,
        "role_id": role_id,
        "intro_channel_id": intro_channel_id,
        "panel_channel_id": panel_channel_id,
        "questions": questions,
    }


def get_role_panel_settings(store, guild_id: int) -> dict:
    """ロールパネル設定。未設定時はオン・送信先なし・ロールなし。"""
    raw = store.get(guild_id, ROLE_PANEL_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else True
    panel_channel_id = _support_int(raw.get("panel_channel_id"))

    raw_roles = raw.get("roles")
    roles: list[int] = []
    if isinstance(raw_roles, list):
        for value in raw_roles:
            role_id = _support_int(value)
            if role_id is None or role_id in roles:
                continue
            roles.append(role_id)
            if len(roles) >= ROLE_PANEL_MAX_ROLES:
                break

    return {
        "enabled": enabled,
        "panel_channel_id": panel_channel_id,
        "roles": roles,
    }


def assignable_role_error(guild: discord.Guild, role: discord.Role | None, action: str = "付与") -> str | None:
    if role is None:
        return "対象ロールが見つかりません。"

    if role.is_default():
        return "@everyone ロールは使用できません。"

    if getattr(role, "managed", False):
        return "連携サービスが管理するロールは使用できません。"

    me = getattr(guild, "me", None)
    permissions = getattr(getattr(me, "guild_permissions", None), "manage_roles", False)
    if me is None or not permissions:
        return "Botに「ロールの管理」権限がありません。"

    if role >= me.top_role:
        return f"Botより上位、または同順位のロールは{action}できません。"

    return None


def can_manage_support_panel(interaction: discord.Interaction) -> bool:
    """
    認証パネル・ロールパネルの設定を操作できるか。
    既定: 管理者権限のみ。
    """
    permissions = getattr(interaction.user, "guild_permissions", None)
    return bool(getattr(permissions, "administrator", False))


def can_manage_auth_panel(interaction: discord.Interaction) -> bool:
    return can_manage_support_panel(interaction)


def can_manage_role_panel(interaction: discord.Interaction) -> bool:
    return can_manage_support_panel(interaction)


async def edit_auth_panel_message(interaction: discord.Interaction, panel):
    """Modal後などでも設定パネルを再描画するための補助。"""
    try:
        await interaction.response.edit_message(
            content=None,
            embed=None,
            attachments=[],
            view=as_panel_v2(panel),
        )
    except discord.HTTPException:
        if interaction.response.is_done():
            await interaction.followup.send(view=as_panel_v2(panel), ephemeral=True)
        else:
            await interaction.response.send_message(view=as_panel_v2(panel), ephemeral=True)


def get_sticky_settings(store, guild_id: int) -> dict[str, int | str | bool | None]:
    """Stickyパネル設定。未設定時はオフ・送信先なし・文言なし。"""
    raw = store.get(guild_id, STICKY_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    message_id = raw.get("message_id")
    if not isinstance(message_id, int) or isinstance(message_id, bool):
        message_id = None

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False
    content = raw.get("content") if isinstance(raw.get("content"), str) else ""

    return {
        "enabled": enabled,
        "channel_id": channel_id,
        "message_id": message_id,
        "content": content,
    }


def self_clip(value, limit=1024):
    text = str(value or "(内容なし)")
    return text if len(text) <= limit else text[:limit - 1] + "…"


def mention_with_id(user) -> str:
    if user is None:
        return "不明"

    mention = getattr(user, "mention", None) or getattr(user, "name", None) or str(user)
    return f"{mention} (`{getattr(user, 'id', '不明')}`)"


def get_vc_log_settings(store, guild_id: int) -> dict[str, int | bool | None]:
    """VC入退室ログ設定。未設定時はオフ・送信先なし。"""
    raw = store.get(guild_id, VC_LOG_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    return {"enabled": enabled, "channel_id": channel_id}


def vc_log_embed(member: discord.Member, channel: discord.VoiceChannel, joined: bool) -> discord.Embed:
    action = "入室しました" if joined else "退室しました"
    embed = discord.Embed(
        title="VC入室" if joined else "VC退室",
        description=(
            f"{member.mention} が **{discord.utils.escape_markdown(channel.name)}** "
            f"{'に' if joined else 'から'}{action}。"
        ),
        color=0x2ECC71 if joined else 0xE74C3C,
        timestamp=discord.utils.utcnow(),
    )

    avatar = getattr(member, "display_avatar", None)
    if avatar is not None:
        embed.set_author(name=member.display_name, icon_url=avatar.url)

    return embed


def get_activity_log_settings(store, guild_id: int, section: str) -> dict[str, int | bool | None]:
    """メッセージ・モデレート履歴の共通設定を返す。未設定時はオフ。"""
    raw = store.get(guild_id, section)
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    settings = {"enabled": enabled, "channel_id": channel_id}

    if section == MODERATION_LOG_SECTION:
        for action in ("timeout", "kick", "ban"):
            key = f"{action}_enabled"
            settings[key] = raw.get(key) if isinstance(raw.get(key), bool) else False

    return settings


class AuthQuestionAddModal(discord.ui.Modal, title="質問を追加"):
    def __init__(self, view: "AuthQuestionSettingsView"):
        super().__init__()
        self.parent_view = view

        self.q_label = discord.ui.TextInput(
            label="質問文（45文字以内）",
            placeholder="例: あだ名はなんですか？",
            max_length=45,
            required=True,
        )
        self.q_placeholder = discord.ui.TextInput(
            label="プレースホルダー",
            placeholder="例: 5文字以内で入力",
            required=False,
            max_length=100,
        )
        self.q_max = discord.ui.TextInput(
            label="最大文字数（1〜1000）",
            default="200",
            required=False,
            max_length=4,
        )
        self.q_style = discord.ui.TextInput(
            label="入力形式（short / long）",
            default="short",
            required=False,
            max_length=10,
        )

        self.add_item(self.q_label)
        self.add_item(self.q_placeholder)
        self.add_item(self.q_max)
        self.add_item(self.q_style)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        if len(self.parent_view.settings["questions"]) >= AUTH_MAX_QUESTIONS:
            return await interaction.response.send_message(
                f"質問は最大{AUTH_MAX_QUESTIONS}個までです。",
                ephemeral=True,
            )

        try:
            max_length = int((self.q_max.value or "200").strip() or 200)
        except ValueError:
            return await interaction.response.send_message(
                "最大文字数は数値で入力してください。",
                ephemeral=True,
            )

        max_length = max(1, min(1000, max_length))
        style_raw = (self.q_style.value or "short").strip().lower()
        style = "paragraph" if style_raw in {"long", "paragraph", "長い"} else "short"

        questions = list(self.parent_view.settings["questions"])
        questions.append(
            {
                "label": self.q_label.value.strip()[:45],
                "placeholder": (self.q_placeholder.value or "").strip()[:100],
                "max_length": max_length,
                "style": style,
                "required": True,
            }
        )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, AUTH_SECTION, questions=questions)

        self.parent_view.settings = get_auth_settings(store, interaction.guild_id)
        self.parent_view.selected = None
        self.parent_view._add_items()

        await edit_auth_panel_message(interaction, self.parent_view)


class AuthQuestionSelect(discord.ui.Select):
    def __init__(self, parent: "AuthQuestionSettingsView"):
        self.parent_view = parent

        options = []
        for i, q in enumerate(parent.settings["questions"]):
            options.append(
                discord.SelectOption(
                    label=f"Q{i + 1}",
                    value=str(i),
                    description=str(q.get("label", ""))[:90],
                    default=(i == parent.selected),
                )
            )

        super().__init__(
            placeholder="削除する質問を選択",
            options=options,
            row=0,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        try:
            self.parent_view.selected = int(self.values[0])
        except (ValueError, IndexError):
            self.parent_view.selected = None

        await interaction.response.defer()
        self.parent_view._add_items()
        await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class AuthAddQuestionButton(discord.ui.Button):
    def __init__(self, parent: "AuthQuestionSettingsView"):
        self.parent_view = parent
        super().__init__(
            label="質問を追加",
            style=discord.ButtonStyle.primary,
            row=1,
        )
        self.disabled = len(parent.settings["questions"]) >= AUTH_MAX_QUESTIONS

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        if len(self.parent_view.settings["questions"]) >= AUTH_MAX_QUESTIONS:
            return await interaction.response.send_message(
                f"質問は最大{AUTH_MAX_QUESTIONS}個までです。",
                ephemeral=True,
            )

        await interaction.response.send_modal(AuthQuestionAddModal(self.parent_view))


class AuthDeleteQuestionButton(discord.ui.Button):
    def __init__(self, parent: "AuthQuestionSettingsView"):
        self.parent_view = parent
        super().__init__(
            label="質問を削除",
            style=discord.ButtonStyle.danger,
            row=1,
        )
        self.disabled = parent.selected is None or not parent.settings["questions"]

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        selected = self.parent_view.selected
        questions = list(self.parent_view.settings["questions"])

        if selected is None or not (0 <= selected < len(questions)):
            return await interaction.response.send_message(
                "削除する質問を選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        del questions[selected]

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, AUTH_SECTION, questions=questions)

        self.parent_view.settings = get_auth_settings(store, interaction.guild_id)
        self.parent_view.selected = None
        self.parent_view._add_items()

        await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class AuthBackToSettingsButton(discord.ui.Button):
    def __init__(self, parent: "AuthQuestionSettingsView"):
        self.parent_view = parent
        super().__init__(
            label="戻る",
            style=discord.ButtonStyle.secondary,
            row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        await edit_panel_v2(
            interaction,
            as_panel_v2(AuthPanelSettingsView(self.parent_view.cog, self.parent_view.settings)),
        )


class AuthQuestionSettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict, selected: int | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.selected = selected
        self._add_items()

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        return can_manage_auth_panel(interaction)

    def _add_items(self):
        self.clear_items()

        if self.settings["questions"]:
            self.add_item(AuthQuestionSelect(self))

        self.add_item(AuthAddQuestionButton(self))
        self.add_item(AuthDeleteQuestionButton(self))
        self.add_item(AuthBackToSettingsButton(self))

    def embed(self) -> discord.Embed:
        lines: list[str] = []
        questions = self.settings["questions"]

        if not questions:
            lines.append("質問がまだありません。「質問を追加」から追加してください。")
        else:
            for i, q in enumerate(questions):
                style = "長い文章" if q.get("style") == "paragraph" else "短文"
                lines.append(f"**Q{i + 1}. {q.get('label', '質問')}**")
                lines.append(
                    f"- 形式: {style} / 最大: {q.get('max_length', 200)}文字 / "
                    f"必須: {'はい' if q.get('required', True) else 'いいえ'}"
                )
                if q.get("placeholder"):
                    lines.append(f"- 例: {q['placeholder']}")
                lines.append("")

        if self.selected is not None and 0 <= self.selected < len(questions):
            lines.append(f"選択中: Q{self.selected + 1}")
            lines.append("")

        lines.append(f"※ DiscordのModal制限により、質問は最大{AUTH_MAX_QUESTIONS}個です。")

        return discord.Embed(
            title="自己紹介フォームの質問設定",
            description="\n".join(lines)[:4000],
            color=0x3498DB,
        )


class AuthStartButton(discord.ui.Button):
    def __init__(self):
        super().__init__(
            label="認証を開始する",
            style=discord.ButtonStyle.green,
            custom_id="auth_panel:start",
        )

    async def callback(self, interaction: discord.Interaction):
        if interaction.response.is_done():
            return

        cog = interaction.client.get_cog("SupportCog")
        if cog is None:
            await interaction.response.send_message(
                "認証機能を読み込めません。",
                ephemeral=True,
            )
            return

        await cog.handle_auth_start(interaction)


class AuthPanelStartView(discord.ui.LayoutView):
    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(
                    "## 認証パネル\n下のボタンを押して認証を開始してください。"
                ),
                discord.ui.ActionRow(AuthStartButton()),
                accent_colour=0x2ECC71,
            )
        )


class AuthFormModal(discord.ui.Modal, title="認証フォーム"):
    def __init__(
        self,
        cog: "SupportCog",
        role_id: int,
        intro_channel_id: int | None,
        questions: list[dict],
    ):
        super().__init__(custom_id="auth_panel:form")
        self.cog = cog
        self.role_id = role_id
        self.intro_channel_id = intro_channel_id
        self.inputs: list[tuple[dict, discord.ui.TextInput]] = []

        for i, q in enumerate(questions[:AUTH_MAX_QUESTIONS]):
            style = (
                discord.TextStyle.paragraph
                if q.get("style") == "paragraph"
                else discord.TextStyle.short
            )

            kwargs = {}
            if q.get("placeholder"):
                kwargs["placeholder"] = q["placeholder"][:100]

            item = discord.ui.TextInput(
                label=str(q.get("label") or f"質問{i + 1}")[:45],
                style=style,
                max_length=int(q.get("max_length") or 200),
                required=bool(q.get("required", True)),
                **kwargs,
            )

            self.add_item(item)
            self.inputs.append((q, item))

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)

        cog = self.cog or interaction.client.get_cog("SupportCog")
        if cog is None:
            await interaction.followup.send(
                "認証機能を読み込めません。",
                ephemeral=True,
            )
            return

        answers = [(q, item.value) for q, item in self.inputs]
        await cog.finish_auth_form(
            interaction,
            self.role_id,
            self.intro_channel_id,
            answers,
        )


class AuthModeSelect(discord.ui.Select):
    def __init__(self, parent: "AuthPanelSettingsView"):
        self.parent_view = parent

        options = [
            discord.SelectOption(
                label="クリックだけ（シンプル）",
                value=AUTH_MODE_SIMPLE,
                description="ボタンを押すとロールが付与されます",
                default=parent.settings["mode"] == AUTH_MODE_SIMPLE,
            ),
            discord.SelectOption(
                label="自己紹介フォーム（質問あり）",
                value=AUTH_MODE_FORM,
                description="フォーム提出後にロールが付与されます",
                default=parent.settings["mode"] == AUTH_MODE_FORM,
            ),
        ]

        super().__init__(
            placeholder="認証モードを選択",
            options=options,
            row=0,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        mode = self.values[0]
        await interaction.response.defer()

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, AUTH_SECTION, mode=mode)

        await self.parent_view.refresh(interaction, "認証モードを更新しました。")


class AuthRoleSelect(discord.ui.RoleSelect):
    def __init__(self, parent: "AuthPanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="認証で付与するロールを選択",
            row=1,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        role = self.values[0]
        if error := assignable_role_error(interaction.guild, role):
            return await interaction.response.send_message(error, ephemeral=True)

        await interaction.response.defer()

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, AUTH_SECTION, role_id=role.id)

        await self.parent_view.refresh(interaction, "認証ロールを設定しました。")


class AuthIntroChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "AuthPanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="自己紹介の出力先チャンネル",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            row=2,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        channel = self.values[0]
        await interaction.response.defer()

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, AUTH_SECTION, intro_channel_id=channel.id)

        await self.parent_view.refresh(interaction, "自己紹介の出力先を設定しました。")


class AuthPanelChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "AuthPanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="認証パネルを送信するチャンネル",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            row=3,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        channel = self.values[0]
        await interaction.response.defer()

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, AUTH_SECTION, panel_channel_id=channel.id)

        self.parent_view.panel_channel_id = channel.id
        await self.parent_view.refresh(interaction, "パネル送信先を設定しました。")


class AuthQuestionSettingsButton(discord.ui.Button):
    def __init__(self, parent: "AuthPanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            label="質問設定",
            style=discord.ButtonStyle.primary,
            row=4,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        if self.parent_view.settings["mode"] != AUTH_MODE_FORM:
            return await interaction.response.send_message(
                "質問設定は自己紹介フォーム方式のときのみ使えます。",
                ephemeral=True,
            )

        await edit_panel_v2(
            interaction,
            as_panel_v2(AuthQuestionSettingsView(self.parent_view.cog, self.parent_view.settings)),
        )


class AuthSendPanelButton(discord.ui.Button):
    def __init__(self, parent: "AuthPanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            label="パネル送信",
            style=discord.ButtonStyle.success,
            row=4,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        settings = self.parent_view.settings
        panel_channel_id = self.parent_view.panel_channel_id or settings.get("panel_channel_id")

        if panel_channel_id is None:
            return await interaction.response.send_message(
                "先に認証パネルを送信するチャンネルを選択してください。",
                ephemeral=True,
            )

        channel = interaction.guild.get_channel(panel_channel_id)
        if channel is None:
            return await interaction.response.send_message(
                "パネル送信先チャンネルが見つかりません。",
                ephemeral=True,
            )

        role = interaction.guild.get_role(settings["role_id"]) if settings["role_id"] else None
        if error := assignable_role_error(interaction.guild, role):
            return await interaction.response.send_message(error, ephemeral=True)

        if settings["mode"] == AUTH_MODE_FORM:
            if not settings["intro_channel_id"]:
                return await interaction.response.send_message(
                    "自己紹介方式の場合は、自己紹介の出力先チャンネルを設定してください。",
                    ephemeral=True,
                )
            if not settings["questions"]:
                return await interaction.response.send_message(
                    "自己紹介方式の場合は、質問を1つ以上設定してください。",
                    ephemeral=True,
                )

        await interaction.response.defer(ephemeral=True)

        try:
            await channel.send(view=AuthPanelStartView())
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("認証パネルの送信に失敗しました")
            await interaction.followup.send(
                "認証パネルを送信できませんでした。Botの権限を確認してください。",
                ephemeral=True,
            )
            return

        await interaction.followup.send(
            f"{channel.mention} に認証パネルを送信しました。",
            ephemeral=True,
        )


class AuthToggleEnabledButton(discord.ui.Button):
    def __init__(self, parent: "AuthPanelSettingsView"):
        self.parent_view = parent

        enabled = parent.settings["enabled"]
        super().__init__(
            label="認証を無効にする" if enabled else "認証を有効にする",
            style=discord.ButtonStyle.danger if enabled else discord.ButtonStyle.success,
            row=4,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        await interaction.response.defer()

        store = guild_settings.get_store()
        await store.ensure_loaded()

        enabled = not self.parent_view.settings["enabled"]
        await store.update(interaction.guild_id, AUTH_SECTION, enabled=enabled)

        await self.parent_view.refresh(
            interaction,
            "認証を有効にしました。" if enabled else "認証を無効にしました。",
        )


class AuthPanelSettingsView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        settings: dict,
        panel_channel_id: int | None = None,
        notice: str | None = None,
    ):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.panel_channel_id = panel_channel_id or settings.get("panel_channel_id")
        self.notice = notice
        self._add_items()

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        return can_manage_auth_panel(interaction)

    def _add_items(self):
        self.clear_items()
        self.add_item(AuthModeSelect(self))
        self.add_item(AuthRoleSelect(self))
        self.add_item(AuthIntroChannelSelect(self))
        self.add_item(AuthPanelChannelSelect(self))
        self.add_item(AuthQuestionSettingsButton(self))
        self.add_item(AuthSendPanelButton(self))
        self.add_item(AuthToggleEnabledButton(self))

    def embed(self) -> discord.Embed:
        lines: list[str] = []

        if self.notice:
            lines.append(self.notice)
            lines.append("")

        mode_label = (
            "クリックだけ（シンプル）"
            if self.settings["mode"] == AUTH_MODE_SIMPLE
            else "自己紹介フォーム（質問あり）"
        )

        role_label = (
            f"<@&{self.settings['role_id']}>" if self.settings["role_id"] else "未設定"
        )
        intro_label = (
            f"<#{self.settings['intro_channel_id']}>"
            if self.settings["intro_channel_id"]
            else "未設定"
        )

        panel_channel_id = self.panel_channel_id or self.settings.get("panel_channel_id")
        panel_label = f"<#{panel_channel_id}>" if panel_channel_id else "未選択"

        lines.append(f"状態: **{'オン' if self.settings['enabled'] else 'オフ'}**")
        lines.append(f"認証モード: **{mode_label}**")
        lines.append(f"付与ロール: {role_label}")
        lines.append(f"自己紹介出力先: {intro_label}")
        lines.append(f"パネル送信先: {panel_label}")

        if self.settings["mode"] == AUTH_MODE_FORM:
            lines.append(
                f"質問数: **{len(self.settings['questions'])} / {AUTH_MAX_QUESTIONS}**"
            )

        lines.append("")
        lines.append("※ この設定は管理者のみ変更できます。")
        lines.append("※ 認証パネルはコンポーネントV2で送信されます。")

        return discord.Embed(
            title="認証パネル作成",
            description="\n".join(lines)[:4000],
            color=0x3498DB,
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()

        current_panel_channel_id = self.panel_channel_id
        self.settings = get_auth_settings(store, interaction.guild_id)
        self.panel_channel_id = (
            self.settings.get("panel_channel_id") or current_panel_channel_id
        )
        self.notice = notice

        self._add_items()
        await edit_panel_v2(interaction, as_panel_v2(self))


class RolePanelAssignSelect(discord.ui.Select):
    def __init__(self, options: list[discord.SelectOption]):
        super().__init__(
            placeholder="付けてほしいロールを選択",
            custom_id="role_panel:assign",
            options=options[:ROLE_PANEL_MAX_ROLES],
            min_values=1,
            max_values=1,
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        if interaction.response.is_done():
            return

        cog = interaction.client.get_cog("SupportCog")
        if cog is None:
            await interaction.response.send_message(
                "ロール機能を読み込めません。",
                ephemeral=True,
            )
            return

        try:
            role_id = int(self.values[0])
        except (ValueError, IndexError):
            await interaction.response.send_message(
                "ロール選択が正しくありません。",
                ephemeral=True,
            )
            return

        await cog.handle_role_panel_assign(interaction, role_id)


class RolePanelUserView(discord.ui.LayoutView):
    def __init__(self, guild: discord.Guild, role_ids: list[int]):
        super().__init__(timeout=None)

        options: list[discord.SelectOption] = []
        for role_id in role_ids[:ROLE_PANEL_MAX_ROLES]:
            role = guild.get_role(role_id)
            if role is None or role.is_default() or getattr(role, "managed", False):
                continue

            options.append(
                discord.SelectOption(
                    label=role.name[:100],
                    value=str(role.id),
                    description=f"ID: {role.id}",
                )
            )

        if not options:
            options.append(
                discord.SelectOption(
                    label="ロールが設定されていません",
                    value="invalid",
                )
            )

        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(
                    """## ロールパネル
ドロップダウンからロールを選択してください。
まだロールを持っていない場合は付与され、すでに持っている場合は解除されます。"""
                ),
                discord.ui.ActionRow(RolePanelAssignSelect(options)),
                accent_colour=0x9B59B6,
            )
        )


class RolePanelAddRoleSelect(discord.ui.RoleSelect):
    def __init__(self, parent: "RolePanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="パネルに追加するロールを選択",
            row=0,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        role = self.values[0]
        if error := assignable_role_error(interaction.guild, role):
            return await interaction.response.send_message(error, ephemeral=True)

        settings = self.parent_view.settings
        if role.id in settings["roles"]:
            return await interaction.response.send_message(
                "そのロールはすでに追加されています。",
                ephemeral=True,
            )

        if len(settings["roles"]) >= ROLE_PANEL_MAX_ROLES:
            return await interaction.response.send_message(
                f"ロールは最大{ROLE_PANEL_MAX_ROLES}個までです。",
                ephemeral=True,
            )

        await interaction.response.defer()

        roles = list(settings["roles"])
        roles.append(role.id)

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, ROLE_PANEL_SECTION, roles=roles)

        await self.parent_view.refresh(interaction, f"{role.name} を追加しました。")


class RolePanelCurrentRoleSelect(discord.ui.Select):
    def __init__(self, parent: "RolePanelSettingsView"):
        self.parent_view = parent

        options: list[discord.SelectOption] = []
        for role_id in parent.settings["roles"][:ROLE_PANEL_MAX_ROLES]:
            role = parent.guild.get_role(role_id)
            if role is None:
                continue

            options.append(
                discord.SelectOption(
                    label=role.name[:100],
                    value=str(role.id),
                    description=f"ID: {role.id}",
                    default=(role_id == parent.selected_role_id),
                )
            )

        super().__init__(
            placeholder="削除するロールを選択",
            options=options[:ROLE_PANEL_MAX_ROLES],
            row=1,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        try:
            self.parent_view.selected_role_id = int(self.values[0])
        except (ValueError, IndexError):
            self.parent_view.selected_role_id = None

        await interaction.response.defer()
        self.parent_view._add_items()
        await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class RolePanelChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "RolePanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="ロールパネルを送信するチャンネル",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            row=2,
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        channel = self.values[0]
        await interaction.response.defer()

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, ROLE_PANEL_SECTION, panel_channel_id=channel.id)

        self.parent_view.panel_channel_id = channel.id
        await self.parent_view.refresh(interaction, "パネル送信先を設定しました。")


class RolePanelRemoveButton(discord.ui.Button):
    def __init__(self, parent: "RolePanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            label="選択ロールを削除",
            style=discord.ButtonStyle.danger,
            row=3,
        )
        self.disabled = parent.selected_role_id is None

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        selected = self.parent_view.selected_role_id
        roles = list(self.parent_view.settings["roles"])

        if selected is None or selected not in roles:
            return await interaction.response.send_message(
                "削除するロールを選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        roles.remove(selected)

        store = guild_settings.get_store()
        await store.ensure_loaded()
        await store.update(interaction.guild_id, ROLE_PANEL_SECTION, roles=roles)

        self.parent_view.selected_role_id = None
        await self.parent_view.refresh(interaction, "ロールを削除しました。")


class RolePanelSendButton(discord.ui.Button):
    def __init__(self, parent: "RolePanelSettingsView"):
        self.parent_view = parent
        super().__init__(
            label="パネル送信",
            style=discord.ButtonStyle.success,
            row=3,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        settings = self.parent_view.settings
        panel_channel_id = self.parent_view.panel_channel_id or settings.get("panel_channel_id")

        if panel_channel_id is None:
            return await interaction.response.send_message(
                "先にロールパネルを送信するチャンネルを選択してください。",
                ephemeral=True,
            )

        channel = interaction.guild.get_channel(panel_channel_id)
        if channel is None:
            return await interaction.response.send_message(
                "パネル送信先チャンネルが見つかりません。",
                ephemeral=True,
            )

        valid_role_ids = [
            role_id
            for role_id in settings["roles"]
            if interaction.guild.get_role(role_id) is not None
        ]

        if not valid_role_ids:
            return await interaction.response.send_message(
                "ロールが1つも追加されていません。",
                ephemeral=True,
            )

        await interaction.response.defer(ephemeral=True)

        try:
            await channel.send(view=RolePanelUserView(interaction.guild, valid_role_ids))
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("ロールパネルの送信に失敗しました")
            await interaction.followup.send(
                "ロールパネルを送信できませんでした。Botの権限を確認してください。",
                ephemeral=True,
            )
            return

        await interaction.followup.send(
            f"{channel.mention} にロールパネルを送信しました。",
            ephemeral=True,
        )


class RolePanelToggleEnabledButton(discord.ui.Button):
    def __init__(self, parent: "RolePanelSettingsView"):
        self.parent_view = parent

        enabled = parent.settings["enabled"]
        super().__init__(
            label="ロールパネルを無効にする" if enabled else "ロールパネルを有効にする",
            style=discord.ButtonStyle.danger if enabled else discord.ButtonStyle.success,
            row=3,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定は管理者のみ利用できます。",
                ephemeral=True,
            )

        await interaction.response.defer()

        store = guild_settings.get_store()
        await store.ensure_loaded()

        enabled = not self.parent_view.settings["enabled"]
        await store.update(interaction.guild_id, ROLE_PANEL_SECTION, enabled=enabled)

        await self.parent_view.refresh(
            interaction,
            "ロールパネルを有効にしました。" if enabled else "ロールパネルを無効にしました。",
        )


class RolePanelSettingsView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        settings: dict,
        guild: discord.Guild,
        panel_channel_id: int | None = None,
        selected_role_id: int | None = None,
        notice: str | None = None,
    ):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.guild = guild
        self.panel_channel_id = panel_channel_id or settings.get("panel_channel_id")
        self.selected_role_id = selected_role_id
        self.notice = notice
        self._add_items()

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        return can_manage_role_panel(interaction)

    def _add_items(self):
        self.clear_items()

        self.add_item(RolePanelAddRoleSelect(self))

        if self.settings["roles"]:
            self.add_item(RolePanelCurrentRoleSelect(self))

        self.add_item(RolePanelChannelSelect(self))
        self.add_item(RolePanelRemoveButton(self))
        self.add_item(RolePanelSendButton(self))
        self.add_item(RolePanelToggleEnabledButton(self))

    def embed(self) -> discord.Embed:
        lines: list[str] = []

        if self.notice:
            lines.append(self.notice)
            lines.append("")

        role_labels: list[str] = []
        for role_id in self.settings["roles"][:ROLE_PANEL_MAX_ROLES]:
            role = self.guild.get_role(role_id)
            if role is not None:
                role_labels.append(role.mention)

        panel_channel_id = self.panel_channel_id or self.settings.get("panel_channel_id")
        panel_label = f"<#{panel_channel_id}>" if panel_channel_id else "未選択"

        lines.append(f"状態: **{'オン' if self.settings['enabled'] else 'オフ'}**")
        lines.append(f"パネル送信先: {panel_label}")
        lines.append(f"登録ロール数: **{len(self.settings['roles'])} / {ROLE_PANEL_MAX_ROLES}**")

        if role_labels:
            lines.append("登録ロール: " + ", ".join(role_labels))
        else:
            lines.append("登録ロール: 未設定")

        lines.append("")
        lines.append("※ この設定は管理者のみ変更できます。")
        lines.append("※ ユーザーはドロップダウンからロールを選んで付与/解除できます。")

        return discord.Embed(
            title="ロールパネル作成",
            description="\n".join(lines)[:4000],
            color=0x9B59B6,
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()

        current_panel_channel_id = self.panel_channel_id
        current_selected_role_id = self.selected_role_id

        self.settings = get_role_panel_settings(store, interaction.guild_id)
        self.panel_channel_id = (
            self.settings.get("panel_channel_id") or current_panel_channel_id
        )

        if current_selected_role_id in self.settings["roles"]:
            self.selected_role_id = current_selected_role_id
        else:
            self.selected_role_id = None

        self.notice = notice
        self._add_items()
        await edit_panel_v2(interaction, as_panel_v2(self))


class ActivityLogChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "ActivityLogSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="履歴を送るテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            channel = self.values[0]
            await guild_settings.get_store().update(
                interaction.guild_id,
                self.parent_view.section,
                channel_id=channel.id,
            )
            await self.parent_view.refresh(interaction, "送信先を設定しました。")
        except Exception:
            logger.exception("履歴送信先の更新に失敗しました")
            await interaction.followup.send(
                "送信先の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )


class ModerationActionToggle(discord.ui.Button):
    def __init__(self, parent: "ActivityLogSettingsView", action: str, label: str, row: int = 2):
        self.parent_view, self.action, self.action_label = parent, action, label
        super().__init__(label=self.button_label(), style=discord.ButtonStyle.secondary, row=row)

    def button_label(self) -> str:
        enabled = self.parent_view.settings.get(f"{self.action}_enabled", False)
        next_state = "オフにする" if enabled else "オンにする"
        return f"{self.action_label}履歴を{next_state}"

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.toggle_action(interaction, self.action)


class ActivityLogSettingsView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        section: str,
        title: str,
        description: str,
        settings: dict,
    ):
        super().__init__(timeout=300)
        self.cog = cog
        self.section = section
        self.title = title
        self.log_description = description
        self.settings = settings

        self.add_item(ActivityLogChannelSelect(self))

        if section == MODERATION_LOG_SECTION:
            self.add_item(ModerationActionToggle(self, "timeout", "TO"))
            self.add_item(ModerationActionToggle(self, "kick", "KICK"))
            self.add_item(ModerationActionToggle(self, "ban", "BAN"))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def embed(self, notice: str | None = None) -> discord.Embed:
        channel_id = self.settings.get("channel_id")
        channel_label = f"<#{channel_id}>" if channel_id else "未設定"

        description = (
            f"状態: **{'オン' if self.settings['enabled'] else 'オフ'}**\n"
            f"送信先: {channel_label}"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        description += f"\n\n{self.log_description}"

        if self.section == MODERATION_LOG_SECTION:
            description += (
                "\n\n個別設定: "
                f"TO {'オン' if self.settings['timeout_enabled'] else 'オフ'} / "
                f"KICK {'オン' if self.settings['kick_enabled'] else 'オフ'} / "
                f"BAN {'オン' if self.settings['ban_enabled'] else 'オフ'}"
            )

        return discord.Embed(title=self.title, description=description, color=0x3498DB)

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.settings = get_activity_log_settings(
            guild_settings.get_store(),
            interaction.guild_id,
            self.section,
        )

        for item in self.children:
            if isinstance(item, ModerationActionToggle):
                item.label = item.button_label()

        await edit_panel_v2(interaction, as_panel_v2(self))

    async def set_enabled(self, interaction: discord.Interaction, enabled: bool):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if enabled and self.settings.get("channel_id") is None:
            return await interaction.response.send_message(
                "先に履歴を送るテキストチャンネルを選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                self.section,
                enabled=enabled,
            )
            await self.refresh(interaction, f"履歴を{'オン' if enabled else 'オフ'}にしました。")
        except Exception:
            logger.exception("履歴設定の更新に失敗しました (section=%s)", self.section)
            await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    async def toggle_action(self, interaction: discord.Interaction, action: str):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        key = f"{action}_enabled"
        enabled = not self.settings.get(key, False)

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                self.section,
                **{key: enabled},
            )
            await self.refresh(
                interaction,
                f"{action.upper()}履歴を{'オン' if enabled else 'オフ'}にしました。",
            )
        except Exception:
            logger.exception("個別モデレート履歴設定の更新に失敗しました (action=%s)", action)
            await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    @discord.ui.button(label="履歴をオンにする", style=discord.ButtonStyle.success, row=1)
    async def turn_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, True)

    @discord.ui.button(label="履歴をオフにする", style=discord.ButtonStyle.secondary, row=1)
    async def turn_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, False)


class VCLogChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "VCLogSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="履歴を送るテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            channel = self.values[0]
            await guild_settings.get_store().update(
                interaction.guild_id,
                VC_LOG_SECTION,
                channel_id=channel.id,
            )
            await self.parent_view.refresh(interaction, "送信先を設定しました。")
        except Exception:
            logger.exception("VC履歴送信先の更新に失敗しました")
            await interaction.followup.send(
                "送信先の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )


class VCLogSettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.add_item(VCLogChannelSelect(self))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def embed(self, notice: str | None = None) -> discord.Embed:
        channel_id = self.settings.get("channel_id")
        channel_label = f"<#{channel_id}>" if channel_id else "未設定"

        description = (
            f"状態: **{'オン' if self.settings['enabled'] else 'オフ'}**\n"
            f"送信先: {channel_label}"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        description += "\n\nVC入室・退出・VC間の移動を記録します。"

        return discord.Embed(
            title="VC入退室履歴の設定",
            description=description,
            color=0x3498DB,
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.settings = get_vc_log_settings(guild_settings.get_store(), interaction.guild_id)
        await edit_panel_v2(interaction, as_panel_v2(self))

    async def set_enabled(self, interaction: discord.Interaction, enabled: bool):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if enabled and self.settings.get("channel_id") is None:
            return await interaction.response.send_message(
                "先に履歴を送るテキストチャンネルを選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                VC_LOG_SECTION,
                enabled=enabled,
            )
            await self.refresh(interaction, f"履歴を{'オン' if enabled else 'オフ'}にしました。")
        except Exception:
            logger.exception("VC履歴設定の更新に失敗しました")
            await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    @discord.ui.button(label="オン", style=discord.ButtonStyle.success, row=1)
    async def turn_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, True)

    @discord.ui.button(label="オフ", style=discord.ButtonStyle.secondary, row=1)
    async def turn_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, False)


class StickyChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "StickySettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="Stickyパネルを置くテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            channel = self.values[0]

            old_channel_id = self.parent_view.settings.get("channel_id")
            old_message_id = self.parent_view.settings.get("message_id")

            if old_channel_id and old_message_id and old_channel_id != channel.id:
                old_channel = await self.parent_view.cog._sticky_channel(
                    interaction.guild,
                    old_channel_id,
                )
                if old_channel is not None:
                    try:
                        await (await old_channel.fetch_message(old_message_id)).delete()
                    except discord.NotFound:
                        pass
                    except (discord.Forbidden, discord.HTTPException):
                        logger.warning(
                            "旧Stickyパネルを削除できません (guild=%s message=%s)",
                            interaction.guild_id,
                            old_message_id,
                        )

            await guild_settings.get_store().update(
                interaction.guild_id,
                STICKY_SECTION,
                channel_id=channel.id,
                message_id=None,
            )

            self.parent_view.settings["channel_id"] = channel.id
            self.parent_view.settings["message_id"] = None

            await self.parent_view.refresh(interaction, "Stickyパネルの設置先を設定しました。")

            if self.parent_view.settings.get("enabled") and self.parent_view.settings.get("content"):
                await self.parent_view.cog.send_sticky_panel(interaction.guild, force=True)
        except Exception:
            logger.exception("Stickyパネル設置先の更新に失敗しました")
            await interaction.followup.send(
                "Stickyパネル設置先の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )


class StickyTextModal(discord.ui.Modal, title="Stickyパネルの文言"):
    def __init__(self, view: "StickySettingsView"):
        super().__init__()
        self.parent_view = view

        self.text = discord.ui.TextInput(
            label="パネルに表示する文言",
            style=discord.TextStyle.paragraph,
            placeholder="例: お問い合わせはこのチャンネルに送信してください。",
            default=view.settings.get("content", "")[:2000],
            max_length=2000,
            required=True,
        )
        self.add_item(self.text)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if self.parent_view.settings.get("channel_id") is None:
            return await interaction.response.send_message(
                "先にStickyパネルを置くチャンネルを選択してください。",
                ephemeral=True,
            )

        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                STICKY_SECTION,
                content=self.text.value,
                enabled=True,
            )

            self.parent_view.settings["content"] = self.text.value
            self.parent_view.settings["enabled"] = True

            await interaction.edit_original_response(
                content="文言を保存しました。Stickyパネルを送信しています。"
            )
            await self.parent_view.cog.send_sticky_panel(interaction.guild, force=True)
        except Exception:
            logger.exception("Stickyパネル文言の保存・送信に失敗しました")
            try:
                await interaction.edit_original_response(
                    content="文言の保存またはパネル送信に失敗しました。Botのログを確認してください。"
                )
            except discord.HTTPException:
                logger.exception("Sticky文言保存エラーの通知に失敗しました")


class StickySettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.add_item(StickyChannelSelect(self))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def embed(self, notice: str | None = None) -> discord.Embed:
        channel_id = self.settings.get("channel_id")
        channel_label = f"<#{channel_id}>" if channel_id else "未設定"

        content = self.settings.get("content") or "未設定"
        if len(content) > 200:
            content = content[:199] + "…"

        description = (
            f"状態: **{'オン' if self.settings.get('enabled') else 'オフ'}**\n"
            f"設置先: {channel_label}\n"
            f"文言: {content}\n\n"
            "設置先のチャンネルに誰かが投稿すると、直前のStickyパネルを削除して再送信します。"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        return discord.Embed(title="Stickyパネルの設定", description=description, color=0x3498DB)

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        self.settings = get_sticky_settings(guild_settings.get_store(), interaction.guild_id)
        await edit_panel_v2(interaction, as_panel_v2(self))

    async def set_enabled(self, interaction: discord.Interaction, enabled: bool):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        if enabled and (self.settings.get("channel_id") is None or not self.settings.get("content")):
            return await interaction.response.send_message(
                "先に設置先と文言を設定してください。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            await guild_settings.get_store().update(
                interaction.guild_id,
                STICKY_SECTION,
                enabled=enabled,
            )
            self.settings["enabled"] = enabled

            notice = "Stickyパネルをオンにしました。" if enabled else "Stickyパネルをオフにしました。"
            await edit_panel_v2(interaction, as_panel_v2(self))

            if enabled:
                await self.cog.send_sticky_panel(interaction.guild, force=True)
        except Exception:
            logger.exception("Stickyパネル有効状態の更新に失敗しました")
            await interaction.followup.send(
                "Sticky設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )

    @discord.ui.button(label="文言を設定・更新", style=discord.ButtonStyle.primary, row=1)
    async def edit_text(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.send_modal(StickyTextModal(self))

    @discord.ui.button(label="オン", style=discord.ButtonStyle.success, row=1)
    async def turn_on(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, True)

    @discord.ui.button(label="オフ", style=discord.ButtonStyle.secondary, row=1)
    async def turn_off(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.set_enabled(interaction, False)


def get_honeypot_settings(store, guild_id: int) -> dict[str, int | bool | None]:
    """Return the configured honeypot channel and its warning-panel message."""
    raw = store.get(guild_id, HONEYPOT_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    channel_id = raw.get("channel_id")
    if not isinstance(channel_id, int) or isinstance(channel_id, bool):
        channel_id = None

    message_id = raw.get("message_id")
    if not isinstance(message_id, int) or isinstance(message_id, bool):
        message_id = None

    enabled = raw.get("enabled") if isinstance(raw.get("enabled"), bool) else bool(channel_id)

    return {"enabled": enabled, "channel_id": channel_id, "message_id": message_id}


class HoneypotPanelView(discord.ui.LayoutView):
    """The intentionally visible warning shown in the honeypot channel."""

    def __init__(self):
        super().__init__(timeout=None)
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(
                    """## ⚠️ 警告
このチャンネルはハニーポットです。
ここにメッセージを送信すると、自動的にサーバーからキックされ、メッセージも削除されます。"""
                ),
                accent_colour=0xFFFFFF,
            )
        )


class HoneypotChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "HoneypotSettingsView"):
        self.parent_view = parent
        super().__init__(
            placeholder="ハニーポットにするテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                "この設定にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        await interaction.response.defer()

        try:
            channel = self.values[0]
            old = self.parent_view.settings

            if old.get("channel_id") and old.get("message_id") and old["channel_id"] != channel.id:
                old_channel = self.parent_view.cog.bot.get_channel(old["channel_id"])
                if old_channel is not None:
                    try:
                        await (await old_channel.fetch_message(old["message_id"])).delete()
                    except discord.NotFound:
                        pass
                    except (discord.Forbidden, discord.HTTPException):
                        logger.warning(
                            "旧ハニーポット警告パネルを削除できません (guild=%s)",
                            interaction.guild_id,
                        )

            await guild_settings.get_store().update(
                interaction.guild_id,
                HONEYPOT_SECTION,
                channel_id=channel.id,
                message_id=None,
                enabled=True,
            )

            self.parent_view.settings.update(
                {"channel_id": channel.id, "message_id": None, "enabled": True}
            )

            await self.parent_view.cog.send_honeypot_panel(interaction.guild, force=True)
            await self.parent_view.refresh(
                interaction,
                "ハニーポットを有効にし、警告パネルを設置しました。",
            )
        except Exception:
            logger.exception("ハニーポットの設置に失敗しました")
            await interaction.followup.send(
                "ハニーポットの設置に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )


class HoneypotSettingsView(discord.ui.View):
    def __init__(self, cog: "SupportCog", settings: dict):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.add_item(HoneypotChannelSelect(self))

    @staticmethod
    def can_manage(interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        )

    def embed(self, notice: str | None = None) -> discord.Embed:
        if notice is None:
            notice = getattr(self, "notice", None)

        channel_id = self.settings.get("channel_id")

        description = (
            f"状態: **{'オン' if self.settings.get('enabled') else 'オフ'}**\n"
            f"設置先: {f'<#{channel_id}>' if channel_id else '未設定'}\n\n"
            "選択したチャンネルに警告パネルを設置します。ユーザーが投稿すると、"
            "その投稿を削除して対象ユーザーをソフトバン（7日分のメッセージ削除後に解除）します。"
        )

        if notice:
            description = f"{notice}\n\n{description}"

        return discord.Embed(title="ハニーポットの設定", description=description, color=0xFFFFFF)

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = get_honeypot_settings(store, interaction.guild_id)
        self.notice = notice
        await edit_panel_v2(interaction, as_panel_v2(self))


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


class RoleBulkConfirmView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        role: discord.Role,
        adding: bool,
        target_mode: str = "humans",
    ):
        super().__init__(timeout=60)
        self.cog = cog
        self.role = role
        self.adding = adding
        self.target_mode = target_mode

    def embed(self):
        action = "付与" if self.adding else "剥奪"
        target_label = {"humans": "人間のみ", "all": "人間＋BOT", "bots": "BOTのみ"}[self.target_mode]

        return discord.Embed(
            title=f"ロール一括{action}の確認",
            description=(
                f"{self.role.mention} をサーバーのメンバーに{action}します。\n"
                f"対象アカウント: **{target_label}**\n"
                "この操作は取り消せません。"
            ),
            color=0xE74C3C,
        )

    @discord.ui.button(label="実行", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.defer(ephemeral=True)

        affected, skipped, failed = await self.cog.bulk_role_update(
            interaction.guild,
            self.role,
            self.adding,
            target_mode=self.target_mode,
        )

        action = "付与" if self.adding else "剥奪"
        target_label = {"humans": "人間のみ", "all": "人間＋BOT", "bots": "BOTのみ"}[self.target_mode]

        await interaction.followup.send(
            view=as_embed_v2(
                discord.Embed(
                    title=f"ロール一括{action} 完了",
                    description=(
                        f"対象ロール: {self.role.mention}\n"
                        f"対象アカウント: **{target_label}**\n"
                        f"{action}: **{affected}人**\n"
                        f"対象外: **{skipped}人**\n"
                        f"失敗: **{failed}人**"
                    ),
                    color=0x2ECC71 if failed == 0 else 0xE67E22,
                )
            ),
            ephemeral=True,
        )
        self.stop()

    @discord.ui.button(label="キャンセル", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, button: discord.ui.Button):
        await edit_panel_v2(
            interaction,
            as_embed_v2(discord.Embed(description="キャンセルしました。", color=0x95A5A6)),
        )
        self.stop()


class RoleBulkView(discord.ui.View):
    def __init__(self, cog: "SupportCog", guild: discord.Guild, role: discord.Role | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.guild = guild
        self.role = role
        self.target_mode = "humans"

        self.add_item(RoleBulkSelect(self))
        self.add_item(RoleTargetSelect(self))

    def description(self) -> str:
        selected = self.role.mention if self.role else "未選択"
        return (
            f"対象ロール: {selected}\n"
            f"対象アカウント: **{self.target_label()}**\n"
            "下のボタンから付与・剥奪を選びます。"
        )

    def embed(self):
        return discord.Embed(
            title="一括ロール操作",
            description=self.description(),
            color=0x3498DB,
        )

    def target_label(self) -> str:
        return {"humans": "人間のみ", "all": "人間＋BOT", "bots": "BOTのみ"}[self.target_mode]

    def role_error(self) -> str | None:
        """Return a user-facing reason why the selected role cannot be changed."""
        if self.role is None:
            return "先に対象ロールを選択してください。"

        if self.role.is_default():
            return "@everyone ロールは操作できません。"

        if getattr(self.role, "managed", False):
            return "連携サービスが管理するロールは操作できません。"

        me = getattr(self.guild, "me", None)
        permissions = getattr(getattr(me, "guild_permissions", None), "manage_roles", False)
        if me is None or not permissions:
            return "Botに「ロールの管理」権限がありません。"

        if self.role >= me.top_role:
            return "Botより上位、または同順位のロールは操作できません。"

        return None

    async def choose_action(self, interaction: discord.Interaction, adding: bool):
        if error := self.role_error():
            return await interaction.response.send_message(error, ephemeral=True)

        action = "付与" if adding else "剥奪"
        confirm = RoleBulkConfirmView(self.cog, self.role, adding, self.target_mode)
        await interaction.response.send_message(view=as_panel_v2(confirm), ephemeral=True)

    @discord.ui.button(label="付与", style=discord.ButtonStyle.success, row=2)
    async def add_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.choose_action(interaction, True)

    @discord.ui.button(label="剥奪", style=discord.ButtonStyle.danger, row=2)
    async def remove_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.choose_action(interaction, False)


class RoleTargetSelect(discord.ui.Select):
    def __init__(self, parent: RoleBulkView):
        self.parent_view = parent
        super().__init__(
            placeholder="対象アカウントを選択",
            min_values=1,
            max_values=1,
            row=1,
            options=[
                discord.SelectOption(label="人間のみ", value="humans", default=True),
                discord.SelectOption(label="人間＋BOT", value="all"),
                discord.SelectOption(label="BOTのみ", value="bots"),
            ],
        )

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.target_mode = self.values[0]

        owner = getattr(self, "view", None)
        if hasattr(owner, "_sync"):
            owner._sync()
            return await edit_panel_v2(interaction, owner)

        return await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class RoleBulkSelect(discord.ui.RoleSelect):
    def __init__(self, parent: RoleBulkView):
        self.parent_view = parent
        super().__init__(placeholder="対象ロールを選択", row=0)

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.role = self.values[0]

        if error := self.parent_view.role_error():
            self.parent_view.role = None
            return await interaction.response.send_message(error, ephemeral=True)

        owner = getattr(self, "view", None)
        if hasattr(owner, "_sync"):
            owner._sync()
            return await edit_panel_v2(interaction, owner)

        return await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class SupportClearModal(discord.ui.Modal, title="メッセージ削除"):
    amount = discord.ui.TextInput(
        label=f"削除する件数（1〜{MAX_CLEAR}）",
        placeholder="例: 10",
        max_length=3,
    )

    def __init__(self, cog: "SupportCog"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        try:
            count = int(self.amount.value)
        except ValueError:
            return await interaction.response.send_message(
                "件数は整数で入力してください。",
                ephemeral=True,
            )

        if not 1 <= count <= MAX_CLEAR:
            return await interaction.response.send_message(
                f"件数は1〜{MAX_CLEAR}で指定してください。",
                ephemeral=True,
            )

        cog = self.cog.bot.get_cog("ClearCog")
        if cog is None:
            return await self.cog._missing(interaction, "メッセージ削除")

        await cog.clear(interaction, count, None)


class GiveawayModal(discord.ui.Modal, title="抽選を作成"):
    prize = discord.ui.TextInput(label="賞品", max_length=200)
    winners = discord.ui.TextInput(label="当選人数", default="1", max_length=2)
    minutes = discord.ui.TextInput(label="締切までの分数", default="60", max_length=5)

    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )

        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (
            getattr(permissions, "manage_guild", False)
            or getattr(permissions, "administrator", False)
        ):
            return await interaction.response.send_message(
                "抽選の作成にはサーバー管理権限が必要です。",
                ephemeral=True,
            )

        try:
            winners = int(self.winners.value)
            minutes = int(self.minutes.value)
        except ValueError:
            return await interaction.response.send_message(
                "当選人数と分数は整数で入力してください。",
                ephemeral=True,
            )

        giveaway = self.cog.bot.get_cog("GiveawayCog")
        if giveaway is None:
            return await self.cog._missing(interaction, "giveaway")

        await giveaway.giveaway(
            interaction,
            self.prize.value,
            winners,
            minutes,
            None,
            None,
            0,
            None,
            None,
        )


class SupportGenreSelect(discord.ui.Select):
    def __init__(self, cog: "SupportCog", selected: str | None = None):
        self.cog = cog
        super().__init__(
            placeholder="ジャンルを選択してください",
            options=[
                discord.SelectOption(
                    label=label,
                    description=description,
                    value=value,
                    default=value == selected,
                )
                for value, (label, description) in SUPPORT_GENRES.items()
            ],
            row=0,
        )

    async def callback(self, interaction: discord.Interaction):
        container = self.view
        view: SupportPanelView = getattr(container, "panel", container)

        await interaction.response.defer()

        try:
            view.genre = self.values[0]
            view.action = None
            view.refresh()

            if hasattr(container, "_sync"):
                container._sync()
                await edit_panel_v2(interaction, container)
            else:
                await edit_panel_v2(interaction, as_panel_v2(view))
        except Exception:
            logger.exception("サポート操作パネルのジャンル更新に失敗しました")
            try:
                await interaction.followup.send(
                    "ジャンルの更新に失敗しました。Botのログを確認してください。",
                    ephemeral=True,
                )
            except discord.HTTPException:
                logger.exception("ジャンル更新エラーの通知にも失敗しました")


class SupportActionSelect(discord.ui.Select):
    def __init__(self, cog: "SupportCog", genre: str):
        self.cog = cog
        super().__init__(
            placeholder="機能を選択してください",
            options=[
                discord.SelectOption(label=label, value=value)
                for label, value in SUPPORT_ACTIONS_BY_GENRE[genre]
            ],
            row=1,
        )

    async def callback(self, interaction: discord.Interaction):
        value = self.values[0]

        container = self.view
        panel = getattr(container, "panel", container)
        panel.action = value

        if getattr(panel, "shortcut_mode", False):
            if hasattr(container, "_sync"):
                container._sync()
                return await edit_panel_v2(interaction, container)
            return await edit_panel_v2(interaction, as_panel_v2(panel))

        await self.cog.dispatch(interaction, value)


class SupportPanelView(discord.ui.View):
    def __init__(
        self,
        cog: "SupportCog",
        genre: str | None = None,
        shortcut_mode: bool = False,
        shortcut_item: dict | None = None,
    ):
        super().__init__(timeout=300)
        self.cog = cog

        saved = (shortcut_item or {}).get("action", {})
        self.genre = genre or saved.get("genre")
        self.action = saved.get("value")
        self.shortcut_mode = shortcut_mode
        self.shortcut_item = shortcut_item

        self.refresh()

    def refresh(self):
        self.clear_items()
        self.add_item(SupportGenreSelect(self.cog, self.genre))

        if self.genre:
            self.add_item(SupportActionSelect(self.cog, self.genre))

        if self.shortcut_mode:
            from cogs.general import ShortcutCommitButton
            self.add_item(ShortcutCommitButton())

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "support", "genre": self.genre, "value": self.action}

    def embed(self):
        description = "ジャンルを選ぶと、その中の機能を選択できます。"

        if self.genre:
            description = f"**{SUPPORT_GENRES[self.genre][0]}** の機能を選択してください。"

        return discord.Embed(title="サポート操作", description=description, color=0xFFFFFF)


class AutoReactChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent_view):
        self.parent_view = parent_view
        super().__init__(
            placeholder="Auto reactを設定するチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message("この設定にはサーバー管理権限が必要です。", ephemeral=True)
        self.parent_view.channel_id = self.values[0].id
        await self.parent_view.refresh(interaction)


class AutoReactModal(discord.ui.Modal, title="Auto reactの絵文字"):
    emojis = discord.ui.TextInput(
        label="自動で付ける絵文字（改行またはカンマ区切り・空欄で解除）",
        placeholder="🎉, <:custom:123456789012345678>",
        max_length=500,
        required=False,
        style=discord.TextStyle.paragraph,
    )

    def __init__(self, parent_view):
        super().__init__()
        self.parent_view = parent_view

    async def on_submit(self, interaction: discord.Interaction):
        await self.parent_view.save(interaction, self.emojis.value)


class AutoReactSettingsView(discord.ui.View):
    def __init__(self, settings: dict):
        super().__init__(timeout=300)
        self.settings = settings
        self.channel_id = None
        self.add_item(AutoReactChannelSelect(self))

    @staticmethod
    def can_manage(interaction):
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(getattr(permissions, "manage_guild", False) or getattr(permissions, "administrator", False))

    def embed(self):
        rows = self.settings.get("channels", {})
        lines = [f"<#{channel_id}>: {' '.join(emojis)}" for channel_id, emojis in rows.items()]
        return discord.Embed(
            title="Auto react設定",
            description=("メッセージ受信時に自動で付ける絵文字をチャンネルごとに設定します。\n"
                         "複数の絵文字は改行またはカンマで区切ってください。空欄で選択チャンネルの設定を解除します。\n\n"
                         + ("\n".join(lines) if lines else "設定済みチャンネルはありません。")),
            color=0xFFFFFF,
        )

    async def refresh(self, interaction):
        await edit_panel_v2(interaction, as_panel_v2(self))

    @discord.ui.button(label="選択チャンネルの絵文字を設定", style=discord.ButtonStyle.primary, row=1)
    async def configure(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.can_manage(interaction):
            return await interaction.response.send_message("この設定にはサーバー管理権限が必要です。", ephemeral=True)
        if self.channel_id is None:
            return await interaction.response.send_message("先にチャンネルを選択してください。", ephemeral=True)
        await interaction.response.send_modal(AutoReactModal(self))

    async def save(self, interaction, text):
        if not self.can_manage(interaction):
            return await interaction.response.send_message("この設定にはサーバー管理権限が必要です。", ephemeral=True)
        raw_emojis = [value.strip() for value in str(text or "").replace("\n", ",").split(",") if value.strip()]
        if len(raw_emojis) > 20:
            return await interaction.response.send_message("絵文字は1チャンネルにつき20個までです。", ephemeral=True)
        try:
            emojis = [str(normalize_binjou_emoji(value)) for value in raw_emojis]
        except ValueError as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        rows = dict(self.settings.get("channels", {}))
        if emojis:
            rows[str(self.channel_id)] = list(dict.fromkeys(emojis))
        else:
            rows.pop(str(self.channel_id), None)
        try:
            await guild_settings.get_store().update(interaction.guild_id, AUTO_REACT_SECTION, channels=rows)
            self.settings["channels"] = rows
            await interaction.response.send_message("Auto react設定を更新しました。", ephemeral=True)
        except Exception:
            logger.exception("Auto react設定の保存に失敗しました")
            await interaction.response.send_message("設定の保存に失敗しました。", ephemeral=True)


class SupportCog(commands.Cog):
    SUPPORT_REQUIRED_PERMISSIONS = {
        "muted": "manage_roles",
        "whisper": "manage_channels",
        "sticky": "manage_guild",
        "clear": "manage_messages",
        "role_bulk": "manage_roles",
        "binjou": "manage_guild",
        "auto_react": "manage_guild",
        "giveaway": "manage_guild",
        "vc_log": "manage_guild",
        "message_log": "manage_guild",
        "moderation_log": "manage_guild",
        "honeypot": "manage_guild",
        "ticket": "manage_guild",
        "auth_panel": "administrator",
        "role_panel": "administrator",
    }

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._sticky_locks: dict[int, asyncio.Lock] = {}
        self._panel_pending: set[int] = set()

    @staticmethod
    def has_support_permission(interaction: discord.Interaction, permission: str) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        return bool(
            getattr(permissions, "administrator", False)
            or getattr(permissions, permission, False)
        )

    async def check_support_permission(self, interaction: discord.Interaction, selected: str) -> bool:
        permission = self.SUPPORT_REQUIRED_PERMISSIONS.get(selected)

        if permission is None or self.has_support_permission(interaction, permission):
            return True

        labels = {
            "manage_guild": "サーバーの管理",
            "manage_roles": "ロールの管理",
            "manage_channels": "チャンネルの管理",
            "manage_messages": "メッセージの管理",
            "administrator": "管理者",
        }

        await interaction.response.send_message(
            f"この機能を使うには「{labels.get(permission, permission)}」権限が必要です。",
            ephemeral=True,
        )
        return False

    async def show_auth_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )

        if not can_manage_auth_panel(interaction):
            return await interaction.response.send_message(
                "この機能は管理者のみ利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_auth_settings(store, interaction.guild.id)

        view = AuthPanelSettingsView(self, settings)
        await interaction.response.send_message(
            view=as_panel_v2(view),
            ephemeral=True,
        )

    async def show_role_panel_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )

        if not can_manage_role_panel(interaction):
            return await interaction.response.send_message(
                "この機能は管理者のみ利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_role_panel_settings(store, interaction.guild.id)

        view = RolePanelSettingsView(self, settings, interaction.guild)
        await interaction.response.send_message(
            view=as_panel_v2(view),
            ephemeral=True,
        )

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return

        custom_id = interaction.data.get("custom_id", "")

        if custom_id == "auth_panel:start":
            await self.handle_auth_start(interaction)
            return

        if custom_id == "role_panel:assign":
            values = interaction.data.get("values") or []
            if not values:
                return

            try:
                role_id = int(values[0])
            except (TypeError, ValueError):
                return

            await self.handle_role_panel_assign(interaction, role_id)

    async def handle_role_panel_assign(self, interaction: discord.Interaction, role_id: int):
        if interaction.guild is None:
            return

        if interaction.response.is_done():
            return

        pending = getattr(self, "_panel_pending", None)
        if pending is None:
            self._panel_pending = set()
            pending = self._panel_pending

        if interaction.id in pending:
            return

        pending.add(interaction.id)

        try:
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_role_panel_settings(store, interaction.guild.id)

            if not settings["enabled"]:
                return await interaction.response.send_message(
                    "現在、このサーバーではロールパネルを停止しています。",
                    ephemeral=True,
                )

            if role_id not in settings["roles"]:
                return await interaction.response.send_message(
                    "このロールは現在選択できません。",
                    ephemeral=True,
                )

            role = interaction.guild.get_role(role_id)
            if role is None:
                return await interaction.response.send_message(
                    "ロールが見つかりません。",
                    ephemeral=True,
                )

            has_role = role in getattr(interaction.user, "roles", [])

            if has_role:
                if error := assignable_role_error(interaction.guild, role, "解除"):
                    return await interaction.response.send_message(error, ephemeral=True)

                await interaction.response.defer(ephemeral=True, thinking=True)

                if await self._remove_role(interaction, role, "ロールパネル"):
                    await interaction.followup.send(
                        f"{role.mention} を解除しました。",
                        ephemeral=True,
                    )
            else:
                if error := assignable_role_error(interaction.guild, role, "付与"):
                    return await interaction.response.send_message(error, ephemeral=True)

                await interaction.response.defer(ephemeral=True, thinking=True)

                if await self._add_role(interaction, role, "ロールパネル"):
                    await interaction.followup.send(
                        f"{role.mention} を付与しました。",
                        ephemeral=True,
                    )
        finally:
            pending.discard(interaction.id)

    async def handle_auth_start(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return

        if interaction.response.is_done():
            return

        pending = getattr(self, "_panel_pending", None)
        if pending is None:
            self._panel_pending = set()
            pending = self._panel_pending

        if interaction.id in pending:
            return

        pending.add(interaction.id)

        try:
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_auth_settings(store, interaction.guild.id)

            if not settings["enabled"]:
                return await interaction.response.send_message(
                    "現在、このサーバーでは認証を停止しています。",
                    ephemeral=True,
                )

            role = (
                interaction.guild.get_role(settings["role_id"])
                if settings["role_id"]
                else None
            )
            if role is None:
                return await interaction.response.send_message(
                    "認証ロールが見つかりません。サーバー管理者に連絡してください。",
                    ephemeral=True,
                )

            if role in getattr(interaction.user, "roles", []):
                return await interaction.response.send_message(
                    "あなたはすでに認証済みです。",
                    ephemeral=True,
                )

            if settings["mode"] == AUTH_MODE_SIMPLE:
                await interaction.response.defer(ephemeral=True, thinking=True)

                if await self._add_role(interaction, role, "認証パネル"):
                    await interaction.followup.send(
                        "認証が完了しました。ロールを付与しました。",
                        ephemeral=True,
                    )
                return

            questions = settings["questions"][:AUTH_MAX_QUESTIONS]
            if not questions:
                return await interaction.response.send_message(
                    "認証フォームの質問が設定されていません。",
                    ephemeral=True,
                )

            modal = AuthFormModal(
                self,
                role.id,
                settings["intro_channel_id"],
                questions,
            )
            await interaction.response.send_modal(modal)
        finally:
            pending.discard(interaction.id)

    async def _add_role(self, interaction: discord.Interaction, role: discord.Role, reason: str) -> bool:
        try:
            await interaction.user.add_roles(role, reason=reason)
            return True
        except discord.Forbidden:
            await interaction.followup.send(
                f"ロールを付けられませんでした。\n理由: {role_failure_reason(interaction.guild, role)}",
                ephemeral=True,
            )
            return False
        except discord.HTTPException:
            logger.exception("ロールの付与に失敗しました")
            await interaction.followup.send(
                "Discordとの通信に失敗しました。少し待ってからもう一度試してください。",
                ephemeral=True,
            )
            return False

    async def _remove_role(self, interaction: discord.Interaction, role: discord.Role, reason: str) -> bool:
        try:
            await interaction.user.remove_roles(role, reason=reason)
            return True
        except discord.Forbidden:
            await interaction.followup.send(
                f"ロールを解除できませんでした。\n理由: {role_failure_reason(interaction.guild, role)}",
                ephemeral=True,
            )
            return False
        except discord.HTTPException:
            logger.exception("ロールの解除に失敗しました")
            await interaction.followup.send(
                "Discordとの通信に失敗しました。少し待ってからもう一度試してください。",
                ephemeral=True,
            )
            return False

    async def finish_auth_form(
        self,
        interaction: discord.Interaction,
        role_id: int | None,
        intro_channel_id: int | None,
        answers: list[tuple[dict, str]],
    ):
        if interaction.guild is None:
            return

        role = interaction.guild.get_role(role_id) if role_id else None
        if role is None:
            return await interaction.followup.send(
                "認証ロールが見つかりません。サーバー管理者に連絡してください。",
                ephemeral=True,
            )

        if role in getattr(interaction.user, "roles", []):
            return await interaction.followup.send(
                "あなたはすでに認証済みです。",
                ephemeral=True,
            )

        if error := assignable_role_error(interaction.guild, role):
            return await interaction.followup.send(error, ephemeral=True)

        if not await self._add_role(interaction, role, "認証パネル"):
            return

        intro_channel = (
            interaction.guild.get_channel(intro_channel_id)
            if intro_channel_id
            else None
        )

        if intro_channel is not None:
            content_parts: list[str] = []
            for q, value in answers:
                content_parts.append(
                    f"【{q.get('label', '質問')}】\n{value or '(未入力)'}"
                )

            content = "\n\n".join(content_parts)

            try:
                webhook = await get_intro_webhook(intro_channel, interaction.client.user.id)
                await webhook.send(
                    content=content,
                    username=sanitize_webhook_name(interaction.user.display_name),
                    avatar_url=interaction.user.display_avatar.url,
                    allowed_mentions=discord.AllowedMentions.none(),
                )
            except discord.HTTPException:
                logger.exception("自己紹介の投稿に失敗しました（ロール付与は完了）")

        await interaction.followup.send(
            "認証が完了しました。ロールを付与しました。",
            ephemeral=True,
        )

    async def show_activity_log_settings(
        self,
        interaction: discord.Interaction,
        section: str,
        title: str,
        description: str,
    ):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_activity_log_settings(store, interaction.guild_id, section)

        view = ActivityLogSettingsView(self, section, title, description, settings)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def _activity_target(self, guild: discord.Guild, section: str):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_activity_log_settings(store, guild.id, section)

        if not settings["enabled"] or settings["channel_id"] is None:
            return None

        target = self.bot.get_channel(settings["channel_id"])
        if target is None:
            try:
                target = await self.bot.fetch_channel(settings["channel_id"])
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "履歴の送信先を取得できません (guild=%s section=%s)",
                    guild.id,
                    section,
                )
                return None

        if getattr(getattr(target, "guild", None), "id", guild.id) != guild.id:
            logger.warning(
                "履歴の送信先が別サーバーです (guild=%s section=%s)",
                guild.id,
                section,
            )
            return None

        return target

    async def _moderation_action_enabled(self, guild: discord.Guild, action: str) -> bool:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_activity_log_settings(store, guild.id, MODERATION_LOG_SECTION)
        return bool(settings["enabled"] and settings.get(f"{action}_enabled", False))

    async def _send_activity(self, guild: discord.Guild, section: str, embed: discord.Embed):
        target = await self._activity_target(guild, section)
        if target is None:
            return

        try:
            await target.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            logger.exception("履歴を送信できません (guild=%s section=%s)", guild.id, section)

    @staticmethod
    def _clip(value, limit=1024):
        text = str(value or "(内容なし)")
        return text if len(text) <= limit else text[:limit - 1] + "…"

    @staticmethod
    def message_edit_embed(before: discord.Message, after: discord.Message) -> discord.Embed:
        embed = discord.Embed(
            title="メッセージ編集",
            color=0xF1C40F,
            timestamp=discord.utils.utcnow(),
        )
        embed.set_author(
            name=before.author.display_name,
            icon_url=before.author.display_avatar.url,
        )
        embed.add_field(
            name="ユーザー",
            value=f"{before.author.mention} (`{before.author.id}`)",
            inline=False,
        )
        embed.add_field(
            name="チャンネル",
            value=f"{before.channel.mention} (`{before.channel.id}`)",
            inline=False,
        )
        embed.add_field(name="編集前", value=self_clip(before.content), inline=False)
        embed.add_field(name="編集後", value=self_clip(after.content), inline=False)
        embed.add_field(
            name="メッセージ",
            value=f"[元のメッセージへ]({after.jump_url})",
            inline=False,
        )
        return embed

    async def _recent_audit_entry(self, guild: discord.Guild, action, target_id: int):
        try:
            async for entry in guild.audit_logs(limit=10, action=action):
                if getattr(getattr(entry, "target", None), "id", None) == target_id:
                    age = (discord.utils.utcnow() - entry.created_at).total_seconds()
                    if -5 <= age <= 60:
                        return entry
        except (discord.Forbidden, discord.HTTPException):
            logger.info("監査ログを取得できません (guild=%s action=%s)", guild.id, action)

        return None

    @staticmethod
    def moderation_embed(title: str, target, entry, detail: str) -> discord.Embed:
        executor = getattr(entry, "user", None) if entry else None
        reason = getattr(entry, "reason", None) if entry else None

        embed = discord.Embed(title=title, color=0xE74C3C, timestamp=discord.utils.utcnow())
        embed.add_field(name="対処したユーザー", value=mention_with_id(executor), inline=True)
        embed.add_field(name="適用されたユーザー", value=mention_with_id(target), inline=True)
        embed.add_field(name="対処詳細", value=SupportCog._clip(detail), inline=False)
        embed.add_field(name="理由", value=SupportCog._clip(reason or "理由なし"), inline=False)

        if executor is not None:
            avatar = getattr(getattr(executor, "display_avatar", None), "url", None)
            embed.set_author(
                name=getattr(executor, "display_name", str(executor)),
                icon_url=avatar,
            )

        return embed

    @commands.Cog.listener()
    async def on_message_edit(self, before: discord.Message, after: discord.Message):
        if before.guild is None or before.author.bot or before.content == after.content:
            return

        await self._send_activity(
            before.guild,
            MESSAGE_LOG_SECTION,
            self.message_edit_embed(before, after),
        )

    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member, after: discord.Member):
        old_until = getattr(before, "timed_out_until", None)
        if old_until is None:
            old_until = getattr(before, "communication_disabled_until", None)

        new_until = getattr(after, "timed_out_until", None)
        if new_until is None:
            new_until = getattr(after, "communication_disabled_until", None)

        if before.guild is None or old_until == new_until:
            return

        if not await self._moderation_action_enabled(before.guild, "timeout"):
            return

        entry = await self._recent_audit_entry(
            before.guild,
            discord.AuditLogAction.member_update,
            after.id,
        )

        if new_until is not None:
            detail = f"タイムアウト期限: {new_until.isoformat()}"
            title = "タイムアウト（TO）"
        else:
            detail = "タイムアウト解除"
            title = "タイムアウト解除（TO）"

        await self._send_activity(
            before.guild,
            MODERATION_LOG_SECTION,
            self.moderation_embed(title, after, entry, detail),
        )

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member):
        if member.guild is None or member.bot:
            return

        if not await self._moderation_action_enabled(member.guild, "kick"):
            return

        ban_entry = await self._recent_audit_entry(
            member.guild,
            discord.AuditLogAction.ban,
            member.id,
        )
        if ban_entry is not None:
            return

        entry = await self._recent_audit_entry(
            member.guild,
            discord.AuditLogAction.kick,
            member.id,
        )
        if entry is not None:
            await self._send_activity(
                member.guild,
                MODERATION_LOG_SECTION,
                self.moderation_embed("KICK", member, entry, "サーバーからキック"),
            )

    @commands.Cog.listener()
    async def on_member_ban(self, guild: discord.Guild, user: discord.User):
        if not await self._moderation_action_enabled(guild, "ban"):
            return

        entry = await self._recent_audit_entry(guild, discord.AuditLogAction.ban, user.id)
        await self._send_activity(
            guild,
            MODERATION_LOG_SECTION,
            self.moderation_embed("BAN", user, entry, "サーバーからBAN"),
        )

    async def show_vc_log_settings(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_vc_log_settings(store, interaction.guild_id)

        view = VCLogSettingsView(self, settings)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def show_sticky_settings(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_sticky_settings(store, interaction.guild_id)

        view = StickySettingsView(self, settings)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def show_honeypot_settings(self, interaction: discord.Interaction):
        if interaction.guild_id is None:
            return await interaction.response.send_message(
                "この設定はサーバー内で利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_honeypot_settings(store, interaction.guild_id)

        await interaction.response.send_message(
            view=as_panel_v2(HoneypotSettingsView(self, settings)),
            ephemeral=True,
        )

    async def _honeypot_channel(self, guild: discord.Guild, channel_id: int):
        target = self.bot.get_channel(channel_id)
        if target is None:
            try:
                target = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "ハニーポットチャンネルを取得できません (guild=%s channel=%s)",
                    guild.id,
                    channel_id,
                )
                return None

        if getattr(getattr(target, "guild", None), "id", guild.id) != guild.id:
            logger.warning(
                "ハニーポットチャンネルが別サーバーです (guild=%s channel=%s)",
                guild.id,
                channel_id,
            )
            return None

        return target

    async def send_honeypot_panel(self, guild: discord.Guild, *, force: bool = False):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_honeypot_settings(store, guild.id)

        if not settings["enabled"] or settings["channel_id"] is None:
            return None

        target = await self._honeypot_channel(guild, settings["channel_id"])
        if target is None:
            return None

        old_id = settings.get("message_id")
        if old_id:
            try:
                await (await target.fetch_message(old_id)).delete()
            except discord.NotFound:
                pass
            except (discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "ハニーポット警告パネルを削除できません (guild=%s message=%s)",
                    guild.id,
                    old_id,
                )

        try:
            panel = await target.send(view=HoneypotPanelView())
        except (discord.Forbidden, discord.HTTPException):
            logger.exception(
                "ハニーポット警告パネルを送信できません (guild=%s channel=%s)",
                guild.id,
                target.id,
            )
            return None

        await store.update(guild.id, HONEYPOT_SECTION, message_id=panel.id)
        return panel

    async def _handle_honeypot_message(self, message: discord.Message) -> bool:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_honeypot_settings(store, message.guild.id)

        if not settings["enabled"] or settings["channel_id"] != message.channel.id:
            return False

        author = message.author
        if getattr(author, "bot", False):
            return False

        permissions = getattr(author, "guild_permissions", None)
        if any(
            getattr(permissions, name, False)
            for name in ("administrator", "manage_guild", "ban_members")
        ):
            return False

        try:
            await message.delete()
        except (discord.NotFound, discord.Forbidden, discord.HTTPException):
            logger.warning(
                "ハニーポット投稿を削除できません (guild=%s message=%s)",
                message.guild.id,
                message.id,
            )

        try:
            await message.guild.ban(
                author,
                delete_message_days=7,
                reason="ハニーポットチャンネルへの投稿",
            )
            await message.guild.unban(author, reason="ハニーポットによる一時BAN解除")
        except (discord.Forbidden, discord.HTTPException):
            logger.exception(
                "ハニーポット対象者のソフトバンに失敗しました (guild=%s user=%s)",
                message.guild.id,
                author.id,
            )

        return True

    async def _sticky_channel(self, guild: discord.Guild, channel_id: int):
        target = self.bot.get_channel(channel_id)
        if target is None:
            try:
                target = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "Stickyパネルの送信先を取得できません (guild=%s channel=%s)",
                    guild.id,
                    channel_id,
                )
                return None

        if getattr(getattr(target, "guild", None), "id", guild.id) != guild.id:
            logger.warning(
                "Stickyパネルの送信先が別サーバーです (guild=%s channel=%s)",
                guild.id,
                channel_id,
            )
            return None

        return target

    async def send_sticky_panel(self, guild: discord.Guild, *, force: bool = False):
        """現在のStickyパネルを削除して、設定された文言を同じチャンネルへ送る。"""
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_sticky_settings(store, guild.id)

        if not settings["enabled"] or settings["channel_id"] is None or not settings["content"]:
            return None

        lock = self._sticky_locks.setdefault(guild.id, asyncio.Lock())
        async with lock:
            settings = get_sticky_settings(store, guild.id)
            if not settings["enabled"] or settings["channel_id"] is None or not settings["content"]:
                return None

            target = await self._sticky_channel(guild, settings["channel_id"])
            if target is None:
                return None

            old_id = settings.get("message_id")
            if old_id:
                try:
                    old_message = await target.fetch_message(old_id)
                    await old_message.delete()
                except discord.NotFound:
                    pass
                except (discord.Forbidden, discord.HTTPException):
                    logger.warning(
                        "Stickyパネルを削除できません (guild=%s message=%s)",
                        guild.id,
                        old_id,
                    )

            try:
                panel = await target.send(settings["content"])
            except (discord.Forbidden, discord.HTTPException):
                logger.exception(
                    "Stickyパネルを送信できません (guild=%s channel=%s)",
                    guild.id,
                    target.id,
                )
                return None

            await store.update(guild.id, STICKY_SECTION, message_id=panel.id)
            return panel

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.guild is None or getattr(message.author, "bot", False):
            return

        if await self._handle_honeypot_message(message):
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        auto_react = store.get(message.guild.id, AUTO_REACT_SECTION).get("channels", {})
        emojis = auto_react.get(str(message.channel.id), []) if isinstance(auto_react, dict) else []
        for emoji_value in emojis if isinstance(emojis, list) else []:
            try:
                await message.add_reaction(normalize_binjou_emoji(emoji_value))
            except (ValueError, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "Auto reactを追加できません (guild=%s channel=%s emoji=%s)",
                    message.guild.id,
                    message.channel.id,
                    emoji_value,
                )
        settings = get_sticky_settings(store, message.guild.id)

        if settings["enabled"] and settings["channel_id"] == message.channel.id:
            await self.send_sticky_panel(message.guild)

    @commands.Cog.listener()
    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ):
        if member.bot or member.guild is None:
            return

        old_channel = getattr(before, "channel", None)
        new_channel = getattr(after, "channel", None)

        old_id = getattr(old_channel, "id", None)
        new_id = getattr(new_channel, "id", None)

        if old_id == new_id:
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_vc_log_settings(store, member.guild.id)

        channel_id = settings["channel_id"]
        if not settings["enabled"] or channel_id is None:
            return

        target = self.bot.get_channel(channel_id)
        if target is None:
            try:
                target = await self.bot.fetch_channel(channel_id)
            except (discord.NotFound, discord.Forbidden, discord.HTTPException):
                logger.warning(
                    "VC入退室ログの送信先を取得できません (guild=%s channel=%s)",
                    member.guild.id,
                    channel_id,
                )
                return

        if getattr(getattr(target, "guild", None), "id", member.guild.id) != member.guild.id:
            logger.warning(
                "VC入退室ログの送信先が別サーバーです (guild=%s channel=%s)",
                member.guild.id,
                channel_id,
            )
            return

        try:
            if old_channel is not None:
                await target.send(embed=vc_log_embed(member, old_channel, joined=False))
            if new_channel is not None:
                await target.send(embed=vc_log_embed(member, new_channel, joined=True))
        except (discord.Forbidden, discord.HTTPException):
            logger.exception(
                "VC入退室ログを送信できません (guild=%s channel=%s)",
                member.guild.id,
                channel_id,
            )

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
        await interaction.response.send_message(
            f"{name}機能が読み込まれていません。",
            ephemeral=True,
        )

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

    async def bulk_role_update(
        self,
        guild: discord.Guild,
        role: discord.Role,
        adding: bool,
        *,
        target_mode: str = "humans",
    ):
        """指定した対象モード（人間のみ・人間＋BOT・BOTのみ）へロールを適用する。"""
        me = getattr(guild, "me", None)

        if (
            role is None
            or role.is_default()
            or getattr(role, "managed", False)
            or me is None
            or not getattr(getattr(me, "guild_permissions", None), "manage_roles", False)
            or role >= me.top_role
        ):
            return 0, 0, len(getattr(guild, "members", []))

        if target_mode not in {"humans", "all", "bots"}:
            target_mode = "humans"

        affected = skipped = failed = 0

        for member in guild.members:
            is_bot = bool(getattr(member, "bot", False))

            if (target_mode == "humans" and is_bot) or (target_mode == "bots" and not is_bot):
                skipped += 1
                continue

            has_role = role in getattr(member, "roles", [])
            if (adding and has_role) or (not adding and not has_role):
                skipped += 1
                continue

            try:
                if adding:
                    await member.add_roles(role, reason="/support 一括ロール付与")
                else:
                    await member.remove_roles(role, reason="/support 一括ロール剥奪")
                affected += 1
            except (discord.Forbidden, discord.HTTPException):
                failed += 1
            except Exception:
                failed += 1

        return affected, skipped, failed

    async def _role_bulk(self, interaction: discord.Interaction, role: discord.Role | None):
        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (
            getattr(permissions, "manage_roles", False)
            or getattr(permissions, "administrator", False)
        ):
            return await interaction.response.send_message(
                "この操作には「ロールの管理」権限が必要です。",
                ephemeral=True,
            )

        me = interaction.guild.me
        if me is None or not getattr(me.guild_permissions, "manage_roles", False):
            return await interaction.response.send_message(
                "Botに「ロールの管理」権限がありません。",
                ephemeral=True,
            )

        if role is not None and (
            role.is_default()
            or getattr(role, "managed", False)
            or role >= me.top_role
        ):
            return await interaction.response.send_message(
                "Botより上位のロール、または@everyoneは操作できません。",
                ephemeral=True,
            )

        view = RoleBulkView(self, interaction.guild, role)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    @app_commands.command(name="support", description="サポート機能の操作パネルを表示します")
    @app_commands.guild_only()
    async def support(self, interaction: discord.Interaction):
        view = SupportPanelView(self)
        await interaction.response.send_message(
            view=as_panel_v2(view),
            ephemeral=True,
        )

    async def dispatch(self, interaction: discord.Interaction, selected: str):
        if not await self.check_support_permission(interaction, selected):
            return

        if selected == "auth_panel":
            return await self.show_auth_settings(interaction)

        if selected == "role_panel":
            return await self.show_role_panel_settings(interaction)

        if selected == "sticky":
            return await self.show_sticky_settings(interaction)

        if selected == "honeypot":
            return await self.show_honeypot_settings(interaction)

        if selected == "ticket":
            cog = self.bot.get_cog("TicketCog")
            if cog is None:
                return await self._missing(interaction, "チケット")
            return await cog.show_settings(interaction)

        if selected == "giveaway":
            return await interaction.response.send_modal(GiveawayModal(self))

        if selected == "vc_log":
            return await self.show_vc_log_settings(interaction)

        if selected == "message_log":
            return await self.show_activity_log_settings(
                interaction,
                MESSAGE_LOG_SECTION,
                "メッセージ編集履歴の設定",
                "オンにすると、ユーザーのメッセージ編集前後をEmbedで記録します。",
            )

        if selected == "moderation_log":
            return await self.show_activity_log_settings(
                interaction,
                MODERATION_LOG_SECTION,
                "モデレート履歴の設定",
                "オンにすると、TO・KICK・BANの実行者、対象者、詳細をEmbedで記録します。",
            )

        if selected == "binjou":
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_binjou_settings(store, interaction.guild_id)

            view = EmojiBinjouView(self, settings)
            return await interaction.response.send_message(
                view=as_panel_v2(view),
                ephemeral=True,
            )

        if selected == "auto_react":
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = store.get(interaction.guild_id, AUTO_REACT_SECTION)
            view = AutoReactSettingsView(settings if isinstance(settings, dict) else {})
            return await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

        if selected == "role_bulk":
            return await self._role_bulk(interaction, None)

        if selected == "muted":
            cog = self.bot.get_cog("Muted")
            if cog is None:
                return await self._missing(interaction, "Muted")
            return await cog.muted_setting(interaction)

        if selected == "whisper":
            permissions = getattr(interaction, "permissions", None)
            if not getattr(permissions, "manage_channels", False):
                return await interaction.response.send_message(
                    "この操作には「チャンネルの管理」権限が必要です。",
                    ephemeral=True,
                )

            cog = self.bot.get_cog("WhisperCog")
            if cog is None:
                return await self._missing(interaction, "匿名つぶやき")

            return await cog.whisper(interaction)

        if selected == "clear":
            return await interaction.response.send_modal(SupportClearModal(self))

        cog = self.bot.get_cog("BumpRta")
        if cog is None:
            return await self._missing(interaction, "bump/up通知・RTA")

        bumprta_action = selected.removeprefix("bumprta_")
        return await cog.bumprta_command(
            interaction,
            app_commands.Choice(name=bumprta_action, value=bumprta_action),
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SupportCog(bot))
