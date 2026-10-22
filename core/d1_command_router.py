"""ローカルD1のchoice判定で既存BOT機能を代理実行する処理。"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import aiohttp

D1_ENDPOINT = os.getenv("D1_ENDPOINT", "http://127.0.0.1:8082/v1/systemone")
D1_TIMEOUT = float(os.getenv("D1_COMMAND_TIMEOUT", "30"))
D1_RETRIES = max(1, int(os.getenv("D1_COMMAND_RETRIES", "1")))

# 引数や確認モーダルを要する処理、権限操作、削除・送金系は代理実行対象外。
BLOCKED_ACTIONS = {
    "general:pay", "general:fujo_register", "general:fujo_freeze", "general:fujo_panic_disable",
    "general:shortcut_manage", "general:d1tools", "general:ai_default",
    "general:image_default", "general:reasoning_default",
    "support:clear", "support:role_bulk", "support:muted", "support:ticket", "support:honeypot",
    "support:whisper", "support:binjou", "support:message_log", "support:moderation_log",
}


class D1DecisionError(RuntimeError):
    pass


def action_candidates(allowed: list[str]) -> dict[str, dict[str, str]]:
    """既存Shortcutのジャンル/機能をD1用の候補へ変換する。"""
    from cogs.general import SHORTCUT_ROOTS

    allowed_set = {item.strip().lower() for item in allowed}
    candidates: dict[str, dict[str, str]] = {}
    for root, (root_label, items) in SHORTCUT_ROOTS.items():
        for label, value in items:
            key = f"{root}:{value}".lower()
            if key in BLOCKED_ACTIONS or key not in allowed_set:
                continue
            candidates[key] = {"root": root, "value": value, "label": label, "genre": root_label}
    return candidates


def _extract_choice(data: dict[str, Any], key: str) -> str:
    answers = data.get("answers")
    if not isinstance(answers, dict):
        raise D1DecisionError("D1応答にanswersオブジェクトがありません。")
    answer = answers.get(key)
    if isinstance(answer, str):
        value = answer
    elif isinstance(answer, dict):
        value = answer.get("choice") or answer.get("answer") or answer.get("value")
    else:
        value = data.get("choice")
    if not isinstance(value, str) or not value.strip():
        raise D1DecisionError("D1応答にchoiceがありません。")
    return value.strip().lower()


async def decide_action(prompt: str, candidates: dict[str, dict[str, str]], instruction: str) -> str:
    if not candidates:
        raise D1DecisionError("許可された機能アクションがありません。")
    criteria = {"none": "適切な機能がない、引数不足、または安全に判断できない場合"}
    for key, item in candidates.items():
        criteria[key] = f"{item['genre']} / {item['label']}"
    payload = {
        "state": json.dumps({
            "user_request": prompt,
            "allowed_actions": criteria,
            "custom_policy": instruction or "なし",
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
    timeout = aiohttp.ClientTimeout(total=D1_TIMEOUT)
    last_error: Exception | None = None
    for attempt in range(D1_RETRIES):
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(D1_ENDPOINT, json=payload) as response:
                    body = await response.text()
                    if response.status != 200:
                        raise D1DecisionError(f"D1 HTTP {response.status}: {body[:240]}")
                    try:
                        data = json.loads(body)
                    except json.JSONDecodeError as exc:
                        raise D1DecisionError("D1応答がJSONではありません。") from exc
                    selected = _extract_choice(data, "action")
                    if selected == "none":
                        raise D1DecisionError("D1が実行不要または判断不能と判定しました。")
                    if selected not in candidates:
                        raise D1DecisionError("D1が許可されていない機能を選択しました。")
                    return selected
        except asyncio.CancelledError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, D1DecisionError) as exc:
            last_error = exc
            if attempt + 1 < D1_RETRIES:
                await asyncio.sleep(0.5)
    raise D1DecisionError(f"D1の判定に失敗しました: {last_error}")


async def invoke_action(bot, message, item: dict[str, str]) -> None:
    """既存GeneralCogのShortcutMessageInteraction経路を再利用する。"""
    if item["root"] in {"support", "general"} and item["value"] in {"pay", "clear"}:
        raise D1DecisionError("この機能は代理実行できません。")
    general = bot.get_cog("GeneralCog")
    if general is None:
        raise D1DecisionError("機能ディスパッチャーが読み込まれていません。")
    shortcut = {
        "user_id": str(message.author.id),
        "action": {"root": item["root"], "value": item["value"]},
    }
    await general.execute_shortcut(message, shortcut)
