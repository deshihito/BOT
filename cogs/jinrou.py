import logging
from typing import Optional
import asyncio
import random
from collections import Counter
import os
import discord
from core.game import game_panels
from core.emojis import FAILED, SUCCESS
from core.game import jinrou_guide
from discord import app_commands
from discord.ext import commands
from core import autoplay
from core.game import jinrou_review
from core import party_ranking
import math
import config
from core.game.jinrou.autoplay import logger, AutoplayMixin  # noqa: F401
from core.game.jinrou.common import logger, db_api, RATINGS_TABLE, ELO_STARTING_RATING, ELO_BASE_K, ELO_WOLF_WIN_K, BLACK_ROLES_URANAI, BLACK_ROLES_REIBAI, uranai_color, reibai_color, URA_YAKUSHOKU, AHO_FAKE_CANDIDATES, HELP_ROLES, _is_wolf_side  # noqa: F401
from core.game.jinrou.game import logger, JinrouGame  # noqa: F401
from core.game.jinrou.gameloop import logger, GameLoopMixin, restore_jinrou_sessions  # noqa: F401
from core.game.jinrou.helpers import logger, _guide_role_lookup, _get_display_role, _check_and_reveal_ura_yakushoku  # noqa: F401
from core.game.jinrou.lifecycle import logger, LifecycleMixin  # noqa: F401
from core.game.jinrou.ratings import logger, calculate_elo_change, can_end_game  # noqa: F401
from core.game.jinrou.results import logger, ResultsMixin  # noqa: F401
from core.game.jinrou.views import logger, SetupView, AdvancedSetupView, RecruitView, ReplayView, GlobalChannelProxy, GlobalJoinView, RoleCheckView, NightActionView, ActionSelectView, PublicVoteView, ChairmanVoteView  # noqa: F401

logger = logging.getLogger("cogs.jinrou")


async def get_player_rating(player_id: int) -> float:
    """Supabaseからプレイヤーのレートを取得"""
    try:
        response = db_api.table(RATINGS_TABLE).select("rating").eq("player_id", player_id).execute()
        if response.data and len(response.data) > 0:
            return float(response.data[0]["rating"])
        else:
            return ELO_STARTING_RATING
    except Exception as e:
        logger.exception("人狼のレート取得に失敗しました")
        return ELO_STARTING_RATING


async def update_player_rating(player_id: int, new_rating: float, won: Optional[bool] = None):
    """Supabaseにプレイヤーのレートを保存（won を渡すと勝敗数・試合数も数える）"""
    try:
        response = db_api.table(RATINGS_TABLE).select("id, wins, losses, games_played").eq("player_id", player_id).execute()
        row = response.data[0] if response.data else None
        values = {"rating": new_rating}
        if won is not None:
            values["wins"] = int((row or {}).get("wins") or 0) + (1 if won else 0)
            values["losses"] = int((row or {}).get("losses") or 0) + (0 if won else 1)
            values["games_played"] = int((row or {}).get("games_played") or 0) + 1
        if row:
            values["updated_at"] = "now()"
            db_api.table(RATINGS_TABLE).update(values).eq("player_id", player_id).execute()
        else:
            db_api.table(RATINGS_TABLE).insert({"player_id": player_id, **values}).execute()
    except Exception as e:
        logger.exception("人狼のレート更新に失敗しました")


async def get_top_ratings(limit: int = 10):
    """上位レーティングを取得"""
    try:
        response = db_api.table(RATINGS_TABLE).select("player_id, rating").order("rating", desc=True).limit(limit).execute()
        return response.data if response.data else []
    except Exception as e:
        logger.exception("人狼のランキング取得に失敗しました")
        return []


class JinrouCog(LifecycleMixin, GameLoopMixin, AutoplayMixin, ResultsMixin, commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.games = {}

    async def restore_after_restart(self):
        """フェーズ境界スナップショット（core/game/jinrou_snapshot.py）からの復旧。"""
        await restore_jinrou_sessions(self)

    async def rating_embed(self, user) -> discord.Embed:
        """/game の人狼画面の「レート」から呼ぶ。自分のレートと、レート上位10人。"""
        rating = await get_player_rating(user.id)
        rankings = await get_top_ratings(10)
        lines = []
        for i, entry in enumerate(rankings or [], 1):
            player_id = entry["player_id"]
            try:
                fetched = await self.bot.fetch_user(player_id)
                name = fetched.display_name if fetched else f"ID: {player_id}"
            except Exception:
                logger.debug("人狼: プレイヤー名の解決に失敗しました", exc_info=True)
                name = f"ID: {player_id}"
            lines.append(f"{i}. **{name}**: {entry['rating']:.0f} pts")
        ranking_text = "\n".join(lines) if lines else "ランキングデータがまだありません。"
        return discord.Embed(
            title="人狼レーティング",
            description=f"**{user.display_name}** さんのレート: {rating:.0f} pts\n\n**レート上位10人**\n{ranking_text}",
            color=0xFFFFFF,
        )

    async def _process_elo_ratings(self, game, winner_is_wolf: bool):
        """ゲーム結果をもとにEloレーティングを更新"""
        def is_wolf_side(p_id):
            return _is_wolf_side(game, p_id)

        players = list(game.players)
        if not players:
            return
        try:
            # 先に全員の今のレートを読んでおき、平均も 1 回だけ計算する（更新の順番で結果が変わらないように）。
            # 以前は sum(await ... for ...) が非同期ジェネレーターになって TypeError で落ち、1 件も保存されていなかった。
            before = {p.id: await get_player_rating(p.id) for p in players}
            avg_rating = sum(before.values()) / len(before)
            for p in players:
                p_id = p.id
                player_is_wolf_side = is_wolf_side(p_id)
                rating = before[p_id]
                won = player_is_wolf_side == winner_is_wolf
                if won:
                    rating_change, _ = calculate_elo_change(rating, avg_rating, player_is_wolf_side)
                else:
                    _, rating_change = calculate_elo_change(avg_rating, rating, not player_is_wolf_side)
                new_rating = max(0, rating + rating_change)
                await update_player_rating(p_id, new_rating, won=won)
        except Exception:
            # レートの失敗でゲームの終了処理（最終役職の開示など）を止めない
            logging.getLogger(__name__).exception("人狼のレート更新に失敗しました")


async def setup(bot):
    await bot.add_cog(JinrouCog(bot))
