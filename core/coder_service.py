"""AGO Coder用のBot側AI実行サービス。"""
from __future__ import annotations

from dataclasses import dataclass

from core import ai_preferences, ai_provider_router, logfare

SYSTEM_PROMPT = (
    "あなたはAGO Coderです。コードと設計に関する質問へ、日本語で簡潔に回答してください。"
    "実際にファイルを編集・実行・確認したとは述べないでください。"
)


@dataclass(frozen=True)
class CoderReply:
    text: str
    provider: str
    model: str


async def reply(prompt: str, user_id: int) -> CoderReply:
    prompt = prompt.strip()
    if not prompt or len(prompt) > 4000:
        raise ValueError("prompt is invalid")

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": prompt},
    ]

    preferred = ai_preferences.get_model(user_id) or logfare.configured_default_model()
    if preferred == ai_provider_router.AUTO_MODEL:
        if not ai_provider_router.enabled():
            raise RuntimeError("AI provider is not configured")
        routed = await ai_provider_router.chat(messages, max_tokens=900)
        return CoderReply(text=routed.text, provider=routed.provider, model=routed.model)

    if logfare.api_key():
        model, _ = await logfare.resolve_model(preferred)
        text = await logfare.chat(model, messages, max_tokens=900)
        if not text:
            raise RuntimeError("empty reply")
        return CoderReply(text=text, provider="logfare", model=model)

    raise RuntimeError("AI provider is not configured")
