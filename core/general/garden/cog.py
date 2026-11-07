# -*- coding: utf-8 -*-
"""植物栽培の入口（/general の「植物栽培」アクション）と操作パネル。

コイン等の経済とは一切つながない純粋な育成枠。入口は新規スラッシュを
作らず /general の栽培ジャンル（general:garden）から開く単一パネルで、
3鉢の状態を1枚の画像で見せ、操作はすべてパネル内ボタンで完結させる。
"""
from __future__ import annotations

import io
import logging
import time

import discord
from discord.ext import commands

from core.general.garden import garden as core
from core.general.garden.render import render_garden_png
from core.support.panel_v2 import as_panel_v2, edit_panel_v2

logger = logging.getLogger(__name__)

GARDEN_COLOR = 0x2E9E5B
IMAGE_FILENAME = "garden.png"


def _now() -> int:
    return int(time.time())


def _pot_line(index: int, plant: dict | None, now: int) -> str:
    """パネル本文の鉢1行分（種類・段階・次までの目安）。"""
    if plant is None:
        return f"**鉢{index + 1}**: 空き"
    status = core.plant_status(plant, now)
    parts = [f"**鉢{index + 1}**: {status.species_name}（{status.stage_label}）"]
    if plant["species"] == "bonsai":
        parts.append(f"樹形: {status.trait}")
        if status.stage == core.STAGE_MATURE:
            detail = f"樹形値 {status.form_points:.0f}（{status.form_band}）"
            if status.points_to_next_band:
                detail += f"、あと{status.points_to_next_band:.0f}で格が上がります"
            parts.append(detail)
    if status.fruit_ready:
        parts.append("実がなっています")
    elif status.fruit_in_seconds:
        parts.append(f"実まで{core.format_duration(status.fruit_in_seconds)}")
    elif status.seconds_to_next_stage is not None:
        parts.append(f"次の段階まで{core.format_duration(status.seconds_to_next_stage)}")
    return " — ".join(parts)


class GardenView(discord.ui.View):
    """自分の庭のパネル。開いた本人のみ操作できる。"""

    def __init__(self, cog: "GardenCog", user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        self.selected = 0
        self.armed_remove = False
        self.snapshot: dict = {"pots": [None] * core.POT_COUNT, "records": {}}
        self._png: bytes | None = None
        self.message: discord.Message | None = None

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return interaction.user.id == self.user_id

    # ------------------------------------------------------------------
    # 表示
    # ------------------------------------------------------------------
    def load(self) -> None:
        """ストアから最新状態を読み直し、画像を描き直す。"""
        now = _now()
        self.cog.store.settle_user(self.user_id, now)
        self.snapshot = self.cog.store.snapshot(self.user_id)
        self._png = render_garden_png(self.snapshot["pots"], now)

    def embed(self) -> discord.Embed:
        now = _now()
        embed = discord.Embed(title="🌱 植物栽培", color=GARDEN_COLOR)
        lines = [
            _pot_line(index, plant, now)
            for index, plant in enumerate(self.snapshot["pots"])
        ]
        records = self.snapshot.get("records", {})
        lines.append(
            "-# 記録: "
            f"草の収穫 {records.get('grass_harvests', 0)}回 ・ "
            f"木の実 {records.get('tree_fruits', 0)}個 ・ "
            f"水やり {records.get('waterings', 0)}回 ・ "
            f"剪定 {records.get('prunings', 0)}回"
        )
        embed.description = "\n".join(lines)
        embed.set_image(url=f"attachment://{IMAGE_FILENAME}")
        return embed

    def image_file(self) -> discord.File:
        if self._png is None:
            self.load()
        return discord.File(io.BytesIO(self._png or b""), filename=IMAGE_FILENAME)

    # ------------------------------------------------------------------
    # 部品の組み立て
    # ------------------------------------------------------------------
    def refresh(self) -> None:
        self.clear_items()
        for index in range(core.POT_COUNT):
            button = discord.ui.Button(
                label=f"鉢{index + 1}",
                style=(discord.ButtonStyle.primary if index == self.selected
                       else discord.ButtonStyle.secondary),
                row=0,
            )
            button.callback = self._make_select(index)
            self.add_item(button)
        self._add_action_buttons()

    def _add_button(self, label: str, callback, *, disabled: bool = False,
                    style: discord.ButtonStyle = discord.ButtonStyle.secondary) -> None:
        button = discord.ui.Button(label=label, style=style, row=1, disabled=disabled)
        button.callback = callback
        self.add_item(button)

    def _add_action_buttons(self) -> None:
        now = _now()
        plant = self.snapshot["pots"][self.selected]
        if plant is None:
            for species_id, definition in core.SPECIES.items():
                self._add_button(f"{definition['name']}を植える",
                                 self._make_plant(species_id),
                                 style=discord.ButtonStyle.success)
            return
        status = core.plant_status(plant, now)
        if status.can_water:
            self._add_button("水やり", self._make_water(),
                             style=discord.ButtonStyle.primary)
        elif plant["species"] == "bonsai" or status.stage != core.STAGE_MATURE:
            # 盆栽・育成中はクールダウン中であることを disabled で示す
            self._add_button("水やり", self._make_water(), disabled=True)
        if plant["species"] == "grass" and status.stage == core.STAGE_MATURE:
            self._add_button("収穫する", self._make_harvest(),
                             style=discord.ButtonStyle.primary)
        if plant["species"] == "tree" and status.stage == core.STAGE_MATURE:
            self._add_button("実を取る", self._make_pick(),
                             disabled=not status.fruit_ready,
                             style=discord.ButtonStyle.primary)
        if plant["species"] == "bonsai" and status.stage == core.STAGE_MATURE:
            self._add_button("剪定", self._make_prune(),
                             disabled=not status.can_prune,
                             style=discord.ButtonStyle.primary)
        if self.armed_remove:
            self._add_button("本当に抜く", self._make_remove_confirm(),
                             style=discord.ButtonStyle.danger)
        else:
            self._add_button("抜く", self._make_remove_arm())

    # ------------------------------------------------------------------
    # 操作コールバック
    # ------------------------------------------------------------------
    async def _sync_panel(self, interaction: discord.Interaction) -> None:
        self.load()
        self.refresh()
        await edit_panel_v2(interaction, as_panel_v2(self), files=[self.image_file()])

    def _make_select(self, index: int):
        async def callback(interaction: discord.Interaction):
            self.selected = index
            self.armed_remove = False
            await self._sync_panel(interaction)
        return callback

    def _make_plant(self, species_id: str):
        async def callback(interaction: discord.Interaction):
            self.cog.store.plant(self.user_id, self.selected, species_id, _now())
            self.armed_remove = False
            await self._sync_panel(interaction)
        return callback

    def _make_water(self):
        async def callback(interaction: discord.Interaction):
            self.cog.store.water(self.user_id, self.selected, _now())
            await self._sync_panel(interaction)
        return callback

    def _make_harvest(self):
        async def callback(interaction: discord.Interaction):
            self.cog.store.harvest_grass(self.user_id, self.selected, _now())
            await self._sync_panel(interaction)
        return callback

    def _make_pick(self):
        async def callback(interaction: discord.Interaction):
            self.cog.store.pick_fruit(self.user_id, self.selected, _now())
            await self._sync_panel(interaction)
        return callback

    def _make_prune(self):
        async def callback(interaction: discord.Interaction):
            self.cog.store.prune(self.user_id, self.selected, _now())
            await self._sync_panel(interaction)
        return callback

    def _make_remove_arm(self):
        async def callback(interaction: discord.Interaction):
            self.armed_remove = True
            await self._sync_panel(interaction)
        return callback

    def _make_remove_confirm(self):
        async def callback(interaction: discord.Interaction):
            self.cog.store.clear_pot(self.user_id, self.selected)
            self.armed_remove = False
            await self._sync_panel(interaction)
        return callback

    async def on_timeout(self) -> None:
        if self.message is None:
            return
        self.clear_items()
        try:
            from core.support.panel_v2 import edit_message_v2
            await edit_message_v2(self.message, as_panel_v2(self),
                                  files=[self.image_file()])
        except Exception:
            pass


class GardenCog(commands.Cog):
    """植物栽培（個人の庭、全サーバー共通）。"""

    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.store = core.GardenStore()

    async def show_garden(self, interaction: discord.Interaction) -> None:
        view = GardenView(self, interaction.user.id)
        view.load()
        view.refresh()
        await interaction.response.send_message(
            view=as_panel_v2(view), files=[view.image_file()])
        try:
            view.message = await interaction.original_response()
        except Exception:
            view.message = None


async def setup(bot: commands.Bot):
    await bot.add_cog(GardenCog(bot))
