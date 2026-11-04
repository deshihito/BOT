"""Logfare Clefで既存BOT機能を判断・実行するAI tools処理。"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import aiohttp

from core import action_registry, logfare

AITOOLS_MODEL = "clef"
AITOOLS_TIMEOUT = float(os.getenv("AITOOLS_TIMEOUT", "30"))
AITOOLS_RETRIES = max(1, int(os.getenv("AITOOLS_RETRIES", "1")))

# 引数や確認モーダルを要する処理、権限操作、削除・送金系は代理実行対象外。
# 実体は core/action_registry.AI_BLOCKED_IDS（risk="blocked" として定義側に保持）。
# ここでは後方互換のため同じ集合を再エクスポートする。
BLOCKED_ACTIONS = action_registry.AI_BLOCKED_IDS


class AIToolsDecisionError(RuntimeError):
    pass


class AIToolsNoAction(AIToolsDecisionError):
    """Clefが実行対象なしと判断したことを示す。"""


def action_candidates() -> dict[str, dict[str, str]]:
    """危険な操作を除き、AI toolsが選択可能な全機能を候補化する。

    候補はアクションレジストリ（core/action_registry）から生成する:
    surfaces に "aitools" を含み、risk が "blocked" でないアクションだけが対象。
    """
    candidates: dict[str, dict[str, str]] = {}
    for spec in action_registry.default_registry().all():
        if "aitools" not in spec.surfaces or spec.risk == "blocked":
            continue
        key = spec.id.lower()
        candidates[key] = {
            "root": spec.root,
            "value": spec.value,
            "label": spec.label,
            "genre": action_registry.ROOT_LABELS[spec.root],
        }
    return candidates


def _extract_choice(data: dict[str, Any], key: str) -> str:
    if data.get("success") is False or data.get("errors"):
        raise AIToolsDecisionError("Logfare decision APIが判定に失敗しました。")
    # Workers AIの互換応答は {result: {model, answers}, success, errors, messages}。
    result = data.get("result")
    if isinstance(result, dict):
        data = result
    answers = data.get("answers")
    if not isinstance(answers, dict):
        raise AIToolsDecisionError("Clef応答にanswersオブジェクトがありません。")
    answer = answers.get(key)
    if isinstance(answer, str):
        value = answer
    elif isinstance(answer, dict):
        value = answer.get("choice") or answer.get("answer") or answer.get("value")
    else:
        value = data.get("choice")
    if not isinstance(value, str) or not value.strip():
        raise AIToolsDecisionError("Clef応答にchoiceがありません。")
    return value.strip().lower()


async def decide_action(prompt: str, candidates: dict[str, dict[str, str]]) -> str:
    if not candidates:
        raise AIToolsDecisionError("実行可能な安全な機能がありません。")
    criteria = {"none": "適切な機能がない、引数不足、または安全に判断できない場合"}
    for key, item in candidates.items():
        criteria[key] = f"{item['genre']} / {item['label']}"
    payload = {
        "state": json.dumps({
            "user_request": prompt,
            "allowed_actions": criteria,
        }, ensure_ascii=False),
        "questions": {
            "action": {
                "type": "choice",
                "instructions": (
                    "ユーザーの依頼に対して実行する機能を1つだけ選び、criteriaのキーを返してください。"
                    "VC参加など、依頼に対応する機能が明確な場合だけ選び、迷う場合はnoneを返してください。"
                ),
                "criteria": criteria,
            }
        },
    }
    last_error: Exception | None = None
    for attempt in range(AITOOLS_RETRIES):
        try:
            data = await asyncio.wait_for(
                logfare.decision(
                    AITOOLS_MODEL,
                    payload["state"],
                    payload["questions"],
                    timeout=aiohttp.ClientTimeout(total=AITOOLS_TIMEOUT),
                ),
                timeout=AITOOLS_TIMEOUT,
            )
            selected = _extract_choice(data, "action")
            if selected == "none":
                raise AIToolsNoAction("Clefが実行不要または判断不能と判定しました。")
            if selected not in candidates:
                raise AIToolsDecisionError("Clefが許可されていない機能を選択しました。")
            return selected
        except asyncio.CancelledError:
            raise
        except logfare.LogfareHTTPError as exc:
            if exc.status == 401:
                raise AIToolsDecisionError("Logfare APIキーが無効です。運用環境のLOGFARE_API_KEYを確認してください。") from exc
            if exc.status == 403:
                raise AIToolsDecisionError(
                    "LogfareがClef利用を拒否しました。APIキーの利用権限とClefのトレーニング利用オプトインを確認してください。"
                ) from exc
            if exc.status not in {429, 500, 502, 503, 504}:
                raise AIToolsDecisionError(f"Logfare decision APIがHTTP {exc.status}を返しました。") from exc
            last_error = exc
            if attempt + 1 < AITOOLS_RETRIES:
                await asyncio.sleep(0.5)
        except AIToolsDecisionError:
            # abstain/不正な選択は再試行しても同じ判断コストだけが増えるため即時停止。
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, RuntimeError, ValueError) as exc:
            last_error = exc
            if attempt + 1 < AITOOLS_RETRIES:
                await asyncio.sleep(0.5)
    raise AIToolsDecisionError(f"Clefの判定に失敗しました: {last_error}")


async def invoke_action(bot, message, item: dict[str, str], *, invoker=None) -> None:
    """既存GeneralCogのShortcutMessageInteraction経路を再利用する。"""
    if item["root"] in {"support", "general"} and item["value"] in {"pay", "clear"}:
        raise AIToolsDecisionError("この操作はAI toolsから実行できません。")
    if item["root"] == "general" and item["value"] == "miq_settings":
        raise AIToolsDecisionError("MIQ設定はAI toolsから実行できません。/general から開いてください。")
    general = bot.get_cog("GeneralCog")
    if general is None:
        raise AIToolsDecisionError("機能ディスパッチャーが読み込まれていません。")
    shortcut = {
        "user_id": str(message.author.id),
        "action": {"root": item["root"], "value": item["value"]},
    }
    await general.execute_shortcut(message, shortcut, invoker=invoker)
