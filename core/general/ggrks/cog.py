import discord
from discord.ext import commands
import urllib.parse

class GoogleSearch(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    @commands.command(name='ggrks')
    async def ggrks(self, ctx, *, keyword: str):
        """指定されたワードのGoogle検索リンクを表示します。"""
        
        # 検索ワードをURLエンコード
        encoded_keyword = urllib.parse.quote(keyword)
        google_url = f"https://www.google.com/search?q={encoded_keyword}"
        
        # Embedの作成 (色は白色: 0xFFFFFF)
        embed = discord.Embed(
            description=f"**ggrksを使用しました**\n[次からは自分でggrks]({google_url})",
            color=0xFFFFFF
        )

        await ctx.send(embed=embed)

async def setup(bot):
    await bot.add_cog(GoogleSearch(bot))
