import asyncio
import random
import discord
from discord.ext import commands

from core.game.game import game_records
from core.game.game.game_v2 import text_panel


class FlashModal(discord.ui.Modal, title="フラッシュ暗算"):
  count = discord.ui.TextInput(label="数字の個数（1〜20）", default="5", max_length=2)
  interval = discord.ui.TextInput(label="表示の間隔（秒、1.0以上）", default="1.0", max_length=5)
  digits = discord.ui.TextInput(label="桁数（1〜6）", default="1", max_length=1)

  def __init__(self, cog):
    super().__init__()
    self.cog = cog

  async def on_submit(self, interaction: discord.Interaction):
    try:
      count = int(str(self.count.value).strip())
      interval = float(str(self.interval.value).strip())
      digits = int(str(self.digits.value).strip())
    except ValueError:
      await interaction.response.send_message("半角の数字で入力してください。", ephemeral=True)
      return
    await self.cog.play(interaction, count, interval, digits)


class FlashMentalArithmetic(commands.Cog):

  def __init__(self, bot: commands.Bot):
    self.bot = bot

  async def start_recruit(self, interaction: discord.Interaction):
    """/game のハブから呼ぶ。個数・間隔・桁数を入れるフォームを出す。"""
    await interaction.response.send_modal(FlashModal(self))

  async def play(
      self, interaction: discord.Interaction, count: int, interval: float, digits: int
  ):
    # Discordのレートリミット（同一チャンネルのメッセージ編集/送信頻度）を考慮し、
    # 連続リクエストが過剰にならないよう最低間隔を1.0秒以上に制限（必要に応じて調整してください）
    if interval < 1.0:
      interval = 1.0

    if count < 1 or digits < 1 or count > 20 or digits > 6:
      await interaction.response.send_message(
          "引数の値が不正です。個数は1〜20、桁数は1〜6で指定してください。",
          ephemeral=True,
      )
      return

    min_val = 10 ** (digits - 1)
    val_range = (10 ** digits) - min_val

    numbers = [random.randint(min_val, min_val + val_range - 1) for _ in range(count)]
    total_sum = sum(numbers)

    await interaction.response.send_message(view=text_panel(
        "",
        f"フラッシュ暗算を開始します。\n数字の個数: {count}個 / 表示間隔: {interval}秒 / 桁数: {digits}桁\nまもなく開始します..."))

    await asyncio.sleep(2)

    for num in numbers:
      try:
        await interaction.edit_original_response(view=text_panel("", f"# {num}"))
      except discord.HTTPException as e:
        if e.status == 429:
          # 万が一レートリミットに達した場合は、指定された秒数待機するか安全に離脱
          retry_after = getattr(e, "retry_after", 2.0)
          await asyncio.sleep(retry_after)
        else:
          raise e
      await asyncio.sleep(interval)

    await interaction.edit_original_response(view=text_panel("", "終了！答えをチャットに送信してください。"))

    def check(m: discord.Message):
      return (
          m.channel == interaction.channel
          and m.author == interaction.user
          and m.content.isdigit()
      )

    try:
      msg = await self.bot.wait_for("message", timeout=30.0, check=check)
    except asyncio.TimeoutError:
      line = self._record_line(interaction.user.id, count, interval, digits, False)
      await interaction.followup.send(view=text_panel(
          "", f"時間切れです。正解は **{total_sum}** でした。{line}"))
      return

    correct = int(msg.content) == total_sum
    line = self._record_line(interaction.user.id, count, interval, digits, correct)
    if correct:
      await interaction.followup.send(view=text_panel(
          "", f"正解です！おめでとうございます！ (答え: {total_sum}){line}"))
    else:
      await interaction.followup.send(view=text_panel(
          "", f"不正解です...。正解は **{total_sum}** でした。{line}"))

  def _record_line(self, user_id, count: int, interval: float, digits: int, correct: bool) -> str:
    # 設定ごとの自己ベスト（core/game/game/game_records.py）。記録できなければ何も付けない。
    entry = game_records.record_flash_safely(user_id, count, digits, interval, correct)
    if entry is None:
      return ""
    return "\n" + game_records.format_flash_line(entry, count, digits, interval)


async def setup(bot: commands.Bot):
  await bot.add_cog(FlashMentalArithmetic(bot))
