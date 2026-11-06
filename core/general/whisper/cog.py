import discord
from discord.ext import commands
import logging

logger = logging.getLogger(__name__)


class WhisperModal(discord.ui.Modal, title="匿名のつぶやき"):
    content = discord.ui.TextInput(
        label="内容",
        style=discord.TextStyle.paragraph,
        placeholder="つぶやきたい内容を入力してください",
        required=True,
        max_length=1000,
    )

    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        
        embed = discord.Embed(
            description=self.content.value,
            color=discord.Color.blue()
        )
        await interaction.channel.send(embed=embed)

        guild_id = interaction.guild_id
        if self.cog and guild_id in self.cog.active_panels:
            old_channel_id, old_message_id = self.cog.active_panels[guild_id]
            try:
                old_channel = self.cog.bot.get_channel(old_channel_id) or await self.cog.bot.fetch_channel(old_channel_id)
                old_message = await old_channel.fetch_message(old_message_id)
                await old_message.delete()
            except Exception:
                logger.debug("Whisper: 旧パネルの削除に失敗しました", exc_info=True)

        panel_embed = discord.Embed(
            title="匿名のつぶやき",
            description="下のボタンを押してつぶやくことができます。",
            color=discord.Color.blue()
        )
        new_message = await interaction.channel.send(embed=panel_embed, view=WhisperView(self.cog))
        if self.cog:
            self.cog.active_panels[guild_id] = (interaction.channel_id, new_message.id)


class WhisperView(discord.ui.View):
    def __init__(self, cog=None):
        super().__init__(timeout=None)
        self.cog = cog

    @discord.ui.button(label="つぶやき", style=discord.ButtonStyle.primary, custom_id="whisper_button_panel")
    async def whisper_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        cog = self.cog or interaction.client.get_cog("WhisperCog")
        await interaction.response.send_modal(WhisperModal(cog))


class WhisperCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.active_panels = {}

    async def cog_load(self):
        self.bot.add_view(WhisperView(self))

    async def whisper(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)
        guild_id = interaction.guild_id

        if guild_id in self.active_panels:
            old_channel_id, old_message_id = self.active_panels[guild_id]
            try:
                old_channel = self.bot.get_channel(old_channel_id) or await self.bot.fetch_channel(old_channel_id)
                old_message = await old_channel.fetch_message(old_message_id)
                await old_message.delete()
            except Exception:
                logger.debug("Whisper: 旧パネルの削除に失敗しました", exc_info=True)

        embed = discord.Embed(
            title="匿名のつぶやき",
            description="下のボタンを押してつぶやくことができます。",
            color=discord.Color.blue()
        )
        
        message = await interaction.channel.send(embed=embed, view=WhisperView(self))
        self.active_panels[guild_id] = (interaction.channel_id, message.id)

async def setup(bot: commands.Bot):
    await bot.add_cog(WhisperCog(bot))
