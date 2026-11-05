# -*- coding: utf-8 -*-
"""ロールパネルとロール一括付与/剥奪の UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *


class RolePanelAssignSelect(discord.ui.Select):
    def __init__(self, options: list[discord.SelectOption]):
        super().__init__(
            placeholder="付与／解除するロールを選択",
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
        role_mentions: list[str] = []
        for role_id in role_ids[:ROLE_PANEL_MAX_ROLES]:
            role = guild.get_role(role_id)
            if role is None or role.is_default() or getattr(role, "managed", False):
                continue

            role_mentions.append(f"• {role.mention}")
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

        role_list = "\n".join(role_mentions) or "（付与・解除できるロールはありません）"
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(
                    f"""## ロールパネル
**このパネルで付与・解除できるロール:**
{role_list}

ドロップダウンからロールを選択してください。
まだ持っていないロールは付与され、すでに持っているロールは解除されます。"""
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
            await channel.send(
                view=RolePanelUserView(interaction.guild, valid_role_ids),
                # Show role mentions for readability without notifying those roles.
                allowed_mentions=discord.AllowedMentions.none(),
            )
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


class RoleSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

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
                logger.debug("一括ロール操作: メンバーへの適用に失敗しました", exc_info=True)
                failed += 1
            except Exception:
                logger.debug("一括ロール操作: メンバーへの適用に失敗しました", exc_info=True)
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
