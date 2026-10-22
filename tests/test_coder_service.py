import asyncio
from unittest.mock import AsyncMock, patch

from core import ai_provider_router, coder_service


def test_coder_uses_bot_provider_router_for_auto_selection():
    routed = ai_provider_router.Answer(text="answer", provider="groq", model="gpt-oss")
    with patch("core.coder_service.ai_preferences.get_model", return_value="ai/auto"), patch(
        "core.coder_service.ai_provider_router.enabled", return_value=True
    ), patch("core.coder_service.ai_provider_router.chat", new=AsyncMock(return_value=routed)) as chat:
        result = asyncio.run(coder_service.reply("コードを見て", 123))

    assert result == coder_service.CoderReply(text="answer", provider="groq", model="gpt-oss")
    assert chat.await_args.kwargs["max_tokens"] == 900
    assert chat.await_args.args[0][1]["content"] == "コードを見て"


def test_coder_uses_the_users_bot_model_setting():
    with patch("core.coder_service.ai_preferences.get_model", return_value="selected-model"), patch(
        "core.coder_service.logfare.api_key", return_value="configured"
    ), patch("core.coder_service.logfare.resolve_model", new=AsyncMock(return_value=("selected-model", True))), patch(
        "core.coder_service.logfare.chat", new=AsyncMock(return_value="answer")
    ) as chat:
        result = asyncio.run(coder_service.reply("設計を説明して", 456))

    assert result == coder_service.CoderReply(text="answer", provider="logfare", model="selected-model")
    assert chat.await_args.args[0] == "selected-model"


def test_coder_rejects_empty_prompt():
    try:
        asyncio.run(coder_service.reply("  ", 123))
    except ValueError:
        pass
    else:
        raise AssertionError("empty prompt was accepted")
