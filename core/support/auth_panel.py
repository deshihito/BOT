# -*- coding: utf-8 -*-
"""認証パネル (Auth) の UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *


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

        from cogs.support import edit_auth_panel_message  # 循環インポート回避
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


class AuthSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

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
