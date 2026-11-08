# -*- coding: utf-8 -*-
"""AI 既定値・推論設定の UI。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *

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
        selected = self.values[0] if self.values else ""
        if selected not in self.model_ids:
            return await interaction.response.send_message(
                "選択したモデルは現在のモデル一覧にありません。設定画面を開き直してください。",
                ephemeral=True,
            )
        try:
            if self.kind == "chat":
                await ai_preferences.set_model(self.user_id, selected)
            else:
                await ai_preferences.set_image_model(self.user_id, selected)
        except Exception:
            logger.exception("AI model preference save failed: user=%s", self.user_id)
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
        next_page = self.owner_view.page + self.direction
        if next_page < 0 or next_page >= self.owner_view.page_count:
            return await interaction.response.send_message(
                "そのページは存在しません。設定画面を開き直してください。", ephemeral=True
            )
        self.owner_view.page = next_page
        self.owner_view.refresh_select()
        if hasattr(self.view, "panel"):
            await self.view.refresh(interaction)
        else:
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

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

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
                logfare_error = None
                try:
                    models.extend(await logfare.fetch_free_chat_models())
                except Exception as exc:
                    logfare_error = exc
                try:
                    kios_models = await ai_provider_router.fetch_kiosapi_models()
                    models.extend({
                        **model,
                        "id": f"kiosapi::{model['id']}",
                        "name": f"KiosAPI · {model['id']}",
                    } for model in kios_models)
                except Exception:
                    logger.warning("AI設定: KiosAPI のモデル一覧の取得に失敗しました", exc_info=True)
                try:
                    apinex_models = await ai_provider_router.fetch_apinex_free_models()
                    models.extend({
                        **model,
                        "id": f"apinex::{model['id']}",
                        "name": f"APInex Free · {model['id'].removeprefix('free/')}",
                    } for model in apinex_models)
                except Exception:
                    logger.warning("AI設定: APInex のモデル一覧の取得に失敗しました", exc_info=True)
                models.extend(ai_omnirush.model_choices())
                if not models and logfare_error:
                    raise logfare_error
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
                f"{'チャット' if self.kind == 'chat' else '画像生成'}モデルを選べます。"
                f"{'自動切替を選ぶと設定済みのAPIを順に使います。' if self.kind == 'chat' else ''}"
                f"{'画像入力は対応モデルのみ利用できます。OmniRushは質問を同サービスへ送信します（[プライバシー](https://omnirush.ai/privacy)）。Logfareの一部モデルはトレーニング利用への同意が必要です。' if self.kind == 'chat' else ''}\n"
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

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    @classmethod
    async def create(cls, user_id: int):
        await ai_preferences.ensure_loaded()
        model_id = ai_preferences.get_model(user_id) or logfare.configured_default_model()
        if model_id == ai_provider_router.AUTO_MODEL:
            return None, "自動切替モデルでは、この思考強度設定を使えません。"
        if model_id.startswith("kiosapi::"):
            return None, f"モデル `{model_id.removeprefix('kiosapi::')}` はこの接続先の思考強度設定に対応していません。"
        if model_id.startswith("apinex::"):
            apinex_model = model_id.removeprefix("apinex::")
            efforts = ai_provider_router.supported_reasoning_efforts("apinex", apinex_model)
            if not efforts:
                return None, f"APInexモデル `{apinex_model}` は思考強度の設定に対応していません。"
            return cls(user_id, model_id, efforts), None
        if model_id.startswith("omnirush::"):
            efforts = ai_omnirush.supports_reasoning_efforts(model_id)
            if not efforts:
                return None, "選択したOmniRushモデルは思考強度を設定できません。"
            return cls(user_id, model_id, efforts), None
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
