import asyncio
import logging
import math
import random

import discord
from discord.ext import commands

import config
from core.game.game import game_records
from core.game.game.game_v2 import text_panel

logger = logging.getLogger("cogs.guess")

WIN_MULTIPLIER = 2.8
LOSS_MULTIPLIER = 1.5
# 残高を書き換えるときに、ほかの処理と同時に更新されて食い違った場合の再試行回数
UPDATE_ATTEMPTS = 3


def resolve_guess(bet: int, selected: int, answer: int) -> tuple[bool, int]:
    """勝敗と残高への増減を返す。勝ちは賭け額の2.8倍、負けは1.5倍。"""
    if bet <= 0:
        raise ValueError("bet must be positive")
    if selected not in (1, 2, 3) or answer not in (1, 2, 3):
        raise ValueError("choice must be between 1 and 3")
    return selected == answer, int(bet * (WIN_MULTIPLIER if selected == answer else -LOSS_MULTIPLIER))


def max_loss(bet: int) -> int:
    """負けたときに引かれる額（resolve_guess の負けと同じ計算）。"""
    return int(bet * LOSS_MULTIPLIER)


def max_bet(balance: int) -> int:
    """負けても残高がマイナスにならない、最大の賭け額。"""
    if balance <= 0:
        return 0
    bet = math.floor(balance / LOSS_MULTIPLIER)
    while max_loss(bet + 1) <= balance:
        bet += 1
    while bet > 0 and max_loss(bet) > balance:
        bet -= 1
    return bet


class GuessModal(discord.ui.Modal, title="数字当て"):
    bet = discord.ui.TextInput(label="賭け額（1以上の整数）", max_length=12)
    choice = discord.ui.TextInput(label="数字（1・2・3 のどれか）", max_length=1)

    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        try:
            bet, choice = int(str(self.bet.value).strip()), int(str(self.choice.value).strip())
        except ValueError:
            await interaction.response.send_message("賭け額と数字は半角の整数で入力してください。", ephemeral=True)
            return
        await self.cog.play(interaction, bet, choice)


class Guess(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。賭け額と数字を入れるフォームを出す。"""
        await interaction.response.send_modal(GuessModal(self))

    async def play(self, interaction: discord.Interaction, bet: int, choice: int):
        user_id = str(interaction.user.id)
        if bet <= 0:
            await interaction.response.send_message("賭け額は1以上で指定してください。", ephemeral=True)
            return
        if choice not in (1, 2, 3):
            await interaction.response.send_message("数字は1・2・3から選んでください。", ephemeral=True)
            return

        try:
            profile = await self._get_profile(user_id)
            balance = int(profile.get("balance") or 0)
        except Exception:
            await interaction.response.send_message("残高を読み込めませんでした。時間を置いて再度お試しください。", ephemeral=True)
            return

        # ゲームを始める前に、負けても残高が足りるかを確かめる（負けると賭け額の1.5倍が引かれる）。
        if balance <= 0:
            await interaction.response.send_message(
                f"残高が {balance:,} ago のため、賭けられません。", ephemeral=True)
            return
        if bet > balance or max_loss(bet) > balance:
            await interaction.response.send_message(
                f"残高が足りません。負けると賭け額の{LOSS_MULTIPLIER}倍が引かれるため、"
                f"現在の残高 {balance:,} ago で賭けられるのは {max_bet(balance):,} ago までです。",
                ephemeral=True,
            )
            return

        answer = random.randint(1, 3)
        won, delta = resolve_guess(bet, choice, answer)

        try:
            applied = await self._apply_delta(user_id, delta, won)
        except Exception:
            applied = None
        if applied is None:
            # 結果は残高に反映していないので、このゲームはなかったことになる（正解も表示しない）。
            await interaction.response.send_message(
                "残高を更新できなかったため、このゲームは無効になりました。時間を置いて再度お試しください。",
                ephemeral=True,
            )
            return
        actual_delta, new_balance = applied

        lines = [
            f"選択した数字: **{choice}**",
            f"正解の数字: **{answer}**",
            "",
            f"{'正解です。' if won else '不正解です。'}",
            f"結果: {'勝ち' if won else '負け'} | 変動 **{actual_delta:+,} ago**",
            f"残高: **{new_balance:,} ago**",
        ]
        # 自分の通算成績（core/game/game/game_records.py）。記録できなければ欄ごと付けない。
        stats = game_records.record_guess_safely(user_id, bet, won, actual_delta)
        if stats is not None:
            lines += ["", "あなたの通算成績:", game_records.format_guess_stats(stats)]
        lines.append(f"（勝利時は賭け額の{WIN_MULTIPLIER}倍、敗北時は{LOSS_MULTIPLIER}倍を反映）")
        await interaction.response.send_message(view=text_panel("数字当て | 結果", "\n".join(lines)))

    async def _get_profile(self, user_id: str) -> dict:
        result = await asyncio.to_thread(
            lambda: config.db_api.table("users").select("balance").eq("user_id", user_id).execute()
        )
        if result.data:
            return result.data[0]
        inserted = await asyncio.to_thread(
            lambda: config.db_api.table("users").insert({
                "user_id": user_id,
                "balance": 0,
                "max_box_slots": 20,
            }).execute()
        )
        return inserted.data[0]

    async def _apply_delta(self, user_id: str, delta: int, won: bool) -> tuple[int, int] | None:
        """更新の直前に残高を読み直して delta を反映する。残高はマイナスにしない。

        ほかの処理と同時に書き換えられたときは読み直してやり直す。反映できたら
        (実際の増減, 新しい残高) を、できなかったら None を返す。
        """
        for _ in range(UPDATE_ATTEMPTS):
            current = await asyncio.to_thread(
                lambda: config.db_api.table("users").select("balance").eq("user_id", user_id).execute()
            )
            if not current.data:
                return None
            old_balance = int(current.data[0].get("balance") or 0)
            new_balance = max(0, old_balance + delta)
            result = await asyncio.to_thread(
                lambda: config.db_api.table("users")
                .update({"balance": new_balance})
                .eq("user_id", user_id)
                .eq("balance", old_balance)
                .execute()
            )
            if not result.data:
                continue
            actual_delta = new_balance - old_balance
            try:
                await asyncio.to_thread(
                    lambda: config.db_api.table("transaction_history").insert({
                        "sender_id": user_id if not won else "SYSTEM_GUESS",
                        "receiver_id": "SYSTEM_GUESS" if not won else user_id,
                        "amount": abs(actual_delta),
                        "reason": "guess_win" if won else "guess_loss",
                    }).execute()
                )
            except Exception:
                # 残高はすでに反映済み。履歴だけ残せなかった場合も結果は有効にする。
                logger.warning("guess: 取引履歴の記録に失敗しました", exc_info=True)
            return actual_delta, new_balance
        return None


async def setup(bot: commands.Bot):
    await bot.add_cog(Guess(bot))
