import time
import asyncio
import aiohttp
from discord.ext import commands

from cogs.terminal import ALLOWED_USER_IDS
from core.autoplay import DEFAULT_D1_ENDPOINT

class D1TestCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.endpoint = DEFAULT_D1_ENDPOINT
        self.service_name = "llama-d1-omni"

    async def _test_response(self) -> tuple[bool, float]:
        """サーバーへテスト送信を行い、(成功判定, 応答時間ms) を返します。"""
        payload = {
            "state": "ping",
            "questions": {
                "ping": {
                    "type": "noul",
                    "instructions": "Is this a test?"
                }
            }
        }
        
        start_time = time.perf_counter()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.endpoint, 
                    json=payload, 
                    timeout=aiohttp.ClientTimeout(total=3.0)
                ) as resp:
                    if resp.status == 200:
                        elapsed_ms = (time.perf_counter() - start_time) * 1000
                        return True, elapsed_ms
                    return False, 0.0
        except Exception:
            return False, 0.0

    async def _start_service(self) -> bool:
        """systemdサービス起動コマンドを実行します。"""
        proc = await asyncio.create_subprocess_exec(
            "sudo", "systemctl", "start", self.service_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        await proc.communicate()
        return proc.returncode == 0

    @commands.command(name="d1ping")
    async def d1ping(self, ctx: commands.Context):
        """d1-omni サーバーの応答テストと自動起動（Bot の持ち主専用）。"""
        if ctx.author.id not in ALLOWED_USER_IDS:
            return
        is_running, elapsed_ms = await self._test_response()
        if is_running:
            await ctx.send(f"**[d1-omni]** サーバーは稼働中です。\n応答速度: `{elapsed_ms:.2f} ms`")
            return
        await ctx.send("**[d1-omni]** 応答が確認できませんでした。サービスを起動します...")
        if await self._start_service():
            await ctx.send("起動リクエストを送信しました。モデルロード完了まで数秒お待ちください。")
        else:
            await ctx.send("起動コマンドの実行に失敗しました。`sudoers` の権限設定を確認してください。")

async def setup(bot: commands.Bot):
    await bot.add_cog(D1TestCog(bot))
