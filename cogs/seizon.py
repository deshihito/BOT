"""生存確認（/fujo）機能。

自前DB APIの ``fujo_users``（登録者と設定）と ``fujo_activities``（検知ログ）を使う。
必要な列は ``docs/sql/fujo.sql`` を参照。

- DB API クライアントは同期なので、呼び出しはすべて ``asyncio.to_thread`` で行い、
  Bot 全体が止まらないようにする。
- 検知はユーザーごとに ``RECORD_INTERVAL`` に 1 回までに間引く（オンライン状態の変化は
  サーバーごとに何度も届くため）。
- 登録者は起動後にまとめて読み込み、メモリに持つ。未登録者の発言では DB を触らない。
- 見回りタスクはエラーが出ても止まらない。
- HTTP接続が瞬間的に切断される（``h2.ConnectionTerminated`` 等）ことがあるため、
  検知ログの INSERT は「一時エラー判定 + 指数バックオフ + ジッター + 直列化」で行う
  （``_is_transient_error`` / ``_insert_activity_with_retry``）。
"""
from __future__ import annotations

import asyncio
import logging
import random
from datetime import date, datetime, timedelta, timezone

import discord
from discord import app_commands
from discord.ext import commands, tasks
from core.api_retry import run_with_retry

log = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))
RECORD_INTERVAL = timedelta(minutes=5)
PAGE_SIZE = 1000
FOOTER = "Survival Surveillance System"
USER_COLUMNS = (
    "user_id, streak_count, last_streak_date, is_frozen, last_pester_level, "
    "panic_days, panic_message, panic_channel_id, last_panic_at"
)

# --- INSERT のリトライ / 直列化 ---
# Cloudflare の HTML 400 や、HTTP/2 接続の瞬断 (h2.ConnectionTerminated) など
# 一時的な失敗をリトライする。同時 INSERT は Semaphore で直列化する。
# Semaphore はイベントループ上で遅延生成する (import時生成によるループ不一致を避ける)。
_ACTIVITY_INSERT_SEM: asyncio.Semaphore | None = None
_ACTIVITY_INSERT_MAX_ATTEMPTS = 3
_ACTIVITY_INSERT_BASE_DELAY = 0.5  # 秒(指数バックオフの初項)
_ACTIVITY_INSERT_MAX_DELAY = 4.0   # 秒(バックオフの上限)
_ACTIVITY_INSERT_JITTER = 0.3      # 秒(同時多発リトライの揺らぎ)

# 名前で一時エラーと判定する例外クラス群。
# httpx / h2 / httpcore / socket 等の接続系例外を網羅する。
_TRANSIENT_EXCEPTION_NAMES: frozenset[str] = frozenset({
    # h2
    "ConnectionTerminated",
    "ProtocolError",
    # httpcore / httpx
    "ConnectError",
    "ConnectTimeout",
    "ReadError",
    "ReadTimeout",
    "WriteError",
    "WriteTimeout",
    "PoolTimeout",
    "RemoteProtocolError",
    "LocalProtocolError",
    # asyncio / socket
    "ConnectionResetError",
    "ConnectionAbortedError",
    "BrokenPipeError",
    "ConnectionError",
    "TimeoutError",
})


def _get_insert_sem() -> asyncio.Semaphore:
    global _ACTIVITY_INSERT_SEM
    if _ACTIVITY_INSERT_SEM is None:
        _ACTIVITY_INSERT_SEM = asyncio.Semaphore(2)
    return _ACTIVITY_INSERT_SEM


def _is_gateway_html_error(exc: Exception) -> bool:
    """Cloudflare 等が返す HTML の 400 を検出する。

    postgrest は HTML 応答を JSON パースできず ``JSON could not be generated`` の
    APIError を投げる。``details`` に HTML が入っている／文字列に ``<html>`` と
    ``cloudflare`` が含まれていれば gateway 起因とみなす。
    """
    text = str(exc)
    low = text.lower()
    if "<html" in low and ("cloudflare" in low or "400 bad request" in low):
        return True
    details = getattr(exc, "details", None)
    if isinstance(details, str) and "<html" in details.lower():
        return True
    return False


def _is_transient_error(exc: Exception) -> bool:
    """再試行で解消しうる一時エラーかどうか。

    - Cloudflare の HTML 400（前段 WAF による弾き）
    - HTTP/2 接続の瞬断（``h2.exceptions.ConnectionTerminated`` 等）
    - httpx / httpcore の接続系例外・タイムアウト
    - asyncio / socket の Connection reset 系
    を対象とする。
    """
    if getattr(exc, "code", None) == "API_UNAVAILABLE":
        # 自前APIがDB poolを取得できず、SQL未開始と明示した応答だけ。
        return True
    if _is_gateway_html_error(exc):
        return True
    # 例外クラス名（MRO 全体）で判定
    for cls in type(exc).__mro__:
        if cls.__name__ in _TRANSIENT_EXCEPTION_NAMES:
            return True
    # 文字列フォールバック（ラップされた例外・サードパーティ独自型向け）
    text = str(exc)
    low = text.lower()
    if "connectionterminated" in low or "connection terminated" in low:
        return True
    if "connection reset" in low or "connection aborted" in low:
        return True
    if "remoteprotocolerror" in low or "protocol error" in low:
        return True
    return False


def _parse_ts(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _today() -> date:
    """連続日数は日本時間の日付で数える。"""
    return datetime.now(JST).date()


class FujoSurvival(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.db_api = getattr(bot, "db_api", None)
        if self.db_api is None:
            from core.api_client import get_client
            self.db_api = get_client()
        # user_id -> fujo_users の行（メモリ上の写し）
        self.users: dict[int, dict] = {}
        self.users_loaded = False
        self._load_lock = asyncio.Lock()
        self._last_record: dict[int, datetime] = {}
        # バックグラウンドタスク（INSERT / ストリーク更新）を保持して
        # cog_unload でキャンセルできるようにする。
        self._bg_tasks: set[asyncio.Task] = set()
        self.check_panic_alerts.start()
        self.check_duo_pester.start()

    def cog_unload(self):
        self.check_panic_alerts.cancel()
        self.check_duo_pester.cancel()
        for task in list(self._bg_tasks):
            task.cancel()

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    FUJO_ACTIONS = [
        app_commands.Choice(name="追跡登録・解除", value="register"),
        app_commands.Choice(name="アクティブ頻度", value="hindo"),
        app_commands.Choice(name="ランキング", value="ranking"),
        app_commands.Choice(name="ストリークフリーズ", value="freeze"),
        app_commands.Choice(name="失踪警報を設定", value="panic_set"),
        app_commands.Choice(name="失踪警報を解除", value="panic_disable"),
    ]

    async def fujo(
        self,
        interaction: discord.Interaction,
        action: str,
        target: discord.User | None = None,
        mode: str = "active",
        days: app_commands.Range[int, 1, 365] | None = None,
        message: app_commands.Range[str, 1, 1000] | None = None,
    ):
        if action == "register":
            return await self.register(interaction)
        if action == "hindo":
            return await self.hindo(interaction, target)
        if action == "ranking":
            return await self.ranking(interaction, mode)
        if action == "freeze":
            return await self.freeze(interaction)
        if action == "panic_disable":
            return await self.panic_disable(interaction)
        if action == "panic_set":
            if days is None or not message:
                return await self._reply(
                    interaction,
                    self.create_simple_embed("入力不足", "失踪警報を設定するには days と message が必要です。", 0xe67e22),
                    ephemeral=True,
                )
            return await self.panic_set(interaction, days, message)
        await self._reply(interaction, self.create_simple_embed("操作不明", "指定された操作は利用できません。", 0xe67e22), ephemeral=True)

    # --- DB ヘルパー ---

    async def _run(self, build):
        """``build()`` で組み立てたクエリを別スレッドで実行し、data を返す。"""
        if self.db_api is None:
            raise RuntimeError("BOT_API_BASE_URL または BOT_API_KEY が設定されていません")
        return (await asyncio.to_thread(
            run_with_retry, lambda: build().execute()
        )).data

    async def _insert_activity_with_retry(self, payload: dict) -> bool:
        """fujo_activities への INSERT。一時エラーを検知してリトライする。

        - 同時 INSERT は Semaphore で直列化（Cloudflare 等の短時間レート制限を回避）
        - 一時エラー（HTML 400 / ConnectionTerminated / 接続タイムアウト等）は
          指数バックオフ + ジッターで最大 3 回まで再試行
        - 恒久的な失敗はログを残して諦める（例外は投げない）
        """
        for attempt in range(1, _ACTIVITY_INSERT_MAX_ATTEMPTS + 1):
            try:
                async with _get_insert_sem():
                    await self._run(lambda: self.db_api.table("fujo_activities").insert(payload))
                return True
            except Exception as exc:
                if not _is_transient_error(exc):
                    log.warning(
                        "fujo: activity insert failed: user=%s signal=%s err=%s",
                        payload.get("user_id"), payload.get("signal_type"), str(exc)[:200],
                    )
                    return False
                if attempt >= _ACTIVITY_INSERT_MAX_ATTEMPTS:
                    log.warning(
                        "fujo: activity insert gave up after %d attempts: user=%s signal=%s err=%s",
                        _ACTIVITY_INSERT_MAX_ATTEMPTS, payload.get("user_id"),
                        payload.get("signal_type"), str(exc)[:200],
                    )
                    return False
                base = _ACTIVITY_INSERT_BASE_DELAY * (2 ** (attempt - 1))
                delay = min(base + random.uniform(0, _ACTIVITY_INSERT_JITTER), _ACTIVITY_INSERT_MAX_DELAY)
                log.info(
                    "fujo: activity insert hit transient error (attempt %d/%d), retrying in %.2fs: user=%s err=%s",
                    attempt, _ACTIVITY_INSERT_MAX_ATTEMPTS, delay,
                    payload.get("user_id"), type(exc).__name__,
                )
                await asyncio.sleep(delay)
        return False

    async def _fetch_all(self, build) -> list[dict]:
        """1000 件を超える結果もページを分けて全部読む。"""
        rows: list[dict] = []
        start = 0
        while True:
            page = await self._run(lambda s=start: build().range(s, s + PAGE_SIZE - 1))
            page = page or []
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                return rows
            start += PAGE_SIZE

    async def _ensure_users(self):
        if self.users_loaded:
            return
        async with self._load_lock:
            if self.users_loaded:
                return
            rows = await self._fetch_all(lambda: self.db_api.table("fujo_users").select(USER_COLUMNS))
            self.users = {int(r["user_id"]): r for r in rows}
            self.users_loaded = True

    async def _update_user(self, user_id: int, values: dict):
        await self._run(lambda: self.db_api.table("fujo_users").update(values).eq("user_id", user_id))
        if user_id in self.users:
            self.users[user_id].update(values)

    async def _latest_activity(self, user_id: int) -> dict | None:
        rows = await self._run(
            lambda: self.db_api.table("fujo_activities")
            .select("detected_at, signal_type, status")
            .eq("user_id", user_id)
            .order("detected_at", desc=True)
            .limit(1)
        )
        return rows[0] if rows else None

    async def _activities_since(self, since: datetime, user_id: int | None = None, columns: str = "detected_at") -> list[dict]:
        def build():
            q = self.db_api.table("fujo_activities").select(columns).gte("detected_at", since.isoformat())
            return q.eq("user_id", user_id) if user_id is not None else q
        return await self._fetch_all(build)

    def _name(self, user_id: int) -> str:
        user = self.bot.get_user(user_id)
        return user.display_name if user else f"<@{user_id}>"

    @staticmethod
    def create_simple_embed(title: str, description: str, color: int = 0x2b2d31) -> discord.Embed:
        embed = discord.Embed(title=title, description=description, color=color)
        embed.set_footer(text=FOOTER)
        return embed

    async def _reply(self, interaction: discord.Interaction, embed: discord.Embed, ephemeral: bool = False):
        if interaction.response.is_done():
            await interaction.followup.send(embed=embed, ephemeral=ephemeral)
        else:
            await interaction.response.send_message(embed=embed, ephemeral=ephemeral)

    async def _require_registered(self, interaction: discord.Interaction, user_id: int, self_check: bool) -> bool:
        await self._ensure_users()
        if user_id in self.users:
            return True
        text = "先に `/fujo register` で追跡登録をしてください。" if self_check else f"<@{user_id}> は追跡登録されていません。"
        await self._reply(interaction, self.create_simple_embed("未登録", text, 0x95a5a6), ephemeral=True)
        return False

    async def cog_app_command_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError):
        log.exception("fujo command failed", exc_info=error)
        embed = self.create_simple_embed("エラー", "生存確認のデータを読み書きできませんでした。少し待ってからもう一度試してください。", 0xe74c3c)
        try:
            await self._reply(interaction, embed, ephemeral=True)
        except discord.HTTPException:
            pass

    # --- 検知と連続日数 ---

    async def record_activity(self, user_id: int, signal_type: str, status: str):
        """アクティビティを記録する。

        重い処理（INSERT のリトライやストリーク更新の DB 書き込み）は
        バックグラウンドタスクに切り出し、このメソッドは即座に戻る。
        イベントハンドラ（``on_message`` / ``on_presence_update`` /
        ``on_voice_state_update``）や ``register`` の応答をブロックしない。
        """
        try:
            await self._ensure_users()
            if user_id not in self.users:
                return
            now = datetime.now(timezone.utc)
            last = self._last_record.get(user_id)
            if last and now - last < RECORD_INTERVAL:
                return
            self._last_record[user_id] = now
            self._spawn(self._record_activity_async(user_id, signal_type, status, now))
        except Exception:
            log.warning("fujo: failed to schedule activity record for %s", user_id, exc_info=True)

    async def _record_activity_async(
        self, user_id: int, signal_type: str, status: str, now: datetime
    ):
        # 1) INSERT（失敗してもストリーク更新は続行）
        try:
            await self._insert_activity_with_retry({
                "user_id": user_id,
                "detected_at": now.isoformat(),
                "signal_type": signal_type,
                "status": status,
            })
        except Exception:
            log.warning("fujo: activity insert crashed for %s", user_id, exc_info=True)

        # 2) ストリーク・警報フラグの更新（メモリは即時、DB は別クエリ）
        try:
            user = self.users.get(user_id)
            if user is None:
                return
            today = _today()
            last_str = user.get("last_streak_date")
            last_date = date.fromisoformat(str(last_str)[:10]) if last_str else None
            changes: dict = {}
            if last_date != today:
                streak = user.get("streak_count") or 0
                if last_date is None:
                    new_streak = 1
                elif last_date == today - timedelta(days=1):
                    new_streak = streak + 1
                elif user.get("is_frozen") and last_date == today - timedelta(days=2):
                    new_streak = streak + 1  # フリーズで 1 日分の空白を許す
                else:
                    new_streak = 1
                changes.update(streak_count=new_streak, last_streak_date=today.isoformat(), is_frozen=False)
            if user.get("last_pester_level"):
                changes["last_pester_level"] = 0
            if changes:
                try:
                    await self._update_user(user_id, changes)
                except Exception:
                    log.warning("fujo: streak update failed for %s", user_id, exc_info=True)
        except Exception:
            log.warning("fujo: streak calculation failed for %s", user_id, exc_info=True)

    def calculate_title(self, records: list[dict]) -> str:
        total = len(records)
        if total < 5:
            return "一般サバイバー"
        counts = {"MESSAGE": 0, "VOICE": 0, "PRESENCE": 0}
        night = 0
        for r in records:
            counts[r.get("signal_type")] = counts.get(r.get("signal_type"), 0) + 1
            hour = _parse_ts(r["detected_at"]).astimezone(JST).hour
            if hour >= 23 or hour < 5:
                night += 1
        msg, voice = counts["MESSAGE"], counts["VOICE"]
        if night / total >= 0.35:
            return "夜行性"
        if (msg + voice) / total <= 0.05:
            return "永遠のROMラー"
        if voice / total >= 0.40:
            return "出会い厨"
        if msg / total >= 0.40:
            return "おしゃべりマシン"
        return "一般サバイバー"

    # --- イベントリスナー ---

    @commands.Cog.listener()
    async def on_ready(self):
        await self._preload()

    async def _preload(self):
        try:
            await self._ensure_users()
        except Exception:
            log.exception("fujo: failed to load users")

    @commands.Cog.listener()
    async def on_presence_update(self, before: discord.Member, after: discord.Member):
        if after.bot or after.status == discord.Status.offline or before.status == after.status:
            return
        await self.record_activity(after.id, "PRESENCE", str(after.status))

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot or not message.guild:
            return
        status = str(getattr(message.author, "status", "unknown"))
        await self.record_activity(message.author.id, "MESSAGE", status)

    @commands.Cog.listener()
    async def on_voice_state_update(self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
        if member.bot or after.channel is None:
            return
        await self.record_activity(member.id, "VOICE", str(member.status))

    # --- コマンド ---

    async def register(self, interaction: discord.Interaction):
        user_id = interaction.user.id
        await self._ensure_users()
        if user_id in self.users:
            await self._run(lambda: self.db_api.table("fujo_users").delete().eq("user_id", user_id))
            self.users.pop(user_id, None)
            self._last_record.pop(user_id, None)
            embed = self.create_simple_embed("追跡解除", "生存確認の追跡を解除しました。これまでの記録と設定も消えました。", 0xe74c3c)
        else:
            row = {"user_id": user_id, "streak_count": 0, "is_frozen": False, "last_pester_level": 0}
            await self._run(lambda: self.db_api.table("fujo_users").upsert(row, on_conflict="user_id"))
            self.users[user_id] = dict(row)
            embed = self.create_simple_embed(
                "追跡開始",
                "生存確認の追跡を始めました。発言・通話・オンライン状態から生存を記録します。\n"
                "もう一度 `/fujo register` を実行すると解除できます。",
                0x2ecc71,
            )
            # record_activity は内部でバックグラウンド化されるため、ここでは即座に戻る
            await self.record_activity(user_id, "COMMAND", "online")
        await self._reply(interaction, embed, ephemeral=True)

    async def status(self, interaction: discord.Interaction, target: discord.User | None = None):
        target = target or interaction.user
        embed = await self.status_embed_for(target)
        if embed is None:
            if not await self._require_registered(interaction, target.id, target.id == interaction.user.id):
                return
            return
        await self._reply(interaction, embed)

    async def status_embed_for(self, target: discord.User) -> discord.Embed | None:
        """登録済みユーザーの生存ステータスを埋め込みで返す。"""
        await self._ensure_users()
        if target.id not in self.users:
            return None
        latest = await self._latest_activity(target.id)
        if not latest:
            return self.create_simple_embed("データなし", f"{target.mention} のアクティブ記録はまだありません。", 0x95a5a6)
        records = await self._activities_since(datetime.now(timezone.utc) - timedelta(days=30), target.id, "detected_at, signal_type")
        user = self.users.get(target.id, {})
        streak = user.get("streak_count") or 0
        is_frozen = bool(user.get("is_frozen"))

        dt = _parse_ts(latest["detected_at"])
        hours_passed = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0)
        if hours_passed < 12:
            status_label, color = "良好", 0x2ecc71
        elif hours_passed < 48:
            status_label, color = "注意", 0xf1c40f
        elif hours_passed < 168:
            status_label, color = "警戒", 0xe67e22
        elif hours_passed < 720:
            status_label, color = "霊体化", 0x9b59b6
        else:
            status_label, color = "化石化", 0x34495e

        zombie_rate = min(100, int(hours_passed / (7 * 24) * 100))
        survival_rate = 100 - zombie_rate
        filled = survival_rate // 10
        bar = f"[{'█' * filled}{'░' * (10 - filled)}] {survival_rate}%"
        unix_ts = int(dt.timestamp())

        embed = discord.Embed(title=f"生存ステータス - {target.display_name}", color=color)
        embed.set_thumbnail(url=target.display_avatar.url)
        embed.add_field(name="判定", value=status_label, inline=True)
        embed.add_field(name="称号", value=f"【{self.calculate_title(records)}】", inline=True)
        embed.add_field(name="連続生存日数", value=f"{streak} 日" + ("（フリーズ中）" if is_frozen else ""), inline=True)
        embed.add_field(name="最終アクティブ", value=f"<t:{unix_ts}:R>\n(<t:{unix_ts}:F>)", inline=False)
        embed.add_field(name="生存確率", value=f"`{bar}`", inline=False)
        embed.add_field(name="ゾンビ化率", value=f"{zombie_rate}%", inline=True)
        embed.add_field(name="最後の検知", value=str(latest.get("signal_type") or "-"), inline=True)
        embed.set_footer(text=FOOTER)
        return embed

    async def hindo(self, interaction: discord.Interaction, target: discord.User | None = None):
        target = target or interaction.user
        if not await self._require_registered(interaction, target.id, target.id == interaction.user.id):
            return
        now = datetime.now(timezone.utc)
        records = await self._activities_since(now - timedelta(days=30), target.id)
        if not records:
            await self._reply(interaction, self.create_simple_embed("データなし", f"{target.mention} の過去 30 日の記録はありません。", 0x95a5a6), ephemeral=True)
            return
        ages = [(now - _parse_ts(r["detected_at"])).total_seconds() / 3600 for r in records]
        count_24h = sum(a <= 24 for a in ages)
        count_7d = sum(a <= 24 * 7 for a in ages)
        count_30d = len(records)
        active_days = len({_parse_ts(r["detected_at"]).astimezone(JST).date() for r in records})

        embed = discord.Embed(title=f"アクティブ頻度 - {target.display_name}", color=0x3498db)
        embed.set_thumbnail(url=target.display_avatar.url)
        embed.add_field(name="直近 24 時間", value=f"{count_24h} 回", inline=True)
        embed.add_field(name="直近 7 日", value=f"{count_7d} 回", inline=True)
        embed.add_field(name="直近 30 日", value=f"{count_30d} 回", inline=True)
        embed.add_field(name="30 日のうち姿を見せた日", value=f"{active_days} 日", inline=True)
        embed.add_field(name="1 日平均", value=f"約 {count_30d / 30:.1f} 回", inline=True)
        embed.set_footer(text=f"{FOOTER}（検知は 5 分に 1 回まで数えます）")
        await self._reply(interaction, embed)

    async def ranking(self, interaction: discord.Interaction, mode: str = "active"):
        await interaction.response.defer()
        await self._ensure_users()
        ids = set(self.users)
        if interaction.guild is not None and getattr(interaction.guild, "members", None):
            members = {m.id for m in interaction.guild.members}
            if members:
                ids &= members
        if not ids:
            await self._reply(interaction, self.create_simple_embed("登録者なし", "このサーバーに追跡登録している人がいません。", 0x95a5a6))
            return

        if mode == "fossil":
            latest = await asyncio.gather(*(self._latest_activity(uid) for uid in ids))
            pairs = [(uid, _parse_ts(row["detected_at"])) for uid, row in zip(ids, latest) if row]
            pairs.sort(key=lambda p: p[1])
            lines = [f"{i}. **{self._name(uid)}**: 最終検知 <t:{int(dt.timestamp())}:R>" for i, (uid, dt) in enumerate(pairs[:5], 1)]
            embed = discord.Embed(title="化石ランキング TOP5", color=0x34495e, description="\n".join(lines) or "まだ記録がありません。")
        else:
            rows = await self._fetch_all(
                lambda: self.db_api.table("fujo_activities").select("user_id")
                .gte("detected_at", (datetime.now(timezone.utc) - timedelta(days=30)).isoformat())
                .in_("user_id", list(ids))
            )
            counts: dict[int, int] = {}
            for r in rows:
                counts[int(r["user_id"])] = counts.get(int(r["user_id"]), 0) + 1
            top = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:5]
            lines = [f"{i}. **{self._name(uid)}**: {n} 回" for i, (uid, n) in enumerate(top, 1)]
            embed = discord.Embed(title="アクティブランキング TOP5（30 日）", color=0x2ecc71, description="\n".join(lines) or "過去 30 日の記録がありません。")
        embed.set_footer(text=FOOTER)
        await self._reply(interaction, embed)

    async def freeze(self, interaction: discord.Interaction):
        user_id = interaction.user.id
        if not await self._require_registered(interaction, user_id, True):
            return
        await self._update_user(user_id, {"is_frozen": True})
        embed = self.create_simple_embed(
            "ストリークフリーズ",
            "1 日分の保護をかけました。1 日まるごと姿を見せなくても、連続生存日数は途切れません。\n次に検知されたときに保護は使い切りになります。",
            0x3498db,
        )
        await self._reply(interaction, embed, ephemeral=True)

    async def panic_set(self, interaction: discord.Interaction, days: app_commands.Range[int, 1, 365], message: app_commands.Range[str, 1, 1000]):
        user_id = interaction.user.id
        if not await self._require_registered(interaction, user_id, True):
            return
        await self._update_user(user_id, {
            "panic_days": days,
            "panic_message": message,
            "panic_channel_id": interaction.channel_id,
            "last_panic_at": None,
        })
        embed = self.create_simple_embed(
            "失踪警報を設定しました",
            f"{days} 日間反応がなければ、このチャンネルにメッセージを流します。\n\n> {message}",
            0xf1c40f,
        )
        await self._reply(interaction, embed, ephemeral=True)

    async def panic_disable(self, interaction: discord.Interaction):
        user_id = interaction.user.id
        if not await self._require_registered(interaction, user_id, True):
            return
        await self._update_user(user_id, {"panic_days": None, "panic_message": None, "panic_channel_id": None, "last_panic_at": None})
        await self._reply(interaction, self.create_simple_embed("警報解除", "失踪警報の設定を解除しました。", 0x95a5a6), ephemeral=True)

    # --- 見回り ---

    async def _get_channel(self, channel_id):
        if not channel_id:
            return None
        channel = self.bot.get_channel(int(channel_id))
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(int(channel_id))
            except discord.HTTPException:
                return None
        return channel

    @tasks.loop(minutes=30)
    async def check_panic_alerts(self):
        try:
            await self._ensure_users()
            now = datetime.now(timezone.utc)
            for uid, u in list(self.users.items()):
                if not u.get("panic_days"):
                    continue
                latest = await self._latest_activity(uid)
                if not latest:
                    continue
                last_act = _parse_ts(latest["detected_at"])
                if (now - last_act) < timedelta(days=int(u["panic_days"])):
                    continue
                last_panic = u.get("last_panic_at")
                if last_panic and _parse_ts(str(last_panic)) >= last_act:
                    continue  # この沈黙ではもう発報済み
                channel = await self._get_channel(u.get("panic_channel_id"))
                if channel is None:
                    continue
                embed = discord.Embed(
                    title="失踪警報",
                    description=f"<@{uid}> の反応が {u['panic_days']} 日以上途絶えています。",
                    color=0xc0392b,
                )
                embed.add_field(name="残されたメッセージ", value=f"> {u.get('panic_message') or '（なし）'}", inline=False)
                embed.set_footer(text=f"{FOOTER} - Emergency Alert")
                await channel.send(content=f"<@{uid}>", embed=embed, allowed_mentions=discord.AllowedMentions(users=True))
                await self._update_user(uid, {"last_panic_at": now.isoformat()})
        except Exception:
            log.exception("fujo: panic check failed")

    @tasks.loop(hours=1)
    async def check_duo_pester(self):
        try:
            await self._ensure_users()
            now = datetime.now(timezone.utc)
            for uid, u in list(self.users.items()):
                latest = await self._latest_activity(uid)
                if not latest:
                    continue
                hours = (now - _parse_ts(latest["detected_at"])).total_seconds() / 3600.0
                if hours >= 72:
                    level, text, color = 3, "あなたの存在がログから消えかけています。何か発言してください。", 0x9b59b6
                elif hours >= 48:
                    level, text, color = 2, "このままだと連続生存日数がリセットされます。生存報告をお願いします。", 0xe67e22
                elif hours >= 24:
                    level, text, color = 1, "今日はまだ生存が確認できていません。寂しいです。", 0xf1c40f
                else:
                    continue
                if level <= (u.get("last_pester_level") or 0):
                    continue
                embed = discord.Embed(title="生存督促", description=text, color=color)
                embed.set_footer(text=f"{FOOTER} - Duo Protocol")
                user = self.bot.get_user(uid)
                if user is None:
                    try:
                        user = await self.bot.fetch_user(uid)
                    except discord.HTTPException:
                        user = None
                sent = False
                if user is not None:
                    try:
                        await user.send(embed=embed)
                        sent = True
                    except discord.HTTPException:
                        pass
                if not sent:
                    channel = await self._get_channel(u.get("panic_channel_id"))
                    if channel is not None:
                        await channel.send(content=f"<@{uid}>", embed=embed)
                await self._update_user(uid, {"last_pester_level": level})
        except Exception:
            log.exception("fujo: pester check failed")

    @check_panic_alerts.before_loop
    @check_duo_pester.before_loop
    async def _wait_ready(self):
        await self.bot.wait_until_ready()


async def setup(bot: commands.Bot):
    await bot.add_cog(FujoSurvival(bot))
