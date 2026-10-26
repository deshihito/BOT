"""Per-guild language selection and the onboarding language reaction panel."""
from __future__ import annotations
import logging
import discord
from discord.ext import commands
from core import localization
from core.guild_settings import get_store

logger = logging.getLogger(__name__)
_PATCHED = False

def install_discord_localization() -> None:
    """Translate every Discord-facing payload at the common transport boundary."""
    global _PATCHED
    if _PATCHED:
        return
    _PATCHED = True

    # These are the common paths used by cogs, webhooks, interactions and edits.
    import discord
    import discord.abc
    targets = (
        (discord.abc.Messageable, "send"),
        (discord.InteractionResponse, "send_message"),
        (discord.InteractionResponse, "edit_message"),
        (discord.InteractionResponse, "send_modal"),
        (discord.Webhook, "send"),
        (discord.Webhook, "edit_message"),
        (discord.Message, "edit"),
        (discord.Interaction, "edit_original_response"),
    )
    for cls, method_name in targets:
        original = getattr(cls, method_name, None)
        if original is None or getattr(original, "_agobot_localized", False):
            continue
        async def localized(self, *args, __original=original, **kwargs):
            from core.localization import localize_kwargs, localize_object, guild_id_for_sender, guild_locale, translate_text
            kwargs = localize_kwargs(self, kwargs)
            args = list(args)
            guild_id = guild_id_for_sender(self)
            locale = guild_locale(guild_id) if guild_id is not None else "en"
            if args and isinstance(args[0], str):
                args[0] = translate_text(args[0], locale)
            elif args:
                args[0] = localize_object(args[0], locale)
            return await __original(self, *args, **kwargs)
        localized._agobot_localized = True
        setattr(cls, method_name, localized)

class LanguageSelect(discord.ui.Select):
    def __init__(self, cog: "LocalizationCog", current: str):
        self.cog = cog
        super().__init__(
            placeholder="Select a language / 言語を選択",
            options=[discord.SelectOption(label=localization.LOCALE_LABELS[locale], value=locale,
                                          emoji=localization.LOCALE_FLAGS[locale], default=locale == current)
                     for locale in localization.SUPPORTED_LOCALES],
            min_values=1, max_values=1,
        )

    async def callback(self, interaction: discord.Interaction):
        locale = localization.normalize_locale(self.values[0])
        await self.cog.set_locale(interaction.guild_id, locale)
        await interaction.response.edit_message(
            embed=self.cog.language_embed(locale, note=localization.text("language_saved", locale,
                                                                         language=localization.LOCALE_LABELS[locale])),
            view=LanguageView(self.cog, locale),
        )

class LanguageView(discord.ui.View):
    def __init__(self, cog: "LocalizationCog", current: str):
        super().__init__(timeout=600)
        self.add_item(LanguageSelect(cog, current))

class LocalizationCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def cog_load(self):
        await get_store().ensure_loaded()

    async def set_locale(self, guild_id: int, locale: str) -> str:
        locale = localization.normalize_locale(locale)
        await get_store().update(guild_id, localization.LANGUAGE_SECTION, locale=locale)
        return locale

    def language_embed(self, locale: str, note: str | None = None) -> discord.Embed:
        description = localization.text("language_settings_description", locale)
        if note:
            description = f"{note}\n\n{description}"
        return discord.Embed(title=localization.text("language_settings_title", locale),
                             description=description, color=0x5865F2)

    async def show_language_settings(self, interaction: discord.Interaction):
        store = get_store()
        await store.ensure_loaded()
        current = localization.guild_locale(interaction.guild_id, store)
        await interaction.response.send_message(embed=self.language_embed(current),
                                                view=LanguageView(self, current), ephemeral=True)

    @commands.Cog.listener()
    async def on_raw_reaction_add(self, payload: discord.RawReactionActionEvent):
        if payload.guild_id is None or payload.user_id == getattr(self.bot.user, "id", None):
            return
        locale = localization.FLAG_TO_LOCALE.get(str(payload.emoji))
        if locale is None:
            return
        permissions = getattr(getattr(payload, "member", None), "guild_permissions", None)
        if not (getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False)):
            return
        store = get_store()
        await store.ensure_loaded()
        settings = localization.locale_settings(store, payload.guild_id)
        if settings.get("panel_message_id") != payload.message_id:
            return
        await self.set_locale(payload.guild_id, locale)
        channel = self.bot.get_channel(payload.channel_id)
        if channel is not None:
            try:
                message = await channel.fetch_message(payload.message_id)
                await message.edit(embed=self.language_embed(locale,
                    note=localization.text("language_saved", locale,
                                           language=localization.LOCALE_LABELS[locale])))
            except discord.HTTPException:
                logger.info("language panel could not be updated", exc_info=True)

async def setup(bot: commands.Bot):
    install_discord_localization()
    await bot.add_cog(LocalizationCog(bot))
