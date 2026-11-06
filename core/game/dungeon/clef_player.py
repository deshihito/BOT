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
from core.general import logfare
import datetime
import logging
from discord.ui import View
from discord import app_commands, Interaction
from discord.ext import commands, tasks
from cogs.terminal import ALLOWED_USER_IDS
from discord.ext.commands import Cog
from PIL import Image, ImageDraw, ImageEnhance
from zoneinfo import ZoneInfo
from core.support.api_client import APIError
from core.support.api_retry import run_with_retry

from core.game.dungeon.common import *  # noqa: F401,F403 - shared constants/state
from core.game.dungeon.actions import _NoopInteraction, d_execute_journey, d_use_job_skill  # noqa: F401
from core.game.dungeon.clef import CLEF_MOVE_KEYS, d_begin_run, d_end_run, d_normalize_choice, d_record_action, dungeon_best_direction, dungeon_candidate_log, dungeon_goal_text, dungeon_move_criteria, dungeon_plan_guidance, dungeon_stairs_hint  # noqa: F401
from core.game.dungeon.combat import d_intent_label  # noqa: F401
from core.game.dungeon.common import CLEF_LOG_LINES, CLEF_MAX_TURNS, CLEF_PLANS, CLEF_RETRIES, CLEF_RETRY_DELAY, CLEF_STATE_CHARS, CLEF_TIMEOUT, D_ARCHETYPE_NAMES, D_FLOORS, D_MINE, D_REST, D_SHOP, D_STAIRS, JOB_MASTER, _DIRECTION_LABELS  # noqa: F401
from core.game.dungeon.player import d_apply_reward, d_clear_status, d_do_mine, d_effective_stats, d_ensure_intent, d_floor_modifier, d_get_player, d_instance_start, d_job_name, d_progress_quest  # noqa: F401
from core.game.dungeon.render import d_map_attachment  # noqa: F401
from core.game.dungeon.storage import dg_save_player  # noqa: F401
from core.game.dungeon.views import DungeonCombatView, DungeonUnifiedView  # noqa: F401
from core.game.dungeon.world import d_consume, d_direction_blocked, d_get_biome, d_get_cell, d_record_floor_clear, d_reset_floor_counters, d_room_summary_text, d_stairs_room_blocked, dungeon_bfs  # noqa: F401

logger = logging.getLogger("cogs.dangeon")




class ClefDungeonPlayer:
    """Logfare Clef によるダンジョン代理プレイ。

    Clefへ渡すのは「現在の状態」「今回の選択肢と判断基準」「直近のログ」だけに絞る。
    ゲーム状態の確定・ダメージ・報酬・保存はすべて本体側が担当し、
    モデルは次の1手を選ぶことだけに責務を限定する。
    """

    def __init__(self, bot):
        self.bot = bot
        self._tasks = {}
        self._stops = {}
        self._plans = {}
        self._run_stats = {}
    # ---------- Clefへの入力生成 ----------

    def _state_text(self, uid, plan, logs):
        """Clefへ渡す唯一のテキスト。ゴールと現在状態を先頭に、ログは短く末尾へ置く。"""
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        floor, x, y = p["floor"], p["x"], p["y"]
        bname, *_ = d_get_biome(floor)
        dist = dungeon_bfs(uid, floor, x, y)
        hp_pct = int(p["hp"] / max(1, stats["max_hp"]) * 100)
        header = [
            "# 現在の状態",
            f"作戦: {plan}",
            f"階層: {floor}F({bname}) / 位置: ({x},{y}) / フロア特性: {d_floor_modifier(floor)}",
            f"HP: {p['hp']}/{stats['max_hp']} ({hp_pct}%) / ATK {stats['atk']} DEF {stats['def_']} / 職業: {d_job_name(uid)}",
            f"目的: {dungeon_goal_text(uid)}",
            f"階段: {dungeon_stairs_hint(uid, floor, x, y, dist)}",
            # Phase 1-E: 旧「周囲3×3」は部屋グラフ要約へ置き換えた（設計 §8）。
            d_room_summary_text(uid, floor, x, y),
        ]
        last = self._run_stats.get(uid, {}).get("last_result")
        if last:
            header.append(f"前回の結果: {last}")
        header.append("直近のログ:")
        head_text = "\n".join(header)
        lines = []
        for line in [entry for entry in logs if entry and not str(entry).startswith("候補評価:")][-CLEF_LOG_LINES:]:
            lines.append("- " + " ".join(str(line).split())[:160])
        log_text = "\n".join(lines)
        remaining = CLEF_STATE_CHARS - len(head_text) - 1
        if remaining <= 0:
            return head_text[:CLEF_STATE_CHARS]
        return head_text + "\n" + log_text[-remaining:]

    def _battle_criteria(self, uid, enemy):
        """戦闘の選択肢と基準。HPとクールダウンから状況を明示する。"""
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        job = JOB_MASTER.get(p.get("job", "warrior"), JOB_MASTER["warrior"])
        skill = job.get("skill", "power_strike")
        cooldown = p.get("cooldowns", {}).get(skill, 0)
        hp_pct = int(p["hp"] / max(1, stats["max_hp"]) * 100)
        # Phase 2-A: 敵の意図（次の行動）も判断材料に含める。
        d_ensure_intent(enemy)
        intent = enemy.get("intent", "attack")
        intent_text = (f"敵の意図: 次は「{d_intent_label(enemy)}」"
                       f"（{D_ARCHETYPE_NAMES.get(enemy.get('archetype', 'normal'), '通常型')}）")
        if intent == "heavy":
            intent_text += "。大ダメージは防御で大きく軽減できるため防御が有効"
        elif intent == "charge":
            intent_text += "。このターンは攻撃してこないので攻撃の好機"
        elif intent == "heal":
            intent_text += "。回復される前に倒し切るか大きな一撃が有効"
        return {
            "intent": intent_text,
            "attack": f"通常攻撃（自分のHP {hp_pct}% / 敵HP {enemy['hp']}/{enemy['max_hp']}）",
            "skill": f"{job['name']}のスキル" + ("（使用可）" if cooldown <= 0 else f"（あと{cooldown}ターン使用不可）"),
            "defend": "防御して次の被ダメージを軽減する（敵の大ダメージ予告時・HPが少ない時に有効）",
            "escape": "逃走する（ボスからは逃げられない・失敗すると攻撃を受ける）" if enemy.get("type") == "boss" else "逃走する（失敗すると攻撃を受ける）",
        }

    async def _decide(self, uid, logs, plan, questions):
        """Clefに状態と選択肢を送り、選択肢キーだけを返す。"""
        state_text = self._state_text(uid, plan, logs)
        timeout = aiohttp.ClientTimeout(total=CLEF_TIMEOUT)
        last_error = None
        for attempt in range(1, CLEF_RETRIES + 1):
            try:
                data = await asyncio.wait_for(
                    logfare.decision("clef", state_text, questions, timeout=timeout),
                    timeout=CLEF_TIMEOUT,
                )
                if isinstance(data.get("result"), dict):
                    data = data["result"]
                answers = data.get("answers", {})
                key = next(iter(questions), "")
                answer = answers.get(key, {}) if isinstance(answers, dict) else {}
                if isinstance(answer, str):
                    return answer
                if isinstance(answer, dict):
                    choice = answer.get("choice") or answer.get("answer") or answer.get("value")
                    if choice is not None:
                        return str(choice)
                choice = data.get("choice") if isinstance(data, dict) else None
                if choice is not None:
                    return str(choice)
                raise ValueError("Clef response did not contain an answer choice")
            except asyncio.CancelledError:
                raise
            except (logfare.LogfareHTTPError, aiohttp.ClientError, asyncio.TimeoutError, OSError, RuntimeError, ValueError) as exc:
                last_error = exc
                status = getattr(exc, "status", None)
                logs.append(f"Clef APIエラー{f' (HTTP {status})' if status else ''}。")
                retryable = status is None or status in (408, 429, 500, 502, 503, 504)
                if not retryable or attempt >= CLEF_RETRIES:
                    break
                await asyncio.sleep(CLEF_RETRY_DELAY * attempt)
            except Exception as exc:
                last_error = exc
                logs.append(f"Clef判断エラー: {type(exc).__name__}")
                break
        if last_error:
            logger.warning("Dungeon Clef decision failed: %s", type(last_error).__name__)
        return ""
    # ---------- 実行制御 ----------

    def is_running(self, uid):
        task = self._tasks.get(str(uid))
        return bool(task and not task.done())

    def plan_for(self, uid):
        return self._plans.get(str(uid), CLEF_PLANS["safe"])

    def set_plan(self, uid, plan):
        self._plans[str(uid)] = plan

    def status_text(self, uid):
        uid = str(uid)
        if self.is_running(uid):
            run = self._run_stats.get(uid, {})
            return f"実行中（{run.get('turns', 0)}journey / 作戦: {self.plan_for(uid)}）"
        return "停止中"

    async def start(self, interaction, plan=None):
        """現在のダンジョン状態をそのまま引き継いで自動操作を開始する。"""
        uid = str(interaction.user.id)
        plan = plan or self.plan_for(uid)
        if self.is_running(uid):
            await interaction.response.send_message("自動操作はすでに実行中です。", ephemeral=True)
            return False
        await interaction.response.defer()
        self._plans[uid] = plan
        # 押した時点の保存済み状態から、表示もClefの判断も同一のフレームで始める。
        p = d_get_player(uid)
        view = DungeonUnifiedView(uid, p["floor"], p["x"], p["y"], self.bot.db_api, plan=plan)
        message = interaction.message or await interaction.original_response()
        stop_event = asyncio.Event()
        self._stops[uid] = stop_event
        # 連続実行はバックグラウンドで進め、ボタン操作を待たせない。
        self._tasks[uid] = asyncio.create_task(self._run_loop(uid, message, view, stop_event, plan))
        return True

    async def stop(self, uid):
        event = self._stops.get(str(uid))
        if event:
            event.set()

    def shutdown(self):
        for event in self._stops.values():
            event.set()
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()
        self._stops.clear()

    async def _edit_screen(self, message, view, logs, *, final=False):
        """1フレームを描画する。添付名は毎回変え、キャッシュされた古い画像を表示させない。"""
        uid = view.uid
        p = view.sync_state()
        stats = d_effective_stats(p)
        embed = discord.Embed(
            title=f"自動操作 {'終了' if final else '実行中'}",
            description="\n".join(str(x) for x in logs[-8:])[-1500:] or "ログはまだありません。",
            color=0x666666 if final else 0x8B5CF6,
        )
        embed.add_field(name="作戦", value=f"{view.clef_plan} / 停止: 終了ボタン", inline=False)
        embed.add_field(
            name="停止条件",
            value=f"HP30%未満 / ボス / 遺物 / {CLEF_MAX_TURNS}journey / APIエラー3回 / 同一地点3回",
            inline=False,
        )
        embed.add_field(
            name="状態",
            value=f"{p['floor']}F ({p['x']},{p['y']}) / HP {p['hp']}/{stats['max_hp']} / {d_job_name(uid)}",
            inline=False,
        )
        map_file, map_url = d_map_attachment(uid, p["floor"], p["x"], p["y"])
        embed.set_image(url=map_url)
        await message.edit(embed=embed, view=None if final else view, attachments=[map_file])

    def _note_result(self, uid, text):
        self._run_stats.setdefault(uid, {"turns": 0, "positions": []})["last_result"] = text

    def _stop_reason(self, uid, logs):
        """Clefの安全停止条件をゲーム側で一元判定する。1ターンにつき1回だけ呼ぶ。"""
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        run = self._run_stats.setdefault(uid, {"turns": 0, "positions": []})
        positions = run.setdefault("positions", [])
        positions.append((p["floor"], p["x"], p["y"]))
        del positions[:-12]
        if p["hp"] <= 0:
            return "HPが0"
        if p["hp"] < stats["max_hp"] * 0.30:
            return "HPが30%未満"
        # 状態異常（毒・出血など）があるだけでは停止しない。軽微/一時的な
        # 異常で自動操作全体が終わってしまうため、停止条件から外した。
        # 異常ダメージで HP が 30% 未満まで落ちれば上の HP 条件で止まる。
        if any("ボス" in line for line in logs[-8:]):
            return "ボス遭遇"
        if any("遺物" in line for line in logs[-8:]):
            return "希少アイテム発見"
        if run.get("turns", 0) >= CLEF_MAX_TURNS:
            # Phase 1-E: 上限の単位はターン数ではなく journey 数。
            return f"1回の自動操作が{CLEF_MAX_TURNS}journeyに到達"
        if len(positions) >= 3 and positions[-1] == positions[-2] == positions[-3]:
            return "同じ場所で3回連続停止"
        if sum("Clef APIエラー" in line or "Clef接続エラー" in line for line in logs[-6:]) >= 3:
            return "Clef APIエラーが連続3回"
        if sum("と遭遇しました" in line for line in logs[-8:]) >= 3:
            return "連続戦闘が多いため"
        return ""

    async def _run_loop(self, uid, message, view, stop_event, plan):
        logs = [f"自動操作を開始しました。作戦: {plan} / 終了ボタンで停止できます。"]
        d_begin_run(uid, "clef")
        self._run_stats[uid] = {"turns": 0, "positions": [], "last_result": ""}
        # 初回判断の前に、ゲームハブのダンジョンと同じ現在状態のフレームを表示する。
        await self._edit_screen(message, view, logs)
        try:
            while not stop_event.is_set():
                reason = self._stop_reason(uid, logs)
                if reason:
                    logs.append(f"停止しました: {reason}")
                    break
                await self._play_turn(uid, logs, plan)
                self._run_stats[uid]["turns"] += 1
                await self._edit_screen(message, view, logs)
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            logs.append("自動操作をキャンセルしました。")
            raise
        except Exception as exc:
            logs.append(f"自動操作エラー: {type(exc).__name__}: {exc}")
        finally:
            self._tasks.pop(uid, None)
            self._stops.pop(uid, None)
            self._run_stats.pop(uid, None)
            d_end_run(uid, "clef_stop")
            logs.append("自動操作を終了しました。")
            try:
                await self._edit_screen(message, view, logs, final=True)
            except Exception:
                logger.debug("ダンジョン: 最終画面の更新に失敗しました", exc_info=True)

    # ---------- 1ターンの判断 ----------

    async def _play_turn(self, uid, logs, plan):
        p = d_get_player(uid)
        stats = d_effective_stats(p)
        floor, x, y = p["floor"], p["x"], p["y"]
        cell = d_get_cell(uid, floor, x, y)
        logs.append(dungeon_candidate_log(uid, plan))
        d_record_action(uid, "decision", source="clef", result=plan)

        if cell == D_STAIRS and not d_stairs_room_blocked(uid, floor, x, y):
            raw = await self._decide(uid, logs, plan, {
                "stairs": {
                    "type": "choice",
                    "instructions": (
                        "階段の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
                        f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
                        "基準: 上の階へ進むとHPが全回復し、より深い階へ移動します。"
                        "この階の探索や回収を優先したい場合は残ってください。\n"
                        "回答は up か stay のどちらか1語のみ。"
                    ),
                    "criteria": {
                        "up": f"上の階へ進む（HPが全回復して{min(floor + 1, D_FLOORS)}Fへ移動する）",
                        "stay": f"この階に残って探索を続ける（現在HP {p['hp']}/{stats['max_hp']}）",
                    },
                }
            })
            choice = d_normalize_choice(raw, {"up", "stay"}, "stay")
            if choice == "up" and floor < D_FLOORS:
                d_record_floor_clear(uid)
                p["floor"] = floor + 1
                p["hp"] = d_effective_stats(p)["max_hp"]
                d_clear_status(uid)
                p["x"], p["y"] = d_instance_start(uid, p["floor"])
                d_reset_floor_counters(p)
                d_progress_quest(uid, "floor", 1)
                logs.append(f"階段を上り、{p['floor']}Fへ進みました。")
            else:
                logs.append("階段では探索を続けました。")
            await dg_save_player(uid, self.bot.db_api)
            return

        if cell == D_MINE:
            raw = await self._decide(uid, logs, plan, {
                "mine": {
                    "type": "choice",
                    "instructions": (
                        "鉱山の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
                        f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
                        "基準: 採掘するとコインを獲得でき、この鉱山は消滅します。\n"
                        "回答は dig か leave のどちらか1語のみ。"
                    ),
                    "criteria": {
                        "dig": "その場で採掘してコインを獲得する",
                        "leave": "採掘せずにそのまま探索を続ける",
                    },
                }
            })
            choice = d_normalize_choice(raw, {"dig", "leave"}, "leave")
            if choice == "dig":
                gain = d_do_mine(uid)
                await d_apply_reward(uid, self.bot.db_api, coins=gain, season_score=10)
                d_consume(uid, floor, x, y)
                logs.append(f"鉱山を採掘し、コインを{gain}枚獲得しました。")
                await dg_save_player(uid, self.bot.db_api)
            else:
                logs.append("鉱山を見送りました。")
            await dg_save_player(uid, self.bot.db_api)
            return

        if cell == D_REST:
            before = p["hp"]
            p["hp"] = min(stats["max_hp"], p["hp"] + max(20, stats["max_hp"] // 3))
            d_clear_status(uid)
            d_consume(uid, floor, x, y)
            logs.append(f"休憩所でHPを{p['hp'] - before}回復しました。")
            await dg_save_player(uid, self.bot.db_api)
            await dg_save_player(uid, self.bot.db_api)
            return

        if cell == D_SHOP:
            raw = await self._decide(uid, logs, plan, {
                "shop": {
                    "type": "choice",
                    "instructions": (
                        "商店の上にいます。次に取る行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
                        f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
                        f"基準: レアパンは30コインでHP回復に使えます（所持パン {p['bread']} 個）。\n"
                        "回答は buy か leave のどちらか1語のみ。"
                    ),
                    "criteria": {
                        "buy": "レアパンを1個購入する（30コイン）",
                        "leave": "購入せずに探索を続ける",
                    },
                }
            })
            choice = d_normalize_choice(raw, {"buy", "leave"}, "leave")
            if choice == "buy":
                try:
                    await d_apply_reward(uid, self.bot.db_api, coins=-30, bread=1)
                    logs.append("商店でレアパンを購入しました。")
                except Exception:
                    logs.append("コイン不足で購入できませんでした。")
            else:
                logs.append("商店で購入せずに進みました。")
            await dg_save_player(uid, self.bot.db_api)
            return

        # 通常移動。待機手は用意せず、必ず1方向を選ばせる。
        # Phase 1-C 以降、1回の判断は1マスではなく1 journey（分岐・部屋・
        # 特殊タイル等で止まるまで自動で進む）を実行する。
        dist = dungeon_bfs(uid, floor, x, y)
        move_criteria = dungeon_move_criteria(uid, floor, x, y, dist)
        criteria_text = "\n".join(f"{key}: {value}" for key, value in move_criteria.items())
        instructions = (
            "あなたはダンジョン探索の意思決定者です。画像ではなく、以下のテキスト盤面を正として次に進む方向を1つ選んでください。\n"
            "選んだ方向へは、分岐・部屋・特殊タイル・エンカウントのいずれかに当たるまで自動で進みます。\n"
            f"目的: {dungeon_goal_text(uid)}\n"
            f"作戦: {plan}（{dungeon_plan_guidance(plan)}）\n"
            f"現在地: {floor}F ({x},{y}) / 階段: {dungeon_stairs_hint(uid, floor, x, y, dist)}\n"
            f"{d_room_summary_text(uid, floor, x, y)}\n"
            f"方向ごとの判定基準:\n{criteria_text}\n"
            "制約: 壁へは進めません。階段へ近づく方向を優先します。HPが30%未満なら回復タイルや階段へ向かってください。\n"
            "回答は次のいずれか1語のみ: " + ", ".join(CLEF_MOVE_KEYS)
        )
        raw = await self._decide(uid, logs, plan, {
            "move": {
                "type": "choice",
                "instructions": instructions,
                "criteria": move_criteria,
            }
        })
        choice = d_normalize_choice(raw, set(CLEF_MOVE_KEYS), None)
        if choice is None:
            choice = dungeon_best_direction(uid, plan, dist)
            logs.append(f"Clefの応答を解釈できなかったため、作戦に沿って{_DIRECTION_LABELS[choice]}へ進みます。")
        if d_direction_blocked(uid, floor, x, y, choice):
            blocked_choice = choice
            choice = dungeon_best_direction(uid, plan, dist)
            if d_direction_blocked(uid, floor, x, y, choice):
                logs.append("周囲に合法な移動先がないため、このターンは移動しません。")
                return
            logs.append(f"{_DIRECTION_LABELS[blocked_choice]}({blocked_choice})は壁でした。サーバー判定で{_DIRECTION_LABELS[choice]}({choice})へ補正します。")
            self._note_result(uid, f"{blocked_choice}は壁のため{choice}へ補正")
        result = await d_execute_journey(uid, self.bot.db_api, choice, source="clef")
        logs.extend(result["messages"])
        p = d_get_player(uid)
        logs.append(f"現在地: {p['floor']}F ({p['x']},{p['y']}) / {d_floor_modifier(p['floor'])}")
        self._note_result(uid, f"{choice}へ{result['steps']}歩進んで ({p['x']},{p['y']}) に到着")
        if result["enemy"] is not None:
            # journey 途中でエンカウントした場合はその場で自動戦闘に入る。
            # （階段・商店・鉱山に着いた場合は次ターンの判断で扱う。）
            logs.append(f"{result['enemy']['name']}と遭遇しました。")
            await self._auto_combat(uid, result["enemy"], logs, room_id=result.get("room_id"))
            await dg_save_player(uid, self.bot.db_api)

    async def _auto_combat(self, uid, enemy, logs, room_id=None):
        """戦闘もClefに選ばせる。ダメージ計算と結果確定は本体側で行う。"""
        p = d_get_player(uid)
        combat = DungeonCombatView(uid, p["floor"], p["x"], p["y"], enemy, self.bot.db_api,
                                    room_id=room_id)
        while enemy["hp"] > 0 and d_get_player(uid)["hp"] > 0:
            raw = await self._decide(uid, logs, "戦闘", {
                "battle": {
                    "type": "choice",
                    "instructions": (
                        "戦闘中です。次の行動を1つだけ選んでください。\n"
                        f"目的: {dungeon_goal_text(uid)}\n"
                        f"敵: {enemy['name']}（HP {enemy['hp']}/{enemy['max_hp']}）\n"
                        "基準: HPが少ない時は防御や逃走も有効です。ボスからは逃げられません。\n"
                        "回答は attack, skill, defend, escape のいずれか1語のみ。"
                    ),
                    "criteria": self._battle_criteria(uid, enemy),
                }
            })
            choice = d_normalize_choice(raw, {"attack", "skill", "defend", "escape"}, "defend")
            p = d_get_player(uid)
            if choice == "skill":
                text, damage = d_use_job_skill(uid, enemy)
                enemy["hp"] = max(0, enemy["hp"] - damage)
                logs.append(text)
            elif choice == "defend":
                combat.defending = True
                logs.append("防御しました。")
            elif choice == "escape" and enemy.get("type") != "boss":
                if random.random() < 0.5:
                    logs.append("逃走に成功しました。")
                    return
                logs.append("逃走に失敗しました。")
            else:
                damage, critical = combat._calculate_damage(p, enemy)
                enemy["hp"] = max(0, enemy["hp"] - damage)
                logs.append(f"攻撃で{damage}ダメージを与えました。")
            if enemy["hp"] <= 0:
                await combat._win(_NoopInteraction())
                logs.append("戦闘に勝利しました。")
                return
            logs.append(combat._enemy_turn())
        if d_get_player(uid)["hp"] <= 0:
            await combat._lose(_NoopInteraction())
            logs.append("敗北し、1Fへ戻されました。")
