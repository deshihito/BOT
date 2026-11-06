"""Logfare Clefで既存BOT機能を判断・実行するAI tools処理。

引数（params）の扱い:
- Clef（Logfare decision API）の質問型は choice / noul / score のみで、
  自由文から値を抽出する型は存在しない（Cloudflare Clef 公式仕様）。
  そのため引数の抽出は、choice / bool 引数を choice 質問で選ばせ、
  数値引数を依頼文からの決定的なローカル抽出（キーワード近傍の数値）で拾う
  2段構えにする。どちらで拾った値も、必ずレジストリの ParamSpec で
  検証してから使う（検証を通らない値はそのキーごと落とす。推測では埋めない）。
- required な引数が抽出できなかった場合は、このモジュールでは実行せず、
  呼び出し側（cogs/ai_tools）が補完ビューでユーザに入力を求める。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import aiohttp

from core import action_registry, logfare

AITOOLS_MODEL = "clef"
AITOOLS_TIMEOUT = float(os.getenv("AITOOLS_TIMEOUT", "30"))
AITOOLS_RETRIES = max(1, int(os.getenv("AITOOLS_RETRIES", "1")))

# 権限操作、削除・送金系などは代理実行対象外。
# 実体は core/action_registry.AI_BLOCKED_IDS（risk="blocked" として定義側に保持）。
# ここでは後方互換のため同じ集合を再エクスポートする。
BLOCKED_ACTIONS = action_registry.AI_BLOCKED_IDS

# 確認ビュー付きなら代理実行可（risk="confirm"）。実体は action_registry 側。
CONFIRM_ACTIONS = action_registry.AI_CONFIRM_IDS


class AIToolsDecisionError(RuntimeError):
    pass


class AIToolsNoAction(AIToolsDecisionError):
    """Clefが実行対象なしと判断したことを示す。"""


def _param_schema(param: action_registry.ParamSpec) -> dict[str, Any]:
    """ParamSpec を候補に載せるための dict 表現に変換する。"""
    return {
        "name": param.name,
        "label": param.label,
        "type": param.type,
        "required": bool(param.required),
        "default": param.default,
        "choices": [[label, value] for label, value in param.choices],
        "min_value": param.min_value,
        "max_value": param.max_value,
        "help": param.help,
    }


def action_candidates() -> dict[str, dict[str, Any]]:
    """危険な操作を除き、AI toolsが選択可能な全機能を候補化する。

    候補はアクションレジストリ（core/action_registry）から生成する:
    surfaces に "aitools" を含み、risk が "blocked" でないアクションだけが対象。
    各候補には ParamSpec のスキーマ（"params"）と risk も載せる。
    """
    candidates: dict[str, dict[str, Any]] = {}
    for spec in action_registry.default_registry().all():
        if "aitools" not in spec.surfaces or spec.risk == "blocked":
            continue
        if spec.id in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS:
            # 表示系 (status / items / money_panel 等) は実行経路の
            # execute_shortcut が ephemeral 前提の応答を守るため拒否し、
            # 選ばれても何も起きない (E-9 付随)。候補側から除外する。
            continue
        key = spec.id.lower()
        candidates[key] = {
            "root": spec.root,
            "value": spec.value,
            "label": spec.label,
            "genre": action_registry.ROOT_LABELS[spec.root],
            "risk": spec.risk,
            "params": [_param_schema(param) for param in spec.params],
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


async def _request_decision(state: str, questions: dict[str, Any]) -> dict[str, Any]:
    """Logfare decision API を呼び、応答 dict を返す（リトライとエラー変換は従来どおり）。"""
    last_error: Exception | None = None
    for attempt in range(AITOOLS_RETRIES):
        try:
            return await asyncio.wait_for(
                logfare.decision(
                    AITOOLS_MODEL,
                    state,
                    questions,
                    timeout=aiohttp.ClientTimeout(total=AITOOLS_TIMEOUT),
                ),
                timeout=AITOOLS_TIMEOUT,
            )
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
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, RuntimeError, ValueError) as exc:
            last_error = exc
            if attempt + 1 < AITOOLS_RETRIES:
                await asyncio.sleep(0.5)
    raise AIToolsDecisionError(f"Clefの判定に失敗しました: {last_error}")


async def decide_action(prompt: str, candidates: dict[str, dict[str, Any]]) -> str:
    if not candidates:
        raise AIToolsDecisionError("実行可能な安全な機能がありません。")
    criteria = {"none": "適切な機能がない、引数不足、または安全に判断できない場合"}
    for key, item in candidates.items():
        text = f"{item['genre']} / {item['label']}"
        param_dicts = item.get("params") or []
        if param_dicts:
            # 引数を持つ候補は、その旨と引数名を criteria に含めて Clef に伝える。
            names = "、".join(d.get("label") or d["name"] for d in param_dicts)
            text += f"（引数あり: {names}）"
        criteria[key] = text
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
    # abstain/不正な選択は再試行しても同じ判断コストだけが増えるため、応答の解釈は
    # リトライ対象にしない（従来どおり）。
    data = await _request_decision(payload["state"], payload["questions"])
    selected = _extract_choice(data, "action")
    if selected == "none":
        raise AIToolsNoAction("Clefが実行不要または判断不能と判定しました。")
    if selected not in candidates:
        raise AIToolsDecisionError("Clefが許可されていない機能を選択しました。")
    return selected


# ---------------------------------------------------------------------------
# 引数（params）の抽出と検証
# ---------------------------------------------------------------------------

# 数値引数のローカル抽出で使う、同義語キーワード（依頼文中の表記ゆれ対策）。
_PARAM_KEYWORDS: dict[str, tuple[str, ...]] = {
    "pitch": ("音程", "ピッチ"),
    "buffer_ms": ("バッファ", "目標バッファ"),
    "max_ms": ("上限バッファ", "最大バッファ", "上限", "最大", "最長"),
    "delay": ("遅延", "ディレイ"),
}
_NUMBER_RE = re.compile(r"[+-]?\d+(?:\.\d+)?")
_FULLWIDTH_TABLE = str.maketrans("０１２３４５６７８９．－−", "0123456789.--")
_NUMERIC_TYPES = frozenset({"int", "number", "duration"})


def candidate_spec(item: dict[str, Any]) -> action_registry.ActionSpec | None:
    """候補 dict の params スキーマから、検証用の ActionSpec を組み立てる。

    実在チェックは済んでいる候補だけが渡される前提で、レジストリ本体ではなく
    候補に載っているスキーマを正とする（validate_params に渡すための器）。
    """
    param_dicts = item.get("params") or []
    if not item.get("root") or not item.get("value"):
        return None
    try:
        params = tuple(
            action_registry.ParamSpec(
                name=str(d["name"]),
                label=str(d.get("label") or d["name"]),
                type=str(d["type"]),
                required=bool(d.get("required")),
                default=d.get("default"),
                choices=tuple(tuple(choice) for choice in d.get("choices") or ()),
                min_value=d.get("min_value"),
                max_value=d.get("max_value"),
                help=str(d.get("help") or ""),
            )
            for d in param_dicts
        )
    except (KeyError, TypeError, ValueError):
        return None
    return action_registry.ActionSpec(
        id=f"{item['root']}:{item['value']}",
        root=str(item["root"]),
        value=str(item["value"]),
        label=str(item.get("label") or item["value"]),
        genre="",
        genre_label="",
        params=params,
        risk=str(item.get("risk") or "safe"),
        surfaces=frozenset({"aitools"}),
    )


def clean_params(spec: action_registry.ActionSpec, raw: dict[str, Any] | None) -> dict[str, Any]:
    """抽出値を ParamSpec で検証し、通ったキーだけを残す（不正なキーは落とす）。"""
    if not raw:
        return {}
    cleaned: dict[str, Any] = {}
    for name, value in raw.items():
        try:
            cleaned.update(action_registry.validate_params(spec, {name: value}))
        except ValueError:
            continue
    return cleaned


def validate_params_for(item: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    """候補の引数を ParamSpec で検証する（不正なら ValueError。補完入力の確認用）。"""
    spec = candidate_spec(item)
    if spec is None:
        raise ValueError("引数の定義が見つかりません。")
    return action_registry.validate_params(spec, params)


def _find_numbers(text: str) -> list[tuple[int, int, float]]:
    """(開始位置, 終了位置, 値) の一覧を返す。"""
    found: list[tuple[int, int, float]] = []
    for match in _NUMBER_RE.finditer(text):
        try:
            found.append((match.start(), match.end(), float(match.group())))
        except ValueError:
            continue
    return found


def _local_numeric_params(prompt: str, specs: list[action_registry.ParamSpec]) -> dict[str, Any]:
    """数値引数を依頼文から決定的に拾う（APIは呼ばない）。

    引数名・ラベル・同義語の直後（または直前）にある数値だけを採用する。
    キーワードで特定できない数値は、数値引数が1つだけで文中の数値も1つだけの
    ときに限り採用する。曖昧な場合は何も入れない（推測で埋めない）。
    """
    numeric = [spec for spec in specs if spec.type in _NUMERIC_TYPES]
    if not numeric:
        return {}
    text = (prompt or "").translate(_FULLWIDTH_TABLE)
    numbers = _find_numbers(text)
    if not numbers:
        return {}
    claimed: set[int] = set()
    raw: dict[str, Any] = {}

    def claim_after(pos: int) -> int | None:
        for index, (start, _end, _value) in enumerate(numbers):
            if index not in claimed and pos <= start <= pos + 16:
                return index
        return None

    def claim_before(pos: int) -> int | None:
        for index in range(len(numbers) - 1, -1, -1):
            if index in claimed:
                continue
            _start, end, _value = numbers[index]
            if pos - 12 <= end <= pos:
                return index
        return None

    for spec in numeric:
        keywords = list(_PARAM_KEYWORDS.get(spec.name, ()))
        keywords.append(spec.name)
        label_core = (spec.label or "").split("（")[0].strip()
        if label_core and label_core not in keywords:
            keywords.append(label_core)
        picked: int | None = None
        for keyword in keywords:
            if not keyword:
                continue
            start = 0
            while picked is None:
                pos = text.lower().find(keyword.lower(), start)
                if pos < 0:
                    break
                picked = claim_after(pos + len(keyword))
                if picked is None:
                    picked = claim_before(pos)
                start = pos + len(keyword)
            if picked is not None:
                break
        if picked is not None:
            claimed.add(picked)
            value = numbers[picked][2]
            if spec.type == "int":
                if not float(value).is_integer():
                    continue
                raw[spec.name] = int(value)
            else:
                raw[spec.name] = float(value)
    if len(numeric) == 1 and len(numbers) == 1 and 0 not in claimed:
        spec = numeric[0]
        value = numbers[0][2]
        if spec.type == "int":
            if float(value).is_integer():
                raw[spec.name] = int(value)
        else:
            raw[spec.name] = float(value)
    return raw


def _answer_text(data: dict[str, Any], key: str) -> str | None:
    """decision 応答から key の回答文字列を取り出す（無い・不正なら None）。

    エンベロープ自体が失敗を示している場合は AIToolsDecisionError にする。
    """
    if data.get("success") is False or data.get("errors"):
        raise AIToolsDecisionError("Logfare decision APIが判定に失敗しました。")
    result = data.get("result")
    if isinstance(result, dict):
        data = result
    answers = data.get("answers")
    if not isinstance(answers, dict):
        return None
    answer = answers.get(key)
    if isinstance(answer, str):
        value = answer
    elif isinstance(answer, dict):
        value = answer.get("choice") or answer.get("answer") or answer.get("value")
    else:
        value = None
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower()


async def _decide_choice_params(
    prompt: str,
    item: dict[str, Any],
    specs: list[action_registry.ParamSpec],
) -> dict[str, Any]:
    """choice / bool 引数を、decision API の choice 質問で選ばせる。

    Clef の質問型には自由文抽出がないため、選択肢のある引数だけがこの方式で
    扱える。各引数に「指定がない（none）」を必ず含め、指定がないものを
    推測で埋めないようにする。
    """
    questions: dict[str, Any] = {}
    for spec in specs:
        if spec.type == "bool":
            criteria: dict[str, str] = {
                "true": "オン・有効にする",
                "false": "オフ・無効にする",
                "none": "依頼文に指定がない",
            }
        else:
            criteria = {str(value): str(label) for label, value in spec.choices}
            criteria["none"] = "依頼文に指定がない"
        questions[spec.name] = {
            "type": "choice",
            "instructions": (
                f"ユーザーの依頼文に、機能「{item.get('label') or item.get('value')}」の引数"
                f"「{spec.label}」の指定が含まれていれば、その値を criteria から選んでください。"
                "含まれていない・判断できない場合は none を返してください。"
            ),
            "criteria": criteria,
        }
    state = json.dumps({
        "user_request": prompt,
        "action": f"{item.get('root')}:{item.get('value')}",
        "action_label": item.get("label") or "",
    }, ensure_ascii=False)
    data = await _request_decision(state, questions)
    raw: dict[str, Any] = {}
    for spec in specs:
        answer = _answer_text(data, spec.name)
        if answer is None or answer == "none":
            continue
        if spec.type == "bool":
            if answer == "true":
                raw[spec.name] = True
            elif answer == "false":
                raw[spec.name] = False
            continue
        for _label, value in spec.choices:
            if str(value).lower() == answer:
                raw[spec.name] = value
                break
    return raw


async def extract_params(prompt: str, item: dict[str, Any]) -> dict[str, Any]:
    """選択済みアクションの引数を依頼文から抽出し、検証済みの dict を返す。

    ParamSpec のないアクションでは何もせず {} を返す（decision API の追加
    コールもしない）。数値引数はローカル抽出、choice / bool 引数は choice
    質問で拾い、結果は必ず ParamSpec で検証する（不正値はキーごと落とす）。
    text や ID 系の引数は自動抽出の対象外（不足すれば補完フローに回る）。
    """
    spec = candidate_spec(item)
    if spec is None or not spec.params:
        return {}
    specs = list(spec.params)
    raw: dict[str, Any] = {}
    raw.update(_local_numeric_params(prompt, specs))
    choice_specs = [s for s in specs if s.type in {"choice", "bool"}]
    if choice_specs:
        raw.update(await _decide_choice_params(prompt, item, choice_specs))
    return clean_params(spec, raw)


def missing_required_params(item: dict[str, Any], params: dict[str, Any] | None) -> list[dict[str, Any]]:
    """必須なのに値が入っていない引数のスキーマ一覧を返す。"""
    params = params or {}
    return [
        d for d in item.get("params") or []
        if d.get("required") and d.get("name") not in params
    ]


def format_params_summary(item: dict[str, Any], params: dict[str, Any] | None) -> str:
    """「ラベル: 値、…」形式の引数要約を作る（確認・実行通知用）。"""
    if not params:
        return ""
    labels = {d.get("name"): (d.get("label") or d.get("name")) for d in item.get("params") or []}
    parts = []
    for name, value in params.items():
        parts.append(f"{labels.get(name, name)}: {value}")
    return "、".join(parts)


def requires_confirmation(item: dict[str, Any]) -> bool:
    """risk="confirm" のアクションかどうか（実行前に確認ビューを挟む対象）。"""
    risk = item.get("risk")
    if risk is None:
        spec = action_registry.default_registry().get(f"{item.get('root')}:{item.get('value')}")
        risk = spec.risk if spec is not None else None
    return risk == "confirm"


async def invoke_action(
    bot, message, item: dict[str, Any], *, invoker=None, params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """既存GeneralCogのShortcutMessageInteraction経路を再利用する。

    params があれば ParamSpec で検証した上で item["params"] に載せ、
    execute_shortcut 経由で dispatch に渡す（PR #375 の受け渡し形式）。
    実際に渡した検証済み params を返す。
    """
    # 実行直前の再検証 (E-9): 候補経由でなく直接呼ばれても、レジストリで
    # risk="blocked" の操作と、メッセージ経由で実行できない表示系
    # (MESSAGE_SHORTCUT_BLOCKED) は拒否する。
    action_id = f"{item['root']}:{item['value']}"
    spec = action_registry.default_registry().get(action_id)
    if spec is not None and spec.risk == "blocked":
        raise AIToolsDecisionError("この操作はAI toolsから実行できません。")
    if action_id in action_registry.MESSAGE_SHORTCUT_BLOCKED_IDS:
        raise AIToolsDecisionError("この操作はAI toolsから実行できません。")
    if item["root"] in {"support", "general"} and item["value"] in {"pay", "clear"}:
        raise AIToolsDecisionError("この操作はAI toolsから実行できません。")
    if item["root"] == "general" and item["value"] == "miq_settings":
        raise AIToolsDecisionError("MIQ設定はAI toolsから実行できません。/general から開いてください。")
    general = bot.get_cog("GeneralCog")
    if general is None:
        raise AIToolsDecisionError("機能ディスパッチャーが読み込まれていません。")
    cleaned: dict[str, Any] = {}
    if params:
        spec = action_registry.default_registry().get(f"{item['root']}:{item['value']}")
        if spec is not None and spec.params:
            cleaned = clean_params(spec, params)
    shortcut: dict[str, Any] = {
        "user_id": str(message.author.id),
        "action": {"root": item["root"], "value": item["value"]},
    }
    if cleaned:
        shortcut["params"] = cleaned
    await general.execute_shortcut(message, shortcut, invoker=invoker)
    return cleaned
