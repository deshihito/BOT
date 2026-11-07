# -*- coding: utf-8 -*-
"""Discord Quest 通知の取得・UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *
from .common import _support_int
from .sns import SnsError, parse_rss_feed, sns_epoch
from core.support.emojis import FAILED


# ===== Discord Quest 通知 ==============================================
QUEST_SECTION = "quest_notify"
QUEST_MAX_SEEN = 2000  # 安全弁。通常は「現在も有効なQuestのID」だけを保持するので小さく収まる
QUEST_MAX_SEND_PER_CYCLE = 5
QUEST_MAX_BODY = 16 * 1024 * 1024  # 全Questの履歴を含むため大きい（2MB超を確認済み）
QUEST_POLL_SECONDS = 900  # 確認間隔（秒）
QUEST_USER_AGENT = "SupportBot-QuestNotifier/1.0"
_ORBS_RE = re.compile(r"\borbs?\b", re.I)


QUEST_FEED_URL = "https://api.discordquest.com/api/quests"
QUEST_REGIONS_URL = "https://api.discordquest.com/api/regions"

# ギルドの言語 → 通知対象にする国・地域（ISO 3166-1 alpha-2）。
# Questは国ごとに提供有無が違う。いずれかの国で提供されているQuestだけ通知する。
QUEST_LANGUAGE_COUNTRIES: dict[str, frozenset[str]] = {
    k: frozenset(v.split())
    for k, v in {
        "ja": "JP", "ko": "KR", "zh": "CN TW HK", "zh-cn": "CN", "zh-tw": "TW HK",
        "en": "US GB CA AU NZ IE", "en-us": "US", "en-gb": "GB",
        "fr": "FR BE CH CA", "de": "DE AT CH", "it": "IT", "nl": "NL",
        "es": "ES MX AR CL CO", "es-es": "ES", "es-419": "MX AR CL CO",
        "pt": "BR PT", "pt-br": "BR", "ru": "RU", "uk": "UA", "pl": "PL",
        "tr": "TR", "id": "ID", "th": "TH", "vi": "VN", "hi": "IN",
        "sv": "SE", "sv-se": "SE", "da": "DK", "fi": "FI", "no": "NO",
        "cs": "CZ", "hu": "HU", "el": "GR", "ro": "RO", "bg": "BG",
        "hr": "HR", "lt": "LT", "ar": "SA AE EG",
    }.items()
}
_QUEST_LANG_RE = re.compile(r"[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?")
QUEST_LANG_SECTIONS = ("language", "localization", "locale", "lang")
QUEST_LANG_KEYS = ("language", "locale", "lang", "code", "value")


def quest_language_countries(language: str | None) -> frozenset[str]:
    """言語コード（ja / en-US / zh_TW など）を国コード集合にする。不明なら空集合。"""
    code = str(language or "").strip().lower().replace("_", "-")
    if not _QUEST_LANG_RE.fullmatch(code):
        return frozenset()
    return QUEST_LANGUAGE_COUNTRIES.get(code) or QUEST_LANGUAGE_COUNTRIES.get(code.split("-")[0], frozenset())


@dataclass(frozen=True)
class QuestRegion:
    include: frozenset[str] = frozenset()
    exclude: frozenset[str] = frozenset()
    is_global: bool = False

    def available_in(self, countries: frozenset[str]) -> bool:
        """countries のいずれかで提供されるか。提供範囲が不明なQuestは除外しない。"""
        if not self.include and not self.exclude and not self.is_global:
            return True
        return any(
            c not in self.exclude and (not self.include or c in self.include)
            for c in countries
        )


def _quest_country(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    code = value.strip().upper()
    return "GB" if code == "UK" else code


def parse_quest_regions(data: bytes) -> dict[str, QuestRegion]:
    """/api/regions を {quest_id: QuestRegion} にする。"""
    try:
        payload = json.loads(data.removeprefix(b"\xef\xbb\xbf"))
    except ValueError as exc:
        raise QuestError(f"リージョン情報のJSONを解析できませんでした（{exc}）。") from exc
    rows = payload.get("quests") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise QuestError("リージョン情報の形式を認識できませんでした。")

    result: dict[str, QuestRegion] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        raw_id = row.get("id")
        if isinstance(raw_id, bool) or not isinstance(raw_id, (str, int)) or not str(raw_id).strip():
            continue
        regions = row.get("regions")
        if isinstance(regions, list):
            include, exclude = regions, []
        elif isinstance(regions, dict):
            include, exclude = regions.get("include") or [], regions.get("exclude") or []
        else:
            include, exclude = [], []
        result[str(raw_id).strip()[:100]] = QuestRegion(
            include=frozenset(filter(None, map(_quest_country, include if isinstance(include, list) else []))),
            exclude=frozenset(filter(None, map(_quest_country, exclude if isinstance(exclude, list) else []))),
            is_global=row.get("is_global") is True,
        )
    return result


def _quest_feed_url() -> str:
    url = QUEST_FEED_URL.strip()
    return url if urlparse(url).scheme in {"http", "https"} else ""


def _quest_http_url(value) -> str | None:
    if isinstance(value, str) and urlparse(value.strip()).scheme in {"http", "https"}:
        return value.strip()[:500]
    return None


class QuestError(Exception):
    """管理者にそのまま見せてよい取得・設定エラー。"""


@dataclass
class QuestItem:
    id: str
    title: str
    url: str = ""
    reward: str = ""
    reward_type: str = ""
    game: str = ""
    ends_at: str | None = None
    image: str | None = None

    @property
    def is_orbs(self) -> bool:
        return bool(_ORBS_RE.search(f"{self.reward_type} {self.reward} {self.title}"))


def _quest_from_discord(row: dict) -> "QuestItem | None":
    cfg = row.get("config") if isinstance(row.get("config"), dict) else row
    raw_id = row.get("id") or cfg.get("id")
    if isinstance(raw_id, bool) or not isinstance(raw_id, (str, int)) or not str(raw_id).strip():
        return None
    if row.get("preview") is True:
        return None
    features = cfg.get("features")
    if isinstance(features, list) and 21 in features:
        return None

    msgs = cfg.get("messages") if isinstance(cfg.get("messages"), dict) else {}
    rewards_cfg = cfg.get("rewards_config") if isinstance(cfg.get("rewards_config"), dict) else {}
    rewards = [r for r in (rewards_cfg.get("rewards") or []) if isinstance(r, dict)]

    orbs = 0
    names: list[str] = []
    reward_type = ""
    for r in rewards:
        qty = r.get("orb_quantity")
        if r.get("type") == 4 or (isinstance(qty, int) and not isinstance(qty, bool) and qty > 0):
            reward_type = "orbs"
            if isinstance(qty, int) and not isinstance(qty, bool):
                orbs = max(orbs, qty)
        elif not reward_type and r.get("type") is not None:
            reward_type = str(r.get("type"))
        r_msgs = r.get("messages") if isinstance(r.get("messages"), dict) else {}
        if r_msgs.get("name"):
            names.append(str(r_msgs["name"]))

    parts = ([f"{orbs:,} Orbs"] if orbs else []) + [n for n in names if not (orbs and "orb" in n.lower())]
    cta = cfg.get("cta_config") if isinstance(cfg.get("cta_config"), dict) else {}
    return QuestItem(
        id=str(raw_id).strip()[:100],
        title=str(msgs.get("quest_name") or "").strip()[:200],
        url=_quest_http_url(cta.get("link")) or "",
        reward=", ".join(parts)[:100],
        reward_type=reward_type,
        game=str(msgs.get("game_title") or "").strip()[:100],
        ends_at=str(cfg["expires_at"]) if cfg.get("expires_at") else None,
    )


def parse_quest_feed(data: bytes) -> list[QuestItem]:
    data = data.removeprefix(b"\xef\xbb\xbf")  # UTF-8 BOM
    if data.lstrip()[:1] in (b"{", b"["):
        try:
            payload = json.loads(data)
        except ValueError as exc:
            logger.warning(
                "QuestフィードのJSON解析に失敗: %s (size=%d, head=%r, tail=%r)",
                exc, len(data), data[:80], data[-80:],
            )
            raise QuestError(
                f"フィードのJSONを解析できませんでした（{len(data):,}バイト受信: {exc}）。"
            ) from exc
        rows = payload
        if isinstance(payload, dict):
            for key in ("quests", "data", "items", "results"):
                if isinstance(payload.get(key), list):
                    rows = payload[key]
                    break
            else:
                vals = list(payload.values())
                rows = vals if vals and all(isinstance(v, dict) for v in vals) else None
        if not isinstance(rows, list):
            raise QuestError('JSONは配列、または {"quests": [...]} の形式にしてください。')

        items: list[QuestItem] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if (
                isinstance(row.get("config"), dict)
                or "rewards_config" in row
                or isinstance(row.get("messages"), dict)  # フラット形式 {id, expires_at, messages, ...}
            ):
                converted = _quest_from_discord(row)
                if converted is not None:
                    items.append(converted)
                continue
            raw_id = row.get("id")
            if isinstance(raw_id, bool) or not isinstance(raw_id, (str, int)) or not str(raw_id).strip():
                continue
            items.append(
                QuestItem(
                    id=str(raw_id).strip()[:100],
                    title=str(row.get("title") or row.get("name") or row.get("quest_name") or "").strip()[:200],
                    url=_quest_http_url(row.get("url")) or "",
                    reward=str(row.get("reward") or "").strip()[:100],
                    reward_type=str(row.get("reward_type") or "").strip()[:30],
                    game=str(row.get("game") or "").strip()[:100],
                    ends_at=str(row["ends_at"]) if row.get("ends_at") else None,
                    image=_quest_http_url(row.get("image")),
                )
            )
        if rows and not items:
            sample = next((r for r in rows if isinstance(r, dict)), None)
            keys = ", ".join(list(sample)[:12]) if sample else "?"
            raise QuestError(f"Questの形式を認識できませんでした（先頭項目のキー: {keys}）。")
        return items

    try:
        _, rss_items = parse_rss_feed(data)
    except SnsError as exc:
        raise QuestError("フィードを解析できませんでした（JSONまたはRSS 2.0に対応）。") from exc
    return [
        QuestItem(
            id=i.id[:100],
            title=(i.title.splitlines() or [""])[0][:200],
            url=_quest_http_url(i.url) or "",
        )
        for i in rss_items
    ]


class QuestFetcher:
    def __init__(self, session: aiohttp.ClientSession):
        self.session = session
        self._etag: str | None = None
        self._last_modified: str | None = None
        self._items: list[QuestItem] = []
        self.regions: dict[str, QuestRegion] = {}
        self._regions_etag: str | None = None
        self._next_allowed = 0.0
        self._failures = 0
        self.last_ok: float | None = None
        self.last_error: str | None = None

    def _defer(self, seconds: float) -> None:
        self._next_allowed = time.monotonic() + seconds * random.uniform(1.0, 1.3)

    def _fail(self, message: str, retry_after: float | None = None) -> QuestError:
        self._failures += 1
        delay = retry_after if retry_after else min(3600, QUEST_POLL_SECONDS * (2 ** self._failures))
        self._defer(max(delay, QUEST_POLL_SECONDS))
        self.last_error = message
        return QuestError(message)

    async def fetch(self) -> list[QuestItem]:
        url = _quest_feed_url()
        if not url:
            raise QuestError("QUEST_FEED_URL のURLが不正です。")
        if time.monotonic() < self._next_allowed:
            return list(self._items)

        headers = {
            "User-Agent": QUEST_USER_AGENT,
            "Accept": "application/json, application/rss+xml;q=0.9, */*;q=0.1",
        }
        if self._etag:
            headers["If-None-Match"] = self._etag
        if self._last_modified:
            headers["If-Modified-Since"] = self._last_modified

        try:
            async with self.session.get(url, headers=headers) as resp:
                if resp.status == 304:
                    body = None
                elif resp.status == 200:
                    # StreamReader.read(n) は「最大nバイト」しか保証せず、受信済み分だけ返すため
                    # 大きなJSONが途中で切れる。EOFまでチャンクで読み切る。
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in resp.content.iter_chunked(64 * 1024):
                        size += len(chunk)
                        if size > QUEST_MAX_BODY:
                            raise self._fail(
                                f"フィードが大きすぎます（{QUEST_MAX_BODY // 1024 // 1024}MB超）。"
                            )
                        chunks.append(chunk)
                    body = b"".join(chunks)
                elif resp.status in (429, 503):
                    try:
                        retry_after = float(resp.headers.get("Retry-After", ""))
                    except ValueError:
                        retry_after = None
                    raise self._fail(f"取得元が混雑しています（HTTP {resp.status}）。", retry_after)
                else:
                    raise self._fail(f"フィードの取得に失敗しました（HTTP {resp.status}）。")
                etag = resp.headers.get("ETag")
                modified = resp.headers.get("Last-Modified")
        except QuestError:
            raise
        except asyncio.TimeoutError as exc:
            raise self._fail("通信がタイムアウトしました。") from exc
        except aiohttp.ClientError as exc:
            raise self._fail(f"通信に失敗しました（{type(exc).__name__}）。") from exc

        if body is not None:
            try:
                self._items = await asyncio.to_thread(parse_quest_feed, body)
            except QuestError as exc:
                raise self._fail(str(exc)) from exc
            self._etag, self._last_modified = etag, modified

        self._failures = 0
        self.last_error = None
        self.last_ok = time.time()
        await self._fetch_regions()
        return list(self._items)

    async def _fetch_regions(self) -> None:
        """国別の提供情報。失敗してもQuest通知自体は止めず、前回の取得分を使い続ける。"""
        headers = {"User-Agent": QUEST_USER_AGENT, "Accept": "application/json"}
        if self._regions_etag and self.regions:
            headers["If-None-Match"] = self._regions_etag
        try:
            async with self.session.get(QUEST_REGIONS_URL, headers=headers) as resp:
                if resp.status == 304:
                    return
                if resp.status != 200:
                    logger.warning("Questリージョン情報の取得に失敗（HTTP %s）", resp.status)
                    return
                chunks: list[bytes] = []
                size = 0
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    size += len(chunk)
                    if size > QUEST_MAX_BODY:
                        logger.warning("Questリージョン情報が大きすぎます")
                        return
                    chunks.append(chunk)
                etag = resp.headers.get("ETag")
            self.regions = await asyncio.to_thread(parse_quest_regions, b"".join(chunks))
            self._regions_etag = etag
        except QuestError as exc:
            logger.warning("Questリージョン情報の解析に失敗: %s", exc)
        except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
            logger.warning("Questリージョン情報の取得に失敗（%s）", type(exc).__name__)


def get_quest_settings(store, guild_id: int) -> dict:
    raw = store.get(guild_id, QUEST_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    raw_seen = raw.get("seen")
    seen = (
        [str(s) for s in raw_seen if isinstance(s, (str, int)) and not isinstance(s, bool)][-QUEST_MAX_SEEN:]
        if isinstance(raw_seen, list)
        else []
    )
    return {
        "enabled": raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False,
        "channel_id": _support_int(raw.get("channel_id")),
        "role_id": _support_int(raw.get("role_id")),
        "orbs_only": raw.get("orbs_only") if isinstance(raw.get("orbs_only"), bool) else False,
        "primed": raw.get("primed") is True,
        "seen": seen,
    }


class QuestNotifyMessage(discord.ui.LayoutView):
    """チャンネルに投稿するQuest通知（Components V2）。"""

    def __init__(self, item: QuestItem, role_id: int | None = None):
        super().__init__(timeout=None)
        children: list[discord.ui.Item] = []

        if role_id:
            children.append(discord.ui.TextDisplay(f"<@&{role_id}>"))
        children.append(discord.ui.TextDisplay("### 🎯 新しい Discord Quest"))

        title = discord.utils.escape_markdown(item.title)[:200] or "(タイトルなし)"
        lines = [f"**{title}**"]
        if item.game:
            lines.append(f"ゲーム: {discord.utils.escape_markdown(item.game)}")
        if item.reward:
            lines.append(f"報酬: {discord.utils.escape_markdown(item.reward)}")
        stamp = sns_epoch(item.ends_at)
        if stamp:
            lines.append(f"期限: <t:{stamp}:f>（<t:{stamp}:R>）")
        children.append(discord.ui.TextDisplay("\n".join(lines)))

        if item.image:
            children.append(discord.ui.MediaGallery(discord.MediaGalleryItem(item.image)))

        if item.url:
            children.append(discord.ui.Separator())
            children.append(
                discord.ui.ActionRow(
                    discord.ui.Button(label="詳細を開く", style=discord.ButtonStyle.link, url=item.url)
                )
            )

        self.add_item(discord.ui.Container(*children, accent_colour=0x5865F2))


class QuestChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "QuestNotifyPanel"):
        self.parent_view = parent
        channel_id = parent.settings.get("channel_id")
        super().__init__(
            placeholder="Quest通知を送るテキストチャンネルを選択",
            channel_types=[discord.ChannelType.text, discord.ChannelType.news],
            min_values=1,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=channel_id, type=discord.SelectDefaultValueType.channel)]
                if channel_id
                else []
            ),
        )

    async def callback(self, interaction: discord.Interaction):
        await self.parent_view.save(interaction, "送信先を設定しました。", channel_id=self.values[0].id)


class QuestRoleSelect(discord.ui.RoleSelect):
    def __init__(self, parent: "QuestNotifyPanel"):
        self.parent_view = parent
        role_id = parent.settings.get("role_id")
        super().__init__(
            placeholder="メンションするロール（任意・解除は選択を外す）",
            min_values=0,
            max_values=1,
            default_values=(
                [discord.SelectDefaultValue(id=role_id, type=discord.SelectDefaultValueType.role)]
                if role_id
                else []
            ),
        )

    async def callback(self, interaction: discord.Interaction):
        role = self.values[0] if self.values else None
        if role is not None and (role.is_default() or role.managed):
            return await interaction.response.send_message(
                "@everyone や連携サービス用のロールは指定できません。",
                ephemeral=True,
            )
        await self.parent_view.save(
            interaction,
            "メンション先を設定しました。" if role else "メンションを解除しました。",
            role_id=role.id if role else None,
        )


class QuestToggleButton(discord.ui.Button):
    def __init__(self, parent: "QuestNotifyPanel"):
        self.parent_view = parent
        enabled = parent.settings["enabled"]
        super().__init__(
            label="通知をオフにする" if enabled else "通知をオンにする",
            style=discord.ButtonStyle.secondary if enabled else discord.ButtonStyle.success,
        )

    async def callback(self, interaction: discord.Interaction):
        settings = self.parent_view.settings
        enabled = not settings["enabled"]
        if enabled and not settings.get("channel_id"):
            return await interaction.response.send_message(
                "先に通知を送るテキストチャンネルを選択してください。",
                ephemeral=True,
            )
        values: dict = {"enabled": enabled}
        if enabled:
            values["primed"] = False
        await self.parent_view.save(
            interaction,
            f"通知を{'オン' if enabled else 'オフ'}にしました。",
            **values,
        )


class QuestOrbsOnlyButton(discord.ui.Button):
    def __init__(self, parent: "QuestNotifyPanel"):
        self.parent_view = parent
        orbs_only = parent.settings["orbs_only"]
        super().__init__(
            label="Orbs報酬のみ: オン" if orbs_only else "Orbs報酬のみ: オフ",
            style=discord.ButtonStyle.primary if orbs_only else discord.ButtonStyle.secondary,
        )

    async def callback(self, interaction: discord.Interaction):
        orbs_only = not self.parent_view.settings["orbs_only"]
        await self.parent_view.save(
            interaction,
            "Orbs報酬のQuestだけを通知します。" if orbs_only else "すべてのQuestを通知します。",
            orbs_only=orbs_only,
        )


class QuestManualButton(discord.ui.Button):
    def __init__(self, parent: "QuestNotifyPanel"):
        self.parent_view = parent
        super().__init__(label="手動で通知を送る", style=discord.ButtonStyle.secondary)

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.send_modal(QuestManualModal(self.parent_view))


class QuestManualModal(discord.ui.Modal):
    def __init__(self, panel: "QuestNotifyPanel"):
        super().__init__(title="Questを手動で通知")
        self.panel = panel
        self.quest_title = discord.ui.TextInput(label="Quest名", max_length=100)
        self.reward = discord.ui.TextInput(
            label="報酬（任意）", placeholder="例: 700 Orbs", max_length=100, required=False
        )
        self.url = discord.ui.TextInput(label="URL（任意）", max_length=300, required=False)
        for field in (self.quest_title, self.reward, self.url):
            self.add_item(field)

    async def on_submit(self, interaction: discord.Interaction):
        if not can_manage_support_panel(interaction):
            return await interaction.response.send_message(
                "この機能は管理者のみ利用できます。",
                ephemeral=True,
            )

        await interaction.response.defer()
        item = QuestItem(
            id=f"manual:{int(time.time())}",
            title=self.quest_title.value.strip(),
            reward=self.reward.value.strip(),
            url=_quest_http_url(self.url.value) or "",
        )
        try:
            notice = await self.panel.cog.quest_send_manual(interaction.guild, item)
        except QuestError as exc:
            notice = f"{FAILED} {exc}"
        except Exception:
            logger.exception("Quest手動通知に失敗しました")
            notice = f"{FAILED} 送信中にエラーが発生しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。"
        await self.panel.refresh(interaction, notice)

    async def on_error(self, interaction: discord.Interaction, error: Exception):
        await report_callback_error(interaction, "Quest手動通知モーダルでエラー", error=error)


class QuestNotifyPanel(discord.ui.LayoutView):
    """Quest通知の設定パネル（Components V2・管理者専用）。"""

    def __init__(self, cog: "SupportCog", settings: dict, notice: str | None = None, lang_label: str = ""):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.notice = notice
        self.lang_label = lang_label
        self._build()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if can_manage_support_panel(interaction):
            return True
        await interaction.response.send_message(
            "この機能は管理者のみ利用できます。",
            ephemeral=True,
        )
        return False

    async def on_error(self, interaction: discord.Interaction, error: Exception, item: discord.ui.Item):
        logger.error("Quest通知パネルでエラー", exc_info=error)
        await report_callback_error(interaction, "Quest通知パネルでエラー", error=error)

    def _status_text(self) -> str:
        s = self.settings
        channel = f"<#{s['channel_id']}>" if s["channel_id"] else "未設定"
        role = f"<@&{s['role_id']}>" if s["role_id"] else "なし"
        source = urlparse(_quest_feed_url()).hostname or "未設定"
        text = (
            f"状態: **{'オン' if s['enabled'] else 'オフ'}**\n"
            f"送信先: {channel}\n"
            f"メンション: {role}\n"
            f"対象: {'Orbs報酬のみ' if s['orbs_only'] else 'すべてのQuest'}\n"
            + (f"言語圏: {self.lang_label}\n" if self.lang_label else "")
            + f"取得元: {source}\n"
            f"確認間隔: 約{QUEST_POLL_SECONDS // 60}分ごと"
        )
        error = self.cog.quest_last_error()
        if error:
            text += f"\n-# {FAILED} 直近の取得エラー: {error}"
        return text

    def _build(self):
        self.clear_items()
        head = "## 🎯 Quest通知\nDiscord QuestとOrbs報酬の新着をチャンネルへ通知します。（管理者専用）"
        if self.notice:
            head = f"{self.notice}\n\n{head}"

        self.add_item(
            discord.ui.Container(
                discord.ui.TextDisplay(head),
                discord.ui.TextDisplay(self._status_text()),
                discord.ui.Separator(),
                discord.ui.ActionRow(QuestChannelSelect(self)),
                discord.ui.ActionRow(QuestRoleSelect(self)),
                discord.ui.ActionRow(
                    QuestToggleButton(self),
                    QuestOrbsOnlyButton(self),
                    QuestManualButton(self),
                ),
                accent_colour=0x5865F2,
            )
        )

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = get_quest_settings(store, interaction.guild_id)
        self.notice = notice
        self.lang_label = await self.cog.quest_language_label(interaction.guild)
        self._build()
        await edit_interaction_message(interaction, view=self)

    async def save(self, interaction: discord.Interaction, notice: str, **values):
        await interaction.response.defer()
        try:
            async with self.cog.quest_lock(interaction.guild_id):
                await guild_settings.get_store().update(interaction.guild_id, QUEST_SECTION, **values)
        except Exception:
            logger.exception("Quest通知設定の更新に失敗しました")
            return await interaction.followup.send(
                "設定の更新に失敗しました。時間をおいて再度お試しください。解決しない場合はBotの運営に連絡してください。",
                ephemeral=True,
            )
        await self.refresh(interaction, notice)


class QuestSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    def quest_lock(self, guild_id: int) -> asyncio.Lock:
        return self._quest_locks.setdefault(guild_id, asyncio.Lock())


    def quest_last_error(self) -> str | None:
        return self._quest.last_error if self._quest is not None else None


    async def quest_guild_language(self, guild: discord.Guild) -> tuple[str, str]:
        """ギルドに設定された言語を (言語コード, 取得元) で返す。"""
        store = guild_settings.get_store()
        await store.ensure_loaded()

        cog = self.bot.get_cog("LocalizationCog")
        if cog is not None:
            for name in (
                "get_guild_language", "guild_language", "get_language",
                "get_guild_locale", "get_locale", "language_for", "get_lang",
            ):
                fn = getattr(cog, name, None)
                if not callable(fn):
                    continue
                for arg in (guild.id, guild):
                    try:
                        value = fn(arg)
                        if inspect.isawaitable(value):
                            value = await value
                    except Exception:
                        logger.debug("Quest: 言語アクセサの呼び出しに失敗しました", exc_info=True)
                        continue
                    if isinstance(value, str) and quest_language_countries(value):
                        return value.strip(), f"LocalizationCog.{name}"

        for section in QUEST_LANG_SECTIONS:
            try:
                raw = store.get(guild.id, section)
            except Exception:
                logger.debug("Quest: 言語設定の読み取りに失敗しました", exc_info=True)
                continue
            candidates = [raw] if isinstance(raw, str) else (
                [raw.get(k) for k in QUEST_LANG_KEYS] if isinstance(raw, dict) else []
            )
            for value in candidates:
                if isinstance(value, str) and quest_language_countries(value):
                    return value.strip(), f"設定:{section}"

        preferred = getattr(guild, "preferred_locale", None)
        preferred = str(getattr(preferred, "value", preferred) or "")
        if quest_language_countries(preferred):
            return preferred, "サーバーの優先言語"
        return "en", "既定値"


    async def quest_language_label(self, guild: discord.Guild | None) -> str:
        if guild is None:
            return ""
        try:
            language, source = await self.quest_guild_language(guild)
        except Exception:
            logger.exception("Quest通知の言語設定を取得できませんでした (guild=%s)", guild.id)
            return ""
        countries = ", ".join(sorted(quest_language_countries(language)))
        return f"**{language}**（{countries}で提供のQuestのみ）\n-# 言語の取得元: {source}"


    async def show_quest_notify_settings(self, interaction: discord.Interaction):
        if interaction.guild is None:
            return await interaction.response.send_message(
                "この機能はサーバー内で利用できます。",
                ephemeral=True,
            )

        if not can_manage_support_panel(interaction):
            return await interaction.response.send_message(
                "この機能は管理者のみ利用できます。",
                ephemeral=True,
            )

        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_quest_settings(store, interaction.guild.id)
        label = await self.quest_language_label(interaction.guild)
        await interaction.response.send_message(
            view=QuestNotifyPanel(self, settings, lang_label=label),
            ephemeral=True,
        )


    def _quest_channel(self, guild: discord.Guild, settings: dict):
        """送信先テキストチャンネル。投稿できない状態ならNone。"""
        channel = guild.get_channel(settings["channel_id"]) if settings["channel_id"] else None
        me = guild.me
        if not isinstance(channel, discord.TextChannel) or me is None:
            return None
        perms = channel.permissions_for(me)
        if not (perms.view_channel and perms.send_messages):
            logger.warning("Quest通知の送信先に投稿できません (guild=%s channel=%s)", guild.id, channel.id)
            return None
        return channel


    @staticmethod
    def _quest_mentions(role_id: int | None) -> discord.AllowedMentions:
        return discord.AllowedMentions(
            everyone=False,
            users=False,
            roles=[discord.Object(id=role_id)] if role_id else False,
        )


    async def quest_send_manual(self, guild: discord.Guild, item: QuestItem) -> str:
        store = guild_settings.get_store()
        await store.ensure_loaded()
        settings = get_quest_settings(store, guild.id)
        channel = self._quest_channel(guild, settings)
        if channel is None:
            raise QuestError("送信先が未設定、またはBotが投稿できないチャンネルです。")
        if not item.title:
            raise QuestError("Quest名を入力してください。")
        try:
            await channel.send(
                view=QuestNotifyMessage(item, settings["role_id"]),
                allowed_mentions=self._quest_mentions(settings["role_id"]),
            )
        except (discord.Forbidden, discord.HTTPException) as exc:
            logger.warning("Quest手動通知の送信に失敗 (guild=%s): %s", guild.id, exc)
            raise QuestError("通知メッセージの送信に失敗しました。Botの権限を確認してください。") from exc
        return f"{channel.mention} に通知を送信しました。"


    @tasks.loop(seconds=QUEST_POLL_SECONDS)
    async def quest_poll(self):
        if self._quest is None or not _quest_feed_url():
            return

        store = guild_settings.get_store()
        await store.ensure_loaded()

        targets = []
        for guild in list(self.bot.guilds):
            settings = get_quest_settings(store, guild.id)
            if settings["enabled"] and settings["channel_id"]:
                targets.append((guild, settings))
        if not targets:
            return

        await asyncio.sleep(random.uniform(0, min(60, QUEST_POLL_SECONDS / 10)))

        try:
            items = await self._quest.fetch()
        except QuestError as exc:
            logger.warning("Questフィードの取得に失敗: %s", exc)
            return

        for guild, settings in targets:
            try:
                await self._quest_poll_guild(guild, store, settings, items)
            except Exception:
                logger.exception("Quest通知の巡回に失敗しました (guild=%s)", guild.id)


    @quest_poll.before_loop
    async def _quest_poll_before(self):
        await self.bot.wait_until_ready()


    @quest_poll.error
    async def _quest_poll_error(self, error: BaseException):
        logger.error("Quest通知の巡回ループが異常終了しました", exc_info=error)


    async def _quest_poll_guild(self, guild: discord.Guild, store, settings: dict, items: list[QuestItem]):
        # フィードは過去分を含めて数百件以上ある。期限切れは通知対象にせず、
        # 既読(seen)も「現在有効なQuest」のIDだけを保持する。
        # （固定件数で古い順に捨てると、捨てたIDが「新着」と誤判定されて再通知される）
        if not items:
            return  # 取得結果が空のときは既読を触らない（一時的な空応答での巻き戻し防止）

        now = time.time()
        live = [i for i in items if (sns_epoch(i.ends_at) or now + 1) >= now]
        live_ids = {i.id for i in live}
        seen_before = list(settings["seen"])

        if not settings["primed"]:
            async with self.quest_lock(guild.id):
                await store.update(
                    guild.id, QUEST_SECTION,
                    seen=list(dict.fromkeys(i.id for i in live))[-QUEST_MAX_SEEN:],
                    primed=True,
                )
            return

        # まだ有効なものだけ既読として残す（期限切れ・フィードから消えたIDは捨てる）
        keep = [sid for sid in dict.fromkeys(seen_before) if sid in live_ids]
        keep_set = set(keep)
        fresh = [i for i in live if i.id not in keep_set]

        # ギルドの言語圏で提供されていないQuestは通知せず既読にする
        regions = self._quest.regions if self._quest is not None else {}
        if regions and fresh:
            language, source = await self.quest_guild_language(guild)
            countries = quest_language_countries(language)
            if countries:
                blocked = [
                    i for i in fresh
                    if i.id in regions and not regions[i.id].available_in(countries)
                ]
                if blocked:
                    logger.info(
                        "Quest通知: 言語圏(%s=%s, %s)外の%d件を除外 (guild=%s)",
                        language, "/".join(sorted(countries)), source, len(blocked), guild.id,
                    )
                    blocked_ids = {i.id for i in blocked}
                    keep.extend(blocked_ids)
                    fresh = [i for i in fresh if i.id not in blocked_ids]

        # ギルドの言語圏で提供されていないQuestは通知せず既読にする
        regions = self._quest.regions if self._quest is not None else {}
        if regions and fresh:
            language, source = await self.quest_guild_language(guild)
            countries = quest_language_countries(language)
            if countries:
                blocked = [
                    i for i in fresh
                    if i.id in regions and not regions[i.id].available_in(countries)
                ]
                if blocked:
                    logger.info(
                        "Quest通知: 言語圏(%s=%s, %s)外の%d件を除外 (guild=%s)",
                        language, "/".join(sorted(countries)), source, len(blocked), guild.id,
                    )
                    blocked_ids = {i.id for i in blocked}
                    keep.extend(blocked_ids)
                    fresh = [i for i in fresh if i.id not in blocked_ids]

        if not fresh:
            if len(keep) != len(seen_before):
                async with self.quest_lock(guild.id):
                    await store.update(guild.id, QUEST_SECTION, seen=keep[-QUEST_MAX_SEEN:])
            return

        channel = self._quest_channel(guild, settings)
        if channel is None:
            return

        role_id = settings["role_id"]
        mentions = self._quest_mentions(role_id)

        if settings["orbs_only"]:
            keep.extend(i.id for i in fresh if not i.is_orbs)
            fresh = [i for i in fresh if i.is_orbs]

        fresh.sort(key=lambda i: sns_epoch(i.ends_at) or 0)
        if len(fresh) > QUEST_MAX_SEND_PER_CYCLE:
            keep.extend(i.id for i in fresh[:-QUEST_MAX_SEND_PER_CYCLE])
            fresh = fresh[-QUEST_MAX_SEND_PER_CYCLE:]

        try:
            for item in fresh:
                try:
                    await channel.send(view=QuestNotifyMessage(item, role_id), allowed_mentions=mentions)
                except (discord.Forbidden, discord.HTTPException) as exc:
                    logger.warning("Quest通知の送信に失敗 (guild=%s %s): %s", guild.id, item.id, exc)
                    break
                keep.append(item.id)
                await asyncio.sleep(1)
        finally:
            # 途中で例外が起きても、送信済みIDは必ず保存して重複通知を防ぐ
            async with self.quest_lock(guild.id):
                await store.update(
                    guild.id, QUEST_SECTION,
                    seen=list(dict.fromkeys(keep))[-QUEST_MAX_SEEN:],
                )
