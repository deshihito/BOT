"""全コマンドのカタログ（JSON）を書き出す。Discord・DB API・外部サービスには接続しない。

    python -m tools.export_commands              # 標準出力へ
    python -m tools.export_commands -o commands.json

cogs/ の拡張をすべて、テストと同じようにオフラインで読み込み（ダミーのキー、ネットワークと
外部コマンドの起動は禁止、作業フォルダは一時フォルダ）、core.command_catalog で JSON にする。
読み込み中に cog が出すログは標準エラーへ回すので、標準出力には JSON だけが出る。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DUMMY_ENV = {
    "BOT_API_BASE_URL": "http://127.0.0.1:8787",
    "BOT_API_KEY": "dummy-key",
    "GROQ_API_KEY": "dummy-key",
    "GEMINI_API_KEY": "dummy-key",
}
# ラズパイにだけ入っているライブラリを使う cog（無ければ読み込まない）
OPTIONAL_COGS = {"judgement": "needle"}
# cog が読み込み時に参照するファイル（一時フォルダにリンクする）
SHARED_FILES = ("Assets", "assets", "font.ttf", "model", "global_channels.json")


class OfflineDBAPI:
    """どんな呼び出しにも自分を返し、execute() で空の結果を返すオフラインDB API。"""

    def __getattr__(self, name):
        return self

    def __call__(self, *args, **kwargs):
        return self

    def execute(self):
        return _Result()


class _Result:
    data: list = []
    count = 0


def _blocked(*args, **kwargs):
    raise OSError("export_commands: network and subprocesses are disabled")


async def _no_process(*args, **kwargs):
    raise OSError("export_commands: subprocesses are disabled")


@contextlib.contextmanager
def offline_environment():
    """ダミーのキー・ネットワーク禁止・一時フォルダの中で実行する。"""
    for name, value in DUMMY_ENV.items():
        os.environ.setdefault(name, value)
    offline = OfflineDBAPI()
    previous_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as work, contextlib.ExitStack() as stack:
        for name in SHARED_FILES:
            if (ROOT / name).exists():
                (Path(work) / name).symlink_to(ROOT / name, target_is_directory=(ROOT / name).is_dir())
        import config
        from core.support import api_client
        stack.enter_context(patch.object(api_client, "get_client", lambda: offline))
        stack.enter_context(patch.object(config, "db_api", offline))
        for target, name, value in (
            (socket.socket, "connect", _blocked),
            (socket, "create_connection", _blocked),
            (socket, "getaddrinfo", _blocked),
            (subprocess.Popen, "_execute_child", _blocked),
            (asyncio, "create_subprocess_exec", _no_process),
            (asyncio, "create_subprocess_shell", _no_process),
        ):
            stack.enter_context(patch.object(target, name, value))
        os.chdir(work)
        try:
            yield
        finally:
            os.chdir(previous_cwd)


async def load_offline_bot():
    """全 cog を読み込んだ Bot を返す（offline_environment の中で呼ぶ）。(bot, 読み込まなかった cog) を返す。"""
    import discord
    from discord.ext import commands

    bot = commands.Bot(command_prefix="!", intents=discord.Intents.none())
    bot.db_api = OfflineDBAPI()
    bot.loop = asyncio.get_running_loop()

    async def never_ready():
        raise asyncio.CancelledError

    bot.wait_until_ready = never_ready
    skipped = {}
    for name in sorted(os.listdir(ROOT / "cogs")):
        if not name.endswith(".py") or name.startswith("__"):
            continue
        module = name[:-3]
        optional = OPTIONAL_COGS.get(module)
        if optional and importlib.util.find_spec(optional) is None:
            skipped[module] = optional
            continue
        with contextlib.redirect_stdout(sys.stderr):
            await bot.load_extension(f"cogs.{module}")
        # 集約入口は機能単位で読み込みを分離するため、拡張の読み込み成功
        # だけでは全機能が揃ったことにならない。欠けた機能がある状態で
        # カタログを書き出すとコマンドが silently 欠落するので、ここで落とす。
        failed = getattr(sys.modules.get(f"cogs.{module}"), "FAILED_FEATURES", None)
        if failed:
            raise RuntimeError(f"cogs.{module}: 読み込めなかった機能があります: {failed}")
    return bot, skipped


def export_catalog() -> dict:
    from core.command_catalog import build_catalog

    async def run():
        bot, _ = await load_offline_bot()
        catalog = build_catalog(bot)
        for task in asyncio.all_tasks():
            if task is not asyncio.current_task():
                task.cancel()
        return catalog

    with offline_environment():
        return asyncio.run(run())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="全コマンドのカタログを JSON で書き出します。")
    parser.add_argument("-o", "--output", help="書き出すファイル（省略すると標準出力）")
    args = parser.parse_args(argv)
    output = Path(args.output).resolve() if args.output else None  # 一時フォルダに移る前に決める
    catalog = export_catalog()
    text = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
    if output:
        output.write_text(text, encoding="utf-8")
        print(f"{len(catalog['commands'])} 件のコマンドを {output} に書き出しました。", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
