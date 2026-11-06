import asyncio
import logging
import random
from typing import Literal

import discord
from discord import app_commands
from discord.ext import commands
from pydantic import Field, create_model

import needle

log = logging.getLogger(__name__)

# Needle は「入力文中に根拠のある値」しか引数に入れられない（grounding）。
# 「0.73」のような数値は発言ログのどこにも書かれていないため、
# score: float 方式では必須引数が埋まらず呼び出しが suppressed_calls に回され、
# results が空 → 常に 0.5 になっていた。
# → enum（閉じた選択肢）による分類にする。enum は文法で出力が固定され、
#    根拠スパンがなくても選べる（公式の "classification is extraction with an enum"）。
LEVELS = ("very_low", "low", "medium", "high", "very_high")
LEVEL_SCORES = {
    "very_low": 0.0,
    "low": 25.0,
    "medium": 50.0,
    "high": 75.0,
    "very_high": 100.0,
}

# 判定パターンの設定辞書（low / high は very_low / very_high が何を意味するか）
JUDGE_TYPES = {
    "safety": {
        "name": "安全度",
        "low": "dangerous, threatening or reckless",
        "high": "safe, harmless and friendly",
    },
    "hentai": {
        "name": "変態度",
        "low": "normal, nothing sexual",
        "high": "highly perverted, sexual",
    },
    "intelligent": {
        "name": "知性度",
        "low": "unintelligent, careless",
        "high": "highly intelligent, thoughtful",
    },
    "kichigai": {
        "name": "キチガイ度",
        "low": "normal and sane",
        "high": "insane, bizarre, incoherent",
    },
    "hage": {
        "name": "ハゲ度",
        "low": "no relation to hair loss or baldness",
        "high": "about baldness or hair loss",
    },
    "bot": {
        "name": "ボット度",
        "low": "human-like, natural",
        "high": "bot-like, repetitive, templated",
    },
    "kire": {
        "name": "キレ度",
        "low": "calm",
        "high": "extremely angry",
    },
}


def _build_rating_model(info: dict):
    """判定項目ごとの分類スキーマ（Needle の唯一のツールになる）を作る。"""
    return create_model(
        "rate_message",
        __doc__=f"Rate the {info['name']} level of one chat message.",
        level=(
            Literal[LEVELS],
            Field(
                description=(
                    f"{info['name']} level: very_low = {info['low']}, "
                    f"very_high = {info['high']}"
                )
            ),
        ),
    )


class JudgeCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        # 項目ごとのスキーマを1回だけ作る
        self._models = {key: _build_rating_model(info) for key, info in JUDGE_TYPES.items()}
        # Needle のエンジンは同時実行を想定しないので直列化する
        self._lock = asyncio.Lock()

    async def cog_load(self):
        # 初回はエンジンと重み(needle3.cact)のダウンロードが走るので、先に温めておく
        try:
            model = next(iter(self._models.values()))
            await asyncio.to_thread(needle.extract, "hello", model)
        except Exception:
            log.exception("Needle warm-up failed")

    def _rate_messages(self, key: str, messages: list[str]) -> list[float]:
        """同期処理。メッセージごとに分類して 0-100 の点数リストを返す。"""
        model = self._models[key]
        scores: list[float] = []
        for msg in messages:
            try:
                # extract は「ツール1個だけの呼び出し」。メッセージ本文を query として渡す。
                result = needle.extract(msg, model)
            except Exception:
                log.exception("needle.extract failed")
                continue
            # None = 何もマッチしなかった（拒否）。0.5 などで埋めずに除外する。
            if result is None:
                continue
            scores.append(LEVEL_SCORES[result.level])
        return scores

    async def judge(
        self,
        interaction: discord.Interaction,
        target: discord.Member,
        type: app_commands.Choice[str],
    ):
        await interaction.response.defer()

        judge_info = JUDGE_TYPES.get(type.value)
        if not judge_info or not interaction.guild:
            await interaction.followup.send("無効な呼び出しです。")
            return

        # サーバー全体のテキストチャンネルから発言ログを取得（最大500件）
        user_messages = []
        for channel in interaction.guild.text_channels:
            permissions = channel.permissions_for(interaction.guild.me)
            if not permissions.read_messages or not permissions.read_message_history:
                continue

            try:
                async for message in channel.history(limit=100):
                    if message.author.id == target.id and message.content:
                        cleaned_msg = message.content.replace("\n", " ")[:100]
                        user_messages.append(cleaned_msg)
                        if len(user_messages) >= 500:
                            break
            except Exception:
                continue

            if len(user_messages) >= 500:
                break

        if not user_messages:
            await interaction.followup.send(
                f"{target.mention} 氏の過去ログが見つかりませんでした。"
            )
            return

        sample_count = min(len(user_messages), 30)
        sampled_messages = random.sample(user_messages, sample_count)

        # agent.run / extract は同期関数なので、イベントループを止めないようスレッドで実行
        try:
            async with self._lock:
                scores = await asyncio.to_thread(
                    self._rate_messages, type.value, sampled_messages
                )
        except Exception as e:
            await interaction.followup.send(f"エラーが発生しました: {e}")
            return

        if not scores:
            await interaction.followup.send(
                f"{target.mention} 氏の発言から判定できるメッセージがありませんでした。"
            )
            return

        score_100 = sum(scores) / len(scores)
        embed_color = self._calculate_gradient_color(score_100)
        status_label = self._get_status_label(score_100)

        embed = discord.Embed(
            title=f"{judge_info['name']}判定結果: {target.display_name}",
            color=embed_color,
        )
        embed.set_thumbnail(url=target.display_avatar.url)
        embed.add_field(
            name=f"{judge_info['name']}スコア",
            value=f"**{score_100:.1f} / 100 点**",
            inline=False,
        )
        embed.add_field(
            name="抽出メッセージ数",
            value=f"{len(scores)} / {sample_count} 件判定 (サーバー全体より選出)",
            inline=True,
        )
        embed.add_field(name="評価ステータス", value=status_label, inline=False)

        await interaction.followup.send(embed=embed)

    def _get_status_label(self, score: float) -> str:
        """スコアに応じた固定ラベルの生成"""
        if score >= 80.0:
            return "極めて高い傾向が検出されました。"
        elif score >= 60.0:
            return "やや高い傾向が見られます。"
        elif score >= 40.0:
            return "標準的な範囲内です。"
        elif score >= 20.0:
            return "傾向は控えめです。"
        else:
            return "該当する傾向はほぼ見られません。"

    def _calculate_gradient_color(self, score: float) -> discord.Color:
        normalized = max(0.0, min(1.0, score / 100.0))
        if normalized < 0.5:
            factor = normalized * 2
            return discord.Color.from_rgb(255, int(255 * factor), 0)
        else:
            factor = (normalized - 0.5) * 2
            return discord.Color.from_rgb(int(255 * (1 - factor)), 255, 0)


async def setup(bot: commands.Bot):
    await bot.add_cog(JudgeCog(bot))
