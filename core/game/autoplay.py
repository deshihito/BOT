"""放置したプレイヤーの番を、d1（ラズパイの意思決定モデル）で代わりに進める共通の仕組み。

どのゲームからも呼べるように、ゲーム固有の知識は持たない。ゲーム側は「いまの状況（state）」と
「選んでよい手の一覧（legal_actions）」と「どう選ぶか（instructions）」を渡すだけ。

    from core.game import autoplay

    result = await autoplay.take_idle_turn(
        channel, guild_id=channel.guild.id, player_name="ひと でし",
        state={"hand": [...], "top": "赤の5"},
        legal_actions=["赤の1", "DRAW"],
        instructions="UNO で出す手を 1 つ選んでください",
        describe=lambda a: "1枚引いてパス" if a == "DRAW" else f"[{a}] を出",
        fallback="DRAW",
    )
    if result is None:   # このサーバーでは代打ちがオフ → ゲーム側の元の時間切れ処理を行う
        ...
    else:
        apply(result.action)

約束ごと:
- ``choose_action`` / ``take_idle_turn`` は例外をゲームに投げない。d1 が止まっている・時間切れ・
  一覧にない答え、のどれでも ``fallback``（なければ一覧からランダム）を返す。
- 返す手は必ず ``legal_actions`` のどれか（一覧が空のときだけ None）。
- d1 の URL は環境変数 ``D1_ENDPOINT`` で変えられる（既定は http://127.0.0.1:8082/v1/systemone）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence

import aiohttp

logger = logging.getLogger(__name__)

DEFAULT_D1_ENDPOINT = "http://127.0.0.1:8082/v1/systemone"
DEFAULT_TIMEOUT = 5.0
QUESTION_KEY = "action"
QUESTION_TYPE = os.getenv("D1_AUTOPLAY_QUESTION_TYPE", "text")

SOURCE_D1 = "d1"
SOURCE_FALLBACK = "fallback"


def d1_endpoint() -> str:
    return os.getenv("D1_ENDPOINT") or DEFAULT_D1_ENDPOINT


@dataclass
class AutoplayResult:
    action: Any            # legal_actions のどれか
    source: str            # "d1" か "fallback"
    notice: str = ""       # 「○○さんが放置したため、代わりに△△しました」


def _label(action: Any) -> str:
    return action if isinstance(action, str) else json.dumps(action, ensure_ascii=False, default=str)


def _build_payload(state: dict, legal_actions: Sequence[Any], instructions: str) -> dict:
    options = "\n".join(f"{i}: {_label(a)}" for i, a in enumerate(legal_actions))
    text = (f"{instructions}\n"
            f"次の選択肢から 1 つだけ選び、選択肢の文字列そのもの（または番号）だけを答えてください。\n{options}")
    return {
        "state": json.dumps({**(state or {}), "legal_actions": [_label(a) for a in legal_actions]},
                            ensure_ascii=False, default=str),
        "questions": {QUESTION_KEY: {"type": QUESTION_TYPE, "instructions": text}},
    }


def _extract_answer(data: Any) -> Any:
    """d1 の返答から答えを取り出す（形が多少違っても拾う）。"""
    if isinstance(data, dict):
        for key in ("answers", "results", "answer", "result", "output", "outputs"):
            if key in data:
                return _extract_answer(data[key])
        if QUESTION_KEY in data:
            return _extract_answer(data[QUESTION_KEY])
        for key in ("value", "choice", "text", "content"):
            if key in data:
                return _extract_answer(data[key])
        if len(data) == 1:
            return _extract_answer(next(iter(data.values())))
        return None
    if isinstance(data, list):
        return _extract_answer(data[0]) if data else None
    return data


def _match(answer: Any, legal_actions: Sequence[Any]) -> tuple[bool, Any]:
    """答えが legal_actions のどれかなら (True, その手)。"""
    if answer is None or isinstance(answer, bool):
        return False, None
    labels = [_label(a) for a in legal_actions]
    if isinstance(answer, int):
        return (True, legal_actions[answer]) if 0 <= answer < len(legal_actions) else (False, None)
    text = str(answer).strip().strip('"「」\'` ').strip()
    if text in labels:
        return True, legal_actions[labels.index(text)]
    if text.isdigit() and 0 <= int(text) < len(legal_actions):
        return True, legal_actions[int(text)]
    # 「0: 赤の1」のような書き方
    head = text.split(":", 1)[0].strip()
    if ":" in text and head.isdigit() and 0 <= int(head) < len(legal_actions):
        return True, legal_actions[int(head)]
    return False, None


async def _ask_d1(payload: dict, timeout: float) -> Any:
    async with aiohttp.ClientSession() as session:
        async with session.post(d1_endpoint(), json=payload,
                                timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            if resp.status != 200:
                raise RuntimeError(f"d1 returned HTTP {resp.status}")
            return await resp.json(content_type=None)


def _fallback(legal_actions: Sequence[Any], fallback: Any) -> Any:
    if callable(fallback):
        try:
            choice = fallback(list(legal_actions))
            if choice in legal_actions:
                return choice
        except Exception:
            logger.exception("autoplay の fallback でエラー（ランダムで選びます）")
    elif fallback is not None and fallback in legal_actions:
        return fallback
    return random.choice(list(legal_actions))


async def choose_action_detailed(game: Any, state: dict, legal_actions: Sequence[Any], instructions: str,
                                 timeout: float = DEFAULT_TIMEOUT, fallback: Any = None) -> AutoplayResult:
    """d1 に手を選ばせる。どんな失敗でも fallback に切り替え、例外は投げない。"""
    legal = list(legal_actions or [])
    if not legal:
        return AutoplayResult(None, SOURCE_FALLBACK)
    if len(legal) == 1:
        return AutoplayResult(legal[0], SOURCE_FALLBACK)
    try:
        data = await asyncio.wait_for(_ask_d1(_build_payload(state, legal, instructions), timeout), timeout + 1)
        ok, action = _match(_extract_answer(data), legal)
        if ok:
            return AutoplayResult(action, SOURCE_D1)
        logger.info("d1 の答えが選択肢にありませんでした: %r", data)
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError:
        logger.info("d1 が時間内に答えませんでした（%s 秒）", timeout)
    except Exception as e:
        logger.info("d1 に聞けませんでした: %s", e)
    try:
        return AutoplayResult(_fallback(legal, fallback), SOURCE_FALLBACK)
    except Exception:
        return AutoplayResult(legal[0], SOURCE_FALLBACK)


async def choose_action(game: Any, state: dict, legal_actions: Sequence[Any], instructions: str,
                        timeout: float = DEFAULT_TIMEOUT, fallback: Any = None) -> Any:
    """legal_actions のどれか 1 つを返す（空なら None）。例外は投げない。

    fallback: d1 が使えないときの手。値なら（一覧にあれば）それを、関数なら fn(legal_actions) の結果を使う。
    None ならランダム。
    """
    return (await choose_action_detailed(game, state, legal_actions, instructions, timeout, fallback)).action


def idle_notice(player_name: str, action_text: str) -> str:
    return f"{player_name}さんが放置したため、代わりに{action_text}しました"


async def take_idle_turn(channel: Any, *, guild_id: Optional[int], player_name: str, state: dict,
                         legal_actions: Sequence[Any], instructions: str,
                         describe: Optional[Callable[[Any], str]] = None, fallback: Any = None,
                         game: Any = None, timeout: float = DEFAULT_TIMEOUT) -> Optional[AutoplayResult]:
    """手番の時間切れで呼ぶ。代打ちがオフのサーバーでは None（ゲーム側の元の処理を続ける）。

    オンなら手を選び、channel があれば「○○さんが放置したため、代わりに△△しました」を送る。
    channel=None なら送らず、result.notice を自分のメッセージに入れて使う。
    """
    try:
        from core.support.guild_settings import autoplay_enabled
        if not autoplay_enabled(guild_id):
            return None
    except Exception:
        logger.exception("代打ちの設定を読めませんでした（オンとして続けます）")
    result = await choose_action_detailed(game, state, legal_actions, instructions, timeout, fallback)
    if result.action is None:
        return result
    try:
        text = describe(result.action) if describe else _label(result.action)
    except Exception:
        text = _label(result.action)
    result.notice = idle_notice(player_name, text)
    if channel is not None:
        try:
            await channel.send(result.notice)
        except Exception:
            logger.exception("代打ちのお知らせを送れませんでした")
    return result
