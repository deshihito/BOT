# -*- coding: utf-8 -*-
"""翻訳設定の UI と翻訳リスナー。元 cogs/general.py から分割。"""
from __future__ import annotations

from .common import *

class TranslationLocaleSelect(discord.ui.Select):
    def __init__(self, parent: "TranslationView", *, source: bool):
        self.parent_view = parent
        self.source = source
        locales = translation.SOURCE_LOCALES if source else localization.SUPPORTED_LOCALES
        current = parent.source_locale if source else parent.target_locale
        labels = translation.SOURCE_LOCALE_LABELS if source else localization.LOCALE_LABELS
        flags = translation.SOURCE_LOCALE_FLAGS if source else localization.LOCALE_FLAGS
        super().__init__(
            placeholder="翻訳前の言語を選択してください" if source else "翻訳後の言語を選択してください",
            options=[
                discord.SelectOption(label=labels[locale], value=locale, emoji=flags[locale], default=locale == current)
                for locale in locales
            ],
            row=0 if source else 1,
        )

    async def callback(self, interaction: discord.Interaction):
        locale = (
            translation.normalize_source_locale(self.values[0])
            if self.source else localization.normalize_locale(self.values[0])
        )
        if self.source:
            self.parent_view.source_locale = locale
            await translation_settings_update(self.parent_view.user_id, source_locale=locale)
        else:
            self.parent_view.target_locale = locale
            await translation_settings_update(self.parent_view.user_id, target_locale=locale)
        # パネルは as_panel_v2 で送信された V2 メッセージなので、embed= 付きの
        # 編集は Discord に 50035 で拒否される。refresh で部品を作り直してから
        # V2 の編集経路 (edit_panel_v2) で再描画する (MiqSettingsView.commit と同型)。
        self.parent_view.refresh()
        await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


class TranslationToggleButton(discord.ui.Button):
    def __init__(self, parent: "TranslationView", enabled: bool):
        self.parent_view = parent
        super().__init__(
            label="自動翻訳をオフにする" if enabled else "自動翻訳をオンにする",
            style=discord.ButtonStyle.danger if enabled else discord.ButtonStyle.success,
            row=2,
        )

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.enabled = not self.parent_view.enabled
        await translation_settings_update(self.parent_view.user_id, enabled=self.parent_view.enabled)
        self.parent_view.refresh()
        # 言語セレクトと同じく V2 の編集経路で再描画する (embed= は 50035 になる)。
        await edit_panel_v2(interaction, as_panel_v2(self.parent_view))


async def translation_settings_update(
    user_id: int, *, enabled: bool | None = None,
    source_locale: str | None = None, target_locale: str | None = None,
):
    return await translation.update_translation_settings(
        user_id, enabled=enabled, source_locale=source_locale, target_locale=target_locale
    )


class TranslationView(discord.ui.View):
    def __init__(self, user_id: int, guild_id: int):
        super().__init__(timeout=300)
        self.user_id, self.guild_id = user_id, guild_id
        settings = translation.translation_settings(user_id, guild_id)
        self.enabled = settings["enabled"]
        self.source_locale = settings["source_locale"]
        self.target_locale = settings["target_locale"]
        self.refresh()

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def refresh(self):
        self.clear_items()
        self.add_item(TranslationLocaleSelect(self, source=True))
        self.add_item(TranslationLocaleSelect(self, source=False))
        self.add_item(TranslationToggleButton(self, self.enabled))

    def embed(self):
        status = "オン" if self.enabled else "オフ"
        source = translation.SOURCE_LOCALE_LABELS[self.source_locale]
        target = localization.LOCALE_LABELS[self.target_locale]
        return discord.Embed(
            title="自動翻訳設定",
            description=(
                f"状態: **{status}**\n"
                f"翻訳前: **{source}** → 翻訳後: **{target}**\n\n"
                "オンにすると、あなたのメッセージを削除し、"
                "送信者の名前とアイコンで翻訳結果を再投稿します。"
            ),
            color=0x5865F2,
        )


class TranslationMixin:
    """GeneralCog の一部。cogs/general.py で合成される。"""

    async def _translation_webhook(self, channel):
        """Return the per-channel webhook used for translated messages."""
        parent = channel.parent if isinstance(channel, discord.Thread) else channel
        cached = self._translation_webhooks.get(parent.id)
        if cached is not None:
            return cached
        webhooks = await parent.webhooks()
        webhook = discord.utils.get(webhooks, name="AGOBOT-Translate")
        if webhook is None:
            webhook = await parent.create_webhook(name="AGOBOT-Translate")
        self._translation_webhooks[parent.id] = webhook
        return webhook


    @commands.Cog.listener("on_message")
    async def on_message_translation(self, message: discord.Message):
        """Replace human messages with a webhook-posted translation when enabled."""
        if (
            message.guild is None
            or message.author.bot
            or message.webhook_id is not None
            or (not message.content.strip() and not message.attachments)
        ):
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = translation.translation_settings(message.author.id, message.guild.id)
        if not settings["enabled"]:
            return

        me = message.guild.me
        permissions = message.channel.permissions_for(me) if me is not None else None
        if not permissions or not permissions.manage_messages or not permissions.manage_webhooks:
            logger.warning(
                "自動翻訳にはメッセージ管理とWebhook管理権限が必要です (guild=%s channel=%s)",
                message.guild.id, message.channel.id,
            )
            return

        try:
            files = []
            for attachment in message.attachments:
                # Download before deleting the source message.  use_cached=True
                # also keeps Discord CDN URLs usable after the source is removed.
                files.append(await attachment.to_file(use_cached=True))
            translated = await translation.translate_message(
                message.content,
                settings["source_locale"],
                settings["target_locale"],
                client=self._translation_client,
            )
            webhook = await self._translation_webhook(message.channel)
            await message.delete()
            kwargs = {
                "content": translated or None,
                "username": str(message.author.display_name)[:80],
                "avatar_url": str(message.author.display_avatar.url),
                "files": files,
                "allowed_mentions": discord.AllowedMentions.none(),
                "_agobot_skip_localization": True,
            }
            if isinstance(message.channel, discord.Thread):
                kwargs["thread"] = message.channel
            await webhook.send(**kwargs)
        except LibreTranslateError:
            logger.warning("自動翻訳APIの呼び出しに失敗しました (guild=%s)", message.guild.id, exc_info=True)
        except discord.NotFound:
            # 元メッセージ（または送信先）が既に消えていた競合。実害なし。
            logger.info("自動翻訳の対象が既に削除されていました (guild=%s)", message.guild.id)
        except discord.HTTPException:
            logger.warning("自動翻訳メッセージの削除または送信に失敗しました", exc_info=True)
        except Exception:
            logger.exception("自動翻訳で予期しないエラーが発生しました")
