"""Comment gacha: draw one past message from the channel and repost it.

トリガー語に反応して、そのチャンネルの全履歴の候補総数を数え、ダイスで
1件を決めてその発言だけを抜き出し、元の投稿者の名前とアバターを付けた
webhook で再投稿する（ガチャ形式）。
"""
from __future__ import annotations

import logging
import random
import time
import uuid
from typing import Any

import discord

from core.support.panel_v2 import as_panel_v2, edit_panel_v2
from core.support.server_assist import Feature, get_settings, update_settings
from core.support.server_assist.features.customreplies import _trigger_key, match_reply
from core.support.server_assist.ui import AssistFeatureView, notice_line
from core.support.server_assist.ui import AssistToggleButton
from core.support.messages import ASSIST_MANAGE_REQUIRED

logger = logging.getLogger(__name__)

KEY = "commentgacha"
# 仮置き（PROVISIONAL）: トリガー語の上限と、履歴走査を伴うため長めに取る
# チャンネル単位クールダウン。ユーザー未決のため定数に集約してある。
MAX_TRIGGERS = 10
COOLDOWN_SECONDS = 60
WEBHOOK_NAME = "AGOBOT-CommentGacha"

FEATURE = Feature(
    key=KEY,
    label="コメントガチャ",
    description="言葉に反応して、そのチャンネルの過去の発言から1件をランダムに再投稿します。",
    order=142,
    module_name=__name__,
)

_last_drawn: dict[str, float] = {}
_webhooks: dict[int, Any] = {}


def reset_cache() -> None:
    _last_drawn.clear()
    _webhooks.clear()


def _normalize(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    trigger = str(raw.get("trigger") or "").strip()
    if not trigger:
        return None
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:8]),
        "trigger": trigger[:100],
        # マッチ方式: "exact"（完全一致・既定）か "contains"（部分一致）。
        # 照合はカスタム返信と共通の match_reply を使う。
        "match": "contains" if raw.get("match") == "contains" else "exact",
    }


def settings(guild_id: int) -> dict[str, Any]:
    raw = get_settings(guild_id, KEY)
    triggers = []
    seen: set[tuple[str, str]] = set()
    for item in raw.get("triggers") or []:
        normalized = _normalize(item)
        if normalized is None:
            continue
        # 重複判定はカスタム返信と同じ (トリガー, マッチ方式) 単位。
        dedupe_key = (_trigger_key(normalized["trigger"]), normalized["match"])
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        triggers.append(normalized)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "triggers": triggers[:MAX_TRIGGERS],
    }


async def _save(guild_id: int, triggers: list[dict[str, Any]]) -> None:
    await update_settings(guild_id, KEY, triggers=triggers[:MAX_TRIGGERS])


def _eligible(message: Any, *, exclude_id: Any) -> bool:
    """ガチャの候補になる発言か。Bot/webhook・空発言・システム発言は除く。"""
    if getattr(message, "id", None) == exclude_id:
        return False
    author = getattr(message, "author", None)
    if author is None or getattr(author, "bot", False):
        return False
    if getattr(message, "webhook_id", None) is not None:
        return False
    message_type = getattr(message, "type", None)
    if message_type is not None and message_type not in (
        discord.MessageType.default,
        discord.MessageType.reply,
    ):
        return False
    content = getattr(message, "content", "") or ""
    attachments = getattr(message, "attachments", None) or []
    return bool(str(content).strip() or attachments)


async def count_candidates(channel: Any, *, exclude_id: Any) -> int:
    """候補になる発言の総数を数える（発言自体は保持しない）。"""
    history = getattr(channel, "history", None)
    if not callable(history):
        return 0
    count = 0
    async for candidate in history(limit=None):
        if _eligible(candidate, exclude_id=exclude_id):
            count += 1
    return count


async def fetch_candidate_at(channel: Any, index: int, *, exclude_id: Any) -> Any | None:
    """候補を先頭から数えて index 番目の1件だけを取り出す（到達したら打ち切る）。

    走査中に発言が削除されて index に届かなかった場合は、最後に見つけた
    候補を返す（ガチャ自体は止めない）。
    """
    history = getattr(channel, "history", None)
    if not callable(history):
        return None
    seen = -1
    last: Any | None = None
    async for candidate in history(limit=None):
        if not _eligible(candidate, exclude_id=exclude_id):
            continue
        seen += 1
        last = candidate
        if seen == index:
            return candidate
    return last


async def draw_random_message(channel: Any, *, exclude_id: Any) -> Any | None:
    """候補の総数を取得 → ダイスロール → 当たりの1件だけを抜き出す。"""
    total = await count_candidates(channel, exclude_id=exclude_id)
    if total <= 0:
        return None
    index = random.randrange(total)
    return await fetch_candidate_at(channel, index, exclude_id=exclude_id)


async def _gacha_webhook(channel: Any) -> Any:
    """Return the per-channel webhook used for gacha reposts."""
    parent = channel.parent if isinstance(channel, discord.Thread) else channel
    cached = _webhooks.get(parent.id)
    if cached is not None:
        return cached
    webhooks = await parent.webhooks()
    webhook = discord.utils.get(webhooks, name=WEBHOOK_NAME)
    if webhook is None:
        webhook = await parent.create_webhook(name=WEBHOOK_NAME)
    _webhooks[parent.id] = webhook
    return webhook


async def _repost(channel: Any, source: Any) -> None:
    webhook = await _gacha_webhook(channel)
    files = []
    for attachment in getattr(source, "attachments", None) or []:
        try:
            files.append(await attachment.to_file(use_cached=True))
        except (discord.HTTPException, AttributeError):
            # 添付が取得できない場合は本文だけでも再投稿する。
            logger.debug("コメントガチャの添付取得に失敗しました", exc_info=True)
    author = source.author
    kwargs: dict[str, Any] = {
        "content": (getattr(source, "content", "") or "")[:2000] or None,
        "username": str(getattr(author, "display_name", "メンバー"))[:80],
        "avatar_url": str(author.display_avatar.url),
        "files": files,
        "allowed_mentions": discord.AllowedMentions.none(),
        # 再投稿は原文のまま出す（自動翻訳/ローカライズをかけない）。
        "_agobot_skip_localization": True,
    }
    if isinstance(channel, discord.Thread):
        kwargs["thread"] = channel
    await webhook.send(**kwargs)


async def on_message(cog: Any, message: Any) -> None:
    guild = getattr(message, "guild", None)
    author = getattr(message, "author", None)
    content = getattr(message, "content", "") or ""
    if guild is None or author is None or getattr(author, "bot", False):
        return
    if content.lstrip().startswith(("/", "!")):
        return
    current = settings(guild.id)
    if not current["enabled"]:
        return
    if match_reply(current["triggers"], content) is None:
        return
    channel = getattr(message, "channel", None)
    if channel is None:
        return
    key = f"{guild.id}:{getattr(channel, 'id', 0)}"
    now = time.time()
    if now - _last_drawn.get(key, 0.0) < COOLDOWN_SECONDS:
        return
    # 走査の前に記録し、同時発動で履歴走査が重ならないようにする。
    _last_drawn[key] = now
    me = getattr(guild, "me", None)
    permissions = None
    if me is not None:
        try:
            permissions = channel.permissions_for(me)
        except Exception:
            permissions = None
    if permissions is not None and not (
        getattr(permissions, "manage_webhooks", False)
        and getattr(permissions, "read_message_history", False)
    ):
        logger.warning(
            "コメントガチャにはWebhook管理とメッセージ履歴の閲覧権限が必要です (guild=%s channel=%s)",
            guild.id,
            getattr(channel, "id", None),
        )
        return
    try:
        source = await draw_random_message(channel, exclude_id=getattr(message, "id", None))
        if source is None:
            return
        await _repost(channel, source)
    except (discord.Forbidden, discord.HTTPException):
        logger.debug("コメントガチャの再投稿に失敗しました: guild=%s", guild.id)


class CommentGachaTriggerSelect(discord.ui.Select):
    def __init__(self, parent: "CommentGachaSettingsView"):
        self.parent_view = parent
        options = [
            discord.SelectOption(
                label=trigger["trigger"][:100],
                value=trigger["id"],
                default=trigger["id"] == parent.selected_id,
            )
            for trigger in parent.settings["triggers"]
        ]
        if not options:
            options = [discord.SelectOption(label="トリガー語はありません", value="__none__")]
        super().__init__(placeholder="編集・削除するトリガー語を選択", options=options[:25], row=0)

    async def callback(self, interaction: discord.Interaction):
        if self.values[0] == "__none__":
            self.parent_view.selected_id = None
            return await interaction.response.send_message("トリガー語がありません。", ephemeral=True)
        self.parent_view.selected_id = self.values[0]
        await self.parent_view.reopen(interaction, "トリガー語を選択しました。")


class CommentGachaAddButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="トリガー語を追加", style=discord.ButtonStyle.success, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: CommentGachaSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        if len(view.settings["triggers"]) >= MAX_TRIGGERS:
            return await interaction.response.send_message(
                f"トリガー語は最大{MAX_TRIGGERS}件です。", ephemeral=True,
            )
        return await interaction.response.send_modal(CommentGachaModal(view))


class CommentGachaEditButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="編集", style=discord.ButtonStyle.primary, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: CommentGachaSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        trigger = view.selected_trigger()
        if trigger is None:
            return await interaction.response.send_message("先にトリガー語を選んでください。", ephemeral=True)
        return await interaction.response.send_modal(CommentGachaModal(view, trigger))


class CommentGachaDeleteButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="削除", style=discord.ButtonStyle.danger, row=2)

    async def callback(self, interaction: discord.Interaction):
        view: CommentGachaSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        if view.selected_id is None:
            return await interaction.response.send_message("先にトリガー語を選んでください。", ephemeral=True)
        triggers = [
            trigger for trigger in settings(view.guild_id)["triggers"]
            if trigger.get("id") != view.selected_id
        ]
        await _save(view.guild_id, triggers)
        view.selected_id = None
        await view.reopen(interaction, "トリガー語を削除しました。")


class CommentGachaMatchButton(discord.ui.Button):
    """選択中のトリガー語のマッチ方式（完全一致／部分一致）を切り替える。"""

    def __init__(self):
        super().__init__(label="マッチ切替", style=discord.ButtonStyle.secondary, row=3)

    async def callback(self, interaction: discord.Interaction):
        view: CommentGachaSettingsView = self.view
        if not view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        trigger = view.selected_trigger()
        if trigger is None:
            return await interaction.response.send_message("先にトリガー語を選んでください。", ephemeral=True)
        new_match = "exact" if trigger.get("match") == "contains" else "contains"
        triggers = list(settings(view.guild_id)["triggers"])
        for item in triggers:
            if item.get("id") == view.selected_id:
                item["match"] = new_match
                break
        else:
            return await interaction.response.send_message("そのトリガー語は既にありません。", ephemeral=True)
        await _save(view.guild_id, triggers)
        await view.reopen(
            interaction,
            f"マッチ方式を{'部分一致（含む）' if new_match == 'contains' else '完全一致'}にしました。",
        )


class CommentGachaModal(discord.ui.Modal):
    def __init__(self, parent: "CommentGachaSettingsView", trigger: dict[str, Any] | None = None):
        super().__init__(title="トリガー語を編集" if trigger else "トリガー語を追加")
        self.parent_view = parent
        self.trigger = trigger
        self.trigger_input = discord.ui.TextInput(
            label="反応する言葉",
            default=str((trigger or {}).get("trigger") or "")[:100],
            max_length=100,
            required=True,
        )
        self.add_item(self.trigger_input)

    async def on_submit(self, interaction: discord.Interaction):
        if not self.parent_view.can_manage(interaction):
            return await interaction.response.send_message(
                ASSIST_MANAGE_REQUIRED, ephemeral=True,
            )
        word = str(self.trigger_input.value or "").strip()
        if not word:
            return await interaction.response.send_message("言葉を入力してください。", ephemeral=True)
        triggers = list(settings(self.parent_view.guild_id)["triggers"])
        trigger_key = _trigger_key(word)
        own_match = (self.trigger or {}).get("match", "exact")
        duplicate = next(
            (
                item for item in triggers
                if item.get("id") != (self.trigger or {}).get("id")
                and _trigger_key(item.get("trigger", "")) == trigger_key
                and item.get("match", "exact") == own_match
            ),
            None,
        )
        if duplicate is not None:
            return await interaction.response.send_message(
                f"同じトリガー `{duplicate['trigger']}` は既に登録されています。別の言葉を指定してください。",
                ephemeral=True,
            )
        if self.trigger:
            found = False
            for item in triggers:
                if item.get("id") == self.trigger.get("id"):
                    item.update({"trigger": word[:100]})
                    found = True
                    break
            if not found:
                return await interaction.response.send_message(
                    "このトリガー語はすでに削除されています。", ephemeral=True,
                )
            selected = self.trigger.get("id")
        else:
            selected = uuid.uuid4().hex[:8]
            triggers.append({
                "id": selected,
                "trigger": word[:100],
                "match": "exact",
            })
        await _save(self.parent_view.guild_id, triggers)
        self.parent_view.selected_id = selected
        await self.parent_view.reopen(interaction, "トリガー語を保存しました。")


class CommentGachaSettingsView(AssistFeatureView):
    feature_key = KEY

    def __init__(self, cog: Any, guild_id: int):
        self.settings = settings(guild_id)
        self.selected_id: str | None = None
        super().__init__(cog, guild_id)
        self.add_item(CommentGachaTriggerSelect(self))
        self.add_item(CommentGachaAddButton())
        self.add_item(CommentGachaEditButton())
        self.add_item(CommentGachaDeleteButton())
        self.add_item(AssistToggleButton("enabled", "コメントガチャ", reopen=True))
        self.add_item(CommentGachaMatchButton())

    def selected_trigger(self) -> dict[str, Any] | None:
        if self.selected_id is None:
            return None
        return next(
            (t for t in self.settings["triggers"] if t.get("id") == self.selected_id),
            None,
        )

    async def reopen(self, interaction: discord.Interaction, notice: str | None = None):
        view = CommentGachaSettingsView(self.cog, self.guild_id)
        view.selected_id = self.selected_id
        view.notice = notice
        return await edit_panel_v2(interaction, as_panel_v2(view))

    def embed(self) -> discord.Embed:
        lines = []
        for trigger in self.settings["triggers"]:
            mark = "▶ " if trigger.get("id") == self.selected_id else ""
            suffix = "（部分一致）" if trigger.get("match") == "contains" else ""
            lines.append(f"{mark}{trigger['trigger']}{suffix}")
        return discord.Embed(
            title="コメントガチャ",
            description=(
                "トリガー語が投稿されたチャンネルの過去の発言から、1件をランダムに再投稿します。"
                f"\n\n**状態**: {'オン' if self.settings['enabled'] else 'オフ'}"
                f"\n**登録数**: {len(self.settings['triggers'])}/{MAX_TRIGGERS}"
                f"\n\n{chr(10).join(lines) if lines else 'トリガー語はありません。'}"
                + notice_line(self.notice)
            )[:4096],
            color=0xFFFFFF,
        )


def build_view(cog: Any, guild_id: int) -> CommentGachaSettingsView:
    return CommentGachaSettingsView(cog, guild_id)
