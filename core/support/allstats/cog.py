import datetime
import os
import platform
import subprocess
from pathlib import Path
import discord
from discord.ext import commands
import psutil

FIELD_VALUE_LIMIT = 1024  # Discord の Embed フィールド値の上限

# 管理者向けコマンド群 (!logs / !check_api / !terminal 等) と同じ許可リスト。
# all_stats は Pi のスペック・バージョン・ファイル構成・経済プール残高まで
# 出すため、hidden (ヘルプ非表示) だけでは足りず実行自体をゲートする (B-1)。
from core.support.terminal.cog import ALLOWED_USER_IDS  # noqa: F401  正は terminal 側


async def is_all_stats_allowed(ctx: commands.Context) -> bool:
    """ALLOWED_USER_IDS に含まれているユーザーのみ許可するチェック (!logs と同型)。"""
    return ctx.author.id in ALLOWED_USER_IDS


def _limit_field_value(value: str, limit: int = FIELD_VALUE_LIMIT) -> str:
    """Embed フィールド値が上限文字数に収まるよう切り詰める。"""
    if len(value) <= limit:
        return value
    return value[: limit - 1] + "…"


class SystemStatsCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.start_time = datetime.datetime.now(datetime.timezone.utc)

    def _get_git_info(self) -> str:
        try:
            commit_hash = subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"], stderr=subprocess.DEVNULL
            ).decode("utf-8").strip()
            commit_msg = subprocess.check_output(
                ["git", "log", "-1", "--pretty=%s"], stderr=subprocess.DEVNULL
            ).decode("utf-8").strip()
            return f"`{commit_hash}`: {commit_msg}"
        except Exception:
            return "Git情報が取得できませんでした"

    def _get_py_file_tree(self, root_dir: Path = Path("."), ignore_dirs: set = None) -> str:
        if ignore_dirs is None:
            ignore_dirs = {".git", ".venv", "venv", "__pycache__", ".pytest_cache", "env"}

        tree_lines = []

        def build_tree(dir_path: Path, prefix: str = ""):
            entries = [
                e for e in sorted(dir_path.iterdir(), key=lambda x: (not x.is_dir(), x.name))
                if e.name not in ignore_dirs and not e.name.startswith(".")
            ]

            filtered_entries = []
            for entry in entries:
                if entry.is_dir():
                    if any(entry.rglob("*.py")):
                        filtered_entries.append(entry)
                elif entry.suffix == ".py":
                    filtered_entries.append(entry)

            count = len(filtered_entries)
            for idx, entry in enumerate(filtered_entries):
                is_last = (idx == count - 1)
                connector = "└── " if is_last else "├── "

                if entry.is_dir():
                    tree_lines.append(f"{prefix}{connector}{entry.name}/")
                    new_prefix = prefix + ("    " if is_last else "│   ")
                    build_tree(entry, new_prefix)
                else:
                    tree_lines.append(f"{prefix}{connector}{entry.name}")

        build_tree(root_dir)
        tree_text = "\n".join(tree_lines)
        
        if len(tree_text) > 950:
            tree_text = tree_text[:900] + "\n... (省略されました)"

        return f"```\n{tree_text}\n```" if tree_text else "`.py` ファイルが見つかりません"

    @commands.command(name="all_stats", aliases=["stats", "spec"])
    @commands.check(is_all_stats_allowed)
    async def all_stats(self, ctx: commands.Context):
        async with ctx.typing():
            now = datetime.datetime.now(datetime.timezone.utc)
            uptime = now - self.start_time
            hours, remainder = divmod(int(uptime.total_seconds()), 3600)
            minutes, seconds = divmod(remainder, 60)
            days, hours = divmod(hours, 24)
            uptime_str = f"{days}日 {hours}時間 {minutes}分 {seconds}秒"

            ping = round(self.bot.latency * 1000)

            cpu_usage = psutil.cpu_percent(interval=0.5)
            cpu_count = psutil.cpu_count(logical=True)
            mem = psutil.virtual_memory()
            mem_total_gb = round(mem.total / (1024 ** 3), 2)
            mem_used_gb = round(mem.used / (1024 ** 3), 2)

            disk = psutil.disk_usage("/")
            disk_total_gb = round(disk.total / (1024 ** 3), 2)
            disk_free_gb = round(disk.free / (1024 ** 3), 2)

            process = psutil.Process(os.getpid())
            bot_mem_mb = round(process.memory_info().rss / (1024 ** 2), 2)
            bot_cpu_usage = process.cpu_percent(interval=None)

            guild_count = len(self.bot.guilds)
            user_count = sum(g.member_count or 0 for g in self.bot.guilds)
            cog_names = list(self.bot.cogs.keys())
            loaded_cogs = ", ".join(f"`{cog}`" for cog in cog_names) or "なし"

            embed = discord.Embed(
                title="システム＆Bot総合ステータス",
                color=discord.Color.blue(),
                timestamp=now
            )

            embed.add_field(
                name="Bot状態",
                value=(
                    f"**Ping:** `{ping} ms`\n"
                    f"**稼働時間:** `{uptime_str}`\n"
                    f"**Python:** `v{platform.python_version()}` | **discord.py:** `v{discord.__version__}`"
                ),
                inline=False
            )

            embed.add_field(
                name="サーバースペック (全体)",
                value=(
                    f"**OS:** `{platform.system()} {platform.release()}`\n"
                    f"**CPU使用率:** `{cpu_usage}%` ({cpu_count} Cores)\n"
                    f"**RAM:** `{mem_used_gb} GB / {mem_total_gb} GB` ({mem.percent}%)\n"
                    f"**Disk:** `{disk_free_gb} GB 空き / {disk_total_gb} GB` ({disk.percent}%)"
                ),
                inline=True
            )

            embed.add_field(
                name="Botプロセス (単体)",
                value=(
                    f"**メモリ使用量:** `{bot_mem_mb} MB`\n"
                    f"**CPU使用率:** `{bot_cpu_usage}%`"
                ),
                inline=True
            )

            scale_head = (
                f"**参加サーバー数:** `{guild_count}`\n"
                f"**アクセスユーザー数:** `{user_count}`\n"
                f"**読み込み済Cog ({len(cog_names)}件):** "
            )
            scale_value = scale_head + loaded_cogs
            if len(scale_value) > FIELD_VALUE_LIMIT and cog_names:
                # Cog一覧が入りきらない場合は、収まる分だけ並べて残りを件数で示す
                shown: list[str] = []
                best = None
                for name in cog_names:
                    shown.append(name)
                    remaining = len(cog_names) - len(shown)
                    suffix = f" …他{remaining}件" if remaining else ""
                    candidate = scale_head + ", ".join(f"`{n}`" for n in shown) + suffix
                    if len(candidate) > FIELD_VALUE_LIMIT:
                        break
                    best = candidate
                scale_value = best if best is not None else _limit_field_value(scale_value)

            embed.add_field(
                name="Discord接続規模",
                value=scale_value,
                inline=False
            )

            # 経済プール／国庫の残高（管理側で見える形。CirculationCog が
            # 共有ストアを持つ）。未読込・取得失敗時はフィールドごと省略。
            get_cog = getattr(self.bot, "get_cog", None)
            circulation = get_cog("CirculationCog") if get_cog else None
            economy_store = getattr(circulation, "economy_store", None)
            if economy_store is not None:
                try:
                    snapshot = economy_store.snapshot()
                    embed.add_field(
                        name="経済プール",
                        value=(
                            f"**採掘プール:** `{snapshot['pool']:,} AGO`\n"
                            f"**国庫:** `{snapshot['treasury']:,} AGO`\n"
                            f"**還流累計:** `{snapshot['total_recycled']:,} AGO`\n"
                            f"**国庫からの還流累計:** "
                            f"`{snapshot.get('total_released', 0):,} AGO`"
                        ),
                        inline=False
                    )
                except Exception:
                    pass

            embed.add_field(
                name="最新Gitコミット",
                value=_limit_field_value(self._get_git_info()),
                inline=False
            )

            embed.add_field(
                name="プロジェクト .py ファイル構成",
                value=_limit_field_value(self._get_py_file_tree()),
                inline=False
            )

            embed.set_footer(text=f"Requested by {ctx.author}", icon_url=ctx.author.display_avatar.url)

            await ctx.send(embed=embed)

    @all_stats.error
    async def all_stats_error(self, ctx: commands.Context, error: commands.CommandError):
        """権限外の実行にはその旨だけ返す (!logs のエラーハンドラと同型)。"""
        if isinstance(error, commands.CheckFailure):
            try:
                await ctx.send("❌ このコマンドは許可されたユーザーのみ使用できます。")
            except Exception:
                pass
            return
        try:
            await ctx.send("❌ ステータス取得中にエラーが発生しました。")
        except Exception:
            pass

async def setup(bot: commands.Bot):
    await bot.add_cog(SystemStatsCog(bot))
