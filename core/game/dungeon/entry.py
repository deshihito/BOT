# -*- coding: utf-8 -*-
"""
ダンジョンシステム Cog（スタンドアロン版）
dungeon.py - Discord.py Cog形式

【必須設定】
  .env:
    DUNGEON_IMG_CHANNEL_ID=画像投稿チャンネルID
  
  自前DB API テーブル:
    - dungeon_players (user_id, floor, x, y, hp, max_hp, atk, def_, spd, crit)
      ※マップは Phase 1-B からプレイヤー個人インスタンス（シード再生成＋
        差分は inventory._dungeon_meta の instances に保存）。
        旧 dungeon_maps / dungeon_bases テーブルは読み書きしない。
  
  main.py:
    await bot.load_extension('cogs.dungeon')
"""
import os
import discord
import json
import random
import asyncio
import base64
import io
import time
import hashlib
import aiohttp
from core.general.ai import logfare
import datetime
import logging
from discord.ui import View
from discord import app_commands, Interaction
from discord.ext import commands, tasks
from cogs.support import ALLOWED_USER_IDS
from discord.ext.commands import Cog
from PIL import Image, ImageDraw, ImageEnhance
from zoneinfo import ZoneInfo
from core.support.api_client import APIError
from core.support.api_retry import run_with_retry
from core.game.dungeon.actions import logger, d_use_job_skill, d_current_cell_action, d_activate_room_entry, d_execute_journey, _NoopResponse, _NoopInteraction, _CLEF_PLAYER, d_lock_callback  # noqa: F401
from core.game.dungeon.clef import logger, CLEF_MOVE_KEYS, CLEF_PLAN_GUIDANCE, dungeon_plan_guidance, d_floor_routes, dungeon_action_candidates, dungeon_candidate_log, d_normalize_choice, dungeon_relative_label, dungeon_stairs_cell, dungeon_stairs_hint, dungeon_move_criteria, dungeon_goal_text, dungeon_best_direction, d_make_reward_choices, d_choose_reward, d_begin_run, d_end_run, d_record_action, d_record_reward  # noqa: F401
from core.game.dungeon.clef_player import logger, ClefDungeonPlayer  # noqa: F401
from core.game.dungeon.combat import logger, d_advance_intent, d_intent_label, d_element_weakness, d_make_enemy  # noqa: F401
from core.game.dungeon.common import JST, D_MAP_W, D_MAP_H, D_FLOORS, D_VIEW_R, D_SIGHT_R, TILE, D2_MAP_W, D2_MAP_H, D2_SECTOR_N, D2_MAIN_ROLES, D2_SUB_ROLES, D_WALL, D_FLOOR, D_START, D_STAIRS, D_CHEST, D_TRAP, D_SHOP, D_BASE, D_MINE, D_REST, D_SHRINE, D_EVENT, I_WALL, I_FLOOR, I_EXIT, I_COUNTER, I_REST, I_STORAGE, I_BAKERY, I_DOUBLE, I_SLOT, D_BIOMES, SEASON_ID, JOB_MASTER, EQUIPMENT_MASTER, ELEMENTS, STATUS_EFFECTS, D_ACTIVE_ELEMENTS, D_ACTIVE_STATUSES, D_INTENT_CYCLES, D_ARCHETYPE_NAMES, D_INTENT_LABELS, D_INTENT_DAMAGE_MUL, D_ENEMY_ARCHETYPES, WEAPON_TYPES, RELIC_MASTER, QUEST_MASTER, ROOM_MODIFIERS, CLEF_PLANS, CLEF_STATE_CHARS, CLEF_LOG_LINES, CLEF_MAX_TURNS, CLEF_TIMEOUT, CLEF_RETRIES, CLEF_RETRY_DELAY, _DIRECTIONS, D_WALK_MAX_STEPS, D_AMBUSH_RATE, D_ROOM_ROLE_NAMES, D_WALK_SPECIAL_CELLS, D_WALK_STOP_TEXTS, _DIRECTION_LABELS, ACHIEVEMENTS, NPC_MASTER, FLOOR_GOALS, TILE_COLORS, ASSET_CONFIG, D_ENEMY_NAMES, D_SUPERENEMY_NAMES, D_BOSS_NAMES, ENEMY_STATS_MASTER, dg_maps, dg_players, dg_starts, dg_used, dg_bases, dg_instances, _ASSET_CACHE, _PLAYER_LOCKS, _MAP_SAVE_DIGESTS, _PLAYER_SAVE_DIGESTS, DUNGEON_IMG_CHANNEL_ID, logger, d_encode_visited, d_decode_visited  # noqa: F401
from core.game.dungeon.floors import logger, d_gen_floor, _D2_ROLE_TILES, d_floor_seed, _d2_sector_origin, _d2_main_route, d_gen_floor_v2  # noqa: F401
from core.game.dungeon.player import logger, d_default_player, d_get_player, d_effective_stats, d_progress_quest, d_grant_relic, d_apply_special_status, d_apply_floor_goal, d_equipment_profile, d_upgrade_equipment, d_floor_modifier, d_content_summary, d_apply_status, d_clear_status, d_tick_status, d_unlock_achievement, d_job_name, d_get_lock, d_apply_economy, d_apply_reward, d_hpbar, d_open_chest, d_trigger_trap, d_do_mine, d_enemy_archetype, d_intent_at, d_ensure_intent, d_instance_start, d_get_instance, d_reveal_room  # noqa: F401
from core.game.dungeon.render import logger, load_all_assets, _draw_tile, d_build_map_image, _MAP_SEQ, d_next_map_filename, d_map_attachment, d_render_pillow, d_render_image  # noqa: F401
from core.game.dungeon.storage import logger, dg_load_all, dg_save_player  # noqa: F401
from core.game.dungeon.views import logger, DungeonViewBase, d_dungeon_view, d_return_to_dungeon, clef_plan_for, clef_status_text, DungeonStatusView, DungeonStairsView, DungeonMineView, DungeonShopView, DungeonCombatView, DungeonMainView, DungeonUnifiedView, DungeonOperationView, DungeonRewardChoiceView  # noqa: F401
from core.game.dungeon.world import logger, d_get_biome, d_instances_snapshot, d_migrate_player_v2, d_ensure_map, d_get_cell, d_consume, d_room_at, d_mark_corridor_visited, d_room_cleared, d_mark_room_cleared, d_room_discovered, d_stairs_room_blocked, d_floor_progress_text, _d_corridor_component, d_room_graph, d_room_distances, d_rooms_to_stairs, d_room_summary_text, d_next_direction_toward, d_plan_navigation_direction, _d_route_anchor_index, d_target_room, d_stairs_discovered, d_reset_floor_counters, d_record_floor_clear, d_destination_label, d_direction_blocked, d_plan_walk, dungeon_bfs, dungeon_plan_key  # noqa: F401

logger = logging.getLogger("cogs.dangeon")


class DungeonCog(Cog):
    """ダンジョンシステムCog"""

    def __init__(self, bot):
        self.bot = bot
        self.db_api = None
        # 自動操作は同一ファイル内で管理する（Clefによる自動操作）。
        self.clef = ClefDungeonPlayer(bot)

    async def cog_load(self):
        """Cog読み込み時"""
        global _CLEF_PLAYER
        _CLEF_PLAYER = self.clef
        # 親botから自前DB APIクライアントを取得
        if hasattr(self.bot, 'db_api'):
            self.db_api = self.bot.db_api
            await dg_load_all(self.db_api)

        # アセットを読み込み
        load_all_assets()

        # タスク開始
        if not self.dungeon_monthly_task.is_running():
            self.dungeon_monthly_task.start()

    def cog_unload(self):
        """Cog アンロード時"""
        self.clef.shutdown()
        if self.dungeon_monthly_task.is_running():
            self.dungeon_monthly_task.cancel()

    async def start_recruit(self, interaction: Interaction):
        """ゲームハブからダンジョンを開始する。"""
        await interaction.response.defer()
        uid = str(interaction.user.id)

        # プレイヤーデータ取得
        p = d_get_player(uid)
        floor, x, y = p["floor"], p["x"], p["y"]

        # そのプレイヤーのインスタンスを用意し、位置が不正（範囲外・壁）ならスタートへ戻す
        sx, sy = d_instance_start(uid, floor)
        if not (0 <= x < D2_MAP_W and 0 <= y < D2_MAP_H) or d_get_cell(uid, floor, x, y) == D_WALL:
            x, y = sx, sy
            p["x"] = x
            p["y"] = y
            if self.db_api:
                await dg_save_player(uid, self.db_api)

        # すべての通常操作・ステータス・自動操作開始/停止を1つの画面へ集約する。
        mv = DungeonUnifiedView(uid, floor, x, y, self.db_api)

        # 初期画像は専用チャンネルへ投げず、コマンド応答へ直接添付する。
        map_file, map_url = await asyncio.to_thread(d_map_attachment, uid, floor, x, y)
        em = mv._embed("ダンジョンへようこそ！ Clef自動操作と作戦はSTATUS画面から設定できます。", image_url=map_url)
        await interaction.followup.send(embed=em, view=mv, file=map_file)

    @commands.command(name="dungeon_reset")
    async def dungeon_reset(self, ctx: commands.Context):
        """ダンジョンをリセット（Bot の持ち主専用）。Phase 1-B: 個人インスタンス基盤。"""
        if ctx.author.id not in ALLOWED_USER_IDS:
            return
        dg_instances.clear()
        dg_players.clear()
        # 互換のため旧共有マップのキャッシュも掃除する（実データはもう使わない）。
        dg_maps.clear()
        dg_starts.clear()
        dg_used.clear()
        dg_bases.clear()

        # DBのプレイヤーデータも全消去する（マップはプレイヤー毎に生成されるため消去不要）。
        if self.db_api:
            try:
                self.db_api.table("dungeon_players").delete().neq("user_id", "").execute()
            except Exception as e:
                logger.exception("dungeon_reset DB削除失敗")

        em = discord.Embed(title="リセット完了", description="プレイヤーデータを消去しました。マップはプレイヤー毎に再生成されます。", color=0xFFFFFF)
        await ctx.send(embed=em)

    @tasks.loop(hours=1)
    async def dungeon_monthly_task(self):
        """月初にインスタンスとラン中状態だけを更新し、永続進行は保持する。"""
        now = datetime.datetime.now(JST)
        if now.day == 1 and now.hour == 0:
            dg_instances.clear()

            for uid, player in dg_players.items():
                player["season_id"] = SEASON_ID
                player["season_score"] = 0
                player["floor"] = 1
                player["instances"] = {}
                player["x"], player["y"] = d_instance_start(uid, 1)
                player["hp"] = d_effective_stats(player)["max_hp"]
                player["turns"] = 0
                d_reset_floor_counters(player)
                player["cooldowns"] = {}

            if self.db_api:
                for uid in list(dg_players):
                    await dg_save_player(uid, self.db_api)

            logger.info("✓ ダンジョン月次リセット完了")

    @dungeon_monthly_task.before_loop
    async def before_dungeon_task(self):
        await self.bot.wait_until_ready()


# セットアップ関数
async def setup(bot):
    """Cogをロード"""
    await bot.add_cog(DungeonCog(bot))
    logger.info("✓ DungeonCog loaded")
