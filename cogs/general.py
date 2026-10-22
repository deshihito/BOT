"""/general: コイン・生存確認・ランキング系機能の操作パネル。"""
from __future__ import annotations

import discord
import logging
from discord import app_commands
from discord.ext import commands
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core import ai_preferences, ai_provider_router, guild_settings, logfare, shortcuts
from core.game_guides import GAME_GUIDES, GAME_ORDER

logger = logging.getLogger(__name__)


GENERAL_GENRES = {
    "economy": ("コイン・ランキング", "所持状況、送金、コインや bump/up のランキング"),
    "survival": ("生存確認", "追跡、アクティブ頻度、フリーズ、失踪警報"),
    "custom": ("カスタム・AI設定", "ショートカット、D1代理実行、チャットAI・画像生成AIの設定"),
}
GENERAL_ACTIONS = {
    "economy": [
        ("プレイヤー状況", "status"),
        ("コイン送金", "pay"),
        ("コイン保有ランキング", "coin_leaderboard"),
        ("bump RTAランキング", "bump_leaderboard"),
        ("up RTAランキング", "up_leaderboard"),
    ],
    "survival": [
        ("追跡登録・解除", "fujo_register"),
        ("アクティブ頻度", "fujo_hindo"),
        ("生存確認ランキング", "fujo_ranking"),
        ("フリーズ", "fujo_freeze"),
        ("失踪警報解除", "fujo_panic_disable"),
    ],
    "custom": [
        ("ショートカットを管理", "shortcut_manage"),
        ("D1機能代理実行を設定", "d1tools"),
        ("チャットAIモデルを設定", "ai_default"),
        ("画像生成AIモデルを設定", "image_default"),
        ("AI思考強度を設定", "reasoning_default"),
    ],
}

SHORTCUT_ROOTS = {
    "general": ("/general", [(label, value) for values in GENERAL_ACTIONS.values() for label, value in values if value != "shortcut_manage"]),
    "vc": ("/vc", [("VC参加", "join"), ("VC退出", "leave"), ("VC状態", "status"),
                    ("音楽操作パネル", "music_panel"), ("録音開始", "record_start"), ("録音停止", "record_stop"),
                    ("やまびこ開始", "echo_start"), ("やまびこ停止", "echo_stop"),
                    ("文字起こし開始", "transcribe_start"), ("文字起こし停止", "transcribe_stop"),
                    ("カラオケ開始", "karaoke_start"), ("カラオケ停止", "karaoke_stop"),
                    ("ランダム通話開始", "match_start"), ("ランダム通話終了", "match_stop"),
                    ("グローバルVC開始", "global_start"), ("グローバルVC終了", "global_stop")]),
    "game": ("/game", [("ゲーム開始: " + GAME_GUIDES[game]["name"], "game:" + game) for game in GAME_ORDER]),
    "support": ("/support", [("Muted設定", "muted"), ("匿名つぶやき", "whisper"), ("メッセージ削除", "clear"),
                              ("一括ロール操作", "role_bulk"), ("bump/up状態", "bumprta_status"),
                              ("bump/upオン", "bumprta_on"), ("bump/upオフ", "bumprta_off"),
                              ("絵文字便乗設定", "binjou"), ("VC入退室履歴", "vc_log"),
                              ("メッセージ編集履歴", "message_log"), ("モデレート履歴", "moderation_log"),
                              ("ハニーポット", "honeypot"), ("チケットツール", "ticket")]),
    "help": ("/help", [("ヘルプを表示", "overview")]),
}


class PayModal(discord.ui.Modal, title="コインを送金"):
    receiver_id = discord.ui.TextInput(label="送金先のユーザーID", max_length=20)
    amount = discord.ui.TextInput(label="送金するAGO", max_length=9)

    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction):
        try:
            receiver = await self.cog.bot.fetch_user(int(self.receiver_id.value))
            amount = int(self.amount.value)
        except (ValueError, discord.HTTPException):
            return await interaction.response.send_message("ユーザーIDまたは数量が正しくありません。", ephemeral=True)
        await self.cog.bot.get_cog("WalletCog").pay(interaction, receiver, amount)


class GeneralGenreSelect(discord.ui.Select):
    def __init__(self, cog, selected: str | None = None):
        self.cog = cog
        super().__init__(
            placeholder="ジャンルを選択してください",
            options=[discord.SelectOption(label=label, description=description, value=value,
                                          default=value == selected)
                     for value, (label, description) in GENERAL_GENRES.items()],
            row=0,
        )

    async def callback(self, interaction):
        view: GeneralPanel = self.view
        wrapper = view if hasattr(view, "panel") else None
        view = getattr(view, "panel", view)
        view.genre = self.values[0]
        view.action = None
        if wrapper is not None:
            wrapper.refresh()
            return await edit_panel_v2(interaction, wrapper)
        view.refresh()
        return await edit_panel_v2(interaction, as_panel_v2(view))


class GeneralActionSelect(discord.ui.Select):
    def __init__(self, cog, genre: str):
        self.cog = cog
        self.genre = genre
        super().__init__(
            placeholder="機能を選択してください",
            options=[discord.SelectOption(label=label, value=value) for label, value in GENERAL_ACTIONS[genre]],
            row=1,
        )

    async def callback(self, interaction):
        view: GeneralPanel = self.view
        panel = getattr(view, "panel", view)
        panel.action = self.values[0]
        if panel.shortcut_mode:
            if hasattr(view, "_sync"):
                view._sync()
                return await edit_panel_v2(interaction, view)
            return await edit_panel_v2(interaction, as_panel_v2(panel))
        await self.cog.dispatch_general(interaction, self.values[0])


class GeneralPanel(discord.ui.View):
    def __init__(self, cog, genre: str | None = None, shortcut_mode: bool = False, shortcut_item: dict | None = None):
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
        self.add_item(GeneralGenreSelect(self.cog, self.genre))
        if self.genre:
            self.add_item(GeneralActionSelect(self.cog, self.genre))
        if self.shortcut_mode:
            self.add_item(ShortcutCommitButton())

    def shortcut_action(self):
        if not self.genre or not self.action:
            return None
        return {"root": "general", "genre": self.genre, "value": self.action}

    def embed(self):
        description = "ジャンルを選ぶと、その中の機能を選択できます。"
        if self.genre:
            description = f"**{GENERAL_GENRES[self.genre][0]}** の機能を選択してください。"
        return discord.Embed(title="一般機能", description=description, color=0xFFFFFF)


class ShortcutNameModal(discord.ui.Modal, title="ショートカット名"):
    trigger = discord.ui.TextInput(
        label="メッセージで送るトリガー（空白なし）", max_length=80,
        placeholder="例: VC参加", required=True,
    )

    def __init__(self, cog: "GeneralCog", action: dict, item: dict | None = None):
        super().__init__()
        self.cog, self.action, self.item = cog, action, item
        if item:
            self.trigger.default = item.get("trigger", "")

    async def on_submit(self, interaction: discord.Interaction):
        try:
            store = guild_settings.get_store()
            if self.item:
                await shortcuts.update(store, interaction.guild_id, interaction.user.id,
                                       self.item["id"], self.trigger.value, self.action)
                text = "ショートカットを編集しました。"
            else:
                await shortcuts.add(store, interaction.guild_id, interaction.user.id,
                                    self.trigger.value, self.action)
                text = "ショートカットを登録しました。"
        except (ValueError, KeyError) as exc:
            return await interaction.response.send_message(str(exc), ephemeral=True)
        await interaction.response.send_message(
            embed=discord.Embed(title=text, description=f"トリガー: `{self.trigger.value}`", color=0x2ECC71),
            ephemeral=True,
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
    """ショートカット登録の入口。選択後は各コマンドの既存パネルを使う。"""
    def __init__(self, item: dict | None = None):
        super().__init__(timeout=300)
        self.item = item
        action = item.get("action", {}) if item else {}
        self.root = action.get("root")
        self.add_item(ShortcutRootSelect(self, self.root))

    def embed(self):
        return discord.Embed(title="ショートカット登録",
                             description="大区分を選ぶと、そのコマンドの通常パネルで機能・オプションを選択できます。",
                             color=0xFFFFFF)

    async def open_existing_panel(self, interaction, root: str):
        from core.panel_v2 import as_panel_v2, edit_panel_v2
        bot = interaction.client
        if root == "general":
            panel = GeneralPanel(bot.get_cog("GeneralCog"), shortcut_mode=True, shortcut_item=self.item)
        elif root == "vc":
            from cogs.sio_voice import VoicePanelView
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
    """既存パネルの現在の選択状態をショートカットとして確定する。"""
    def __init__(self):
        super().__init__(label="この内容で決定", style=discord.ButtonStyle.success, row=4)

    async def callback(self, interaction: discord.Interaction):
        panel = getattr(self.view, "panel", self.view)
        action = panel.shortcut_action()
        if action is None:
            return await interaction.response.send_message("機能を選択してから決定してください。", ephemeral=True)
        cog = interaction.client.get_cog("GeneralCog")
        await interaction.response.send_modal(ShortcutNameModal(cog, action, getattr(panel, "shortcut_item", None)))


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
        wrapper = getattr(self.view, "panel", None)
        if wrapper is not None:
            wrapper._sync()
            return await edit_panel_v2(interaction, self.view)
        return await edit_panel_v2(interaction, as_panel_v2(self))


MODEL_PAGE_SIZE = 25


class AIDefaultSelect(discord.ui.Select):
    def __init__(self, user_id: int, models: list[dict], kind: str = "chat", page: int = 0):
        self.user_id, self.kind = user_id, kind
        self.model_ids = {str(model.get("id")) for model in models if model.get("id")}
        self.page = page
        if kind == "chat":
            current = ai_preferences.get_model(user_id) or logfare.configured_default_model()
        else:
            current = ai_preferences.get_image_model(user_id) or logfare.DEFAULT_IMAGE_MODEL
        start = page * MODEL_PAGE_SIZE
        page_models = models[start:start + MODEL_PAGE_SIZE]
        options = []
        for model in page_models:
            model_id = str(model["id"])
            label = str(model.get("name") or model_id)
            if model.get("requires_training_optin"):
                label += "（同意が必要）"
            options.append(discord.SelectOption(
                label=label[:100], value=model_id, default=model_id == current,
            ))
        if not options:
            options = [discord.SelectOption(label="logfare/auto", value="logfare/auto")]
        super().__init__(placeholder="デフォルトAIを選択", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "この設定画面を開いたユーザーだけ変更できます。", ephemeral=True
            )
        selected = self.values[0] if self.values else ""
        if selected not in self.model_ids:
            return await interaction.response.send_message(
                "選択したモデルは現在のLogfare一覧にありません。設定画面を開き直してください。",
                ephemeral=True,
            )
        try:
            if self.kind == "chat":
                await ai_preferences.set_model(self.user_id, selected)
            else:
                await ai_preferences.set_image_model(self.user_id, selected)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("AI model preference save failed: user=%s", self.user_id)
            return await interaction.response.send_message(
                "AI設定の保存に失敗しました。しばらくしてから再試行してください。", ephemeral=True
            )
        command = "!ai" if self.kind == "chat" else "!generate"
        await interaction.response.send_message(
            f"デフォルトAIを `{selected}` に設定しました。`{command} プロンプト` で使えます。",
            ephemeral=True,
        )


class AIDefaultPageButton(discord.ui.Button):
    def __init__(self, owner: "AIDefaultView", direction: int):
        self.owner_view, self.direction = owner, direction
        label = "前のページ" if direction < 0 else "次のページ"
        super().__init__(label=label, style=discord.ButtonStyle.secondary, row=1)

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_view.user_id:
            return await interaction.response.send_message(
                "この設定画面を開いたユーザーだけ操作できます。", ephemeral=True
            )
        next_page = self.owner_view.page + self.direction
        if next_page < 0 or next_page >= self.owner_view.page_count:
            return await interaction.response.send_message(
                "そのページは存在しません。設定画面を開き直してください。", ephemeral=True
            )
        self.owner_view.page = next_page
        self.owner_view.refresh_select()
        await interaction.response.edit_message(
            embed=self.owner_view.embed(), view=self.owner_view
        )


class AIDefaultView(discord.ui.View):
    def __init__(self, user_id: int, models: list[dict], kind: str = "chat", load_error: Exception | None = None):
        super().__init__(timeout=300)
        self.user_id = user_id
        self.kind, self.models, self.load_error = kind, models, load_error
        self.page = 0
        self.page_count = max(1, (len(models) + MODEL_PAGE_SIZE - 1) // MODEL_PAGE_SIZE)
        self.select = AIDefaultSelect(user_id, models, kind, self.page)
        self.add_item(self.select)
        if self.page_count > 1:
            self.add_item(AIDefaultPageButton(self, -1))
            self.add_item(AIDefaultPageButton(self, 1))

    def refresh_select(self):
        self.remove_item(self.select)
        self.select = AIDefaultSelect(self.user_id, self.models, self.kind, self.page)
        self.add_item(self.select)

    @classmethod
    async def create(cls, user_id: int, kind: str = "chat"):
        try:
            await ai_preferences.ensure_loaded()
            if kind == "image":
                models = await logfare.fetch_image_models()
            else:
                models = []
                if ai_provider_router.enabled():
                    name = ai_provider_router.logical_model() or "設定済みモデル"
                    models.append({"id": ai_provider_router.AUTO_MODEL,
                                   "name": f"自動切替: {name}"})
                try:
                    models.extend(await logfare.fetch_free_chat_models())
                except Exception:
                    if not models:
                        raise
        except Exception as exc:
            return cls(user_id, [], kind, exc)
        return cls(user_id, models, kind)

    def embed(self):
        if self.kind == "chat":
            current = ai_preferences.get_model(self.user_id) or logfare.configured_default_model()
        else:
            current = ai_preferences.get_image_model(self.user_id) or logfare.DEFAULT_IMAGE_MODEL
        title = "AI設定" if self.kind == "chat" else "画像生成AI設定"
        return discord.Embed(
            title=title,
            description=(
                f"`{'!ai' if self.kind == 'chat' else '!generate'}` で使うデフォルトAIを選択してください。\n"
                f"現在: `{current}`\n\n"
                f"Logfareの{'チャット' if self.kind == 'chat' else '画像生成'}モデルを選べます。"
                f"{'自動切替を選ぶと設定済みのAPIを順に使います。' if self.kind == 'chat' else ''}"
                f"Logfareの一部モデルはトレーニング利用への同意が必要です。\n"
                f"モデル一覧 {self.page + 1}/{self.page_count}ページ（全{len(self.models)}件）"
            ),
            color=0xFFFFFF,
        )


class ReasoningSelect(discord.ui.Select):
    def __init__(self, user_id: int, model_id: str, efforts: list[str], current: str | None):
        self.user_id, self.model_id = user_id, model_id
        self.efforts = set(efforts)
        options = [discord.SelectOption(
            label="モデルの既定値", value="__default__", default=current is None,
        )]
        options.extend(
            discord.SelectOption(label=effort, value=effort, default=effort == current)
            for effort in efforts
        )
        super().__init__(placeholder="思考強度を選択", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            return await interaction.response.send_message(
                "この設定画面を開いたユーザーだけ変更できます。", ephemeral=True
            )
        selected = self.values[0] if self.values else ""
        if selected != "__default__" and selected not in self.efforts:
            return await interaction.response.send_message(
                "選択した思考強度は現在のモデルに対応していません。設定画面を開き直してください。",
                ephemeral=True,
            )
        try:
            if selected == "__default__":
                await ai_preferences.clear_reasoning_effort(self.user_id)
                label = "モデルの既定値"
            else:
                await ai_preferences.set_reasoning_effort(self.user_id, selected)
                label = selected
        except Exception:
            logger.exception("reasoning preference save failed: user=%s", self.user_id)
            return await interaction.response.send_message(
                "思考強度の保存に失敗しました。しばらくしてから再試行してください。", ephemeral=True
            )
        await interaction.response.send_message(
            f"思考強度を `{label}` に設定しました。", ephemeral=True
        )


class ReasoningView(discord.ui.View):
    def __init__(self, user_id: int, model_id: str, efforts: list[str]):
        super().__init__(timeout=300)
        self.user_id, self.model_id, self.efforts = user_id, model_id, efforts
        self.add_item(ReasoningSelect(
            user_id, model_id, efforts, ai_preferences.get_reasoning_effort(user_id)
        ))

    @classmethod
    async def create(cls, user_id: int):
        await ai_preferences.ensure_loaded()
        model_id = ai_preferences.get_model(user_id) or logfare.configured_default_model()
        if model_id == ai_provider_router.AUTO_MODEL:
            return None, "自動切替モデルでは、この思考強度設定を使えません。"
        models = await logfare.fetch_free_chat_models()
        model = next((item for item in models if item.get("id") == model_id), None)
        if model is None:
            return None, f"現在のモデル `{model_id}` の情報を取得できませんでした。先にデフォルトAIを設定してください。"
        efforts = logfare.reasoning_efforts(model)
        if not efforts:
            return None, f"現在のモデル `{model_id}` は思考強度の設定に対応していません。"
        return cls(user_id, model_id, efforts), None

    def embed(self):
        current = ai_preferences.get_reasoning_effort(self.user_id) or "モデルの既定値"
        return discord.Embed(
            title="思考強度設定",
            description=(
                f"モデル `{self.model_id}` の思考強度を選択してください。\n"
                f"現在: `{current}`\n対応値: {', '.join(self.efforts)}"
            ),
            color=0xFFFFFF,
        )


class GeneralCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @app_commands.command(name="general", description="一般機能の操作パネルを表示します")
    async def general(self, interaction: discord.Interaction):
        view = GeneralPanel(self)
        await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)

    async def dispatch_general(self, interaction: discord.Interaction, value: str):
        if value == "d1tools":
            from core import d1_command_preferences, d1_command_router
            config = d1_command_preferences.get_config(interaction.user.id)
            available = d1_command_router.action_candidates(config["actions"])
            embed = discord.Embed(title="D1機能代理実行", color=0x5865F2)
            embed.description = (
                f"有効: `{config['enabled']}`\n"
                f"許可機能: `{', '.join(config['actions']) or 'なし'}`\n"
                f"解決可能: `{', '.join(available) or 'なし'}`\n\n"
                "詳細設定は `!d1tools allow vc:join`、`!d1tools allow vc`、"
                "`!d1tools on` で行えます。"
            )
            return await interaction.response.send_message(embed=embed, ephemeral=True)
        if value == "reasoning_default":
            await interaction.response.defer(ephemeral=True)
            try:
                view, error = await ReasoningView.create(interaction.user.id)
            except Exception as exc:
                logger.exception("reasoning model metadata unavailable: user=%s", interaction.user.id)
                status = getattr(exc, "status", None)
                detail = f"（HTTP {status}）" if status else ""
                return await interaction.followup.send(
                    f"思考強度の対応状況を取得できませんでした{detail}。時間をおいて再試行してください。",
                    ephemeral=True,
                )
            if error:
                return await interaction.followup.send(error, ephemeral=True)
            return await interaction.followup.send(
                embed=view.embed(), view=view, ephemeral=True
            )
        if value in {"ai_default", "image_default"}:
            await interaction.response.defer(ephemeral=True)
            kind = "chat" if value == "ai_default" else "image"
            view = await AIDefaultView.create(interaction.user.id, kind)
            if view.load_error or not view.models:
                logger.error(
                    "Logfare model catalog unavailable: kind=%s user=%s",
                    kind, interaction.user.id, exc_info=view.load_error,
                )
                status = getattr(view.load_error, "status", None)
                detail = f"（HTTP {status}）" if status else ""
                return await interaction.followup.send(
                    f"Logfareのモデル一覧を取得できませんでした{detail}。"
                    "時間をおいて再試行し、`.env` とAPI接続を確認してください。",
                    ephemeral=True,
                )
            return await interaction.followup.send(embed=view.embed(), view=view, ephemeral=True)
        if value == "shortcut_manage":
            view = ShortcutManagerView(self, interaction.guild_id, interaction.user.id)
            return await interaction.response.send_message(view=as_panel_v2(view), ephemeral=True)
        wallet = self.bot.get_cog("WalletCog")
        fujo = self.bot.get_cog("FujoSurvival")
        if value == "pay":
            return await interaction.response.send_modal(PayModal(self))
        if value == "status":
            return await wallet.user_status(interaction)
        if value == "coin_leaderboard":
            return await wallet.leaderboard(interaction)
        if value in {"bump_leaderboard", "up_leaderboard"}:
            event_type = value.removesuffix("_leaderboard")
            return await wallet.leaderboard(interaction, app_commands.Choice(name=event_type, value=event_type))
        action = value.removeprefix("fujo_")
        return await fujo.fujo(interaction, action, None, "active", None, None)

    async def execute_shortcut(self, message: discord.Message, item: dict):
        # Message shortcuts are personal settings.  Keep this guard here as well
        # as in ``on_message`` so callers cannot accidentally bypass ownership
        # validation by invoking the executor directly.
        try:
            owner_id = int(item.get("user_id"))
            author_id = int(message.author.id)
        except (AttributeError, TypeError, ValueError):
            return False
        if author_id != owner_id:
            return False
        action = item.get("action") or {}
        source = ShortcutMessageInteraction(self.bot, message, author_id)
        root, value = action.get("root"), action.get("value")
        try:
            if root == "general":
                return await self.dispatch_general(source, value)
            if root == "vc":
                cog = self.bot.get_cog("VoiceHub")
                if cog:
                    return await cog.dispatch_voice_action(source, value)
            if root == "game":
                cog = self.bot.get_cog("GameHub")
                if cog and value.startswith("game:"):
                    options = action.get("options") or {}
                    return await cog.start_game(source, value.removeprefix("game:"), **options)
            if root == "support":
                cog = self.bot.get_cog("SupportCog")
                if cog:
                    return await cog.dispatch(source, value)
            if root == "help":
                return await message.channel.send("ヘルプは `/help` で確認できます。")
        except Exception:
            import logging
            logging.getLogger(__name__).exception("shortcut execution failed: %s", item)
            await message.channel.send("ショートカットの実行中にエラーが発生しました。")

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot or message.guild is None:
            return
        store = guild_settings.get_store()
        await store.ensure_loaded()
        for item in shortcuts.matching(
            store, message.guild.id, message.content.strip(), user_id=message.author.id
        ):
            await self.execute_shortcut(message, item)


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
    """既存のinteractionベース実装をメッセージトリガーから再利用する薄いアダプター。"""
    def __init__(self, bot, message, user_id: int):
        self.client = bot
        self.bot = bot
        self.message = message
        self.channel = message.channel
        self.guild = message.guild
        self.guild_id = message.guild.id
        self.user = bot.get_user(user_id) or message.author
        self.response = _MessageResponse(self)
        self.followup = _MessageFollowup(self)


async def setup(bot):
    await bot.add_cog(GeneralCog(bot))
