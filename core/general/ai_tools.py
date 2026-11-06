"""Logfareのtool callingとWeb検索RAGを接続する処理。"""
from __future__ import annotations

import json
from typing import Any

from core import logfare, web_search

WEB_SEARCH_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "最新情報、時事情報、変化する仕様、外部ページの内容が必要な場合にWeb検索する。"
            "検索結果のURLを最終回答の根拠として示す。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "検索エンジンに渡す具体的な検索語",
                },
                "max_results": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 5,
                    "default": 3,
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
}


async def answer_with_web_search(
    model: str,
    messages: list[dict[str, Any]],
    *,
    reasoning_effort: str | None = None,
    max_tokens: int = 1200,
) -> tuple[str, list[dict[str, str]]]:
    """モデルのweb_search呼び出しを最大2回実行し、RAG結果で最終回答を生成する。"""
    working_messages = list(messages)
    sources: list[dict[str, str]] = []
    retrieved_contexts: list[str] = []

    def message_content(message: dict[str, Any]) -> str:
        content = message.get("content")
        if isinstance(content, list):
            return "\n".join(
                str(part.get("text", "")) for part in content
                if isinstance(part, dict) and part.get("type") in {"text", "output_text"}
            ).strip()
        return str(content or "").strip()

    async def final_answer() -> str:
        # 一部の推論モデルはassistant/tool履歴を含む再送を空回答にするため、
        # ツール履歴ではなく元の会話と取得済み本文だけで再構成する。
        context = "\n\n".join(retrieved_contexts)[:18000]
        fallback_messages = list(messages) + [{
            "role": "system",
            "content": (
                "検索処理は完了しています。検索結果を根拠として、必ず回答本文を日本語で生成してください。"
                "ツール呼び出しは追加せず、参照URLも含めてください。"
            ),
        }, {
            "role": "user",
            "content": f"以下はWeb検索で取得した参考資料です。内容を根拠として回答してください。\n{context}",
        }]
        final = await logfare.chat_completion(
            model,
            fallback_messages,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
        )
        message = final.get("choices", [{}])[0].get("message", {})
        answer = message_content(message)
        if answer or not reasoning_effort:
            return answer
        # 強度指定が原因で最終生成だけ空になった場合は、既定値でもう一度試す。
        final = await logfare.chat_completion(
            model, fallback_messages, max_tokens=max_tokens, reasoning_effort=None
        )
        return message_content(final.get("choices", [{}])[0].get("message", {}))

    for _ in range(2):
        data = await logfare.chat_completion(
            model,
            working_messages,
            max_tokens=max_tokens,
            reasoning_effort=reasoning_effort,
            tools=[WEB_SEARCH_TOOL],
            tool_choice="auto",
        )
        message = data.get("choices", [{}])[0].get("message", {})
        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            content = message_content(message)
            if content:
                return content, sources
            if sources:
                return await final_answer(), sources
            return "", sources

        working_messages.append(message)
        for call in tool_calls:
            function = call.get("function") or {}
            if function.get("name") != "web_search":
                result = {"error": "許可されていないツールです。"}
            else:
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                    query = str(arguments.get("query") or "").strip()
                    max_results = int(arguments.get("max_results", 3))
                    documents = await web_search.retrieve(query, max_results=max_results)
                    sources.extend(documents)
                    retrieved_contexts.append(web_search.compact_documents(documents))
                    result = {
                        "query": query,
                        "sources": [
                            {
                                "title": item.get("title", ""),
                                "url": item.get("url", ""),
                                "snippet": item.get("snippet", ""),
                            }
                            for item in documents
                        ],
                        "retrieved_context": web_search.compact_documents(documents),
                    }
                except (ValueError, TypeError, json.JSONDecodeError) as exc:
                    result = {"error": f"検索引数が不正です: {exc}"}
                except Exception as exc:
                    result = {"error": f"Web検索に失敗しました: {str(exc)[:200]}"}
            working_messages.append({
                "role": "tool",
                "tool_call_id": call.get("id", "web_search"),
                "content": json.dumps(result, ensure_ascii=False),
            })

    # ツールを繰り返し呼び続けるモデルには、最後に通常回答を要求する。
    return await final_answer(), sources
