"""OmniRush CLIを限定的なチャット経路として呼び出す。"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import shutil
import tempfile

DEFAULT_CLI_TIMEOUT_SECONDS = 300
MIN_CLI_TIMEOUT_SECONDS = 30
MAX_CLI_TIMEOUT_SECONDS = 600
MAX_PROMPT_CHARS = 32_000

# OmniRush公式CLIで案内されているモデルのみ。Astraは公式既定モデル。
MODEL_CHOICES = (
    {"id": "omnirush::gpt-6-astra", "name": "OmniRush · GPT 6 Astra"},
    {"id": "omnirush::gpt-6.1-sol", "name": "OmniRush · GPT 6.1 Sol"},
    {"id": "omnirush::gpt-6-sol", "name": "OmniRush · GPT 6 Sol"},
)
MODEL_IDS = {
    "omnirush::gpt-6-astra": None,  # OmniRushの公式既定モデル
    "omnirush::gpt-6.1-sol": "gpt-6.1-sol",
    "omnirush::gpt-6-sol": "gpt-6-sol",
}
MODEL_NAMES = {item["id"]: item["name"].split(" · ", 1)[1] for item in MODEL_CHOICES}
REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
_SYSTEM_INSTRUCTION = (
    "あなたはDiscord上の質問に答える日本語アシスタントです。簡潔かつ正確に回答してください。"
    "これは通常のチャットです。ファイルを読んだり変更したりせず、コマンドやツールを実行せず、"
    "質問文に直接回答してください。"
)
_request_lock = asyncio.Lock()


class OmniRushError(RuntimeError):
    """OmniRush CLI呼び出しの安全なエラー。"""


class OmniRushUnavailable(OmniRushError):
    """CLIが見つからない。"""


class OmniRushLoginRequired(OmniRushError):
    """Bot実行ユーザーのCLIが未ログイン。"""


class OmniRushBusy(OmniRushError):
    """共有アカウントの別リクエストを処理中。"""


def cli_path() -> str | None:
    """PATH、明示設定、nvmのユーザー領域からCLIを探す。"""
    configured = os.getenv("OMNIRUSH_CLI_PATH", "").strip()
    if configured:
        expanded = os.path.abspath(os.path.expanduser(configured))
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded
        found = shutil.which(configured)
        if found:
            return found
        return None

    found = shutil.which("omnirush")
    if found:
        return found

    nvm_root = Path.home() / ".nvm" / "versions" / "node"
    candidates = [path for path in nvm_root.glob("*/bin/omnirush")
                  if path.is_file() and os.access(path, os.X_OK)]
    if not candidates:
        return None
    return str(max(candidates, key=lambda path: path.stat().st_mtime))


def model_choices() -> list[dict[str, str]]:
    """OmniRushがこのBot実行ユーザーから利用できる時だけ選択肢を返す。"""
    return [dict(item) for item in MODEL_CHOICES] if cli_path() else []


def supports_reasoning_efforts(model_id: str) -> list[str]:
    return REASONING_EFFORTS.copy() if model_id in MODEL_IDS else []


def model_name(model_id: str | None) -> str:
    return MODEL_NAMES.get(model_id or "", "OmniRush")


def cli_timeout_seconds() -> int:
    """`.env` で指定されたCLI待機時間を安全な範囲へ丸める。"""
    try:
        configured = int(os.getenv("OMNIRUSH_TIMEOUT_SECONDS", ""))
    except (TypeError, ValueError):
        return DEFAULT_CLI_TIMEOUT_SECONDS
    return max(MIN_CLI_TIMEOUT_SECONDS, min(MAX_CLI_TIMEOUT_SECONDS, configured))


async def chat(model_id: str, prompt: str, *, reasoning_effort: str | None = None) -> str:
    """一時ディレクトリと最小環境で、許可済みモデルを一度だけ呼び出す。"""
    if model_id not in MODEL_IDS:
        raise OmniRushError("選択されたOmniRushモデルは許可リストにありません。")
    prompt = prompt.replace("\x00", " ")
    if not prompt.strip():
        raise OmniRushError("質問内容が空です。")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise OmniRushError("OmniRushへ送る質問は32,000文字までです。")
    executable = cli_path()
    if not executable:
        raise OmniRushUnavailable("OmniRush CLIが見つかりません。")
    if _request_lock.locked():
        raise OmniRushBusy("OmniRushの別リクエストを処理中です。少し待ってから再試行してください。")

    cli_model = MODEL_IDS[model_id]
    args = [executable, "--permissions", "careful"]
    if cli_model:
        args.extend(["--model", cli_model])
    if reasoning_effort in REASONING_EFFORTS:
        args.extend(["--thinking", reasoning_effort])
    args.extend(["--print", f"{_SYSTEM_INSTRUCTION}\n\nユーザーの質問:\n{prompt}"])

    # BotのAPIキーやDB資格情報をCLIとその子プロセスへ継承しない。
    home = str(Path.home())
    safe_path = os.pathsep.join(dict.fromkeys([
        str(Path(executable).parent), "/usr/local/bin", "/usr/bin", "/bin",
    ]))
    child_env = {
        "HOME": home,
        "PATH": safe_path,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    timeout_seconds = cli_timeout_seconds()

    async with _request_lock:
        with tempfile.TemporaryDirectory(prefix="bot-omnirush-") as workdir:
            try:
                process = await asyncio.create_subprocess_exec(
                    *args,
                    cwd=workdir,
                    env=child_env,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=timeout_seconds
                )
            except asyncio.TimeoutError as exc:
                if "process" in locals() and process.returncode is None:
                    process.kill()
                    await process.communicate()
                raise OmniRushError(
                    f"OmniRushの応答が{timeout_seconds}秒以内に完了しませんでした。"
                ) from exc
            except asyncio.CancelledError:
                if "process" in locals() and process.returncode is None:
                    process.kill()
                    await process.communicate()
                raise
            except OSError as exc:
                raise OmniRushUnavailable("OmniRush CLIを起動できませんでした。") from exc

    answer = stdout.decode("utf-8", errors="replace").strip()
    error_text = (stderr + stdout).decode("utf-8", errors="replace").lower()
    if process.returncode != 0:
        if any(token in error_text for token in ("login", "log in", "sign in", "unauthoriz", "authenticat")):
            raise OmniRushLoginRequired("OmniRush CLIのログインが必要です。")
        if any(token in error_text for token in ("unknown model", "invalid model", "model not found", "model unavailable")):
            raise OmniRushError("選択したOmniRushモデルを利用できません。モデル一覧を開き直してください。")
        raise OmniRushError("OmniRush CLIがエラーを返しました。")
    if not answer:
        raise OmniRushError("OmniRush CLIから空の回答が返りました。")
    return answer
