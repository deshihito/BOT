"""Logfare Clefで既存BOT機能を判断・実行するAI tools処理。"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import aiohttp

from core import logfare

AITOOLS_MODEL = "clef"
AITOOLS_TIMEOUT = float(os.getenv("AITOOLS_TIMEOUT", "30"))
AITOOLS_RETRIES = max(1, int(os.getenv("AITOOLS_RETRIES", "1")))

# 引数や確認モーダルを要する処理、権限操作、削除・送金系は代理実行対象外。
BLOCKED_ACTIONS = {
    "general:pay", "general:fujo_register", "general:fujo_freeze", "general:fujo_panic_disable",
    "general:shortcut_manage", "general:aitools", "general:ai_default",
    "general:image_default", "general:reasoning_default",
    "support:clear", "support:role_bulk", "support:muted", "support:ticket", "support:honeypot",
    "support:whisper", "support:binjou", "support:message_log", "support:moderation_log",
    "support:bumprta_on", "support:bumprta_off",
    # 音声の記録・文字起こしや、参加先を指定する必要があるコミュニティ機能は明示操作に限定。
    "vc:record_start", "vc:echo_start", "vc:transcribe_start", "vc:karaoke_start",
    "vc:global_start", "vc:match_start",
}


class AIToolsDecisionError(RuntimeError):
    pass


def action_candidates() -> dict[str, dict[str, str]]:
    """危険な操作を除き、AI toolsが選択可能な全機能を候補化する。"""
    from cogs.general import SHORTCUT_ROOTS

    candidates: dict[str, dict[str, str]] = {}
    for root, (root_label, items) in SHORTCUT_ROOTS.items():
        for label, value in items:
            key = f"{root}:{value}".lower()
            if key in BLOCKED_ACTIONS:
                continue
            candidates[key] = {"root": root, "value": value, "label": label, "genre": root_label}
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
                raise AIToolsDecisionError("Clefが実行不要または判断不能と判定しました。")
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
    general = bot.get_cog("GeneralCog")
    if general is None:
        raise AIToolsDecisionError("機能ディスパッチャーが読み込まれていません。")
    shortcut = {
        "user_id": str(message.author.id),
        "action": {"root": item["root"], "value": item["value"]},
    }
    await general.execute_shortcut(message, shortcut, invoker=invoker)
