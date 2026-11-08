"""!ai  のチャットモデルを呼び出す機能。バグが多すぎてつかれたんだよー(ちいかわ)"""
from __future__ import annotations

import asyncio
import dataclasses
import io
import json
import logging
import re
from typing import Any

import discord
from discord.ext import commands

from core.general.ai import logfare
from core.general.ai import ai_context, ai_input, ai_latex, ai_omnirush, ai_preferences, ai_provider_router
from core.general.ai_tools import ai_tools
logger = logging.getLogger(__name__)


async def _reply_without_localization(ctx: commands.Context, *args, **kwargs):
    """Send an !ai response verbatim, without the transport translator."""
    kwargs["_agobot_skip_localization"] = True
    try:
        return await ctx.reply(*args, **kwargs)
    except TypeError as exc:
        # Keep !ai usable where the localization patch is not installed.
        if "_agobot_skip_localization" not in str(exc):
            raise
        kwargs.pop("_agobot_skip_localization", None)
        return await ctx.reply(*args, **kwargs)


HISTORY_AUTO_DEFAULT = 10
HISTORY_AUTO_MAX = 50
HISTORY_JUDGE_PROMPT = (
    "あなたはDiscord Botの前処理です。ユーザーの依頼に答えるために、"
    "このチャンネルの直近の会話履歴が必要かだけを判定してください。\n"
    "必要な例: 「さっきの」「これ」「上の」「この会話」「要約して」「続き」「他の人の発言への返答」など、"
    "依頼文だけでは内容が特定できない場合。\n"
    "不要な例: 一般知識の質問、依頼文だけで完結する翻訳・計算・文章作成など。\n"
    '出力は次の形式のJSONのみ（説明文やコードフェンスは付けない）: '
    '{"history": true, "count": 5〜50の整数} または {"history": false}'
)

_HISTORY_TRUE_RE = re.compile(r'"history"\s*:\s*(?:"true"|true|1)(?![\w.])', re.IGNORECASE)
_HISTORY_COUNT_RE = re.compile(r'"count"\s*:\s*"?(\d{1,3})')

HISTORY_JUDGE_TIMEOUT = 30

# 履歴が必要な依頼に典型的な言い回し。依頼文にこれらが含まれていれば、
# モデルへ判定を聞かずに履歴を読む。判定モデルの応答形式に左右されない
# 決定的な経路を用意し、JSON 指示に従わないモデル (Gemma 等) でも
# 自動読み込みが効くようにするための保険。
_HISTORY_HINT_RE = re.compile(
    r"さっき|先ほど|この会話|このチャンネル|会話履歴|チャット履歴"
    r"|続き|要約|まとめ|振り返|これまでの|今までの|他の人の発言"
)
# 判定モデルが JSON でなく日本語の散文で返した場合の救済用。
_JUDGE_NEGATIVE_RE = re.compile(r"不要|必要ありません|必要ない|必要ではあり?ません|いりません")
_JUDGE_POSITIVE_RE = re.compile(r"必要")


def _first_json_object(text: str) -> dict | None:
    """テキスト中の最初の完結した {...} を JSON として読む。読めなければ None。

    前置きの文章やコードフェンスが混ざっていても拾えるよう、波括弧の対応を
    数えて切り出す（従来の「最初の { から最後の } まで」だと、後続の文章に
    } があるだけで壊れる）。
    """
    start = text.find("{")
    while start >= 0:
        depth = 0
        in_string = False
        escaped = False
        end = -1
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    end = index
                    break
        if end < 0:
            return None
        try:
            data = json.loads(text[start:end + 1])
        except ValueError:
            start = text.find("{", start + 1)
            continue
        return data if isinstance(data, dict) else None
    return None


def _as_bool(value: Any) -> bool | None:
    """JSONの真偽値に加え、"true" のような文字列表記も受理する。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "on", "1"}:
            return True
        if lowered in {"false", "no", "off", "0"}:
            return False
        return None
    if isinstance(value, (int, float)):
        return bool(value)
    return None


def _parse_history_decision(text: str) -> int:
    """判定JSONから読み込み件数を返す。不要・解析失敗は0。

    Gemma系などJSONの形式が緩いモデルでも拾えるよう、厳密なパースに
    失敗したらキーと値だけを正規表現で救済する。
    """
    raw = text or ""
    data = _first_json_object(raw)
    if data is not None:
        if _as_bool(data.get("history")) is not True:
            return 0
        count_value = data.get("count", HISTORY_AUTO_DEFAULT)
    elif _HISTORY_TRUE_RE.search(raw):
        count_match = _HISTORY_COUNT_RE.search(raw)
        count_value = int(count_match.group(1)) if count_match else HISTORY_AUTO_DEFAULT
    elif _JUDGE_NEGATIVE_RE.search(raw):
        return 0
    elif _JUDGE_POSITIVE_RE.search(raw):
        # 「履歴が必要です」のような散文の肯定も拾う (件数はデフォルト)。
        count_value = HISTORY_AUTO_DEFAULT
    else:
        return 0
    try:
        count = int(count_value)
    except (TypeError, ValueError):
        count = HISTORY_AUTO_DEFAULT
    return max(1, min(count, HISTORY_AUTO_MAX))


async def _judge_history(ask, prompt: str) -> int:
    # 典型的な言い回しはモデル判定を待たずに即決する (モデルの応答形式や
    # 応答速度に左右されず、確実に履歴が読まれるように)。
    if _HISTORY_HINT_RE.search(prompt or ""):
        logger.info(
            "history judge: keyword hint matched; loading %d messages",
            HISTORY_AUTO_DEFAULT,
        )
        return HISTORY_AUTO_DEFAULT
    messages = [
        {"role": "system", "content": HISTORY_JUDGE_PROMPT},
        {"role": "user", "content": prompt[:1500]},
    ]
    try:
        text = await asyncio.wait_for(ask(messages), timeout=HISTORY_JUDGE_TIMEOUT)
    except Exception:
        logger.warning("history judge failed; continuing without history", exc_info=True)
        return 0
    count = _parse_history_decision(text)
    # !logs で後から追えるよう、判定結果と応答の冒頭を残す。
    logger.info("history judge: count=%d reply=%r", count, (text or "").strip()[:120])
    return count


def _with_history(options, count: int):
    try:
        options.history = count
        return options
    except (AttributeError, dataclasses.FrozenInstanceError):
        return dataclasses.replace(options, history=count)


class AICog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.command(name="ai", help="Ask AI a question. Supports PDF, DOCX, text attachments and links in the prompt (images depend on the model). Options: --history[=N] reads recent chat (auto-detected when needed), --nolink skips link loading.")
    @commands.cooldown(1, 5.0, commands.BucketType.user)
    async def ai(self, ctx: commands.Context, *, prompt: str = ""):
        options = ai_context.parse_options(prompt)
        prompt = options.prompt
        attachments = list(getattr(getattr(ctx, "message", None), "attachments", []) or [])
        if not prompt and options.history:
            prompt = "このチャンネルの直近の会話を要約してください。"
        if not prompt and not attachments:
            return await _reply_without_localization(ctx,
                "使い方: `!ai 質問内容`（URLを含めると本文を読み込みます。履歴が必要な質問は自動で直近の会話も参照します。`--history=10` で明示指定、`--nolink` でリンク読み込みを無効化）",
                mention_author=False,
            )
        has_images = ai_input.has_image_attachment(attachments)
        preferred = ai_preferences.get_model(ctx.author.id) or logfare.configured_default_model()
        auto = preferred == ai_provider_router.AUTO_MODEL
        kios_model = preferred.partition("kiosapi::")[2] if preferred.startswith("kiosapi::") else None
        apinex_model = preferred.partition("apinex::")[2] if preferred.startswith("apinex::") else None
        omnirush_model = preferred if preferred.startswith("omnirush::") else None
        if auto and not ai_provider_router.enabled():
            return await _reply_without_localization(ctx, "AIの自動切替が未設定です。", mention_author=False)
        if not auto and not kios_model and not apinex_model and not omnirush_model and not logfare.api_key():
            return await _reply_without_localization(ctx, "AI機能は現在利用できません。", mention_author=False)

        sources = []
        context = ai_context.ContextResult()
        history_auto = False
        try:
            if auto or kios_model:
                model, exact = preferred, True
                reasoning_effort = None
                model_info = None
                images_supported = False
                if kios_model and has_images:
                    kios_catalog = await ai_provider_router.fetch_kiosapi_models()
                    model_info = next((item for item in kios_catalog if item.get("id") == kios_model), None)
                    images_supported = ai_provider_router.supports_images("kiosapi", kios_model, model_info)
            elif apinex_model:
                model, exact = apinex_model, True
                requested_effort = ai_preferences.get_reasoning_effort(ctx.author.id)
                supported_efforts = ai_provider_router.supported_reasoning_efforts("apinex", apinex_model)
                reasoning_effort = requested_effort if requested_effort in supported_efforts else None
                model_info = None
                images_supported = ai_provider_router.supports_images("apinex", apinex_model)
            elif omnirush_model:
                model, exact = omnirush_model, True
                requested_effort = ai_preferences.get_reasoning_effort(ctx.author.id)
                efforts = ai_omnirush.supports_reasoning_efforts(omnirush_model)
                reasoning_effort = requested_effort if requested_effort in efforts else None
                model_info = None
                images_supported = False
            else:
                model, exact = await logfare.resolve_model(preferred)
                reasoning_effort = ai_preferences.get_reasoning_effort(ctx.author.id)
                try:
                    model_info = next(
                        (item for item in await logfare.fetch_free_chat_models() if item.get("id") == model),
                        None,
                    )
                except Exception:
                    model_info = None
                images_supported = ai_provider_router.supports_images("logfare", model, model_info)
                if reasoning_effort:
                    if not model_info or reasoning_effort not in logfare.reasoning_efforts(model_info):
                        reasoning_effort = None
            can_use_web_search = bool(
                model_info and (model_info.get("chat_capabilities") or {}).get("tools") is True
            )
            if has_images and not images_supported:
                return await _reply_without_localization(ctx,
                    ai_input.IMAGE_UNSUPPORTED_MESSAGE,
                    mention_author=False,
                )

            async def ask_plain(msgs):
                """履歴判定用の軽い1回呼び出し(ツール・推論なし)。"""
                if auto:
                    return (await ai_provider_router.chat(msgs)).text
                if kios_model:
                    return (await ai_provider_router.chat_with_model("kiosapi", kios_model, msgs)).text
                if apinex_model:
                    return (await ai_provider_router.chat_with_model("apinex", apinex_model, msgs)).text
                if omnirush_model:
                    return await ai_omnirush.chat(omnirush_model, f"{msgs[0]['content']}\n\n{msgs[1]['content']}")
                return await logfare.chat(model, msgs)

            async with ctx.typing():
                # --history 未指定でも、AIが必要と判断したら直近の会話を読み込む
                if not options.history and prompt:
                    count = await _judge_history(ask_plain, prompt)
                    if count:
                        options = _with_history(options, count)
                        history_auto = True
                context = await ai_context.build_context(ctx, options)
            full_prompt = f"{prompt}\n\n{context.text}" if context.text else prompt
            user_content = await ai_input.build_user_content(
                full_prompt, attachments, images_supported=images_supported
            )
            messages = [
                {
                    "role": "system",
                    "content": (
                        "あなたはDiscord上の親切なアシスタントです。日本語で簡潔かつ正確に回答してください。"
                        + ("必要に応じてweb_searchを使い、回答に参照URLを含めてください。" if can_use_web_search else "")
                        + ai_latex.SYSTEM_HINT
                        + (ai_context.SYSTEM_HINT if context.text else "")
                    ),
                },
                {"role": "user", "content": user_content},
            ]
            async with ctx.typing():
                if auto:
                    routed = await ai_provider_router.chat(messages)
                    answer = routed.text
                elif kios_model:
                    routed = await ai_provider_router.chat_with_model("kiosapi", kios_model, messages)
                    answer = routed.text
                elif apinex_model:
                    routed = await ai_provider_router.chat_with_model(
                        "apinex", apinex_model, messages, reasoning_effort=reasoning_effort
                    )
                    answer = routed.text
                elif omnirush_model:
                    answer = await ai_omnirush.chat(
                        omnirush_model,
                        f"{ai_latex.SYSTEM_HINT}{ai_context.SYSTEM_HINT if context.text else ''}\n\n{user_content}",
                        reasoning_effort=reasoning_effort,
                    )
                elif can_use_web_search:
                    answer, sources = await ai_tools.answer_with_web_search(
                        model, messages, reasoning_effort=reasoning_effort
                    )
                else:
                    answer = await logfare.chat(model, messages, reasoning_effort=reasoning_effort)
        except (ai_input.AttachmentInputError, ai_context.ContextError) as exc:
            return await _reply_without_localization(ctx, str(exc), mention_author=False)
        except (ai_omnirush.OmniRushLoginRequired, ai_omnirush.OmniRushUnavailable):
            logger.warning("!ai: OmniRush unavailable", exc_info=True)
            return await _reply_without_localization(ctx,
                "AI機能は現在利用できません。",
                mention_author=False,
            )
        except ai_omnirush.OmniRushError:
            logger.warning("!ai: OmniRush error", exc_info=True)
            return await _reply_without_localization(ctx, "AIへの問い合わせに失敗しました。しばらくしてから再試行してください。", mention_author=False)
        except Exception:
            logger.exception("!ai request failed: user=%s model=%s", ctx.author.id, preferred)
            return await _reply_without_localization(ctx, "AIへの問い合わせに失敗しました。しばらくしてから再試行してください。", mention_author=False)

        if not answer:
            return await _reply_without_localization(ctx, "AIから空の回答が返りました。", mention_author=False)
        notice = "" if exact else f"（指定モデルがfree一覧にないため `{model}` を使用）"
        latex = await ai_latex.process(answer)
        description = latex.text[:4096]
        # 4096字で切れた分の数式は除き、残りを1枚にまとめてembedの画像にする
        composed = await ai_latex.compose([image for image in latex.images if image.marker in description])
        send_kwargs = {}
        if composed:
            math_data, math_alt = composed
            send_kwargs["file"] = discord.File(io.BytesIO(math_data), filename="math.png", description=math_alt)
        embed = discord.Embed(
            title="AI回答",
            description=description,
            color=0x5865F2,
        )
        footer = (f"モデル: {routed.model} / 接続先: {routed.provider}（自動切替）"
                  if auto else f"モデル: {routed.model} / 接続先: KiosAPI" if kios_model
                  else f"モデル: {routed.model} / 接続先: APInex" if apinex_model
                  else f"モデル: {ai_omnirush.model_name(omnirush_model)} / 接続先: OmniRush CLI" if omnirush_model
                  else f"モデル: {model}{notice}")
        embed.set_footer(text=footer)
        if composed:
            embed.set_image(url="attachment://math.png")
        context_lines = list(context.summary_lines() or [])
        if history_auto:
            context_lines.append("AI判断で直近の会話履歴を読み込みました")
        if context_lines:
            embed.add_field(name="読み込んだ情報", value="\n".join(context_lines)[:1024], inline=False)
        unique_sources = {source.get("url"): source for source in sources if source.get("url")}
        if unique_sources:
            links = "\n".join(
                f"[{source.get('title', '参照')[:80]}]({url})"
                for url, source in list(unique_sources.items())[:5]
            )
            embed.add_field(name="参照ソース", value=links[:1024], inline=False)
        await _reply_without_localization(ctx, embed=embed, mention_author=False, **send_kwargs)

    @ai.error
    async def ai_error(self, ctx: commands.Context, error: commands.CommandError):
        if isinstance(error, commands.CommandOnCooldown):
            return await _reply_without_localization(ctx, f"少し待ってから再試行してください（{error.retry_after:.1f}秒）。", mention_author=False)
        logger.exception("!ai command error", exc_info=error)

    @commands.command(name="generate", help="Generate an image with Logfare. Example: !generate cat under a starry sky")
    @commands.cooldown(1, 15.0, commands.BucketType.user)
    async def generate(self, ctx: commands.Context, *, prompt: str = ""):
        prompt = prompt.strip()
        if not prompt:
            return await ctx.reply("使い方: `!generate 画像のプロンプト`", mention_author=False)
        if not logfare.api_key():
            return await ctx.reply("AI機能は現在利用できません。", mention_author=False)

        preferred = ai_preferences.get_image_model(ctx.author.id)
        try:
            model, exact = await logfare.resolve_image_model(preferred)
            async with ctx.typing():
                image = await logfare.generate_image(model, prompt)
        except Exception:
            logger.exception("!generate request failed: user=%s model=%s", ctx.author.id, preferred)
            return await ctx.reply("画像生成に失敗しました。モデルの利用条件やプロンプトを確認してください。", mention_author=False)

        notice = "" if exact else f"（指定モデルが見つからないため `{model}` を使用）"
        file = discord.File(io.BytesIO(image), filename="logfare-generated.png")
        embed = discord.Embed(title="画像生成", description=notice or None, color=0xE67E22)
        embed.set_image(url="attachment://logfare-generated.png")
        embed.set_footer(text=f"モデル: {model}")
        await ctx.reply(embed=embed, file=file, mention_author=False)

    @generate.error
    async def generate_error(self, ctx: commands.Context, error: commands.CommandError):
        if isinstance(error, commands.CommandOnCooldown):
            return await ctx.reply(f"少し待ってから再試行してください（{error.retry_after:.1f}秒）。", mention_author=False)
        logger.exception("!generate command error", exc_info=error)

    # ------------------------------------------------------------------
    # /general パネル入口 (general:ai_chat / general:ai_generate)
    #
    # !ai / !generate の実行部は commands.Context（message 前提）のため
    # interaction から直接は呼べない。パネル版は「プロンプトのみ・
    # 添付なし・履歴/リンク読み込みなし・web検索なし」の最小実装として、
    # モデル解決と応答生成は prefix 版と同一の既存関数
    # (ai_preferences / logfare.resolve_model / logfare.chat /
    # ai_provider_router / ai_omnirush / logfare.generate_image) を
    # そのまま使う（新しい AI 呼び出し経路は作らない）。
    # ------------------------------------------------------------------

    async def open_chat(self, interaction: discord.Interaction):
        await interaction.response.send_modal(AiChatPromptModal(self))

    async def open_generate(self, interaction: discord.Interaction):
        await interaction.response.send_modal(AiGeneratePromptModal(self))

    async def panel_chat(self, user_id: int, prompt: str):
        """パネル版 !ai: (embed, file|None) か、エラー時は文面 (str) を返す。"""
        preferred = ai_preferences.get_model(user_id) or logfare.configured_default_model()
        auto = preferred == ai_provider_router.AUTO_MODEL
        kios_model = preferred.partition("kiosapi::")[2] if preferred.startswith("kiosapi::") else None
        apinex_model = preferred.partition("apinex::")[2] if preferred.startswith("apinex::") else None
        omnirush_model = preferred if preferred.startswith("omnirush::") else None
        if auto and not ai_provider_router.enabled():
            return "AIの自動切替が未設定です。"
        if not auto and not kios_model and not apinex_model and not omnirush_model and not logfare.api_key():
            return "Logfareが未設定です。`.env` に `LOGFARE_API_KEY` を設定してください。"
        routed = None
        model = preferred
        exact = True
        reasoning_effort = None
        try:
            if auto or kios_model:
                model, exact = preferred, True
            elif apinex_model:
                model, exact = apinex_model, True
                requested_effort = ai_preferences.get_reasoning_effort(user_id)
                supported_efforts = ai_provider_router.supported_reasoning_efforts("apinex", apinex_model)
                reasoning_effort = requested_effort if requested_effort in supported_efforts else None
            elif omnirush_model:
                model, exact = omnirush_model, True
                requested_effort = ai_preferences.get_reasoning_effort(user_id)
                efforts = ai_omnirush.supports_reasoning_efforts(omnirush_model)
                reasoning_effort = requested_effort if requested_effort in efforts else None
            else:
                model, exact = await logfare.resolve_model(preferred)
                reasoning_effort = ai_preferences.get_reasoning_effort(user_id)
                try:
                    model_info = next(
                        (item for item in await logfare.fetch_free_chat_models() if item.get("id") == model),
                        None,
                    )
                except Exception:
                    model_info = None
                if reasoning_effort:
                    if not model_info or reasoning_effort not in logfare.reasoning_efforts(model_info):
                        reasoning_effort = None
            messages = [
                {
                    "role": "system",
                    "content": (
                        "あなたはDiscord上の親切なアシスタントです。日本語で簡潔かつ正確に回答してください。"
                        + ai_latex.SYSTEM_HINT
                    ),
                },
                {"role": "user", "content": prompt},
            ]
            if auto:
                routed = await ai_provider_router.chat(messages)
                answer = routed.text
            elif kios_model:
                routed = await ai_provider_router.chat_with_model("kiosapi", kios_model, messages)
                answer = routed.text
            elif apinex_model:
                routed = await ai_provider_router.chat_with_model(
                    "apinex", apinex_model, messages, reasoning_effort=reasoning_effort
                )
                answer = routed.text
            elif omnirush_model:
                answer = await ai_omnirush.chat(
                    omnirush_model,
                    f"{ai_latex.SYSTEM_HINT}\n\n{prompt}",
                    reasoning_effort=reasoning_effort,
                )
            else:
                answer = await logfare.chat(model, messages, reasoning_effort=reasoning_effort)
        except ai_omnirush.OmniRushLoginRequired:
            return "OmniRushが未ログインです。Botと同じLinuxユーザーで `omnirush login` を実行してください。"
        except ai_omnirush.OmniRushUnavailable:
            return "OmniRush CLIが見つかりません。Botの実行ユーザーから利用可能か確認してください。"
        except ai_omnirush.OmniRushError as exc:
            return str(exc)
        except Exception:
            logger.exception("panel ai chat failed: user=%s model=%s", user_id, preferred)
            return "AIへの問い合わせに失敗しました。しばらくしてから再試行してください。"
        if not answer:
            return "AIから空の回答が返りました。"
        notice = "" if exact else f"（指定モデルがfree一覧にないため `{model}` を使用）"
        latex = await ai_latex.process(answer)
        description = latex.text[:4096]
        composed = await ai_latex.compose([image for image in latex.images if image.marker in description])
        file = None
        embed = discord.Embed(title="AI回答", description=description, color=0x5865F2)
        footer = (f"モデル: {routed.model} / 接続先: {routed.provider}（自動切替）"
                  if auto else f"モデル: {routed.model} / 接続先: KiosAPI" if kios_model
                  else f"モデル: {routed.model} / 接続先: APInex" if apinex_model
                  else f"モデル: {ai_omnirush.model_name(omnirush_model)} / 接続先: OmniRush CLI" if omnirush_model
                  else f"モデル: {model}{notice}")
        embed.set_footer(text=footer)
        if composed:
            math_data, math_alt = composed
            file = discord.File(io.BytesIO(math_data), filename="math.png", description=math_alt)
            embed.set_image(url="attachment://math.png")
        return embed, file

    async def panel_generate(self, user_id: int, prompt: str):
        """パネル版 !generate: (embed, file) か、エラー時は文面 (str) を返す。"""
        if not logfare.api_key():
            return "Logfareが未設定です。`.env` に `LOGFARE_API_KEY` を設定してください。"
        preferred = ai_preferences.get_image_model(user_id)
        try:
            model, exact = await logfare.resolve_image_model(preferred)
            image = await logfare.generate_image(model, prompt)
        except Exception:
            logger.exception("panel generate failed: user=%s model=%s", user_id, preferred)
            return "画像生成に失敗しました。モデルの利用条件やプロンプトを確認してください。"
        notice = "" if exact else f"（指定モデルが見つからないため `{model}` を使用）"
        file = discord.File(io.BytesIO(image), filename="logfare-generated.png")
        embed = discord.Embed(title="画像生成", description=notice or None, color=0xE67E22)
        embed.set_image(url="attachment://logfare-generated.png")
        embed.set_footer(text=f"モデル: {model}")
        return embed, file


class AiChatPromptModal(discord.ui.Modal, title="AIチャット（!ai）"):
    """!ai へのプロンプトを聞くモーダル（パネル版はプロンプトのみ）。"""

    prompt = discord.ui.TextInput(
        label="質問・依頼", style=discord.TextStyle.paragraph,
        max_length=4000, placeholder="例: Discord Botの作り方を教えて",
    )

    def __init__(self, cog: "AICog"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        text = (self.prompt.value or "").strip()
        if not text:
            return await interaction.response.send_message(
                "質問・依頼を入力してください。", ephemeral=True)
        await interaction.response.defer(thinking=True)
        result = await self.cog.panel_chat(interaction.user.id, text)
        if isinstance(result, str):
            return await interaction.followup.send(result)
        embed, file = result
        if file is not None:
            return await interaction.followup.send(embed=embed, file=file)
        return await interaction.followup.send(embed=embed)


class AiGeneratePromptModal(discord.ui.Modal, title="AI画像生成（!generate）"):
    """!generate へのプロンプトを聞くモーダル。"""

    prompt = discord.ui.TextInput(
        label="画像のプロンプト", style=discord.TextStyle.paragraph,
        max_length=1000, placeholder="例: 星空の下の猫",
    )

    def __init__(self, cog: "AICog"):
        super().__init__()
        self.cog = cog

    async def on_submit(self, interaction: discord.Interaction):
        text = (self.prompt.value or "").strip()
        if not text:
            return await interaction.response.send_message(
                "画像のプロンプトを入力してください。", ephemeral=True)
        await interaction.response.defer(thinking=True)
        result = await self.cog.panel_generate(interaction.user.id, text)
        if isinstance(result, str):
            return await interaction.followup.send(result)
        embed, file = result
        return await interaction.followup.send(embed=embed, file=file)


async def setup(bot: commands.Bot):
    await bot.add_cog(AICog(bot))