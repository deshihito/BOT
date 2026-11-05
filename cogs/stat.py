import discord
from discord.ext import commands

from cogs.terminal import ALLOWED_USER_IDS
import sys
import importlib.metadata
import io

class SystemInfoCog(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @commands.command(name="check_api")
    async def check_api(self, ctx: commands.Context):
        """インストールされているライブラリの一覧（Bot の持ち主専用）。"""
        if ctx.author.id not in ALLOWED_USER_IDS:
            return
        
        python_version = sys.version.split()[0]
        try:
            discord_version = importlib.metadata.version("discord.py")
        except importlib.metadata.PackageNotFoundError:
            discord_version = "Unknown"

        base_message = f"Python Version: {python_version}\ndiscord.py Version: {discord_version}\n\n"
        
        distributions = sorted([f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions()])
        package_list = "\n".join(distributions)
        
        if len(base_message) + len(package_list) < 1900:
            await ctx.send(f"```\n{base_message}{package_list}\n```")
        else:
            file = discord.File(fp=io.StringIO(package_list), filename="packages.txt")
            await ctx.send(f"```\n{base_message}詳細なパッケージ一覧は添付ファイルを確認してください。\n```", file=file)

async def setup(bot):
    await bot.add_cog(SystemInfoCog(bot))
