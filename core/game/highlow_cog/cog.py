# -*- coding: utf-8 -*-
"""ハイ＆ロー（ソロ・ストリーク型）。

今見えているカードより、次にめくるカードが高いか低いかを当て続ける。
同点は引き分け: その札を今のカードにしてストリークを維持したまま、
「続ける／ここでやめる」をボタンで選べる（2026-11-07 仕様変更。
変更前は同点=外れだった）。連続正解数が記録（core/game/game_records.py
の highlow）に残る。賭け要素はない。パネルは Components V2。
"""
import io
import random

import discord
from discord.ext import commands

from core.game import board_image, game_records
from core.game.board_image import render_cached, render_card_hand
from core.game.game_v2 import GamePanelView
from core.game.highlow import HighLowGame, card_label, rank_label

GAME_ID = "highlow"

_SUIT_TO_LETTER = {"♠": "S", "♥": "H", "♦": "D", "♣": "C"}
IMAGE_NAME = "highlow_cards.png"
TIE_SECONDS = 120


def card_spec_of(card):
    """(ランク数値, スート記号) を描画基盤の正規形に変換する。"""
    rank, suit = card
    return board_image.card_spec(rank_label(rank), _SUIT_TO_LETTER[suit])


def state_file(game: HighLowGame, prev=None):
    """表示用カード画像の File。今のカード単体、結果表示時は 前→今 の2枚。"""
    specs = [card_spec_of(game.current)]
    if prev is not None and prev != game.current:
        specs = [card_spec_of(prev), card_spec_of(game.current)]
    key = ("highlow-cards", tuple(specs))
    data = render_cached(key, lambda: render_card_hand(specs, card_w=132))
    return discord.File(io.BytesIO(data), filename=IMAGE_NAME)


def game_text(game: HighLowGame, user, status: str = "") -> str:
    desc = (f"<@{user.id}> の挑戦です。\n"
            f"今のカード: **{card_label(game.current)}**\n"
            f"連続正解: **{game.streak}回**／残りの山札: {game.remaining}枚")
    if status:
        desc += f"\n{status}"
    return desc


class HighLowPanel(GamePanelView):
    """ハイ＆ローのパネル（V2）。mode: "play" / "tie" / "done"。"""

    def __init__(self, cog, owner, game: HighLowGame, status: str = "", prev=None,
                 mode: str = "play"):
        super().__init__("🃏 ハイ＆ロー", game_text(game, owner, status),
                         timeout=TIE_SECONDS if mode == "tie" else 600)
        self.cog = cog
        self.owner = owner
        self.game = game
        self.mode = mode
        self.message = None  # タイムアウト時の編集用（送信後に cog が入れる）
        gallery = discord.ui.MediaGallery()
        gallery.add_item(media=f"attachment://{IMAGE_NAME}")
        self.add_extra(gallery)
        if mode == "play":
            self.high = discord.ui.Button(label="⬆ 高い", style=discord.ButtonStyle.primary)
            self.high.callback = self._on_high
            self.low = discord.ui.Button(label="⬇ 低い", style=discord.ButtonStyle.primary)
            self.low.callback = self._on_low
            self.quit = discord.ui.Button(label="やめる", style=discord.ButtonStyle.secondary)
            self.quit.callback = self._on_quit
            self.add_row(self.high, self.low, self.quit)
        elif mode == "tie":
            self.keep_going = discord.ui.Button(label="続ける", style=discord.ButtonStyle.primary)
            self.keep_going.callback = self._on_continue
            self.stop_here = discord.ui.Button(label="ここでやめる", style=discord.ButtonStyle.secondary)
            self.stop_here.callback = self._on_stop_here
            self.add_row(self.keep_going, self.stop_here)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if not await super().interaction_check(interaction):
            return False
        if interaction.user.id != self.owner.id:
            await interaction.response.send_message("これは他の人の挑戦です。", ephemeral=True)
            return False
        return True

    # ------------------------------------------------------------------
    async def _on_high(self, interaction: discord.Interaction):
        await self._guess(interaction, "high")

    async def _on_low(self, interaction: discord.Interaction):
        await self._guess(interaction, "low")

    async def _on_quit(self, interaction: discord.Interaction):
        if self.mode != "play":
            return
        status = f"ここでやめました。連続正解は **{self.game.streak}回** でした。"
        await self.cog.finish_panel(interaction, self, status)

    async def _guess(self, interaction: discord.Interaction, direction: str):
        if self.mode != "play" or self.game.finished:
            return await interaction.response.send_message("この挑戦は終わっています。", ephemeral=True)
        game = self.game
        prev = game.current
        correct = game.guess(direction)
        drawn = card_label(game.last_drawn)
        if game.last_outcome == "tie":
            if game.finished:
                status = (f"{card_label(prev)} → **{drawn}** … 同じ数字（同点）でしたが、"
                          "山札が尽きたためここで終了です。"
                          f"\n連続正解 **{game.streak}回** でした。")
                return await self.cog.finish_panel(interaction, self, status, prev=prev)
            status = (f"{card_label(prev)} → **{drawn}** … **同じ数字！同点です。**\n"
                      "引き分けとして、この札を今のカードにして続けられます"
                      f"（連続正解は **{game.streak}回** のまま維持）。"
                      f"{TIE_SECONDS}秒以内に選ばないと、ここでやめた扱いになります。")
            panel = HighLowPanel(self.cog, self.owner, game, status, prev=prev, mode="tie")
            panel.message = interaction.message
            return await interaction.response.edit_message(
                view=panel, attachments=[state_file(game, prev)])
        if game.cleared:
            status = f"{card_label(prev)} → **{drawn}** … 正解！\n🎉 山札を全部当て切りました！"
            return await self.cog.finish_panel(interaction, self, status, prev=prev)
        if not correct:
            status = (f"{card_label(prev)} → **{drawn}** … 外れ。"
                      f"\n連続正解 **{game.streak}回** で終了です。")
            return await self.cog.finish_panel(interaction, self, status, prev=prev)
        status = f"{card_label(prev)} → **{drawn}** … 正解！連続 **{game.streak}回**。次はこのカードより高い？低い？"
        panel = HighLowPanel(self.cog, self.owner, game, status, prev=prev, mode="play")
        await interaction.response.edit_message(
            view=panel, attachments=[state_file(game, prev)])

    async def _on_continue(self, interaction: discord.Interaction):
        if self.mode != "tie":
            return
        game = self.game
        status = (f"同点の札 **{card_label(game.current)}** で続けます。"
                  f"連続正解は **{game.streak}回** のまま。次はこのカードより高い？低い？")
        panel = HighLowPanel(self.cog, self.owner, game, status, mode="play")
        await interaction.response.edit_message(
            view=panel, attachments=[state_file(game)])

    async def _on_stop_here(self, interaction: discord.Interaction):
        if self.mode != "tie":
            return
        status = f"同点でここでやめました。連続正解は **{self.game.streak}回** でした。"
        await self.cog.finish_panel(interaction, self, status)

    async def on_timeout(self) -> None:
        # 同点の選択を放置したら「ここでやめる」扱いで記録して終える。
        if self.mode != "tie" or self.game.finished:
            return
        self.game.finished = True
        status = f"同点のまま時間切れのため、ここで終了しました。連続正解は **{self.game.streak}回** でした。"
        entry = game_records.record_highlow_safely(self.owner.id, self.game.streak)
        if entry is not None:
            status += "\n" + game_records.format_highlow_line(entry, self.game.streak)
        if self.message is not None:
            panel = HighLowPanel(self.cog, self.owner, self.game, status, mode="done")
            try:
                await self.message.edit(view=panel, attachments=[state_file(self.game)])
            except Exception:
                pass


HighLowView = HighLowPanel  # 互換名


class HighLow(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

    async def finish_panel(self, interaction: discord.Interaction, panel: HighLowPanel,
                           status: str, prev=None):
        """挑戦を終え、記録してボタンのない最終パネルに差し替える。"""
        game = panel.game
        game.finished = True
        entry = game_records.record_highlow_safely(panel.owner.id, game.streak)
        if entry is not None:
            status += "\n" + game_records.format_highlow_line(entry, game.streak)
        done = HighLowPanel(self, panel.owner, game, status, prev=prev, mode="done")
        await interaction.response.edit_message(
            view=done, attachments=[state_file(game, prev)])
        panel.stop()

    async def start_recruit(self, interaction: discord.Interaction):
        """/game のハブから呼ぶ。その場で1プレイ始まる。"""
        game = HighLowGame(rng=random.Random())
        panel = HighLowPanel(self, interaction.user, game,
                             "次のカードはこのカードより高い？低い？")
        await interaction.response.send_message(view=panel, file=state_file(game))
        panel.message = await interaction.original_response()


async def setup(bot):
    await bot.add_cog(HighLow(bot))
