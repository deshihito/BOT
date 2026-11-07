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

from core.game.dungeon.common import *  # noqa: F401,F403 - shared constants/state
from core.game.dungeon.actions import _CLEF_PLAYER, _NoopInteraction, d_current_cell_action, d_execute_journey, d_lock_callback, d_use_job_skill  # noqa: F401
from core.game.dungeon.clef import d_choose_reward, d_make_reward_choices  # noqa: F401
from core.game.dungeon.combat import d_advance_intent, d_element_weakness, d_intent_label  # noqa: F401
from core.game.dungeon.common import ACHIEVEMENTS, CLEF_PLANS, D_ARCHETYPE_NAMES, D_FLOORS, D_INTENT_DAMAGE_MUL, ELEMENTS, EQUIPMENT_MASTER, FLOOR_GOALS, JOB_MASTER, NPC_MASTER, QUEST_MASTER, RELIC_MASTER, STATUS_EFFECTS, _DIRECTIONS  # noqa: F401
from core.game.dungeon.player import d_apply_floor_goal, d_apply_reward, d_apply_special_status, d_clear_status, d_content_summary, d_do_mine, d_effective_stats, d_ensure_intent, d_floor_modifier, d_get_instance, d_get_lock, d_get_player, d_hpbar, d_instance_start, d_job_name, d_progress_quest, d_tick_status, d_unlock_achievement, d_upgrade_equipment  # noqa: F401
from core.game.dungeon.render import d_map_attachment  # noqa: F401
from core.game.dungeon.storage import dg_save_player  # noqa: F401
from core.game.dungeon.world import d_consume, d_destination_label, d_direction_blocked, d_floor_progress_text, d_get_biome, d_mark_room_cleared, d_plan_navigation_direction, d_record_floor_clear, d_reset_floor_counters, d_room_discovered, d_stairs_discovered, d_stairs_room_blocked  # noqa: F401

logger = logging.getLogger("cogs.dangeon")




class DungeonViewBase(View):
    """全ダンジョンUIの共通基底。所有者以外の操作を拒否し、常に最新のプレイヤー状態を参照する。"""

    def __init__(self, uid, *, timeout):
        super().__init__(timeout=timeout)
        self.uid = str(uid)

    def sync_state(self):
        """生成時のスナップショットではなく、保存済みプレイヤー状態を正とする。"""
        p = d_get_player(self.uid)
        self.floor, self.x, self.y = p["floor"], p["x"], p["y"]
        return p

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if str(interaction.user.id) != self.uid:
            await interaction.response.send_message(
                "このダンジョン画面は開始者本人のみ操作できます。", ephemeral=True
            )
            return False
        return True

    async def on_timeout(self):
        for item in self.children:
            item.disabled = True


def d_dungeon_view(uid, db_api=None, plan=None):
    """保存済み状態から統合パネルを作り直す。全画面の「戻る」はここへ揃える。"""
    p = d_get_player(uid)
    return DungeonUnifiedView(uid, p["floor"], p["x"], p["y"], db_api, plan=plan)


async def d_return_to_dungeon(interaction, uid, db_api, msg=""):
    """現在状態の統合パネルへ戻る。全画面共通の復帰処理。"""
    p = d_get_player(uid)
    view = d_dungeon_view(uid, db_api)
    map_file, map_url = d_map_attachment(uid, p["floor"], p["x"], p["y"])
    await interaction.edit_original_response(
        embed=view._embed(msg, image_url=map_url), view=view, attachments=[map_file]
    )


def clef_plan_for(uid):
    """現在のClef作戦。実行中は実行中のもの、停止中は最後に選んだものを返す。"""
    if _CLEF_PLAYER is None:
        return CLEF_PLANS["safe"]
    return _CLEF_PLAYER.plan_for(uid)


def clef_status_text(uid):
    """ステータス画面に表示するClefの実行状況。"""
    if _CLEF_PLAYER is None:
        return "未初期化"
    return _CLEF_PLAYER.status_text(uid)


class DungeonStatusView(DungeonViewBase):
    """ステータス表示。自動操作の接続と作戦選択はこの画面へ集約する。"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=300)
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api
        self.clef_plan = clef_plan_for(uid)

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        stats = d_effective_stats(p)
        em = discord.Embed(title="ダンジョン ステータス", description=msg, color=0xFFFFFF)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="現在位置", value=f"フロア **{p['floor']}** ({p['x']}, {p['y']}) / {d_floor_modifier(p['floor'])}", inline=False)
        em.add_field(name="HP", value=f"{d_hpbar(p['hp'], stats['max_hp'])} {p['hp']}/{stats['max_hp']}", inline=False)
        em.add_field(name="職業", value=d_job_name(self.uid), inline=True)
        em.add_field(name="ステータス", value=f"ATK:{stats['atk']} DEF:{stats['def_']} SPD:{stats['spd']} CRIT:{int(stats['crit']*100)}%", inline=False)
        effects = [STATUS_EFFECTS.get(e.get('key'), {}).get('name', e.get('key')) for e in p.get('active_effects', []) if isinstance(e, dict)]
        em.add_field(name="成長", value=f"Lv.{p['level']} XP:{p['xp']} / 次:{p['level']*100}\n実績:{len(p['achievements'])}/{len(ACHIEVEMENTS)} スコア:{p['season_score']}", inline=False)
        em.add_field(name="状態異常", value="、".join(effects) if effects else "なし", inline=True)
        em.add_field(name="遺物・属性", value=f"遺物: {', '.join(RELIC_MASTER.get(k, {}).get('name', k) for k in p.get('relics', [])) or 'なし'}\n装備属性: {', '.join(EQUIPMENT_MASTER.get(k, {}).get('element', 'none') for k in p.get('equipment', {}).values()) or 'none'}", inline=False)
        quests, _ = d_content_summary(self.uid)
        em.add_field(name="クエスト", value="\n".join(quests) if quests else "全クエスト達成", inline=False)
        em.add_field(name="自動操作", value=f"作戦: **{self.clef_plan}**\n状態: {clef_status_text(self.uid)}", inline=False)
        # Phase 1-E の踏破計測: 直近に踏破したフロアの実績を小さく添える。
        history = p.get("floor_history") or []
        if history:
            last = history[-1]
            em.add_field(
                name="前フロアの実績",
                value=f"{last.get('floor', '?')}F: {last.get('turns_used', 0)}ターン / {last.get('journeys_used', 0)}回移動",
                inline=False,
            )
        return em

    async def _render(self, interaction, msg=""):
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file]
        )

    @discord.ui.button(label="自動操作開始", style=discord.ButtonStyle.blurple, row=0)
    async def start_autoplay(self, interaction, button):
        if _CLEF_PLAYER is None:
            await interaction.response.send_message("自動操作機能が初期化されていません。", ephemeral=True)
            return
        # 押した時点の現在状態と作戦で自動操作を開始する（状態はダンジョンと共有）。
        await _CLEF_PLAYER.start(interaction, self.clef_plan)

    @discord.ui.button(label="操作メニュー", style=discord.ButtonStyle.green, row=0)
    async def operations(self, interaction, button):
        await interaction.response.defer()
        p = self.sync_state()
        op = DungeonOperationView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=op._embed("操作メニュー", image_url=map_url), view=op, attachments=[map_file]
        )

    @discord.ui.button(label="ダンジョンへ戻る", style=discord.ButtonStyle.grey, row=0)
    async def back(self, interaction, button):
        await interaction.response.defer()
        await d_return_to_dungeon(interaction, self.uid, self.db_api, "")

    @discord.ui.select(
        placeholder="Clef作戦を選択",
        options=[discord.SelectOption(label=name, value=key) for key, name in CLEF_PLANS.items()],
        row=1,
    )
    async def select_plan(self, interaction, select):
        await interaction.response.defer()
        self.clef_plan = CLEF_PLANS.get(select.values[0], CLEF_PLANS["safe"])
        if _CLEF_PLAYER is not None:
            # 実行中の場合は走行中の作戦も即時更新する。
            _CLEF_PLAYER.set_plan(self.uid, self.clef_plan)
        await self._render(interaction, f"Clef作戦を **{self.clef_plan}** に設定しました。")


class DungeonStairsView(DungeonViewBase):
    """階段View"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=180)
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api

    def _embed(self, msg="", image_url=None):
        em = discord.Embed(title="階段がある", color=0xFFFFFF, description=msg)
        if image_url:
            em.set_image(url=image_url)
        return em

    async def _render(self, interaction, msg=""):
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file]
        )

    @discord.ui.button(label="上へ進む", style=discord.ButtonStyle.green)
    @d_lock_callback
    async def up(self, i, b):
        await i.response.defer()
        p = self.sync_state()
        floor = p["floor"]
        if d_stairs_room_blocked(self.uid, floor, p["x"], p["y"]):
            # Phase 1-D: 番人を倒すまでは階段を使えない（防御的な再確認）。
            await self._render(i, "階段は番人に守られている。番人を倒さないと使えない。")
            return
        if floor < D_FLOORS:
            d_record_floor_clear(self.uid)
            p["floor"] = floor + 1
            p["hp"] = d_effective_stats(p)["max_hp"]
            d_clear_status(self.uid)
            p["x"], p["y"] = d_instance_start(self.uid, p["floor"])
            d_reset_floor_counters(p)
            d_progress_quest(self.uid, "floor", 1)
            await dg_save_player(self.uid, self.db_api)
            await d_return_to_dungeon(i, self.uid, self.db_api, f"フロア {p['floor']}へ到達！")
        else:
            await i.edit_original_response(embed=discord.Embed(title="ゴール！", description="ダンジョンをクリアしました！", color=0xFFFFFF))

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.db_api, "")


class DungeonMineView(DungeonViewBase):
    """採掘View"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=60)
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api

    def _embed(self, msg="", image_url=None):
        em = discord.Embed(title="鉱山", color=0xFFFFFF, description=msg)
        if image_url:
            em.set_image(url=image_url)
        return em

    @discord.ui.button(label="⛏ 採掘する", style=discord.ButtonStyle.green)
    @d_lock_callback
    async def mine(self, i, b):
        await i.response.defer()
        gain = d_do_mine(self.uid)
        await d_apply_reward(self.uid, self.db_api, coins=gain)
        d_consume(self.uid, self.floor, self.x, self.y)
        await dg_save_player(self.uid, self.db_api)
        await dg_save_player(self.uid, self.db_api)
        await d_return_to_dungeon(i, self.uid, self.db_api, f"採掘！ **+{gain}** コイン")

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.db_api, "")


class DungeonShopView(DungeonViewBase):
    """軽量な商店View。購入はサーバー側で価格を検証する。"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=120)
        self.floor, self.x, self.y, self.db_api = floor, x, y, db_api

    def _embed(self, msg="", image_url=None):
        p = d_get_player(self.uid)
        em = discord.Embed(title="旅の商店", description=msg, color=0xB450C8)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="レアパン 30 AGO", value="HPを回復するアイテム", inline=True)
        em.add_field(name="革鎧 250 AGO", value="DEF+3 / HP+15", inline=True)
        em.add_field(name="所持", value=f"レアパン:{p['bread']} / 宝箱:{p['boxes']}", inline=False)
        return em

    async def _buy(self, i, price, reward, label):
        await i.response.defer()
        try:
            await d_apply_reward(self.uid, self.db_api, coins=-price, **reward)
            msg = f"{label}を購入しました。"
        except Exception:
            msg = "コインが足りないか、購入に失敗しました。"
        await dg_save_player(self.uid, self.db_api)
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await i.edit_original_response(embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file])

    @discord.ui.button(label="パンを買う", style=discord.ButtonStyle.green)
    @d_lock_callback
    async def buy_bread(self, i, b):
        await self._buy(i, 30, {"bread": 1}, "レアパン")

    @discord.ui.button(label="革鎧を買う", style=discord.ButtonStyle.blurple)
    @d_lock_callback
    async def buy_armor(self, i, b):
        await self._buy(i, 250, {"equipment": "leather_armor"}, "革鎧")

    @discord.ui.button(label="戻る", style=discord.ButtonStyle.grey, row=1)
    @d_lock_callback
    async def back(self, i, b):
        await i.response.defer()
        await d_return_to_dungeon(i, self.uid, self.db_api, "")


class DungeonCombatView(DungeonViewBase):
    """戦闘View"""

    def __init__(self, uid, floor, x, y, enemy, db_api, room_id=None):
        super().__init__(uid, timeout=180)
        self.uid = uid
        self.floor = floor
        self.x = x
        self.y = y
        self.enemy = d_ensure_intent(enemy)
        self.log = []
        self.defending = False
        self.db_api = db_api
        # Phase 1-D: 部屋発動の戦闘の場合、勝利時にその部屋を制圧済みに
        # する（combat 部屋の再発動防止、階段部屋のガード解除）。
        self.room_id = room_id

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        e = self.enemy
        p_stats = d_effective_stats(p)

        etype = e.get("type", "normal")
        type_text = {"normal": "通常", "elite": "精鋭", "boss": "ボス"}.get(etype, "通常")

        em = discord.Embed(title=f"{e['name']}（{type_text}）が現れた！", color=0xFFFFFF)
        if image_url:
            em.set_image(url=image_url)

        em.add_field(name="あなた",
                     value=f"`{d_hpbar(p['hp'],p_stats['max_hp'])}`{p['hp']}/{p_stats['max_hp']}\nATK:{p_stats['atk']} DEF:{p_stats['def_']}",
                     inline=True)

        element_name = ELEMENTS.get(e.get("element", "none"), {}).get("name", "無")
        weakness = d_element_weakness(e.get("element", "none"))
        weakness_name = ELEMENTS.get(weakness, {}).get("name", "なし") if weakness else "なし"
        em.add_field(name=e["name"],
                     value=f"`{d_hpbar(e['hp'],e['max_hp'])}`{e['hp']}/{e['max_hp']}\nATK:{e['atk']} DEF:{e['def_']}\n属性:{element_name} 弱点:{weakness_name}",
                     inline=True)

        player_first = p_stats.get("spd", 10) >= e.get("spd", 10)
        # Phase 2-A: 予告は実在の意図（次に必ず取る行動）を表示する。
        intent_note = ""
        if e.get("intent") == "heavy":
            intent_note = "（防御で軽減できる）"
        elif e.get("intent") == "charge":
            intent_note = "（このターンは攻撃してこない）"
        em.add_field(
            name="行動順 / 敵の意図",
            value=(f"{'あなた → ' + e['name'] if player_first else e['name'] + ' → あなた'}\n"
                   f"次: **{d_intent_label(e)}**{intent_note}"
                   f"（{D_ARCHETYPE_NAMES.get(e.get('archetype', 'normal'), '通常型')}）"),
            inline=False,
        )

        if self.log:
            em.add_field(name="ログ", value="\n".join(self.log[-5:]), inline=False)
        return em

    async def _render(self, interaction, msg=""):
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=self._embed(msg, image_url=map_url), view=self, attachments=[map_file]
        )

    def _calculate_damage(self, attacker, defender, is_defending=False):
        attacker_stats = d_effective_stats(attacker) if "job" in attacker else attacker
        defender_stats = d_effective_stats(defender) if "job" in defender else defender
        is_crit = random.random() < attacker_stats.get("crit", 0.05)
        target_def = defender_stats.get("def_", 0)
        if is_defending:
            target_def *= 2
        dmg = max(1, attacker_stats["atk"] - target_def + random.randint(-2, 3))
        # プレイヤーの属性は装備中の武器から解決する。
        attacker_element = attacker.get("element", "none") if isinstance(attacker, dict) else "none"
        if "job" in attacker:
            weapon_key = attacker.get("equipment", {}).get("weapon")
            attacker_element = EQUIPMENT_MASTER.get(weapon_key, {}).get("element", "none")
        defender_element = defender.get("element", "none") if isinstance(defender, dict) else "none"
        if attacker_element in ELEMENTS and defender_element in ELEMENTS:
            # Phase 2-A: 弱点/耐性の向きを修正した。ELEMENTS[X]["weak"] は
            # 「X が弱点とする攻撃属性」の一覧なので、防御側のエントリで
            # 攻撃属性を引く（旧実装は攻撃側で引いており向きが逆だった）。
            if attacker_element in ELEMENTS[defender_element].get("weak", []):
                dmg = int(dmg * 1.35)
            elif attacker_element in ELEMENTS[defender_element].get("resist", []):
                dmg = max(1, int(dmg * 0.75))
        if is_crit:
            return int(dmg * 1.5), True
        return dmg, False

    def _enemy_turn(self):
        p = d_get_player(self.uid)
        e = self.enemy
        flags = p.setdefault("battle_flags", {})
        # 凍結・麻痺は行動そのものを失う。付与時の状態異常処理はここで消化する。
        if flags.pop("skip_next", False):
            self.defending = False
            return "凍結で行動できませんでした"
        if flags.pop("paralyzed", False) and random.random() < 0.5:
            self.defending = False
            return "麻痺で行動に失敗しました"

        effect_logs = d_tick_status(self.uid)
        # Phase 2-A: 行動はランダムではなく、表示中の意図どおりに実行する。
        d_ensure_intent(e)
        action = e["intent"]

        log_msg = ""
        if action == "charge":
            log_msg = f"{e['name']}は力を溜めている…次の攻撃は大ダメージになる！"
        elif action in ("heavy", "strong"):
            dmg, crit = self._calculate_damage(e, p, self.defending)
            dmg = int(dmg * D_INTENT_DAMAGE_MUL[action])
            p["hp"] = max(0, p["hp"] - dmg)
            label = "大ダメージ攻撃" if action == "heavy" else "強攻撃"
            log_msg = f"**{e['name']}の{label}！！** {dmg} ダメージ"
        elif action == "heal":
            heal_amt = int(e["max_hp"] * 0.15)
            e["hp"] = min(e["max_hp"], e["hp"] + heal_amt)
            log_msg = f"{e['name']}は傷口を舐めて {heal_amt} 回復した"
        elif action == "wait":
            log_msg = f"{e['name']}は様子を伺っている..."
        else:  # "attack" / "status"
            dmg, crit = self._calculate_damage(e, p, self.defending)
            if action == "status":
                dmg = max(1, int(dmg * D_INTENT_DAMAGE_MUL["status"]))
            p["hp"] = max(0, p["hp"] - dmg)
            c_msg = "**CRITICAL!!** " if crit else ""
            log_msg = f"{c_msg}{e['name']}の攻撃：{dmg} ダメージ"

        # 状態異常の付与: 「状態異常攻撃」の意図では確実に、それ以外の
        # 攻撃では従来どおり25%で付与する。
        if p["hp"] > 0 and e.get("status_effect"):
            if action == "status" or (action in ("attack", "strong", "heavy") and random.random() < 0.25):
                d_apply_special_status(self.uid, e["status_effect"])
                log_msg += f" / {STATUS_EFFECTS[e['status_effect']]['name']}を受けた"
        d_advance_intent(e)

        self.defending = False
        p_cooldowns = d_get_player(self.uid).setdefault("cooldowns", {})
        for key in list(p_cooldowns):
            if p_cooldowns[key] > 0:
                p_cooldowns[key] -= 1
        result = " / ".join(effect_logs + [log_msg])
        if flags.get("cursed"):
            p["hp"] = max(0, p["hp"] - 2)
            result += " / 呪いで2ダメージ"
        return result

    async def _register_kill(self):
        """撃破の記録・実績・クエストを、報酬の受け取り方法に関わらず一度だけ処理する。"""
        p = d_get_player(self.uid)
        stats = p.setdefault("battle_stats", {})
        stats["kills"] = stats.get("kills", 0) + 1
        if self.enemy.get("type") == "boss":
            d_unlock_achievement(self.uid, "first_boss")
        d_apply_floor_goal(self.uid, "kills", 1)
        for quest_key in d_progress_quest(self.uid, "kills", 1):
            await d_apply_reward(self.uid, self.db_api, **QUEST_MASTER[quest_key]["reward"])

    async def _win(self, i):
        e = self.enemy
        p = d_get_player(self.uid)
        if self.room_id is not None:
            # 部屋発動の戦闘に勝利したので部屋を制圧済みにする（Phase 1-D）。
            # 逃走・敗北では呼ばれないため、未制圧のまま再挑戦できる。
            d_mark_room_cleared(d_get_instance(self.uid, self.floor), self.room_id)
        if isinstance(i, _NoopInteraction):
            # 自動操作中は選択UIを挟まず、その場で戦利品を反映する。
            p["pending_rewards"] = []
            await self._register_kill()
            await d_apply_reward(
                self.uid, self.db_api,
                coins=e["reward_coins"], xp=e["reward_xp"], boxes=e["reward_box"],
                season_score=500 if e.get("type") == "boss" else 25,
            )
            msg = f"勝利！ +{e['reward_coins']}コイン +{e['reward_xp']}XP"
            if e["reward_box"] > 0:
                msg += f" +宝箱{e['reward_box']}個"
            self.log.append(msg)
            await dg_save_player(self.uid, self.db_api)
            return

        choices = d_make_reward_choices(self.uid, e)
        await self._register_kill()
        p["pending_rewards"] = [c["reward"] for c in choices]
        self.log.append("勝利！報酬を3候補から1つ選択してください")
        await dg_save_player(self.uid, self.db_api)
        self.stop()
        view = DungeonRewardChoiceView(self.uid, self.floor, self.x, self.y, self.db_api, choices)
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await i.edit_original_response(embed=self._embed(image_url=map_url), view=view, attachments=[map_file])

    async def _lose(self, i):
        p = d_get_player(self.uid)
        p["hp"] = d_effective_stats(p)["max_hp"]
        p["floor"] = 1
        p["x"], p["y"] = d_instance_start(self.uid, 1)
        d_reset_floor_counters(p)
        self.log.append("敗北… スタート地点へ送還された")
        await dg_save_player(self.uid, self.db_api)
        self.stop()
        if isinstance(i, _NoopInteraction):
            return
        await d_return_to_dungeon(i, self.uid, self.db_api, "敗北して戻された…")

    @discord.ui.button(label="攻撃", style=discord.ButtonStyle.red, row=0)
    @d_lock_callback
    async def attack(self, i, b):
        await i.response.defer()
        p = d_get_player(self.uid)
        e = self.enemy
        p_first = d_effective_stats(p).get("spd", 10) >= e.get("spd", 10)

        if p_first:
            dmg, crit = self._calculate_damage(p, e)
            e["hp"] = max(0, e["hp"] - dmg)
            self.log.append(f"{'**CRIT!!** ' if crit else ''}{dmg} ダメージ！")
            if e["hp"] <= 0:
                await self._win(i)
                return
            self.log.append(self._enemy_turn())
        else:
            self.log.append(self._enemy_turn())
            if p["hp"] <= 0:
                await self._lose(i)
                return
            dmg, crit = self._calculate_damage(p, e)
            e["hp"] = max(0, e["hp"] - dmg)
            self.log.append(f"{'**CRIT!!** ' if crit else ''}{dmg} ダメージ！")

        if e["hp"] <= 0:
            await self._win(i)
            return
        if p["hp"] <= 0:
            await self._lose(i)
            return
        await self._render(i)

    @discord.ui.button(label="防御", style=discord.ButtonStyle.blurple, row=0)
    @d_lock_callback
    async def defend(self, i, b):
        await i.response.defer()
        self.defending = True
        self.log.append(f"防御体制！\n{self._enemy_turn()}")
        if d_get_player(self.uid)["hp"] <= 0:
            await self._lose(i)
            return
        await self._render(i)

    @discord.ui.button(label="逃走", style=discord.ButtonStyle.grey, row=0)
    @d_lock_callback
    async def run_away(self, i, b):
        await i.response.defer()
        if self.enemy.get("type") == "boss":
            self.log.append("ボスからは逃げられない！\n" + self._enemy_turn())
            if d_get_player(self.uid)["hp"] <= 0:
                await self._lose(i)
                return
            await self._render(i)
            return

        p = d_get_player(self.uid)
        escape_rate = 0.2 if self.enemy.get("type") == "elite" else 0.5
        if p.get("cooldowns", {}).get("smoke_buff", 0) > 0:
            escape_rate = min(0.95, escape_rate + 0.30)
        if random.random() < escape_rate:
            self.stop()
            await d_return_to_dungeon(i, self.uid, self.db_api, "逃走成功")
        else:
            self.log.append("逃げ失敗！\n" + self._enemy_turn())
            if d_get_player(self.uid)["hp"] <= 0:
                await self._lose(i)
                return
            await self._render(i)

    @discord.ui.button(label="スキル", style=discord.ButtonStyle.blurple, row=1)
    @d_lock_callback
    async def skill(self, i, b):
        await i.response.defer()
        p = d_get_player(self.uid)
        log, damage = d_use_job_skill(self.uid, self.enemy)
        self.enemy["hp"] = max(0, self.enemy["hp"] - damage)
        self.log.append(log)
        d_unlock_achievement(self.uid, "skill_user")
        if self.enemy["hp"] <= 0:
            await self._win(i)
            return
        self.log.append(self._enemy_turn())
        if p["hp"] <= 0:
            await self._lose(i)
            return
        await dg_save_player(self.uid, self.db_api)
        await self._render(i)


class DungeonMainView(DungeonViewBase):
    """ダンジョンメインView（統合パネルの基底）"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=600)
        self.uid = uid
        self.floor = floor
        self.x = x
        self.y = y
        self.db_api = db_api
        # 進めない方向のボタンは最初から無効化する（「壁！」の空振り防止）。
        for child in self.children:
            key = {"dg_u": "up", "dg_d": "down", "dg_l": "left", "dg_r": "right"}.get(
                getattr(child, "custom_id", None))
            if key is not None:
                child.disabled = d_direction_blocked(uid, floor, x, y, key)

    def _fresh_main_view(self, p):
        """移動後の再描画用に作り直したメインView（ボタン無効状態を最新化する）。"""
        return self

    async def act_here_action(self, interaction):
        """中央ボタン「部屋で行動」: 現在マスのタイルを再発動する。"""
        await interaction.response.defer()
        msg = await d_current_cell_action(self.uid, self.db_api)
        p = self.sync_state()
        await self._redraw(interaction, msg, p, view=self._fresh_main_view(p))

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        stats = d_effective_stats(p)
        bname, _, _, _, _ = d_get_biome(p["floor"])
        em = discord.Embed(title=f"フロア {p['floor']} ({bname})", color=0xFFFFFF)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="位置", value=f"{p['floor']}F / ({p['x']}, {p['y']}) / {d_floor_modifier(p['floor'])}", inline=True)
        em.add_field(name="HP", value=f"{d_hpbar(p['hp'], stats['max_hp'])} {p['hp']}/{stats['max_hp']}", inline=True)
        quests, relics = d_content_summary(self.uid)
        em.add_field(name="冒険パネル", value=f"職業: {d_job_name(self.uid)}\nターン: {p['turns']} / スコア: {p['season_score']}\n遺物: {', '.join(relics) if relics else 'なし'}", inline=False)
        em.add_field(name="フロア進捗", value=d_floor_progress_text(self.uid), inline=False)
        em.add_field(name="凡例", value="🟩自分 🟨宝箱 🟥階段 🟪店 ⛏採掘 ✦祠・イベント R休憩 ⬛未探索（暗い場所は探索済み）", inline=False)
        em.add_field(name="進行中の目的", value="\n".join(quests) if quests else "全クエスト達成", inline=False)
        em.add_field(name="自動操作", value=f"作戦: {getattr(self, 'clef_plan', clef_plan_for(self.uid))} / 状態: {clef_status_text(self.uid)}", inline=False)
        if msg:
            em.add_field(name="ログ", value=msg, inline=False)
        return em

    async def _redraw(self, interaction, msg, p, view=None):
        """現在のプレイヤー状態から1枚の画面（Embed＋画像）を作り直す。"""
        target = view or self
        target.floor, target.x, target.y = p["floor"], p["x"], p["y"]
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        await interaction.edit_original_response(
            embed=target._embed(msg, image_url=map_url), view=target, attachments=[map_file]
        )

    async def _move(self, i, direction):
        lock = d_get_lock(self.uid)
        if lock.locked():
            await i.response.send_message("前の操作を処理中です。少し待ってください。", ephemeral=True)
            return
        await lock.acquire()
        try:
            await self._move_locked(i, direction)
        finally:
            lock.release()

    async def _move_locked(self, i, direction):
        await i.response.defer()

        # ビュー生成時のスナップショットではなく、常に保存済みの現在状態を使う。
        p = self.sync_state()
        floor = p["floor"]

        # 進めない方向は通常ボタン側で無効化しているが、古いパネル等からの
        # 押下に備えてサーバー側でも弾く（描画は従来どおり1回だけ行う）。
        if direction not in _DIRECTIONS or d_direction_blocked(
                self.uid, floor, p["x"], p["y"], direction):
            await self._redraw(i, "壁！進めない", p)
            return

        # 1押下 = 1 journey。歩行・タイル処理・保存は d_execute_journey 側で
        # 行い、ここでは結果に応じた View 遷移と最終描画だけを行う。
        result = await d_execute_journey(self.uid, self.db_api, direction, source="manual")
        p = self.sync_state()
        msg = "\n".join(result["messages"])
        await self._render_journey_result(i, result, msg, p)

    async def _render_journey_result(self, interaction, result, msg, p):
        """journey 結果に応じた View 遷移と最終描画（手動移動と「階段へ」で共用）。"""
        if result["view"] == "stairs":
            sv = DungeonStairsView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
            await self._redraw(interaction, "階段がある。どうする？", p, view=sv)
            return
        if result["view"] == "shop":
            shop = DungeonShopView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
            await self._redraw(interaction, "商店を発見！", p, view=shop)
            return
        if result["view"] == "mine":
            mv = DungeonMineView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
            await self._redraw(interaction, "鉱山を発見！", p, view=mv)
            return
        if result["view"] == "combat":
            cv = DungeonCombatView(self.uid, p["floor"], p["x"], p["y"], result["enemy"], self.db_api,
                                   room_id=result.get("room_id"))
            await self._redraw(interaction, msg, p, view=cv)
            return
        await self._redraw(interaction, msg, p, view=self._fresh_main_view(p))

    @discord.ui.button(label="北", style=discord.ButtonStyle.grey, row=0, custom_id="dg_u")
    async def up(self, i, b): await self._move(i, "up")

    @discord.ui.button(label="西", style=discord.ButtonStyle.grey, row=1, custom_id="dg_l")
    async def left(self, i, b): await self._move(i, "left")

    @discord.ui.button(label="部屋で行動", style=discord.ButtonStyle.green, row=1, custom_id="dg_c")
    async def act_here(self, i, b): await self.act_here_action(i)

    @discord.ui.button(label="東", style=discord.ButtonStyle.grey, row=1, custom_id="dg_r")
    async def right(self, i, b): await self._move(i, "right")

    @discord.ui.button(label="南", style=discord.ButtonStyle.grey, row=2, custom_id="dg_d")
    async def down(self, i, b): await self._move(i, "down")

    @discord.ui.button(label="STATUS", style=discord.ButtonStyle.green, row=3, custom_id="dg_status")
    async def status(self, i, b):
        await i.response.defer()
        p = self.sync_state()
        sv = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
        await sv._render(i, "")
class DungeonUnifiedView(DungeonMainView):
    """ゲームハブから起動したダンジョン一つで操作を完結させる圧縮UI。

    Clef自動操作の開始ボタンと作戦選択はSTATUS画面へ集約し、このパネルには移動と終了だけを残す。
    """

    def __init__(self, uid, floor, x, y, db_api, plan=None):
        super().__init__(uid, floor, x, y, db_api)
        self.clef_plan = plan or clef_plan_for(uid)
        self.clear_items()
        # Phase 1-C: 4方向＋中央「部屋で行動」。進めない方向は disabled。
        # Phase 1-D: ラベルに行き先情報（発見済み=役割名 / 未発見=未探索 / 通路）。
        directions = [
            ("北", "up", 0), ("西", "left", 1), ("東", "right", 1), ("南", "down", 2),
        ]
        for label, key, row in directions:
            blocked = d_direction_blocked(uid, floor, x, y, key)
            dest = None if blocked else d_destination_label(uid, floor, x, y, key)
            button = discord.ui.Button(
                label=f"{label}: {dest}" if dest else label,
                style=discord.ButtonStyle.grey, row=row,
                disabled=blocked,
            )
            async def move_callback(interaction, key=key):
                await self._move(interaction, key)
            button.callback = move_callback
            self.add_item(button)

        center = discord.ui.Button(label="部屋で行動", style=discord.ButtonStyle.green, row=1)
        center.callback = self.act_here_action
        self.add_item(center)

        status_button = discord.ui.Button(label="STATUS", style=discord.ButtonStyle.green, row=3)
        status_button.callback = self.open_status
        self.add_item(status_button)
        # Phase 1-E「階段へ」: 階段の間が発見済みのときだけ有効（設計 §4-1）。
        stairs_button = discord.ui.Button(
            label="階段へ", style=discord.ButtonStyle.primary, row=3,
            disabled=not d_stairs_discovered(uid, floor),
        )
        stairs_button.callback = self.go_stairs
        self.add_item(stairs_button)
        stop = discord.ui.Button(label="終了", style=discord.ButtonStyle.red, row=3)
        stop.callback = self.end_session
        self.add_item(stop)

    async def go_stairs(self, interaction):
        """「階段へ」: 発見済みの階段の間まで最短路を journey で辿る（Phase 1-E）。

        計画（次に進む方向）は d_plan_navigation_direction で停止のたびに
        再計算し、実行は通常移動と同じ d_execute_journey を上限10回
        繰り返す。戦闘開始・View遷移（商店/鉱山/階段）・HP低下停止・
        死亡などの割り込みがあれば即座に止め、最後の journey の結果を
        通常移動と同様に描画する。
        """
        lock = d_get_lock(self.uid)
        if lock.locked():
            await interaction.response.send_message("前の操作を処理中です。少し待ってください。", ephemeral=True)
            return
        await lock.acquire()
        try:
            await interaction.response.defer()
            p = self.sync_state()
            floor = p["floor"]
            inst = d_get_instance(self.uid, floor)
            stairs_room = next((r for r in inst.get("rooms", []) if r["role"] == "stairs"), None)
            if stairs_room is None or not d_room_discovered(inst, stairs_room):
                await self._redraw(interaction, "階段の間はまだ見つかっていない。", p,
                                    view=self._fresh_main_view(p))
                return
            target = stairs_room["center"]
            messages = []
            result = None
            for _ in range(10):
                p = self.sync_state()
                if (p["x"], p["y"]) == tuple(target):
                    break
                direction = d_plan_navigation_direction(self.uid, floor, p["x"], p["y"], target)
                if direction is None:
                    break
                result = await d_execute_journey(self.uid, self.db_api, direction, source="manual")
                messages.extend(result["messages"])
                if (result["view"] is not None or result["enemy"] is not None
                        or result["died"] or result["steps"] == 0
                        or result["stop_reason"] == "low_hp"):
                    break
            p = self.sync_state()
            msg = "\n".join(messages) or "階段へ移動した。"
            if result is None:
                await self._redraw(interaction, msg, p, view=self._fresh_main_view(p))
                return
            await self._render_journey_result(interaction, result, msg, p)
        finally:
            lock.release()

    def _fresh_main_view(self, p):
        return DungeonUnifiedView(self.uid, p["floor"], p["x"], p["y"], self.db_api, plan=self.clef_plan)

    async def open_status(self, interaction):
        """ステータス画面（自動操作開始・作戦選択を含む）を開く。"""
        await interaction.response.defer()
        p = self.sync_state()
        sv = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
        sv.clef_plan = self.clef_plan
        await sv._render(interaction, "")

    async def end_session(self, interaction):
        """自動操作を止め、操作を終了する。"""
        if _CLEF_PLAYER is not None:
            await _CLEF_PLAYER.stop(self.uid)
        self.stop()
        await interaction.response.defer()
        p = self.sync_state()
        map_file, map_url = d_map_attachment(self.uid, p["floor"], p["x"], p["y"])
        embed = self._embed("ダンジョンを終了しました。再開する場合は `/game` からダンジョンを選んでください。", image_url=map_url)
        await interaction.edit_original_response(embed=embed, view=None, attachments=[map_file])


class DungeonOperationView(DungeonViewBase):
    """ステータス・アイテム・拠点・現在地操作を1画面に集約する。"""

    def __init__(self, uid, floor, x, y, db_api):
        super().__init__(uid, timeout=600)
        self.floor, self.x, self.y, self.db_api = floor, x, y, db_api
        self._add("STATUS", self.status, 0, discord.ButtonStyle.green)
        self._add("パン", self.use_bread, 0, discord.ButtonStyle.blurple)
        self._add("現在地を操作", self.current_action, 1, discord.ButtonStyle.primary)
        self._add("実績", self.achievements, 2, discord.ButtonStyle.grey)
        self._add("所持品", self.show_inventory, 2, discord.ButtonStyle.grey)
        self._add("NPC/依頼", self.show_npcs, 2, discord.ButtonStyle.grey)
        self._add("フロア目標", self.show_goals, 3, discord.ButtonStyle.primary)
        self._add("鍛冶強化", self.upgrade_forge, 3, discord.ButtonStyle.grey)
        self._add("戻る", self.back, 3, discord.ButtonStyle.grey)
        job_select = discord.ui.Select(
            placeholder="職業を選択（冒険開始前のみ）",
            options=[discord.SelectOption(label=data["name"], value=key) for key, data in JOB_MASTER.items()],
            row=4,
        )
        job_select.callback = self.select_job
        self.add_item(job_select)

    def _add(self, label, callback, row=0, style=discord.ButtonStyle.grey):
        button = discord.ui.Button(label=label, style=style, row=row)
        button.callback = callback
        self.add_item(button)

    def _embed(self, msg="", image_url=None):
        p = self.sync_state()
        stats = d_effective_stats(p)
        em = discord.Embed(title="ダンジョン操作メニュー", description=msg, color=0x4EA1FF)
        if image_url:
            em.set_image(url=image_url)
        em.add_field(name="位置", value=f"{p['floor']}F ({p['x']},{p['y']}) / {d_floor_modifier(p['floor'])}", inline=True)
        em.add_field(name="HP", value=f"{p['hp']}/{stats['max_hp']}", inline=True)
        em.add_field(name="所持資源", value=f"パン:{p['bread']} / 宝箱:{p['boxes']} / チップ:{p['chips']}", inline=False)
        em.add_field(name="装備", value="、".join(EQUIPMENT_MASTER.get(k, {}).get('name', k) for k in p.get('equipment', {}).values()) or "なし", inline=True)
        em.add_field(name="遺物", value="、".join(RELIC_MASTER.get(k, {}).get('name', k) for k in p.get('relics', [])) or "なし", inline=True)
        facilities = p.get('camp_facilities', {})
        em.add_field(name="拠点施設", value=f"宿屋Lv.{facilities.get('inn', 0)} / 鍛冶Lv.{facilities.get('forge', 0)} / ギルドLv.{facilities.get('guild', 0)}", inline=False)
        return em

    async def _back(self, interaction, msg=""):
        await d_return_to_dungeon(interaction, self.uid, self.db_api, msg)

    async def status(self, interaction):
        """ステータス画面（自動操作開始・作戦選択）を開く。"""
        await interaction.response.defer()
        p = self.sync_state()
        status = DungeonStatusView(self.uid, p["floor"], p["x"], p["y"], self.db_api)
        await status._render(interaction, "")

    async def use_bread(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        if p.get("bread", 0) <= 0:
            await self._back(interaction, "レアパンを持っていません。")
            return
        stats = d_effective_stats(p)
        before = p["hp"]
        p["bread"] -= 1
        p["hp"] = min(stats["max_hp"], p["hp"] + max(25, stats["max_hp"] // 4))
        await dg_save_player(self.uid, self.db_api)
        await self._back(interaction, f"レアパンを使用し、HPが {p['hp'] - before} 回復しました。")

    async def camp(self, interaction):
        """拠点は共有マップ前提の機能だったため Phase 1-B で無効化（既存データは保持する）。"""
        await interaction.response.defer()
        await self._back(interaction, "拠点機能は現在利用できません。")

    async def achievements(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        unlocked = [f"解除済み: {ACHIEVEMENTS[k]}" for k in p["achievements"] if k in ACHIEVEMENTS]
        locked = [f"未解除: {name}" for k, name in ACHIEVEMENTS.items() if k not in p["achievements"]]
        await self._back(interaction, "\n".join(unlocked + locked))

    async def show_inventory(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        lines = [f"{EQUIPMENT_MASTER[k]['name']} ×{v}" for k, v in p.get("inventory", {}).items() if k in EQUIPMENT_MASTER]
        lines += [f"素材: {k} ×{v}" for k, v in p.get("materials", {}).items()]
        await self._back(interaction, "所持品\n" + ("\n".join(lines) or "なし"))

    async def show_npcs(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        lines = [
            f"{v['name']}: {'進行済み' if any(x.get('flag') in p.get('npc_flags', {}) for x in v['steps']) else '未訪問'}"
            for v in NPC_MASTER.values()
        ]
        await self._back(interaction, "NPC・依頼\n" + "\n".join(lines))

    async def show_goals(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        goal = p.setdefault("floor_goals", {}).get(str(p["floor"]), {"kind": "chests", "progress": 0, "target": 3, "completed": False})
        name = next((v["name"] for v in FLOOR_GOALS.values() if v["kind"] == goal.get("kind")), "宝箱を開ける")
        await self._back(interaction, f"フロア目標: {name} {goal.get('progress', 0)}/{goal.get('target', 3)}")

    async def upgrade_forge(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        weapon = p.get("equipment", {}).get("weapon")
        msg = "鍛冶対象の武器がありません。"
        if weapon and d_upgrade_equipment(self.uid, weapon):
            msg = f"{EQUIPMENT_MASTER[weapon]['name']}を強化しました。"
        await dg_save_player(self.uid, self.db_api)
        await self._back(interaction, msg)

    async def select_job(self, interaction):
        await interaction.response.defer()
        p = self.sync_state()
        if p.get("turns", 0) > 0:
            await self._back(interaction, "冒険開始後は職業を変更できません。")
            return
        selected = interaction.data.get("values", [""])[0]
        if selected not in JOB_MASTER:
            await self._back(interaction, "無効な職業です。")
            return
        p["job"] = selected
        await dg_save_player(self.uid, self.db_api)
        await self._back(interaction, f"職業を **{JOB_MASTER[selected]['name']}** に設定しました。")

    async def current_action(self, interaction):
        await interaction.response.defer()
        # 実処理は d_current_cell_action に集約（メインパネルの中央ボタンと共用）。
        msg = await d_current_cell_action(self.uid, self.db_api)
        await self._back(interaction, msg)

    async def back(self, interaction):
        await interaction.response.defer()
        await self._back(interaction)


class DungeonRewardChoiceView(DungeonViewBase):
    """戦闘勝利時に3候補から1つだけ受け取るView。"""

    def __init__(self, uid, floor, x, y, db_api, choices):
        super().__init__(uid, timeout=120)
        self.floor, self.x, self.y, self.db_api, self.choices = floor, x, y, db_api, choices
        for index, item in enumerate(choices):
            button = discord.ui.Button(label=item["label"], style=discord.ButtonStyle.green, row=0)

            async def choose(interaction, index=index, label=item["label"]):
                await interaction.response.defer()
                p = d_get_player(self.uid)
                if not p.get("pending_rewards"):
                    await interaction.edit_original_response(
                        embed=discord.Embed(title="報酬は受取済みです"), view=None, attachments=[]
                    )
                    return
                reward = d_choose_reward(self.uid, index)
                if reward is None:
                    await interaction.edit_original_response(
                        embed=discord.Embed(title="報酬の選択に失敗しました"), view=self
                    )
                    return
                await d_apply_reward(self.uid, self.db_api, **reward)
                await dg_save_player(self.uid, self.db_api)
                self.stop()
                await d_return_to_dungeon(interaction, self.uid, self.db_api, f"報酬を選択: {label}")

            button.callback = choose
            self.add_item(button)
