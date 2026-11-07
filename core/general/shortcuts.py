# -*- coding: utf-8 -*-
"""ショートカット管理の UI と実行。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *
from .miq.miq import is_miq_trigger

def shortcut_vc_params(value: str, params: dict) -> dict:
    """vc ショートカットの params を ParamSpec で検証し、定義済みキーだけを返す。

    保存データが古い・壊れている場合でも実行自体は止めず、不正なキー・値は
    そのキーだけ落として実行する（落としたことはログに残す）。
    """
    if not params:
        return {}
    spec = action_registry.default_registry().get(f"vc:{value}")
    if spec is None or not spec.params:
        return {}
    cleaned: dict = {}
    for name, raw in params.items():
        try:
            cleaned.update(action_registry.validate_params(spec, {name: raw}))
        except ValueError:
            logger.warning("shortcut vc params dropped: %s.%s=%r", value, name, raw)
    return cleaned


class ShortcutNameModal(discord.ui.Modal, title="ショートカット名"):
    trigger = discord.ui.TextInput(
        label="メッセージで送るトリガー（空白なし）", max_length=80,
        placeholder="例: VC参加", required=True,
    )

    def __init__(self, cog: "GeneralCog", action: dict, item: dict | None = None,
                 params: dict | None = None):
        super().__init__()
        self.cog, self.action, self.item = cog, action, item
        # params はパラメータ設定ステップを経たときだけ渡される（None は変更しない）。
        self.params = params
        if item:
            self.trigger.default = item.get("trigger", "")

    async def on_submit(self, interaction: discord.Interaction):
        try:
            store = guild_settings.get_store()
            if self.item:
                await shortcuts.update(store, interaction.guild_id, interaction.user.id,
                                       self.item["id"], self.trigger.value, self.action,
                                       params=self.params)
                text = "ショートカットを編集しました。"
            else:
                await shortcuts.add(store, interaction.guild_id, interaction.user.id,
                                    self.trigger.value, self.action, params=self.params)
                text = "ショートカットを登録しました。"
        except (ValueError, KeyError) as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        await interaction.response.send_message(
            embed=discord.Embed(title=text, description=f"トリガー: `{self.trigger.value}`", color=0x2ECC71),
            ephemeral=True,
        )


class ShortcutParamSelect(discord.ui.Select):
    """choice / bool 型パラメータ1件の設定セレクト。"""

    def __init__(self, parent: "ShortcutParamsView", param, row: int):
        self.parent_view = parent
        self.param = param
        if param.type == "choice":
            options = [
                discord.SelectOption(label=str(label), value=str(value),
                                     default=parent.params.get(param.name) == value)
                for label, value in param.choices
            ]
        else:  # bool
            options = [
                discord.SelectOption(label="オン", value="true",
                                     default=parent.params.get(param.name) is True),
                discord.SelectOption(label="オフ", value="false",
                                     default=parent.params.get(param.name) is False),
            ]
        super().__init__(placeholder=f"{param.label}を選択", options=options, row=row)

    async def callback(self, interaction: discord.Interaction):
        raw = self.values[0]
        if self.param.type == "bool":
            value: object = raw == "true"
        else:
            value = next((v for _label, v in self.param.choices if str(v) == raw), raw)
        self.parent_view.params[self.param.name] = value
        self.parent_view.refresh()
        await interaction.response.edit_message(embed=self.parent_view.embed(), view=self.parent_view)


class ShortcutParamModal(discord.ui.Modal, title="パラメータ設定"):
    """int / number / text 型パラメータをまとめて入力するモーダル（最大5件）。"""

    def __init__(self, parent: "ShortcutParamsView"):
        super().__init__()
        self.parent_view = parent
        self.inputs: dict[str, discord.ui.TextInput] = {}
        for param in parent.modal_params[:5]:
            current = parent.params.get(param.name)
            item = discord.ui.TextInput(
                label=param.label[:45],
                required=False,
                default="" if current is None else str(current),
                placeholder=param.help or "未入力なら既定値のまま",
                style=(discord.TextStyle.paragraph if param.name == "lyrics"
                       else discord.TextStyle.short),
            )
            self.inputs[param.name] = item
            self.add_item(item)

    async def on_submit(self, interaction: discord.Interaction):
        view = self.parent_view
        by_name = {param.name: param for param in view.spec.params}
        errors: list[str] = []
        for name, item in self.inputs.items():
            param = by_name[name]
            raw = item.value.strip()
            if not raw:
                view.params.pop(name, None)
                continue
            try:
                if param.type == "int":
                    value: object = int(raw)
                elif param.type in {"number", "duration"}:
                    value = float(raw)
                else:
                    value = raw
                action_registry.validate_params(view.spec, {name: value})
            except ValueError as exc:
                errors.append(str(exc))
                continue
            view.params[name] = value
        if errors:
            return await interaction.response.send_message(
                "入力に誤りがあります:\n" + "\n".join(errors), ephemeral=True)
        view.refresh()
        await interaction.response.edit_message(embed=view.embed(), view=view)


class ShortcutParamInputButton(discord.ui.Button):
    def __init__(self, parent: "ShortcutParamsView", row: int):
        self.parent_view = parent
        super().__init__(label="数値・テキストを入力", style=discord.ButtonStyle.primary, row=row)

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.send_modal(ShortcutParamModal(self.parent_view))


class ShortcutParamsCommitButton(discord.ui.Button):
    def __init__(self, parent: "ShortcutParamsView"):
        self.parent_view = parent
        super().__init__(label="この内容で決定", style=discord.ButtonStyle.success, row=4)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        await interaction.response.send_modal(
            ShortcutNameModal(view.cog, view.action, view.item, params=dict(view.params)))


class ShortcutParamsSkipButton(discord.ui.Button):
    def __init__(self, parent: "ShortcutParamsView"):
        self.parent_view = parent
        super().__init__(label="設定しない（既定値で登録）", style=discord.ButtonStyle.secondary, row=4)

    async def callback(self, interaction: discord.Interaction):
        view = self.parent_view
        # 編集時に既存プリセットを消す意味も含め、空の params で登録へ進む。
        await interaction.response.send_modal(
            ShortcutNameModal(view.cog, view.action, view.item, params={}))


class ShortcutParamsView(discord.ui.View):
    """ショートカット登録時のパラメータ設定ステップ。

    ParamSpec を持つアクションを選んだときだけ、名前モーダルの前に挟む。
    パラメータは登録時のプリセット専用で、メッセージ経由の実行時に追加で
    聞くことはしない（モーダルを出せないため。仕様書 D-4）。
    """

    def __init__(self, cog: "GeneralCog", action: dict, item: dict | None, spec):
        super().__init__(timeout=300)
        self.cog, self.action, self.item, self.spec = cog, action, item, spec
        self.params: dict = {}
        saved = (item or {}).get("action", {})
        if (item and saved.get("root") == action.get("root")
                and saved.get("value") == action.get("value")):
            # 編集時は保存済みプリセットを初期表示する。
            names = {param.name for param in spec.params}
            self.params = {key: value for key, value in shortcuts.effective_params(item).items()
                           if key in names}
        self.select_params = [p for p in spec.params if p.type in {"choice", "bool"}]
        self.modal_params = [p for p in spec.params
                             if p.type in {"text", "int", "number", "duration"}]
        self.refresh()

    def refresh(self):
        self.clear_items()
        for index, param in enumerate(self.select_params[:4]):
            self.add_item(ShortcutParamSelect(self, param, row=index))
        if self.modal_params:
            # セレクトが4行を占める場合は入力ボタンも最終行に同居させる。
            row = len(self.select_params) if len(self.select_params) < 4 else 4
            self.add_item(ShortcutParamInputButton(self, row=row))
        self.add_item(ShortcutParamsCommitButton(self))
        self.add_item(ShortcutParamsSkipButton(self))

    def embed(self):
        lines = []
        for param in self.spec.params:
            value = self.params.get(param.name)
            shown = "（未設定：既定値）" if value is None else f"`{value}`"
            suffix = " ※実行に必要" if param.required else ""
            lines.append(f"**{param.label}**: {shown}{suffix}")
        return discord.Embed(
            title=f"パラメータ設定: {self.spec.label}",
            description=(
                "ショートカットに保存する値（プリセット）を設定してください。\n"
                "未設定の項目は実行時の既定値が使われます。パラメータは登録時の設定専用で、"
                "メッセージで実行するときに追加で聞かれることはありません。\n\n"
                + "\n".join(lines)
            ),
            color=0xFFFFFF,
        )


class ShortcutRootSelect(discord.ui.Select):
    def __init__(self, parent: "ShortcutBuilderView", selected: str | None = None):
        self.parent_view = parent
        super().__init__(placeholder="大区分コマンドを選択", options=[
            discord.SelectOption(label=label, value=root, default=root == selected)
            for root, (label, _) in SHORTCUT_ROOTS.items()
        ], row=0)

    async def callback(self, interaction: discord.Interaction):
        if isinstance(self.parent_view, ShortcutRootPanel):
            return await self.parent_view.open_existing_panel(interaction, self.values[0])
        self.parent_view.root = self.values[0]
        self.parent_view.selected = None
        self.parent_view.refresh()
        if hasattr(self.view, "_sync"):
            self.view._sync()
            return await edit_panel_v2(interaction, self.view)
        return await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class ShortcutRootPanel(discord.ui.View):
    def __init__(self, item: dict | None = None):
        super().__init__(timeout=300)
        self.item = item
        action = item.get("action", {}) if item else {}
        self.root = action.get("root")
        self.add_item(ShortcutRootSelect(self, self.root))

    def embed(self):
        return discord.Embed(title="ショートカット登録", color=0xFFFFFF)

    async def open_existing_panel(self, interaction, root: str):
        from core.support.panel_v2 import as_panel_v2, edit_panel_v2
        bot = interaction.client
        if root == "general":
            panel = GeneralPanel(bot.get_cog("GeneralCog"), shortcut_mode=True, shortcut_item=self.item)
        elif root == "vc":
            from cogs.vc import VoicePanelView
            panel = VoicePanelView(bot.get_cog("VoiceHub"), shortcut_mode=True, shortcut_item=self.item)
        elif root == "game":
            from cogs.game import GameHubView
            panel = GameHubView(bot.get_cog("GameHub"), shortcut_mode=True, shortcut_item=self.item)
        elif root == "support":
            from cogs.support import SupportPanelView
            panel = SupportPanelView(bot.get_cog("SupportCog"), shortcut_mode=True, shortcut_item=self.item)
        else:
            from cogs.help import HelpView
            help_cog = bot.get_cog("HelpCog")
            panel = HelpView(help_cog.catalog(), shortcut_mode=True, shortcut_item=self.item)
        if panel is None:
            return await interaction.response.send_message("対象のパネルが読み込まれていません。", ephemeral=True)
        await edit_panel_v2(interaction, as_panel_v2(panel))


class ShortcutCommitButton(discord.ui.Button):
    def __init__(self, root: str = "general"):
        # root は表示元のパネル (/general /vc /support /game /help)。
        # 再起動後に死んだパネルが押されたとき、cogs/panel_recovery.py が
        # この custom_id の root を見て正しいパネルを開き直すために使う。
        super().__init__(label="この内容で決定", style=discord.ButtonStyle.success, row=4,
                         custom_id=f"panel:{root}:commit")

    async def callback(self, interaction: discord.Interaction):
        panel = getattr(self.view, "panel", self.view)
        await begin_shortcut_registration(interaction, panel)


async def begin_shortcut_registration(interaction: discord.Interaction, panel):
    """パネルで選択中のアクションをショートカット登録する共通入口（導線最適化 M9）。

    ShortcutCommitButton（登録フロー内）と RegisterShortcutButton（通常パネル）
    の両方から使う。ParamSpec を持つアクションだけ、名前モーダルの前に
    パラメータ設定を挟む。
    """
    action = panel.shortcut_action()
    if action is None:
        return await interaction.response.send_message(
            "機能を選択してから押してください。", ephemeral=True)
    cog = interaction.client.get_cog("GeneralCog")
    item = getattr(panel, "shortcut_item", None)
    spec = action_registry.default_registry().get(
        f"{action.get('root')}:{action.get('value')}")
    if spec is not None and spec.params:
        view = ShortcutParamsView(cog, action, item, spec)
        return await interaction.response.send_message(embed=view.embed(), view=view, ephemeral=True)
    await interaction.response.send_modal(ShortcutNameModal(cog, action, item))


class RegisterShortcutButton(discord.ui.Button):
    """通常パネルから直接ショートカット登録を始めるボタン（導線最適化 M9）。

    管理画面経由（約9操作）ではなく、機能を選んだその場で押すと
    名前モーダル（またはパラメータ設定）へ進める。
    """

    def __init__(self, root: str = "general", row: int = 4):
        # custom_id は panel:<root>:register の固定形。パネル復旧（PR-B 不変条件）
        # が root を見て正しいパネルを開き直せるようにするため。
        super().__init__(label="⭐ ショートカットに登録", style=discord.ButtonStyle.secondary,
                         row=row, custom_id=f"panel:{root}:register")

    async def callback(self, interaction: discord.Interaction):
        panel = getattr(self.view, "panel", self.view)
        await begin_shortcut_registration(interaction, panel)


class ShortcutManageSelect(discord.ui.Select):
    def __init__(self, parent: "ShortcutManagerView", mode: str):
        self.parent_view, self.mode = parent, mode
        rows = shortcuts.for_user(guild_settings.get_store(), parent.guild_id, parent.user_id)
        options = [
            discord.SelectOption(label=str(x.get("trigger", "不明"))[:100], value=str(x["id"])) for x in rows
        ][:25]
        if not options:
            options = [discord.SelectOption(label="登録されていません", value="__none__")]
        super().__init__(placeholder="対象のショートカットを選択", options=options)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            return await interaction.response.send_message("ショートカットが登録されていません。", ephemeral=True)
        rows = shortcuts.for_user(guild_settings.get_store(), interaction.guild_id, interaction.user.id)
        item = next((x for x in rows if x.get("id") == self.values[0]), None)
        if item is None:
            return await interaction.response.send_message("ショートカットが見つかりません。", ephemeral=True)
        if self.mode == "delete":
            await shortcuts.remove(guild_settings.get_store(), interaction.guild_id, interaction.user.id, item["id"])
            wrapper = getattr(self.view, "panel", None)
            if wrapper is not None:
                wrapper._sync()
                return await edit_panel_v2(interaction, self.view)
            return await edit_panel_v2(interaction, as_panel_v2(self.parent_view))
        view = ShortcutRootPanel(item)
        await edit_panel_v2(interaction, as_panel_v2(view))


class ShortcutManagerView(discord.ui.View):
    def __init__(self, cog: "GeneralCog", guild_id: int, user_id: int):
        super().__init__(timeout=300)
        self.cog, self.guild_id, self.user_id = cog, guild_id, user_id

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self, notice: str | None = None):
        rows = shortcuts.for_user(guild_settings.get_store(), self.guild_id, self.user_id)
        lines = [f"`{x['trigger']}` → {x.get('action', {}).get('root')}/{x.get('action', {}).get('value')}" for x in rows]
        description = (notice + "\n\n" if notice else "") + ("\n".join(lines) or "登録はありません。")
        description += f"\n\n登録数: {len(rows)}/{shortcuts.MAX_SHORTCUTS}"
        return discord.Embed(title="ショートカット管理", description=description, color=0xFFFFFF)

    @discord.ui.button(label="登録", style=discord.ButtonStyle.success, row=0)
    async def register(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = ShortcutRootPanel()
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="編集", style=discord.ButtonStyle.primary, row=0)
    async def edit(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = ShortcutManagerView(self.cog, interaction.guild_id, interaction.user.id)
        view.add_item(ShortcutManageSelect(view, "edit"))
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="削除", style=discord.ButtonStyle.danger, row=0)
    async def delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = ShortcutManagerView(self.cog, interaction.guild_id, interaction.user.id)
        view.add_item(ShortcutManageSelect(view, "delete"))
        await edit_panel_v2(interaction, as_panel_v2(view))

    @discord.ui.button(label="一覧更新", style=discord.ButtonStyle.secondary, row=0)
    async def refresh_list(self, interaction: discord.Interaction, button: discord.ui.Button):
        return await edit_panel_v2(interaction, as_panel_v2(self))


class _MessageResponse:
    def __init__(self, source):
        self.source, self.done = source, False

    def is_done(self):
        return self.done

    async def defer(self, **kwargs):
        self.done = True

    async def send_message(self, content=None, **kwargs):
        self.done = True
        kwargs.pop("ephemeral", None)
        kwargs.pop("wait", None)
        return await self.source.channel.send(content=content, **kwargs)

    async def send_modal(self, modal):
        self.done = True
        return await self.source.channel.send("このショートカットは追加入力が必要なため、パネルから実行してください。")


class _MessageFollowup:
    def __init__(self, source):
        self.source = source

    async def send(self, content=None, **kwargs):
        kwargs.pop("ephemeral", None)
        kwargs.pop("wait", None)
        return await self.source.channel.send(content=content, **kwargs)


class ShortcutMessageInteraction:
    def __init__(self, bot, message, user_id: int, *, invoker=None):
        self.client = bot
        self.bot = bot
        self.message = message
        self.channel = message.channel
        self.guild = message.guild
        self.guild_id = message.guild.id
        self.user = invoker or message.author
        self.user_id = self.user.id
        self.response = _MessageResponse(self)
        self.followup = _MessageFollowup(self)


class ShortcutsMixin:
    """GeneralCog の一部。cogs/general.py で合成される。"""

    async def execute_shortcut(self, message: discord.Message, item: dict, *, invoker=None):
        # MIQトリガー（引用への返信で「@BOT miq」）からは、どのショートカットも
        # 実行しない。AITools等がこの経路で miq_settings を選ぶと、メッセージ経由の
        # Interaction は ephemeral を使えず、MIQ設定パネルがチャンネルへ公開送信
        # されて引用画像と一緒に出てしまうため。画像生成は on_message の MIQ側が行う。
        if is_miq_trigger(message, self.bot.user if self.bot is not None else None):
            return False
        try:
            owner_id = int(item.get("user_id"))
            author_id = int(message.author.id)
        except (AttributeError, TypeError, ValueError):
            return False
        if author_id != owner_id:
            return False
        action = item.get("action") or {}
        root, value = action.get("root"), action.get("value")
        # ephemeral 前提の個人向け応答はこの経路で実行しない（登録済みの
        # ショートカットに対する実行時ガード。候補からの除外は
        # core.general.action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS が正）。
        if root == "general" and f"general:{value}" in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS:
            return False
        source = ShortcutMessageInteraction(self.bot, message, author_id, invoker=invoker)
        # v2 のプリセット値（旧形式では action["options"]）。メッセージ経由の
        # 実行ではモーダルを出せないため、params は登録時のプリセット専用で、
        # 実行時に追加で聞くことはしない（仕様書 D-4）。
        params = shortcuts.effective_params(item)
        try:
            if root == "general":
                return await self.dispatch_general(source, value)
            if root == "vc":
                cog = self.bot.get_cog("VoiceHub")
                if cog:
                    return await cog.dispatch_voice_action(
                        source, value, **shortcut_vc_params(value, params))
            if root == "game":
                cog = self.bot.get_cog("GameHub")
                if cog and value.startswith("game:"):
                    return await cog.start_game(source, value.removeprefix("game:"), **params)
            if root == "support":
                cog = self.bot.get_cog("SupportCog")
                if cog:
                    return await cog.dispatch(source, value)
            if root == "help":
                return await message.channel.send("ヘルプは `/help` で確認できます。")
        except Exception:
            logger.exception("shortcut execution failed: %s", item)
            await message.channel.send("ショートカットの実行中にエラーが発生しました。")

from .panel import GeneralPanel  # 相互参照のため末尾で import
from cogs.general import SHORTCUT_ROOTS  # cogs/general.py 側で算出済みのものを読む
