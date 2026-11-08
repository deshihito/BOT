# -*- coding: utf-8 -*-
"""ルートパネル間のジャンルワープ（関連ジャンルへの移動ボタン）の宣言的対応表。

各ルートパネル（/general /vc /game /support）は、自分のジャンルに
対応するワープがあればパネル末尾に「◯◯へ移動」ボタンを自動配置する。
着地は対象ルートのパネルを対象ジャンルで開く（landing="panel"）。

対応表の書き方:
- ``from_genre`` / ``to_genre`` は各ルートの実ジャンルキーを使う
  （general: core/general/common.py の GENERAL_GENRES、vc: core/vc/common.py
  の VOICE_GENRES、support: core/support/common.py の SUPPORT_GENRES、
  game: core/game/game/cog.py の GAME_GENRES）。
- ジャンルでなくルートのハブ全体が起点/着地の場合は ``None`` を使う
  （game ハブはジャンル未選択が既定で、今月のゲーム王ボタンもハブにある。
  vc ハブも同様にジャンル未選択で開ける）。
- ``scope="genre"``: ジャンルパネルにボタンを出すワープ。
- ``scope="action"``: 特定アクション（``anchor``）に紐づくワープ。
  ジャンルパネルには出さない。support の automation ジャンルは
  「ジャンル単位でワープ1本まで」（levelup の general:exp 行き）という
  制約があるため、automation 起点の残りは action スコープで宣言だけする。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PanelWarp:
    from_root: str
    from_genre: str | None
    to_root: str
    to_genre: str | None
    label: str
    landing: str = "panel"
    scope: str = "genre"          # "genre" | "action"
    anchor: str | None = None     # scope="action" のときの起点アクション値


PANEL_WARPS: tuple[PanelWarp, ...] = (
    # general:boardnotify_rta ⇔ support:boardnotify / support:rta
    PanelWarp("support", "boardnotify", "general", "boardnotify_rta", "RTAランキングへ移動"),
    PanelWarp("general", "boardnotify_rta", "support", "boardnotify", "boardNotifyへ移動"),
    PanelWarp("support", "rta", "general", "boardnotify_rta", "RTAランキングへ移動"),
    PanelWarp("general", "boardnotify_rta", "support", "rta", "RTA設定へ移動"),
    # support:automation(levelup) ⇔ general:exp
    PanelWarp("support", "automation", "general", "exp", "EXP・レベルへ移動",
              anchor="levelup_notify"),
    PanelWarp("general", "exp", "support", "automation", "レベルアップ通知へ移動",
              anchor="levelup_notify"),
    # vc:trigger ⇔ support:automation（voice_trigger）
    PanelWarp("vc", "trigger", "support", "automation", "音声トリガー設定へ移動",
              anchor="voice_trigger"),
    PanelWarp("support", "automation", "vc", "trigger", "音声トリガーへ移動",
              scope="action", anchor="voice_trigger"),
    # vc ハブ ⇔ support:automation（vc_auto_start）
    PanelWarp("vc", None, "support", "automation", "VC自動参加設定へ移動",
              anchor="vc_auto_start"),
    PanelWarp("support", "automation", "vc", None, "VCパネルへ移動",
              scope="action", anchor="vc_auto_start"),
    # support:automation(globalchat) ⇔ vc:gvc_rooms
    PanelWarp("support", "automation", "vc", "gvc_rooms", "グローバルVCへ移動",
              scope="action", anchor="globalchat"),
    PanelWarp("vc", "gvc_rooms", "support", "automation", "グローバルチャット設定へ移動",
              anchor="globalchat"),
    # general:money ⇔ general:boardnotify_rta
    PanelWarp("general", "money", "general", "boardnotify_rta", "RTAランキングへ移動"),
    PanelWarp("general", "boardnotify_rta", "general", "money", "マネーへ移動"),
    # game ハブ（今月のゲーム王）⇔ general:boardnotify_rta
    PanelWarp("game", None, "general", "boardnotify_rta", "RTAランキングへ移動",
              anchor="monthly_king"),
    PanelWarp("general", "boardnotify_rta", "game", None, "ゲームへ移動",
              anchor="monthly_king"),
)


def warps_from(root: str, genre: str | None, *, scope: str = "genre") -> list[PanelWarp]:
    """(root, genre) を起点とするワープ。既定はジャンルパネル表示用。"""
    return [
        warp for warp in PANEL_WARPS
        if warp.from_root == root and warp.from_genre == genre and warp.scope == scope
    ]


def make_warp_button(root: str, warp: PanelWarp, row: int):
    """各ルートパネル共通のワープボタン（support の SupportWarpButton と同型）。

    custom_id は panel:<root>: の固定形にし、再起動後に死んだパネルを
    押した場合は panel_recovery が起点ルートのパネルを開き直す
    （ワープ先ジャンルまでは復元されない。現行パネル共通の制限）。
    discord の import は循環回避のため関数内で行う。
    """
    import discord

    class WarpButton(discord.ui.Button):
        def __init__(self):
            super().__init__(
                label=warp.label,
                style=discord.ButtonStyle.primary,
                custom_id=f"panel:{root}:warp_{warp.to_root}_{warp.to_genre or 'hub'}",
                row=row,
            )
            self.warp = warp

        async def callback(self, interaction: discord.Interaction):
            from core.support.panel_v2 import as_panel_v2, edit_panel_v2

            container = self.view
            panel = getattr(container, "panel", container)
            target = build_warp_panel(
                interaction.client, self.warp,
                owner_id=getattr(panel, "owner_id", None),
            )
            if target is None:
                return await interaction.response.send_message(
                    "移動先のパネルが読み込まれていません。", ephemeral=True)
            return await edit_panel_v2(interaction, as_panel_v2(target))

    return WarpButton()


def build_warp_panel(bot, warp: PanelWarp, owner_id: int | None = None):
    """ワープ先ルートのパネルを、着地ジャンルで開いた状態で作る。

    対象 cog が読み込まれていない場合は None を返す。パネル生成は
    panel_recovery の build_panel と同じ cog 名・クラスを使う。
    """
    if warp.landing != "panel":
        return None
    if warp.to_root == "general":
        cog = bot.get_cog("GeneralCog")
        if cog is None:
            return None
        from core.general.panel import GeneralPanel

        return GeneralPanel(cog, genre=warp.to_genre, owner_id=owner_id)
    if warp.to_root == "support":
        cog = bot.get_cog("SupportCog")
        if cog is None:
            return None
        from core.support.panel import SupportPanelView

        return SupportPanelView(cog, genre=warp.to_genre, owner_id=owner_id)
    if warp.to_root == "vc":
        hub = bot.get_cog("VoiceHub")
        if hub is None:
            return None
        from core.vc.hub import VoicePanelView

        return VoicePanelView(hub, genre=warp.to_genre, owner_id=owner_id)
    if warp.to_root == "game":
        cog = bot.get_cog("GameHub")
        if cog is None:
            return None
        from core.game.game.cog import GameHubView

        # GameHubView はジャンル引数を持たず、ハブ（ジャンル未選択）が着地。
        return GameHubView(cog, owner_id=owner_id)
    return None
