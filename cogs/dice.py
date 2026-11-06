"""通常メッセージで使えるダイス機能。"""
from __future__ import annotations
from core.emojis import DICE

import random
import re

import discord
from discord.ext import commands


# Pythonの任意精度整数を利用しつつ、メッセージ長・計算量の暴走を防ぐ。
MAX_SIDES_DIGITS = 1000
MAX_SIDES = 10**MAX_SIDES_DIGITS
MAX_DICE_COUNT = 100
_DICE_PATTERN = re.compile(r"^([0-9]+)(id|d)(any|[0-9]+)(?:\s+(int8))?$")


def parse_dice_message(content: str) -> tuple[int, str, int | None, bool] | None:
    """ダイス表記を解釈する。

    対応形式は ``1d100``、``3d8``、``4id7``、``1dany``。
    ``id`` は ``d`` と同じ計算を行う互換表記として扱う。
    """
    match = _DICE_PATTERN.fullmatch((content or "").strip())
    if not match:
        return None

    count_text, operator, sides_text, int8_text = match.groups()
    int8 = int8_text == "int8"
    count = int(count_text)
    if count < 1 or count > MAX_DICE_COUNT:
        return count, operator, -1, int8
    if sides_text == "any":
        return count, operator, None, int8

    sides = int(sides_text)
    if sides < 1 or len(sides_text) > MAX_SIDES_DIGITS:
        return count, operator, -1, int8
    return count, operator, sides, int8


def roll_dice(sides: int, rng: random.Random | random.SystemRandom = random) -> int:
    """1以上 sides 以下の値を返す。"""
    return rng.randint(1, sides)


class DiceCog(commands.Cog):
    """コマンド登録を行わず、通常メッセージだけを監視するCog。"""

    def __init__(self, bot: commands.Bot, rng=None):
        self.bot = bot
        self.rng = rng or random.SystemRandom()

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot:
            return

        parsed = parse_dice_message(message.content)
        if parsed is None:
            return

        count, operator, sides, int8 = parsed
        if sides == -1 or count > MAX_DICE_COUNT:
            await message.reply(
                f"{DICE} ダイス個数は1〜{MAX_DICE_COUNT}個、面数は1以上{MAX_SIDES_DIGITS}桁以内で指定してください。",
                mention_author=False,
            )
            return

        if sides is None:
            sides = self.rng.randint(1, MAX_SIDES)

        rolls = [roll_dice(sides, self.rng) for _ in range(count)]
        total = sum(rolls)
        notation = f"{count}{operator}{sides}"
        detail = f"（内訳: {', '.join(map(str, rolls))}）" if count > 1 else ""
        result = oct(total) if int8 else str(total)
        modifier = " int8" if int8 else ""
        await message.reply(f"{DICE} `{notation}{modifier}` → **{result}**{detail}", mention_author=False)


async def setup(bot: commands.Bot):
    await bot.add_cog(DiceCog(bot))
