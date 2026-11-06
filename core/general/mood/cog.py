import discord
from discord.ext import commands
import datetime
from groq import AsyncGroq
import os

class MoodAnalysis(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY"))
        self.model = "llama-3.3-70b-versatile"

    @commands.command()
    async def mood(self, ctx):
        await ctx.send("分析を開始します。メッセージ履歴の取得に時間がかかる場合があります。")

        three_weeks_ago = discord.utils.utcnow() - datetime.timedelta(days=21)
        messages_text = []

        async for message in ctx.channel.history(limit=1000, after=three_weeks_ago):
            if not message.author.bot and message.content:
                if not message.content.startswith(ctx.prefix):
                    messages_text.append(message.content)

        if not messages_text:
            await ctx.send("分析対象のメッセージが見つかりませんでした。")
            return

        combined_messages = "\n".join(messages_text)
        
        prompt = (
            f"以下のテキストは、あるチャネルの過去3週間のチャット発言履歴です。\n"
            f"これらの発言から、チャンネル全体の雰囲気（ムード）、主な話題、活気などを分析し、要約してください。\n\n"
            f"発言履歴:\n{combined_messages}"
        )

        try:
            chat_completion = await self.client.chat.completions.create(
                messages=[
                    {
                        "role": "user",
                        "content": prompt,
                    }
                ],
                model=self.model,
            )
            analysis_result = chat_completion.choices[0].message.content
            
            if len(analysis_result) > 2000:
                for i in range(0, len(analysis_result), 2000):
                    await ctx.send(analysis_result[i:i+2000])
            else:
                await ctx.send(analysis_result)

        except Exception as e:
            await ctx.send(f"エラーが発生しました: {e}")

async def setup(bot):
    await bot.add_cog(MoodAnalysis(bot))
