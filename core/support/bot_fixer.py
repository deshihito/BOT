# -*- coding: utf-8 -*-
"""BOT fixer の設定パネル。元は /support「モデレーション」から開く。

パネル内に2つの設定エリアを持つ:
- ①AGOコマンド制限（core/support/command_control.py）
- ②他ボット制限（core/support/bot_control.py）
"""
from __future__ import annotations

from .common import *
from core.support import bot_control, command_control
from core.general import action_registry
from core.support.bot_control import BOT_CONTROL_SECTION
from core.support.messages import SETTINGS_UPDATE_FAILED
from core.support.command_control import (
    COMMAND_CONTROL_SECTION,
    MODE_ALLOW,
    MODE_DENY,
    MODE_LABELS,
    MODE_OFF,
    MODES,
    SELF_ACTION_ID,
    SELF_ACTION_IDS,
)

PAGE_SIZE = 25
ROOTS = action_registry.ROOT_ORDER

_label_cache: dict[str, str] | None = None


def _action_labels() -> dict[str, str]:
    global _label_cache
    if _label_cache is None:
        _label_cache = {spec.id: spec.label for spec in action_registry.default_registry().all()}
    return _label_cache


def _actions_of_root(root: str) -> list:
    specs = [
        spec for spec in action_registry.default_registry().by_root(root)
        if spec.id not in SELF_ACTION_IDS
    ]
    return specs


class _ModeButton(discord.ui.Button):
    def __init__(self, parent: "BotFixerPanel", mode: str):
        self.parent_view = parent
        active = parent.settings["mode"] == mode
        super().__init__(
            label=f"{MODE_LABELS[mode]}{'（現在）' if active else ''}",
            style=discord.ButtonStyle.primary if active else discord.ButtonStyle.secondary,
        )
        self.mode = mode

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.settings["mode"] = self.mode
        await self.parent_view.save(interaction, f"モードを「{MODE_LABELS[self.mode]}」にしました。")


class _PurposeButton(discord.ui.Button):
    def __init__(self, parent: "BotFixerPanel"):
        self.parent_view = parent
        label = "対象リストを編集" if parent.purpose == "rate" else "レート制限を設定"
        super().__init__(label=label, style=discord.ButtonStyle.secondary)

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.purpose = "list" if self.parent_view.purpose == "rate" else "rate"
        await self.parent_view.rebuild(interaction)


class _PageButton(discord.ui.Button):
    def __init__(self, parent: "BotFixerPanel", delta: int, label: str, disabled: bool):
        self.parent_view = parent
        self.delta = delta
        super().__init__(label=label, style=discord.ButtonStyle.secondary, disabled=disabled)

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.page += self.delta
        await self.parent_view.rebuild(interaction)


class _RootSelect(discord.ui.Select):
    def __init__(self, parent: "BotFixerPanel"):
        self.parent_view = parent
        options = [
            discord.SelectOption(
                label=action_registry.ROOT_LABELS[root], value=root,
                default=(root == parent.root),
            )
            for root in ROOTS
        ]
        super().__init__(placeholder="対象の種類（ルート）", options=options, min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.root = self.values[0]
        self.parent_view.page = 0
        await self.parent_view.rebuild(interaction)


class _ActionSelect(discord.ui.Select):
    def __init__(self, parent: "BotFixerPanel", specs: list):
        self.parent_view = parent
        settings = parent.settings
        options = []
        for spec in specs:
            if parent.purpose == "rate":
                rule = settings["rates"].get(spec.id)
                desc = f"{rule['count']}回 / {rule['window_seconds'] // 60}分" if rule else "レート制限なし"
            else:
                desc = "対象リストに登録済み" if spec.id in settings["actions"] else spec.genre_label
            options.append(discord.SelectOption(label=spec.label[:100], value=spec.id, description=desc[:100]))
        placeholder = "レート制限を設定する機能" if parent.purpose == "rate" else "対象リストに追加／削除する機能"
        super().__init__(placeholder=placeholder, options=options, min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        action_id = self.values[0]
        parent = self.parent_view
        if parent.purpose == "rate":
            label = _action_labels().get(action_id, action_id)
            return await interaction.response.send_modal(
                _RateModal(parent, action_id, label))
        actions = parent.settings["actions"]
        if action_id in actions:
            actions.remove(action_id)
            notice = f"{_action_labels().get(action_id, action_id)} を対象リストから外しました。"
        else:
            actions.append(action_id)
            notice = f"{_action_labels().get(action_id, action_id)} を対象リストに追加しました。"
        await parent.save(interaction, notice)


class _RateModal(discord.ui.Modal, title="レート制限"):
    count = discord.ui.TextInput(label="回数（空欄で解除）", required=False, max_length=5)
    minutes = discord.ui.TextInput(label="期間（分）", required=False, max_length=6)

    def __init__(self, parent: "BotFixerPanel", action_id: str, label: str):
        super().__init__()
        self.parent_view = parent
        self.action_id = action_id
        self.action_label = label
        rule = parent.settings["rates"].get(action_id)
        if rule:
            self.count.default = str(rule["count"])
            self.minutes.default = str(max(1, rule["window_seconds"] // 60))

    async def on_submit(self, interaction: discord.Interaction):
        parent = self.parent_view
        raw_count = (self.count.value or "").strip()
        raw_minutes = (self.minutes.value or "").strip()
        if not raw_count and not raw_minutes:
            parent.settings["rates"].pop(self.action_id, None)
            return await parent.save(interaction, f"{self.action_label} のレート制限を解除しました。")
        try:
            count = int(raw_count)
            minutes = int(raw_minutes)
        except ValueError:
            return await parent.fail(interaction, "回数と期間（分）は数字で入力してください。")
        window = minutes * 60
        if not (1 <= count <= command_control.RATE_MAX_COUNT) or not (60 <= window <= command_control.RATE_MAX_WINDOW_SECONDS):
            return await parent.fail(interaction, "回数は1〜1000、期間は1〜10080分で入力してください。")
        parent.settings["rates"][self.action_id] = {"count": count, "window_seconds": window}
        await parent.save(interaction, f"{self.action_label} にレート制限（{count}回／{minutes}分）を設定しました。")


class _AreaButton(discord.ui.Button):
    def __init__(self, parent: "BotFixerPanel", area: str, label: str):
        self.parent_view = parent
        active = parent.area == area
        super().__init__(
            label=f"{label}{'（現在）' if active else ''}",
            style=discord.ButtonStyle.primary if active else discord.ButtonStyle.secondary,
            disabled=active,
        )
        self.area = area

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.area = self.area
        await self.parent_view.rebuild(interaction)


class _BotUserSelect(discord.ui.UserSelect):
    def __init__(self, parent: "BotFixerPanel"):
        self.parent_view = parent
        super().__init__(placeholder="制限するボットを選択", min_values=1, max_values=1)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        user = self.values[0]
        if not getattr(user, "bot", False):
            return await parent.fail(interaction, "ボットのアカウントを選択してください。")
        self_bot = getattr(interaction.client, "user", None)
        if self_bot is not None and user.id == self_bot.id:
            return await parent.fail(interaction, "AGO BOT 自身は対象にできません。")
        parent.bot_target = user.id
        await parent.rebuild(interaction)


class _BotChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "BotFixerPanel"):
        self.parent_view = parent
        entry = parent.bot_settings.get(str(parent.bot_target)) or {}
        defaults = [
            discord.Object(id=channel_id)
            for channel_id in entry.get("allowed_channel_ids", [])
        ]
        super().__init__(
            placeholder="発言を許可するチャンネル（1件以上）",
            channel_types=[discord.ChannelType.text],
            min_values=1, max_values=25, default_values=defaults,
        )

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        channel_ids = [channel.id for channel in self.values]
        entry = dict(parent.bot_settings.get(str(parent.bot_target)) or {})
        entry["allowed_channel_ids"] = channel_ids
        entry.setdefault("rate", None)
        parent.bot_settings[str(parent.bot_target)] = entry
        await parent.save_bot(interaction, "許可チャンネルを設定しました。", parent.bot_target, entry)


class _BotRateButton(discord.ui.Button):
    def __init__(self, parent: "BotFixerPanel"):
        self.parent_view = parent
        super().__init__(label="レート制限を設定", style=discord.ButtonStyle.secondary)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        if str(parent.bot_target) not in parent.bot_settings:
            return await parent.fail(interaction, "先に許可チャンネルを設定してください。")
        await interaction.response.send_modal(_BotRateModal(parent))


class _BotRemoveButton(discord.ui.Button):
    def __init__(self, parent: "BotFixerPanel"):
        self.parent_view = parent
        super().__init__(label="対象から外す", style=discord.ButtonStyle.danger)

    async def callback(self, interaction: discord.Interaction):
        parent = self.parent_view
        target = parent.bot_target
        parent.bot_settings.pop(str(target), None)
        parent.bot_target = None
        await parent.save_bot(interaction, "ボット制限の対象から外しました。", target, None)


class _BotRateModal(discord.ui.Modal, title="ボットのレート制限"):
    count = discord.ui.TextInput(label="回数（空欄で解除）", required=False, max_length=5)
    minutes = discord.ui.TextInput(label="期間（分）", required=False, max_length=6)

    def __init__(self, parent: "BotFixerPanel"):
        super().__init__()
        self.parent_view = parent
        entry = parent.bot_settings.get(str(parent.bot_target)) or {}
        rule = entry.get("rate")
        if rule:
            self.count.default = str(rule["count"])
            self.minutes.default = str(max(1, rule["window_seconds"] // 60))

    async def on_submit(self, interaction: discord.Interaction):
        parent = self.parent_view
        entry = dict(parent.bot_settings.get(str(parent.bot_target)) or {})
        raw_count = (self.count.value or "").strip()
        raw_minutes = (self.minutes.value or "").strip()
        if not raw_count and not raw_minutes:
            entry["rate"] = None
            parent.bot_settings[str(parent.bot_target)] = entry
            return await parent.save_bot(interaction, "レート制限を解除しました。", parent.bot_target, entry)
        try:
            count = int(raw_count)
            minutes = int(raw_minutes)
        except ValueError:
            return await parent.fail(interaction, "回数と期間（分）は数字で入力してください。")
        window = minutes * 60
        if not (1 <= count <= command_control.RATE_MAX_COUNT) or not (60 <= window <= command_control.RATE_MAX_WINDOW_SECONDS):
            return await parent.fail(interaction, "回数は1〜1000、期間は1〜10080分で入力してください。")
        entry["rate"] = {"count": count, "window_seconds": window}
        parent.bot_settings[str(parent.bot_target)] = entry
        await parent.save_bot(
            interaction, f"レート制限（{count}回／{minutes}分）を設定しました。",
            parent.bot_target, entry)


class BotFixerPanel(discord.ui.LayoutView):
    """BOT fixer の設定パネル（Components V2・サーバー管理権限）。"""

    def __init__(self, cog: "SupportCog", settings: dict, bot_settings: dict | None = None,
                 notice: str | None = None, preset: dict | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.bot_settings = bot_settings or {}
        self.bot_target: int | None = None
        self.notice = notice
        self.area = "command"
        self.root = "general"
        self.page = 0
        self.purpose = "list"
        # preset（機能数再編の分割入口）: {"area": "bot"} で他ボット制限側、
        # {"area": "command", "purpose": "rates"} でコマンド制限の
        # レート制限側を初期表示にする。purpose は内部表現 "rate" に寄せる。
        if isinstance(preset, dict):
            if preset.get("area") in {"command", "bot"}:
                self.area = preset["area"]
            purpose = preset.get("purpose")
            if purpose in {"rate", "rates"}:
                self.purpose = "rate"
            elif purpose == "list":
                self.purpose = "list"
        self._build()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        permissions = getattr(interaction.user, "guild_permissions", None)
        if getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False):
            return True
        await interaction.response.send_message(
            "この設定にはサーバー管理権限が必要です。",
            ephemeral=True,
        )
        return False

    async def on_error(self, interaction: discord.Interaction, error: Exception, item: discord.ui.Item):
        await report_callback_error(interaction, "BOT fixer パネルでエラー", error=error)

    def _status_text(self) -> str:
        s = self.settings
        labels = _action_labels()
        lines = [f"モード: **{MODE_LABELS[s['mode']]}**"]
        if s["actions"]:
            shown = [labels.get(a, a) for a in s["actions"][:10]]
            suffix = f" 他{len(s['actions']) - 10}件" if len(s["actions"]) > 10 else ""
            lines.append(f"対象リスト（{len(s['actions'])}件）: " + "、".join(shown) + suffix)
        else:
            lines.append("対象リスト: （空）")
        if s["rates"]:
            parts = [
                f"{labels.get(a, a)} {r['count']}回/{r['window_seconds'] // 60}分"
                for a, r in list(s["rates"].items())[:10]
            ]
            suffix = f" 他{len(s['rates']) - 10}件" if len(s["rates"]) > 10 else ""
            lines.append(f"レート制限（{len(s['rates'])}件）: " + "、".join(parts) + suffix)
        else:
            lines.append("レート制限: なし")
        lines.append("サーバー管理者は制限の対象外です。")
        return "\n".join(lines)

    def _page_specs(self) -> tuple[list, int]:
        specs = _actions_of_root(self.root)
        pages = max(1, (len(specs) + PAGE_SIZE - 1) // PAGE_SIZE)
        self.page = min(self.page, pages - 1)
        return specs[self.page * PAGE_SIZE:(self.page + 1) * PAGE_SIZE], pages

    def _area_row(self) -> discord.ui.ActionRow:
        return discord.ui.ActionRow(
            _AreaButton(self, "command", "コマンド制限"),
            _AreaButton(self, "bot", "他ボット制限"),
        )

    def _build(self):
        if self.area == "bot":
            self._build_bot()
        else:
            self._build_command()

    def _build_command(self):
        self.clear_items()
        head = "## BOT fixer\n### コマンド制限"
        if self.notice:
            head = f"{self.notice}\n\n{head}"
        page_specs, pages = self._page_specs()
        rows: list[discord.ui.ActionRow] = [
            self._area_row(),
            discord.ui.ActionRow(*[_ModeButton(self, mode) for mode in MODES]),
            discord.ui.ActionRow(_RootSelect(self)),
            discord.ui.ActionRow(_ActionSelect(self, page_specs)),
            discord.ui.ActionRow(
                _PageButton(self, -1, "前へ", disabled=self.page <= 0),
                _PageButton(self, 1, "次へ", disabled=self.page >= pages - 1),
                _PurposeButton(self),
            ),
        ]
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(head),
                discord.ui.TextDisplay(self._status_text()),
                discord.ui.Separator(),
                *rows,
                accent_colour=0xE74C3C,
            )
        )

    def _bot_status_text(self) -> str:
        if not self.bot_settings:
            lines = ["対象のボットは登録されていません。"]
        else:
            lines = []
            bot = getattr(self.cog, "bot", None) if self.cog else None
            for bot_id, entry in self.bot_settings.items():
                user = bot.get_user(int(bot_id)) if bot is not None else None
                name = getattr(user, "name", None) or f"ID: {bot_id}"
                channels = "、".join(f"<#{cid}>" for cid in entry["allowed_channel_ids"])
                rate = entry.get("rate")
                rate_text = f"{rate['count']}回/{rate['window_seconds'] // 60}分" if rate else "なし"
                lines.append(f"**{name}** 許可: {channels}／レート: {rate_text}")
        if self.bot_target is not None:
            lines.append(f"\n編集中: <@{self.bot_target}>")
        else:
            lines.append("\n下のセレクトでボットを選ぶと、そのボットの許可チャンネルとレート制限を編集できます。")
        return "\n".join(lines)

    def _build_bot(self):
        self.clear_items()
        head = "## BOT fixer\n### 他ボット制限"
        if self.notice:
            head = f"{self.notice}\n\n{head}"
        rows: list[discord.ui.ActionRow] = [
            self._area_row(),
            discord.ui.ActionRow(_BotUserSelect(self)),
        ]
        if self.bot_target is not None:
            rows.append(discord.ui.ActionRow(_BotChannelSelect(self)))
            buttons = [_BotRateButton(self)]
            if str(self.bot_target) in self.bot_settings:
                buttons.append(_BotRemoveButton(self))
            rows.append(discord.ui.ActionRow(*buttons))
        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(head),
                discord.ui.TextDisplay(self._bot_status_text()),
                discord.ui.Separator(),
                *rows,
                accent_colour=0xE74C3C,
            )
        )

    async def save_bot(self, interaction: discord.Interaction, notice: str,
                       bot_id: int, entry: dict | None):
        await interaction.response.defer()
        try:
            await guild_settings.get_store().update(
                interaction.guild_id, BOT_CONTROL_SECTION, **{str(bot_id): entry})
        except Exception:
            logger.exception("BOT fixer（ボット制限）設定の更新に失敗しました")
            return await interaction.followup.send(
                SETTINGS_UPDATE_FAILED,
                ephemeral=True,
            )
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.bot_settings = bot_control.get_settings(store, interaction.guild_id)
        await self.rebuild(interaction, notice)

    async def rebuild(self, interaction: discord.Interaction, notice: str | None = None):
        if notice is not None:
            self.notice = notice
        self._build()
        await edit_interaction_message(interaction, view=self)

    async def fail(self, interaction: discord.Interaction, message: str):
        await interaction.response.send_message(message, ephemeral=True)

    async def save(self, interaction: discord.Interaction, notice: str):
        await interaction.response.defer()
        try:
            await guild_settings.get_store().update(
                interaction.guild_id, COMMAND_CONTROL_SECTION,
                mode=self.settings["mode"],
                actions=list(self.settings["actions"]),
                rates=dict(self.settings["rates"]),
            )
        except Exception:
            logger.exception("BOT fixer（コマンド制限）設定の更新に失敗しました")
            return await interaction.followup.send(
                SETTINGS_UPDATE_FAILED,
                ephemeral=True,
            )
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = command_control.get_settings(store, interaction.guild_id)
        await self.rebuild(interaction, notice)


class BotFixerSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    async def show_bot_fixer_settings(self, interaction: discord.Interaction,
                                      preset: dict | None = None):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = command_control.get_settings(store, interaction.guild_id)
        bot_settings = bot_control.get_settings(store, interaction.guild_id)
        await interaction.response.send_message(
            view=BotFixerPanel(self, settings, bot_settings, preset=preset),
            ephemeral=True,
        )

    @commands.Cog.listener("on_message")
    async def on_message_bot_control(self, message: discord.Message):
        # BOT fixer の他ボット制限: 対象ボットの許可チャンネル外／レート超過の
        # 発言を削除する。失敗しても他の on_message 処理は止めない
        # （enforce_message 側で例外を握る）。
        self_bot = getattr(self.bot, "user", None)
        await bot_control.enforce_message(getattr(self_bot, "id", None), message)
