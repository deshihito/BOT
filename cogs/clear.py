import discord
from discord import app_commands
from discord.ext import commands
from typing import Optional

MAX_CLEAR = 100


class ClearCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def clear(self, interaction: discord.Interaction, amount: app_commands.Range[int, 1, MAX_CLEAR],
                    member: Optional[discord.Member] = None):
        # default_permissions はサーバー側の設定で変えられるので、実行時にも必ず確かめる。
        if interaction.guild is None:
            await interaction.response.send_message("このコマンドはサーバー内でのみ使えます。", ephemeral=True)
            return
        if not interaction.permissions.manage_messages:
            await interaction.response.send_message(
                "このコマンドを使うには「メッセージの管理」権限が必要です。", ephemeral=True)
            return
        if not isinstance(amount, int) or not 1 <= amount <= MAX_CLEAR:
            await interaction.response.send_message(
                f"削除する数は 1〜{MAX_CLEAR} の範囲で指定してください。", ephemeral=True)
            return
        if not isinstance(interaction.channel, (discord.TextChannel, discord.VoiceChannel, discord.Thread)):
            await interaction.response.send_message("このチャンネルでは実行できません。", ephemeral=True)
            return
        bot_permissions = interaction.app_permissions
        if not (bot_permissions.manage_messages and bot_permissions.read_message_history):
            await interaction.response.send_message(
                "Bot にこのチャンネルの「メッセージの管理」と「メッセージ履歴を読む」権限がないため、削除できません。",
                ephemeral=True,
            )
            return

        await interaction.response.defer()

        def check(message: discord.Message) -> bool:
            if member is None:
                return True
            return message.author.id == member.id

        try:
            deleted = await interaction.channel.purge(limit=amount, check=check)
        except discord.Forbidden:
            await interaction.followup.send(
                "Bot に必要な権限がないため、メッセージを削除できませんでした。", ephemeral=True)
            return
        except discord.HTTPException:
            await interaction.followup.send(
                "メッセージの削除中にエラーが発生しました。時間を置いて再度お試しください。", ephemeral=True)
            return

        target = f"{member.display_name} さんの" if member else ""
        await interaction.followup.send(f"{target}メッセージを {len(deleted)} 件削除しました。")


async def setup(bot: commands.Bot):
    await bot.add_cog(ClearCog(bot))
