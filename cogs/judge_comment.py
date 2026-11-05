import aiohttp
import discord
from discord.ext import commands
from core.autoplay import DEFAULT_D1_ENDPOINT

class JudgeCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.endpoint = DEFAULT_D1_ENDPOINT
        
        # オプション（評価軸）の設定定義
        self.options = {
            "難解": {
                "instructions": "How esoteric, complex, or difficult to comprehend is this text?",
                "criteria": [
                    "Extremely simple and direct",
                    "Common and clear",
                    "Slightly complex or technical",
                    "Hard to understand or abstract",
                    "Extremely complex, esoteric, or incomprehensible"
                ]
            },
            "知能": {
                "instructions": "How intelligent, logical, and insightful is this text?",
                "criteria": [
                    "No logic, highly uneducated or nonsensical",
                    "Basic and mundane statement",
                    "Logical and well-structured",
                    "Highly intelligent and analytical",
                    "Genius-level, profoundly insightful and academic"
                ]
            },
            "キチガイ": {
                "instructions": "How crazy, unhinged, absurd, or bizarre is this text?",
                "criteria": [
                    "Completely normal and sane",
                    "Slightly odd or unusual",
                    "Noticeably bizarre or eccentric",
                    "Highly unhinged and chaotic",
                    "Extremely crazy, insane, or completely absurd"
                ]
            },
            "大喜利": {
                "instructions": "How funny, witty, clever, or comedy-focused is this response?",
                "criteria": [
                    "Not funny at all, completely serious or boring",
                    "Slightly amusing",
                    "Moderately funny or clever response",
                    "Very funny, witty, and clever Ogiri answer",
                    "Masterpiece of humor, extremely funny and genius wit"
                ]
            }
        }

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        # ボット自身のメッセージは無視
        if message.author.bot:
            return

        # 1. リプライかつボットへのメンションが含まれているか確認
        if not message.reference or not self.bot.user.mentioned_in(message):
            return

        # 2. メッセージ内に指定オプションが含まれているか判定
        selected_option = None
        for option_name in self.options.keys():
            if option_name in message.content:
                selected_option = option_name
                break

        # オプション指定がない場合は処理を行わない
        if not selected_option:
            return

        # 3. リプライ先のメッセージを取得
        try:
            referenced_msg = await message.channel.fetch_message(message.reference.message_id)
        except (discord.NotFound, discord.HTTPException):
            return

        target_text = referenced_msg.content
        if not target_text:
            await message.reply("評価対象のメッセージにテキストが存在しません。")
            return

        # 4. d1-omni へ判定リクエストを作成
        config = self.options[selected_option]
        payload = {
            "state": target_text,
            "questions": {
                "eval": {
                    "type": "score",
                    "instructions": config["instructions"],
                    "criteria": config["criteria"]
                }
            }
        }

        # 5. エンドポイントへPOSTリクエストを送信
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(self.endpoint, json=payload, timeout=10) as resp:
                    if resp.status == 200:
                        result = await resp.json()
                        eval_data = result.get("answers", {}).get("eval", {})
                        
                        # scoreタイプで返される値（1.0〜5.0）を0〜100点に換算
                        # (score - 1) / (5 - 1) * 100
                        raw_score = eval_data.get("score", 1.0)
                        final_score = round((raw_score - 1.0) / 4.0 * 100)
                        
                        await message.reply(
                            f"【{selected_option}評価】 **{final_score}** / 100点"
                        )
                    else:
                        await message.reply(f"評価サーバーエラーが発生しました (Status: {resp.status})")
        except Exception as e:
            await message.reply(f"通信エラーが発生しました: {str(e)}")

async def setup(bot: commands.Bot):
    await bot.add_cog(JudgeCog(bot))
