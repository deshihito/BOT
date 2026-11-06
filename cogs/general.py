# -*- coding: utf-8 -*-
"""汎用機能（/general）の入口。

実装は core/general/ パッケージに機能ごとに分割されている。
このモジュールは、それらを合成した GeneralCog と、従来どおり
`cogs.general` から import できる名前の再エクスポートを担う。
EXP 系の名前を差し替えるテスト互換のため、EXP の保存系を呼ぶ
リスナー/タスク (on_message 等) はこのファイルに残している。
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import math
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.panel_v2 import as_panel_v2, edit_panel_v2
from core import action_registry, action_usage, guild_settings, levelup_card, logfare, shortcuts
from core.support import usage_stats
from core.general import ai_omnirush, ai_preferences, ai_provider_router
from core.game.game_guides import GAME_GUIDES, GAME_ORDER
from core import translation
from core.support import localization
from core.game import prison as prison_core
from core.messages import CIRCULATION_NOT_LOADED, GAMBLING_NOT_LOADED, ITEMS_NOT_LOADED, MARKET_NOT_LOADED, MONEY_PANEL_NOT_LOADED, WORKSHOP_NOT_LOADED
from core.libretranslate import LibreTranslateClient, LibreTranslateError

logger = logging.getLogger(__name__)

from core.general.common import *
from core.general.exp.exp import *
from core.general.exp.levelup import *
from core.general.miq.miq import *
from core.general.miq.miq_styles import *
from core.general.miq.miq_cards import *
from core.general.miq.miq_line import *
from core.general.meme import *
from core.general.miq.miq_ui import *
# アクション定義の単一の真実は core/action_registry。SHORTCUT_ROOTS は
# レジストリからの生成物（名前・形状・import 互換は従来どおり維持する）。
SHORTCUT_ROOTS = action_registry.build_shortcut_roots()

from core.general.shortcuts import *
from core.general.panel import *
from core.general.translation import *
from core.general.exp.exp_ui import *
from core.general.ai_ui import *
from core.general.exp.exp import _EXP_DATA, _EXP_LOCK, _as_float, _as_int, _exp_ensure, _exp_load, _exp_lock, _exp_root, _exp_save, _grant_chat_exp, _grant_vc_exp, _iter_voice_user_channels, _iter_voice_user_ids, _merge_exp, _read_exp_file, _store_fetch, _user_general_level, _write_exp_file
from core.general.exp.levelup import _LEVELUP_CJK_FONTS, _LEVELUP_DISPLAY_FONTS, _LEVELUP_DISPLAY_PICK, _LEVELUP_FONT_PICK, _LEVELUP_LATIN_FONTS, _LEVELUP_SS, _levelup_display_font, _levelup_draw_tracked, _levelup_font, _levelup_pick_display_font, _levelup_pick_font, _levelup_safe_name
from core.general.miq.miq import _MIQ_ASSET_FONTS, _MIQ_CUSTOM_EMOJI, _MIQ_CUSTOM_EMOJI_TOKEN, _MIQ_DATA, _MIQ_EMOJI_PATHS, _MIQ_EMOJI_PATH_CACHE, _MIQ_EMOJI_SIZE, _MIQ_FONTS_CACHE, _MIQ_FONT_CMAP_CACHE, _MIQ_FONT_DEFS, _MIQ_FONT_OBJ_CACHE, _MIQ_JP_PROBE, _MIQ_LOCK, _MIQ_NO_LINE_START, _MIQ_REPO_FONT, _MIQ_SYMBOL_PATHS, _font_covers_japanese, _miq_af, _miq_available_fonts, _miq_clean_text, _miq_contrast, _miq_discover_asset_fonts, _miq_display_text, _miq_draw_centered, _miq_emoji_font_path, _miq_emoji_width, _miq_fallback_fonts, _miq_fit, _miq_font_cmap, _miq_font_has_char, _miq_is_emoji_unit, _miq_is_image_attachment, _miq_line_message_has_media, _miq_load_font, _miq_lock, _miq_lum, _miq_mix, _miq_open_avatar, _miq_read_file, _miq_render_emoji_unit, _miq_root, _miq_save_png, _miq_split_units, _miq_sticker_renderable, _miq_unit_bases, _miq_unit_font, _miq_unit_width, _miq_wrap, _miq_write_file
from core.general.miq.miq_styles import _miq_circle_avatar, _miq_date_str, _miq_draw_vertical, _miq_fit_vertical, _miq_glow_lines, _miq_hash_int, _miq_heart, _miq_rng, _miq_rounded_avatar, _miq_special_font_path, _miq_star4, _miq_star5, _miq_truncate, _miq_vertical_columns
from core.general.miq.miq_cards import _MIQ_CARD_FRAME_STOPS, _MIQ_CARD_RARITIES, _MIQ_TICKET_PALETTES, _miq_pick_card_rarity, _miq_pick_ticket_palette
from core.general.miq.miq_line import _MIQ_AGO_CACHE, _MIQ_AGO_DIR, _MIQ_CUSTOM_EMOJI_TOKEN, _MIQ_DATED_FORMATS, _MIQ_FORMAT_RENDERERS, _MIQ_UNICODE_EMOJI_SUPPORTED, _miq_ago_images, _miq_line_atom_width, _miq_line_avatar_image, _miq_line_draw_atoms, _miq_line_entry_atoms, _miq_line_field, _miq_line_fit_media, _miq_line_media_image, _miq_line_split_segments, _miq_line_time_str, _miq_line_wrap_atoms, _miq_unicode_emoji_supported
from core.general.meme import _meme_fit, _meme_font_path, _meme_image_attachment
from core.general.shortcuts import _MessageFollowup, _MessageResponse
from core.general.exp.levelup import LevelUpMixin
from core.general.miq.miq import MiqMixin
from core.general.miq.miq_line import MiqLineMixin
from core.general.meme import MemeMixin
from core.general.translation import TranslationMixin
from core.general.shortcuts import ShortcutsMixin


class RankingsView(discord.ui.View):
    """ランキングの集約ビュー（導線最適化 M7）。

    既存のランキング表示そのものは各 dispatch に委譲し、ここは入口だけを束ねる。
    ゲーム別ランキングは /game の各ゲーム詳細にあるため、ここには含めない。
    """

    TARGETS = (
        ("コイン保有", "coin_leaderboard"),
        ("bump RTA", "bump_leaderboard"),
        ("up RTA", "up_leaderboard"),
        ("生存確認", "fujo_ranking"),
        ("EXP", "exp_ranking"),
    )

    def __init__(self, cog, user_id: int):
        super().__init__(timeout=300)
        self.cog = cog
        self.user_id = user_id
        for label, value in self.TARGETS:
            button = discord.ui.Button(label=label, style=discord.ButtonStyle.primary)
            button.callback = self._make_callback(value)
            self.add_item(button)

    def _make_callback(self, value: str):
        async def callback(interaction: discord.Interaction):
            await self.cog.dispatch_general(interaction, value)
        return callback

    async def interaction_check(self, interaction) -> bool:
        # 公開パネル化（ephemeral第2波）: 操作は本人のみ。
        return interaction.user.id == self.user_id

    def embed(self) -> discord.Embed:
        return discord.Embed(
            title="ランキング",
            description="見たいランキングを選んでください。\n"
                        "ゲーム別ランキングは /game の各ゲーム詳細にあります。",
            color=0xFFFFFF)


class GeneralCog(
    MiqMixin,
    MiqLineMixin,
    MemeMixin,
    LevelUpMixin,
    TranslationMixin,
    ShortcutsMixin,
    commands.Cog,
):
    def __init__(self, bot):
        self.bot = bot
        self._bg_tasks: set[asyncio.Task] = set()
        self._levelup_sem = asyncio.Semaphore(2)  # 画像生成の同時実行数(低スペック機での詰まり防止)
        self._levelup_pillow_warned = False
        self._miq_last: dict[int, float] = {}
        self._translation_client = LibreTranslateClient()
        self._translation_webhooks: dict[int, discord.Webhook] = {}
        # メッセージの右クリックメニュー(アプリ → 引用画像にする)
        self.miq_menu = app_commands.ContextMenu(name="引用画像にする", callback=self.miq_context)
        # メッセージの右クリックメニュー(アプリ → meme画像にする)
        self.meme_menu = app_commands.ContextMenu(name="meme画像にする", callback=self.meme_context)
        # meme作成のパネル経由フローで画像待ち中のセッション {(channel_id, user_id): Event}
        self._meme_waits: dict[tuple[int, int], asyncio.Event] = {}


    async def cog_load(self):
        await translation.ensure_loaded()
        self.exp_vc_tick.start()
        self.bot.tree.add_command(self.miq_menu, override=True)
        self.bot.tree.add_command(self.meme_menu, override=True)


    def cog_unload(self):
        self.exp_vc_tick.cancel()
        self.bot.tree.remove_command(self.miq_menu.name, type=self.miq_menu.type)
        self.bot.tree.remove_command(self.meme_menu.name, type=self.meme_menu.type)
        for task in list(self._bg_tasks):
            task.cancel()


    @app_commands.command(name="general", description="一般機能の操作パネルを表示します")
    async def general(self, interaction: discord.Interaction):
        # Building the panel may touch lazily loaded settings/models.  Reserve
        # the interaction response before doing any work so Discord's 3-second
        # acknowledgement deadline cannot turn a valid command into 10062.
        await interaction.response.defer(thinking=True)
        history_specs = []
        if interaction.guild_id is not None:
            store = guild_settings.get_store()
            await store.ensure_loaded()
            history_specs = action_usage.history_panel_specs(
                store, interaction.guild_id, interaction.user.id, "general")
        view = GeneralPanel(self, history_specs=history_specs, owner_id=interaction.user.id)
        await interaction.followup.send(view=as_panel_v2(view))


    async def _safe_respond(self, interaction: discord.Interaction, message: str, *, ephemeral: bool = True):
        """interaction の応答状態に応じて安全にメッセージを返す。

        通常の Interaction でも ShortcutMessageInteraction（メッセージアダプタ）でも
        同じように動作する。既に応答済みなら followup に切り替える。
        """
        try:
            if interaction.response.is_done():
                return await interaction.followup.send(message, ephemeral=ephemeral)
            return await interaction.response.send_message(message, ephemeral=ephemeral)
        except discord.HTTPException:
            logger.warning("dispatch_general: error response failed", exc_info=True)
        return None


    async def dispatch_general(self, interaction: discord.Interaction, value: str):
        # 利用履歴（よく使う／最近）は入口ここで記録する。記録の失敗で
        # dispatch を壊さないよう record_safely 側で例外は握る。
        await action_usage.record_safely(
            getattr(interaction, "guild_id", None),
            getattr(getattr(interaction, "user", None), "id", None),
            f"general:{value}",
        )
        # 管理者向け総量統計も同じ入口で数える（個人履歴とは別集計）。
        usage_stats.record_action_safely(f"general:{value}")
        if value in {"zetamodoki", "zeta_reset", "zeta_register", "zeta_manage"}:
            cog = self.bot.get_cog("ZetaModoki")
            if cog is None:
                return await self._safe_respond(interaction, "ZetaModokiが読み込まれていません。")
            if value == "zetamodoki":
                return await cog.start(interaction)
            if value == "zeta_register":
                return await cog.register(interaction)
            if value == "zeta_manage":
                return await cog.manage(interaction)
            return await cog.reset(interaction)

        if value == "miq_settings":
            view = MiqSettingsView(self, interaction.user.id)
            return await interaction.response.send_message(view=as_panel_v2(view))

        if value == "meme_create":
            # モーダルを開けない経路 (メッセージ型ショートカット) では
            # _MessageResponse.send_modal が「パネルから実行してください」と
            # 案内する (pay 等の既存モーダル系と同じ扱い)。
            modal = MemeTextModal(self._meme_panel_texts_done)
            return await interaction.response.send_modal(modal)

        if value == "meme_help":
            embed = discord.Embed(title="meme作成", color=0xFFFFFF)
            embed.description = (
                "**作り方**\n"
                "・`/general` → meme作成 → **memeを作成**：上/下テキストを入力したあと、"
                "同じチャンネルにベースにしたい画像を投稿してください（120秒以内）。\n"
                "・画像のあるメッセージを右クリック(スマホは長押し) → アプリ → **meme画像にする**："
                "その画像（無ければ投稿者のアバター）がベースになります。\n\n"
                "**仕様**\n"
                "・上テキスト/下テキストは各100文字まで。どちらか一方だけでも作れます。\n"
                "・GIFアニメは1フレーム目を使った静止画になります。出力は常にPNGです。\n"
                "・ベース画像は最大8MBまで。生成画像は最大1200x1200に収まります。\n"
                "・アバターをベースにする場合のみ、MIQの引用拒否設定が適用されます。"
            )
            return await interaction.response.send_message(embed=embed)

        if value == "rankings":
            # 導線最適化 M7: ランキング6系統のうちパネル系5件を1画面に束ねる。
            view = RankingsView(self, interaction.user.id)
            return await interaction.response.send_message(
                embed=view.embed(), view=view)

        if value == "translation_settings":
            view = TranslationView(interaction.user.id, interaction.guild_id)
            return await interaction.response.send_message(embed=view.embed(), view=view)

        if value == "aitools":
            from core.general import ai_tools_router
            from cogs.ai_tools import _enabled as ai_tools_enabled
            available = ai_tools_router.action_candidates()
            key_status = "設定済み" if logfare.api_key() else "未設定"
            embed = discord.Embed(title="AI tools", color=0x5865F2)
            embed.description = (
                f"全体有効: `{ai_tools_enabled()}`\n"
                f"Logfare APIキー: `{key_status}`\n"
                f"利用可能な安全ツール: `{len(available)}件`\n\n"
                "BOTにメンションして依頼してください。個人別・機能別の設定はありません。"
            )
            return await interaction.response.send_message(embed=embed)

        if value == "reasoning_default":
            await interaction.response.defer(ephemeral=True)
            try:
                view, error = await ReasoningView.create(interaction.user.id)
            except Exception as exc:
                logger.exception("reasoning model metadata unavailable: user=%s", interaction.user.id)
                status = getattr(exc, "status", None)
                detail = f"（HTTP {status}）" if status else ""
                return await interaction.followup.send(
                    f"思考強度の対応状況を取得できませんでした{detail}。時間をおいて再試行してください。",
                    ephemeral=True,
                )
            if error:
                return await interaction.followup.send(error, ephemeral=True)
            return await interaction.followup.send(embed=view.embed(), view=view, ephemeral=True)

        if value in {"ai_default", "image_default"}:
            await interaction.response.defer(ephemeral=True)
            kind = "chat" if value == "ai_default" else "image"
            view = await AIDefaultView.create(interaction.user.id, kind)
            if view.load_error or not view.models:
                logger.error(
                    "Logfare model catalog unavailable: kind=%s user=%s",
                    kind, interaction.user.id, exc_info=view.load_error,
                )
                status = getattr(view.load_error, "status", None)
                detail = f"（HTTP {status}）" if status else ""
                return await interaction.followup.send(
                    f"Logfareのモデル一覧を取得できませんでした{detail}。"
                    "時間をおいて再試行し、`.env` とAPI接続を確認してください。",
                    ephemeral=True,
                )
            return await interaction.followup.send(embed=view.embed(), view=view, ephemeral=True)

        if value == "shortcut_manage":
            view = ShortcutManagerView(self, interaction.guild_id, interaction.user.id)
            return await interaction.response.send_message(view=as_panel_v2(view))

        if value == "exp_status":
            view = ExpStatusView(interaction.user.id, interaction.guild_id)
            await view._load_latest()
            return await interaction.response.send_message(
                view=as_panel_v2(view)
            )

        if value == "exp_ranking":
            view = ExpRankingView(interaction.guild_id)
            await view._load_latest()
            return await interaction.response.send_message(
                view=as_panel_v2(view)
            )

        wallet = self.bot.get_cog("WalletCog")
        fujo = self.bot.get_cog("FujoSurvival")

        # ===== マネー系 =====
        # 逮捕中はマネージャンルの実行系アクションを入口で一元的に拒否する
        # （core/game/prison.py）。表示系（マネーパネル・残高・市場/アイテム/
        # 工房/宝くじのパネル表示・ランキング）は逮捕中でも開けるが、
        # パネル内の実行は各 cog の execute_* 側でも同じチェックをする。
        if value in MONEY_PRISON_BLOCKED_VALUES:
            blocked_message = prison_core.block_message(
                str(interaction.user.id))
            if blocked_message:
                return await self._safe_respond(interaction, blocked_message)
        if value == "money_panel":
            panel_cog = self.bot.get_cog("MoneyPanelCog")
            if panel_cog is None:
                return await self._safe_respond(interaction, MONEY_PANEL_NOT_LOADED)
            return await panel_cog.show_panel(interaction)

        if value == "daily_report":
            report_cog = self.bot.get_cog("DailyReportCog")
            if report_cog is None:
                return await self._safe_respond(interaction, "日報機能は現在利用できません。")
            return await report_cog.toggle(interaction)

        if value == "role_shop":
            shop_cog = self.bot.get_cog("RoleShopCog")
            if shop_cog is None:
                return await self._safe_respond(interaction, "ロールショップは現在利用できません。")
            return await shop_cog.show_shop(interaction)

        if value == "gacha":
            gacha_cog = self.bot.get_cog("GachaCog")
            if gacha_cog is None:
                return await self._safe_respond(interaction, "ガチャは現在利用できません。")
            return await gacha_cog.show_gacha(interaction)

        if value in {"items", "item_buy", "item_use", "box_open"}:
            items_cog = self.bot.get_cog("ItemsCog")
            if items_cog is None:
                return await self._safe_respond(interaction, ITEMS_NOT_LOADED)
            if value == "items":
                return await items_cog.show_items(interaction)
            if value == "item_buy":
                return await items_cog.open_buy(interaction)
            if value == "item_use":
                return await items_cog.open_use(interaction)
            return await items_cog.open_boxes(interaction)

        if value in {"workshop", "machine_buy", "workshop_claim", "craft"}:
            workshop_cog = self.bot.get_cog("WorkshopCog")
            if workshop_cog is None:
                return await self._safe_respond(interaction, WORKSHOP_NOT_LOADED)
            if value == "workshop":
                return await workshop_cog.show_workshop(interaction)
            if value == "machine_buy":
                return await workshop_cog.open_buy_machine(interaction)
            if value == "workshop_claim":
                return await workshop_cog.open_claim(interaction)
            return await workshop_cog.show_craft(interaction)

        if value in {"mining", "lottery", "lottery_buy", "steal"}:
            circulation_cog = self.bot.get_cog("CirculationCog")
            if circulation_cog is None:
                return await self._safe_respond(interaction, CIRCULATION_NOT_LOADED)
            if value == "mining":
                return await circulation_cog.show_mining(interaction)
            if value == "lottery":
                return await circulation_cog.show_lottery(interaction)
            if value == "lottery_buy":
                return await circulation_cog.open_lottery_buy(interaction)
            return await circulation_cog.open_steal(interaction)

        if value in {"slot", "double", "blackjack", "dice"}:
            gambling_cog = self.bot.get_cog("GamblingCog")
            if gambling_cog is None:
                return await self._safe_respond(interaction, GAMBLING_NOT_LOADED)
            if value == "slot":
                return await gambling_cog.show_slot(interaction)
            if value == "double":
                return await gambling_cog.show_double(interaction)
            if value == "blackjack":
                return await gambling_cog.show_blackjack(interaction)
            return await gambling_cog.show_dice(interaction)

        if value in {"market", "token_buy", "token_sell"}:
            market_cog = self.bot.get_cog("MarketCog")
            if market_cog is None:
                return await self._safe_respond(interaction, MARKET_NOT_LOADED)
            if value == "market":
                return await market_cog.show_market(interaction)
            if value == "token_buy":
                return await market_cog.open_buy(interaction)
            return await market_cog.open_sell(interaction)

        if value in {"pay", "status", "coin_leaderboard", "bump_leaderboard", "up_leaderboard"}:
            if wallet is None:
                return await self._safe_respond(interaction, "WalletCogが読み込まれていません。")
            if value == "pay":
                return await interaction.response.send_modal(PayModal(self))
            if value == "status":
                return await wallet.user_status(interaction)
            if value == "coin_leaderboard":
                return await wallet.leaderboard(interaction)
            event_type = value.removesuffix("_leaderboard")
            return await wallet.leaderboard(
                interaction, app_commands.Choice(name=event_type, value=event_type)
            )

        # ===== fujo（生存確認）系 =====
        if value.startswith("fujo_"):
            if fujo is None:
                return await self._safe_respond(interaction, "FujoSurvivalが読み込まれていません。")
            action = value.removeprefix("fujo_")
            try:
                return await fujo.fujo(interaction, action, None, "active", None, None)
            except Exception:
                logger.exception(
                    "fujo dispatch failed: action=%s user=%s guild=%s",
                    action, interaction.user.id,
                    getattr(interaction, "guild_id", None),
                )
                return await self._safe_respond(
                    interaction,
                    "生存確認機能の処理中にエラーが発生しました。時間をおいて再試行してください。",
                )

        logger.warning("dispatch_general: unknown action %r", value)
        return await self._safe_respond(interaction, "この機能は現在利用できません。")


    def _spawn(self, coro) -> None:
        """通知は EXP の保存や他の処理を待たせないよう、バックグラウンドで送る。"""
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)


    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot or message.guild is None:
            return

        try:
            data = await _exp_load()
            user = _exp_ensure(data, message.guild.id, message.author.id)
            level_before = _user_general_level(user)
            if _grant_chat_exp(user, time.time()):
                level_after = _user_general_level(user)  # 保存のawaitを挟む前に確定させる
                await _exp_save()
                if level_after > level_before:
                    self._spawn(self._notify_levelup(
                        message.guild, message.author, level_before, level_after,
                        fallback_channel=message.channel,
                    ))
                    await self._notify_level_rewards(
                        message.guild, message.author, level_before, level_after,
                    )
        except Exception:
            logger.exception("EXP: チャットEXPの付与に失敗しました")

        # MIQ: 引用したいメッセージに返信して「@BOT miq」と送ると発動
        # MIQ として処理した場合は、以降のショートカット処理へ進ませない
        # (トリガー「miq」のショートカットが誤爆して設定パネル等が出るのを防ぐ)。
        if is_miq_trigger(message, self.bot.user if self.bot is not None else None):
            self._spawn(self._miq_from_reply(message))
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()
        for item in shortcuts.matching(
            store, message.guild.id, message.content.strip(), user_id=message.author.id
        ):
            await self.execute_shortcut(message, item)


    @commands.Cog.listener()
    async def on_voice_state_update(self, member, before, after):
        if member.bot or member.guild is None:
            return
        try:
            data = await _exp_load()
            user = _exp_ensure(data, member.guild.id, member.id)
            now = time.time()
            was_in = before.channel is not None
            now_in = after.channel is not None
            levelup = None
            tick_before = _as_float(user.get("vc_last_tick"))
            changed = False
            if not was_in and now_in:
                user["vc_last_tick"] = now
                changed = tick_before != now
            elif was_in and not now_in:
                level_before = _user_general_level(user)
                granted = _grant_vc_exp(user, now)
                level_after = _user_general_level(user)
                if level_after > level_before:
                    levelup = (level_before, level_after)
                user["vc_last_tick"] = 0.0
                # 付与があったか、計測中フラグが実際に下りたときだけ保存する
                changed = granted or tick_before != 0.0
            else:
                return
            if changed:
                await _exp_save()
            if levelup:
                self._spawn(self._notify_levelup(
                    member.guild, member, levelup[0], levelup[1], fallback_channel=before.channel,
                ))
                await self._notify_level_rewards(
                    member.guild, member, levelup[0], levelup[1],
                )
        except Exception:
            logger.exception("EXP: VC入退室の処理に失敗しました")


    @tasks.loop(minutes=1)
    async def exp_vc_tick(self):
        try:
            data = await _exp_load()
            now = time.time()
            touched = False
            active: set[tuple[str, str]] = set()
            levelups: list[tuple[discord.Guild, int, int, int, object]] = []
            for guild in list(self.bot.guilds):
                for uid, voice_channel in _iter_voice_user_channels(guild):
                    active.add((str(guild.id), str(uid)))
                    user = _exp_ensure(data, guild.id, uid)
                    level_before = _user_general_level(user)
                    # 保存するのは実際にEXPが付与されたときだけにする。
                    # vc_accum_sec / vc_last_tick の進行はメモリ上で保持され、
                    # 次回の付与時 (または入退室時) の保存でまとめて永続化される。
                    if _grant_vc_exp(user, now):
                        touched = True
                    level_after = _user_general_level(user)
                    if level_after > level_before:
                        levelups.append((guild, uid, level_before, level_after, voice_channel))
            # VCにいないのに計測中のままの人(退室イベント取りこぼし等)は計測を止める
            for gid, users in data.items():
                if not isinstance(users, dict):
                    continue
                for uid, u in users.items():
                    if (gid, uid) in active or not isinstance(u, dict):
                        continue
                    if _as_float(u.get("vc_last_tick")) > 0.0:
                        u["vc_last_tick"] = 0.0
                        touched = True
            if touched:
                await _exp_save()
            for guild, uid, level_before, level_after, voice_channel in levelups:
                member = guild.get_member(uid)
                if member is not None:
                    await self._notify_level_rewards(
                        guild, member, level_before, level_after,
                    )
                self._spawn(self._notify_levelup(
                    guild, uid, level_before, level_after, fallback_channel=voice_channel,
                ))
        except Exception:
            logger.exception("EXP: VC tick に失敗しました (次の周期で再試行します)")


    @exp_vc_tick.before_loop
    async def before_exp_vc_tick(self):
        await self.bot.wait_until_ready()
        try:
            data = await _exp_load()
            now = time.time()
            touched = False
            for guild in list(self.bot.guilds):
                for uid in _iter_voice_user_ids(guild):
                    user = _exp_ensure(data, guild.id, uid)
                    if _as_float(user.get("vc_last_tick")) != now:
                        user["vc_last_tick"] = now
                        touched = True
            if touched:
                await _exp_save()
        except Exception:
            logger.exception("EXP: 起動時のVC計測の初期化に失敗しました")


async def setup(bot):
    await bot.add_cog(GeneralCog(bot))
