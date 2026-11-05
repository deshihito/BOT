# -*- coding: utf-8 -*-
"""SNS新着通知 (X / YouTube / GitHub) の取得・UI。元 cogs/support.py から分割。"""
from __future__ import annotations

from .common import *
from .common import _support_int


# ===== SNS新着通知（X / YouTube / GitHub） ======================================
SNS_SECTION = "sns_notify"
SNS_MAX_SUBS = 10
SNS_MAX_SEEN = 100
SNS_MAX_SEND_PER_CYCLE = 5


def _sns_env_int(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.getenv(name, "") or default))
    except ValueError:
        return default


SNS_POLL_SECONDS = _sns_env_int("SNS_POLL_SECONDS", 300, 60)
SNS_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

SNS_PLATFORMS = {
    "youtube": {"label": "YouTube", "emoji": "▶️", "color": 0xFF0000, "noun": "動画", "open": "YouTubeで開く"},
    "x": {"label": "X", "emoji": "𝕏", "color": 0xFFFFFF, "noun": "ポスト", "open": "Xで開く"},
    "github": {"label": "GitHub", "emoji": "🐙", "color": 0x24292F, "noun": "更新", "open": "GitHubで開く"},
}

_SNS_NS = {
    "a": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}
_YT_ID_RE = re.compile(r"UC[0-9A-Za-z_-]{22}")
_X_USER_RE = re.compile(r"[A-Za-z0-9_]{1,15}")
_GH_OWNER_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?")
_GH_REPO_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")
SNS_GITHUB_KINDS = {"prs": "PR", "issues": "Issue", "commits": "コミット"}


def default_github_options() -> dict:
    return {kind: True for kind in SNS_GITHUB_KINDS}


def normalize_github_options(raw) -> dict:
    """GitHub通知の種類ごとのオン/オフ。欠けた種類はオンとして扱う。"""
    options = default_github_options()
    if isinstance(raw, dict):
        for kind in options:
            if isinstance(raw.get(kind), bool):
                options[kind] = raw[kind]
    return options


def parse_github_repo(raw: str) -> str:
    """owner/repo 形式またはGitHubのリポジトリURLを owner/repo に正規化する。"""
    text = (raw or "").strip()
    match = re.match(
        r"^(?:https?://)?(?:www\.)?github\.com/([^/\s]+)/([^/\s#?]+)(?:[/?#].*)?$",
        text,
        re.I,
    )
    if match:
        owner, repo = match.group(1), match.group(2)
    else:
        parts = text.split("/")
        if len(parts) != 2:
            raise SnsError("リポジトリを owner/repo の形式か、GitHubのリポジトリURLで入力してください。")
        owner, repo = parts
    repo = repo.removesuffix(".git")
    if not _GH_OWNER_RE.fullmatch(owner) or not _GH_REPO_RE.fullmatch(repo) or repo in {".", ".."}:
        raise SnsError("リポジトリ名の形式が正しくありません（例: deshihito/BOT）。")
    return f"{owner}/{repo}"


def github_items_from_pulls(pulls, full_name: str) -> list:
    """Pull requests 一覧（作成日時の降順）を作成されたPRの通知アイテムにする。"""
    items: list = []
    for pr in pulls if isinstance(pulls, list) else []:
        if not isinstance(pr, dict):
            continue
        number = pr.get("number")
        if not isinstance(number, int) or isinstance(number, bool):
            continue
        published = pr.get("created_at")
        items.append(SnsItem(
            id=f"gh:pr:{number}",
            title=f"新しいPR #{number}: {str(pr.get('title') or '').strip()}",
            url=str(pr.get("html_url") or f"https://github.com/{full_name}/pull/{number}"),
            author=full_name,
            published=published if isinstance(published, str) else None,
        ))
    return items


def github_items_from_issues(issues, full_name: str) -> list:
    """Issues 一覧を作成されたIssueの通知アイテムにする（PRは混ざるので除く）。"""
    items: list = []
    for issue in issues if isinstance(issues, list) else []:
        if not isinstance(issue, dict) or "pull_request" in issue:
            continue
        number = issue.get("number")
        if not isinstance(number, int) or isinstance(number, bool):
            continue
        published = issue.get("created_at")
        items.append(SnsItem(
            id=f"gh:issue:{number}",
            title=f"新しいIssue #{number}: {str(issue.get('title') or '').strip()}",
            url=str(issue.get("html_url") or f"https://github.com/{full_name}/issues/{number}"),
            author=full_name,
            published=published if isinstance(published, str) else None,
        ))
    return items


def github_items_from_commits(commits, full_name: str) -> list:
    """Commits 一覧を push されたコミットの通知アイテムにする。"""
    items: list = []
    for row in commits if isinstance(commits, list) else []:
        if not isinstance(row, dict):
            continue
        sha = str(row.get("sha") or "").strip()
        if not sha:
            continue
        commit = row.get("commit") if isinstance(row.get("commit"), dict) else {}
        lines = str(commit.get("message") or "").strip().splitlines()
        stamp = commit.get("committer") if isinstance(commit.get("committer"), dict) else {}
        published = stamp.get("date")
        if not isinstance(published, str):
            author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
            published = author.get("date")
        items.append(SnsItem(
            id=f"gh:commit:{sha}",
            title=f"新しいコミット: {lines[0] if lines else sha[:7]}",
            url=str(row.get("html_url") or f"https://github.com/{full_name}/commit/{sha}"),
            author=full_name,
            published=published if isinstance(published, str) else None,
        ))
    return items


def _sns_github_token() -> str:
    return (os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN") or "").strip()


class SnsError(Exception):
    """管理者にそのまま見せてよい取得・設定エラー。"""


@dataclass
class SnsItem:
    id: str
    title: str
    url: str
    author: str = ""
    published: str | None = None
    thumbnail: str | None = None
    live: bool = False


def _sns_text(value: str | None) -> str:
    text = re.sub(r"<br\s*/?>", "\n", value or "", flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return _html.unescape(text).strip()


def sns_epoch(value: str | None) -> int | None:
    """ISO8601 / RFC822 の日時文字列をUNIX秒にする。解釈できなければNone。"""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value.strip())
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def parse_youtube_feed(data: bytes) -> tuple[str, list[SnsItem]]:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise SnsError("YouTubeのフィードを解析できませんでした。") from exc

    name = (root.findtext("a:author/a:name", default="", namespaces=_SNS_NS)
            or root.findtext("a:title", default="", namespaces=_SNS_NS)).strip()

    items: list[SnsItem] = []
    for entry in root.findall("a:entry", _SNS_NS):
        video_id = (entry.findtext("yt:videoId", default="", namespaces=_SNS_NS) or "").strip()
        if not video_id:
            continue
        link = entry.find("a:link[@rel='alternate']", _SNS_NS)
        thumb = entry.find("media:group/media:thumbnail", _SNS_NS)
        thumb_url = (thumb.get("url") if thumb is not None else None) or ""
        # ライブ/プレミア公開の判定 (Atomフィードには明示フラグが無いためヒューリスティクス):
        # ライブ中はサムネイルが hqdefault_live.jpg になり、通常動画にある starRating が付かない。
        star = entry.find("media:group/media:community/media:starRating", _SNS_NS)
        is_live = "_live" in thumb_url or star is None
        items.append(
            SnsItem(
                id=video_id,
                title=(entry.findtext("a:title", default="", namespaces=_SNS_NS) or "").strip(),
                url=(link.get("href") if link is not None else None) or f"https://www.youtube.com/watch?v={video_id}",
                author=name,
                published=entry.findtext("a:published", default=None, namespaces=_SNS_NS),
                thumbnail=thumb_url or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
                live=is_live,
            )
        )
    return name, items


def sns_youtube_kind_allowed(item: SnsItem, settings: dict) -> bool:
    """YouTube新着をライブ/通常動画の設定で振り分ける。他プラットフォームは常に対象。"""
    if item.live:
        return bool(settings.get("live_enabled", True))
    return bool(settings.get("uploads_enabled", True))


def parse_rss_feed(data: bytes) -> tuple[str, list[SnsItem]]:
    """RSS 2.0（RSSHub・Nitter等のX用フィード）を解析する。"""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise SnsError("RSSを解析できませんでした。") from exc

    channel_title = _sns_text(root.findtext("channel/title"))
    items: list[SnsItem] = []
    for node in root.iter("item"):
        link = (node.findtext("link") or "").strip()
        guid = (node.findtext("guid") or link).strip()
        match = re.search(r"/status/(\d+)", link) or re.search(r"/status/(\d+)", guid)
        item_id = match.group(1) if match else guid
        if not item_id:
            continue
        text = _sns_text(node.findtext("description")) or _sns_text(node.findtext("title"))
        items.append(
            SnsItem(
                id=item_id,
                title=text,
                url=link,
                author=channel_title,
                published=node.findtext("pubDate"),
            )
        )
    return channel_title, items


def parse_x_username(raw: str) -> str:
    raw = (raw or "").strip()
    match = re.match(
        r"^(?:https?://)?(?:www\.|mobile\.)?(?:x|twitter)\.com/@?([A-Za-z0-9_]{1,15})(?:[/?#].*)?$",
        raw,
        re.I,
    )
    name = match.group(1) if match else raw.lstrip("@")
    if not _X_USER_RE.fullmatch(name):
        raise SnsError("Xのユーザー名（@名前）またはプロフィールURLを入力してください。")
    return name


def sns_x_since_id(seen: list[str]) -> str | None:
    ids = [s for s in seen if s.isdigit()]
    return max(ids, key=int) if ids else None


def _sns_x_token() -> str:
    return (os.getenv("X_BEARER_TOKEN") or "").strip()


def _sns_x_rss_template() -> str:
    # ローカルRSSサービスを既定値として使用。必要なら環境変数で上書きできる。
    return (os.getenv("X_RSS_URL") or "http://192.168.11.15:1200/x/user/{username}").strip()


class SnsFetcher:
    """YouTube / X / GitHub の新着取得。ネットワーク周りはここに集約する。"""

    def __init__(self, session: aiohttp.ClientSession):
        self.session = session

    async def _get(self, url: str, *, params=None, headers=None) -> tuple[int, bytes]:
        try:
            async with self.session.get(url, params=params, headers=headers) as resp:
                return resp.status, await resp.read()
        except asyncio.TimeoutError as exc:
            raise SnsError("通信がタイムアウトしました。") from exc
        except aiohttp.ClientError as exc:
            raise SnsError(f"通信に失敗しました（{type(exc).__name__}）。") from exc

    # --- YouTube ---------------------------------------------------------
    async def resolve_youtube(self, raw: str) -> str:
        raw = (raw or "").strip()
        if not raw:
            raise SnsError("チャンネルのURL・@ハンドル・チャンネルIDのいずれかを入力してください。")

        if _YT_ID_RE.fullmatch(raw):
            return raw

        match = re.search(r"youtube\.com/channel/(UC[0-9A-Za-z_-]{22})", raw)
        if match:
            return match.group(1)

        if raw.lower().startswith(("http://", "https://")):
            host = (urlparse(raw).hostname or "").lower()
            if not (host == "youtube.com" or host.endswith(".youtube.com")):
                raise SnsError("YouTubeのURLではありません。")
            if "/watch" in raw or "youtu.be" in host:
                raise SnsError("動画ではなく、チャンネルのURLまたは@ハンドルを入力してください。")
            page_url = raw.split("?")[0].split("#")[0]
        else:
            handle = raw.lstrip("@")
            if not re.fullmatch(r"[\w.\-]{1,100}", handle):
                raise SnsError("@ハンドルの形式が正しくありません。")
            page_url = f"https://www.youtube.com/@{quote(handle)}"

        status, body = await self._get(
            page_url,
            headers={"Accept-Language": "ja,en;q=0.8", "Cookie": "CONSENT=YES+1; SOCS=CAI"},
        )
        if status == 404:
            raise SnsError("チャンネルが見つかりませんでした。")
        if status != 200:
            raise SnsError(f"チャンネルページの取得に失敗しました（HTTP {status}）。")

        text = body.decode("utf-8", errors="ignore")
        for pattern in (
            r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[0-9A-Za-z_-]{22})"',
            r'"externalId":"(UC[0-9A-Za-z_-]{22})"',
            r'"channelId":"(UC[0-9A-Za-z_-]{22})"',
        ):
            found = re.search(pattern, text)
            if found:
                return found.group(1)
        raise SnsError("チャンネルIDを特定できませんでした。チャンネルID（UC…）を直接入力してください。")

    async def youtube_feed(self, channel_id: str) -> tuple[str, list[SnsItem]]:
        status, body = await self._get(
            "https://www.youtube.com/feeds/videos.xml",
            params={"channel_id": channel_id},
        )
        if status == 404:
            raise SnsError("チャンネルのフィードが見つかりませんでした。")
        if status != 200:
            raise SnsError(f"YouTubeフィードの取得に失敗しました（HTTP {status}）。")
        return parse_youtube_feed(body)

    # --- X ---------------------------------------------------------------
    async def _x_api(self, path: str, params=None) -> dict:
        status, body = await self._get(
            f"https://api.x.com/2/{path}",
            params=params,
            headers={"Authorization": f"Bearer {_sns_x_token()}"},
        )
        if status != 200:
            messages = {
                401: "X APIの認証に失敗しました（X_BEARER_TOKENを確認してください）。",
                402: "X APIのクレジットが不足しています。",
                403: "X APIへのアクセスが拒否されました（プランや権限を確認してください）。",
                429: "X APIのレート制限に達しました。しばらく待つと再開します。",
            }
            raise SnsError(messages.get(status, f"X APIがHTTP {status}を返しました。"))
        try:
            return json.loads(body)
        except ValueError as exc:
            raise SnsError("X APIの応答を解析できませんでした。") from exc

    async def x_lookup_user(self, username: str) -> tuple[str, str]:
        payload = await self._x_api(f"users/by/username/{username}")
        data = payload.get("data")
        if not data:
            raise SnsError(f"@{username} が見つかりませんでした。")
        return str(data["id"]), str(data.get("name") or username)

    async def x_api_posts(self, uid: str, username: str, since_id: str | None) -> list[SnsItem]:
        # 課金は「返ったポスト数」単位なので、since_idで新着だけを取得する
        params = {
            "max_results": "10" if since_id else "5",
            "exclude": "replies,retweets",
            "tweet.fields": "created_at",
        }
        if since_id:
            params["since_id"] = since_id
        payload = await self._x_api(f"users/{uid}/tweets", params)
        return [
            SnsItem(
                id=str(tweet["id"]),
                title=str(tweet.get("text") or ""),
                url=f"https://x.com/{username}/status/{tweet['id']}",
                author=username,
                published=tweet.get("created_at"),
            )
            for tweet in payload.get("data") or []
        ]

    async def x_rss_posts(self, username: str) -> list[SnsItem]:
        template = _sns_x_rss_template()
        if not template:
            raise SnsError(
                "X RSSの取得に失敗しました。RSSサービスと X_RSS_URL の設定を確認してください。"
            )
        # URL内でプレースホルダーが %7Busername%7D とURLエンコードされていても対応する。
        url = re.sub(r"%7Busername%7D", quote(username), template, flags=re.I)
        url = url.replace("{username}", quote(username))
        status, body = await self._get(url)
        if status != 200:
            raise SnsError(f"XのRSS取得に失敗しました（HTTP {status}）。")
        _, items = parse_rss_feed(body)
        for item in items:
            if re.fullmatch(r"\d+", item.id):
                item.url = f"https://x.com/{username}/status/{item.id}"
        return items

    # --- GitHub ------------------------------------------------------------
    def _github_headers(self) -> dict:
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        token = _sns_github_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def _github_json(self, path: str, params=None):
        status, body = await self._get(
            f"https://api.github.com{path}", params=params, headers=self._github_headers()
        )
        if status == 404:
            raise SnsError("リポジトリが見つかりませんでした。")
        if status == 403:
            raise SnsError("GitHub APIのレート制限に達した可能性があります。GITHUB_TOKEN を設定すると緩和されます。")
        if status != 200:
            raise SnsError(f"GitHub APIがHTTP {status}を返しました。")
        try:
            return json.loads(body)
        except ValueError as exc:
            raise SnsError("GitHub APIの応答を解析できませんでした。") from exc

    async def resolve_github(self, raw: str) -> str:
        full_name = parse_github_repo(raw)
        data = await self._github_json(f"/repos/{full_name}")
        canonical = data.get("full_name") if isinstance(data, dict) else None
        return str(canonical) if canonical else full_name

    async def github_items(self, full_name: str, options) -> list:
        """オンになっている種類だけAPIを叩く（レート制限の節約）。"""
        options = normalize_github_options(options)
        items: list = []
        if options["prs"]:
            data = await self._github_json(
                f"/repos/{full_name}/pulls",
                params={"state": "all", "sort": "created", "direction": "desc", "per_page": "10"},
            )
            items += github_items_from_pulls(data, full_name)
        if options["issues"]:
            data = await self._github_json(
                f"/repos/{full_name}/issues",
                params={"state": "all", "sort": "created", "direction": "desc", "per_page": "10"},
            )
            items += github_items_from_issues(data, full_name)
        if options["commits"]:
            data = await self._github_json(
                f"/repos/{full_name}/commits", params={"per_page": "10"}
            )
            items += github_items_from_commits(data, full_name)
        return items

    # --- 共通 ------------------------------------------------------------
    async def lookup(self, platform: str, raw: str) -> dict:
        """追加時の解決。現在の最新分も返す（既読の基準にするため）。"""
        if platform == "youtube":
            channel_id = await self.resolve_youtube(raw)
            name, items = await self.youtube_feed(channel_id)
            return {"key": channel_id, "name": name or channel_id, "uid": None, "items": items}

        if platform == "github":
            full_name = await self.resolve_github(raw)
            items = await self.github_items(full_name, default_github_options())
            return {"key": full_name, "name": full_name, "uid": None, "items": items}

        username = parse_x_username(raw)
        # Xは無料のRSS経由に統一し、X APIトークンが設定されていても使用しない。
        if _sns_x_rss_template():
            items = await self.x_rss_posts(username)
            return {"key": username.lower(), "name": f"@{username}", "uid": None, "items": items}
        raise SnsError(
            "X RSSの取得に失敗しました。RSSサービスと X_RSS_URL の設定を確認してください。"
        )

    async def poll(self, sub: dict) -> tuple[list[SnsItem], str | None]:
        """巡回用。戻り値は (取得したアイテム, 判明したX user id)。"""
        if sub["platform"] == "youtube":
            _, items = await self.youtube_feed(sub["key"])
            return items, None

        if sub["platform"] == "github":
            return await self.github_items(sub["key"], sub.get("options")), None

        username = sub["key"]
        # X通知はRSSを使用。APIの課金・トークン設定には依存しない。
        if _sns_x_rss_template():
            return await self.x_rss_posts(username), None
        raise SnsError("X RSSの取得先が設定されていません。RSSサービスと X_RSS_URL の設定を確認してください。")


def get_sns_settings(store, guild_id: int) -> dict:
    """SNS通知設定。未設定時はオフ・送信先なし・登録なし。"""
    raw = store.get(guild_id, SNS_SECTION)
    if not isinstance(raw, dict):
        raw = {}

    subs: list[dict] = []
    for item in raw.get("subs") if isinstance(raw.get("subs"), list) else []:
        if not isinstance(item, dict):
            continue
        platform = item.get("platform")
        key = item.get("key")
        if platform not in SNS_PLATFORMS or not isinstance(key, str) or not key:
            continue
        seen = [str(s) for s in item.get("seen", []) if isinstance(s, (str, int)) and not isinstance(s, bool)]
        uid = item.get("uid")
        error = item.get("error")
        subs.append(
            {
                "platform": platform,
                "key": key,
                "name": str(item.get("name") or key)[:100],
                "uid": uid if isinstance(uid, str) and uid else None,
                "seen": seen[-SNS_MAX_SEEN:],
                "error": error[:200] if isinstance(error, str) and error else None,
                "options": normalize_github_options(item.get("options")),
            }
        )

    return {
        "enabled": raw.get("enabled") if isinstance(raw.get("enabled"), bool) else False,
        "channel_id": _support_int(raw.get("channel_id")),
        "role_id": _support_int(raw.get("role_id")),
        "live_role_id": _support_int(raw.get("live_role_id")),
        "live_enabled": raw.get("live_enabled") if isinstance(raw.get("live_enabled"), bool) else True,
        "uploads_enabled": raw.get("uploads_enabled") if isinstance(raw.get("uploads_enabled"), bool) else True,
        "subs": subs[:SNS_MAX_SUBS],
    }


class SnsNotifyMessage(discord.ui.LayoutView):
    """チャンネルに投稿する新着通知（Components V2）。"""

    def __init__(self, sub: dict, item: SnsItem, role_id: int | None = None):
        super().__init__(timeout=None)
        meta = SNS_PLATFORMS[sub["platform"]]
        children: list[discord.ui.Item] = []

        if role_id:
            children.append(discord.ui.TextDisplay(f"<@&{role_id}>"))

        if item.live and sub["platform"] == "youtube":
            header = f"### 🔴 {discord.utils.escape_markdown(sub['name'])} がライブ配信を開始しました"
        else:
            header = f"### {meta['emoji']} {discord.utils.escape_markdown(sub['name'])} の新着{meta['noun']}"
        stamp = sns_epoch(item.published)
        if stamp:
            header += f"\n-# <t:{stamp}:R>"
        children.append(discord.ui.TextDisplay(header))

        if sub["platform"] in ("youtube", "github"):
            title = discord.utils.escape_markdown(item.title)[:200] or "(タイトルなし)"
            children.append(discord.ui.TextDisplay(f"**{title}**"))
            if item.thumbnail:
                children.append(discord.ui.MediaGallery(discord.MediaGalleryItem(item.thumbnail)))
        else:
            children.append(discord.ui.TextDisplay((item.title or "(本文なし)")[:1500]))

        children.append(discord.ui.Separator())
        if item.url:
            children.append(
                discord.ui.ActionRow(
                    discord.ui.Button(label=meta["open"], style=discord.ButtonStyle.link, url=item.url)
                )
            )

        self.add_item(discord.ui.Container(*children, accent_colour=meta["color"]))


class SnsChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent: "SnsNotifyPanel"):
        self.parent_view = parent
        channel_id = parent.settings.get("channel_id")
        super().__init__(
            placeholder="通知を送るテキストチャンネルを選択",
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


class SnsRoleSelect(discord.ui.RoleSelect):
    def __init__(self, parent: "SnsNotifyPanel"):
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


class SnsLiveRoleSelect(discord.ui.RoleSelect):
    def __init__(self, parent: "SnsNotifyPanel"):
        self.parent_view = parent
        role_id = parent.settings.get("live_role_id")
        super().__init__(
            placeholder="ライブ通知でメンションするロール（任意・未設定時は通常と同じ）",
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
            "ライブ用のメンション先を設定しました。" if role else "ライブ用のメンションを解除しました。",
            live_role_id=role.id if role else None,
        )


class SnsKindToggleButton(discord.ui.Button):
    """YouTubeのライブ/通常動画、それぞれの通知オン・オフ。"""

    def __init__(self, parent: "SnsNotifyPanel", kind: str):
        self.parent_view = parent
        self.kind = kind  # "live" | "uploads"
        field = "live_enabled" if kind == "live" else "uploads_enabled"
        on = bool(parent.settings.get(field, True))
        label = "ライブ通知" if kind == "live" else "通常動画の通知"
        super().__init__(
            label=f"{label}: {'オン' if on else 'オフ'}",
            style=discord.ButtonStyle.success if on else discord.ButtonStyle.secondary,
        )

    async def callback(self, interaction: discord.Interaction):
        field = "live_enabled" if self.kind == "live" else "uploads_enabled"
        value = not bool(self.parent_view.settings.get(field, True))
        label = "ライブ通知" if self.kind == "live" else "通常動画の通知"
        await self.parent_view.save(
            interaction,
            f"{label}を{'オン' if value else 'オフ'}にしました。",
            **{field: value},
        )


class SnsAddButton(discord.ui.Button):
    def __init__(self, parent: "SnsNotifyPanel", platform: str):
        self.parent_view = parent
        self.platform = platform
        meta = SNS_PLATFORMS[platform]
        super().__init__(
            label=f"{meta['label']}を追加",
            style=discord.ButtonStyle.primary,
            disabled=len(parent.settings["subs"]) >= SNS_MAX_SUBS,
        )

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.send_modal(SnsAddModal(self.parent_view, self.platform))


class SnsToggleButton(discord.ui.Button):
    def __init__(self, parent: "SnsNotifyPanel"):
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
        await self.parent_view.save(
            interaction,
            f"通知を{'オン' if enabled else 'オフ'}にしました。",
            enabled=enabled,
        )


class SnsRemoveSelect(discord.ui.Select):
    def __init__(self, parent: "SnsNotifyPanel"):
        self.parent_view = parent
        super().__init__(
            placeholder="登録を解除するアカウントを選択",
            options=[
                discord.SelectOption(
                    label=f"{SNS_PLATFORMS[sub['platform']]['label']}: {sub['name']}"[:100],
                    value=f"{sub['platform']}:{sub['key']}"[:100],
                )
                for sub in parent.settings["subs"]
            ],
        )

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer()
        try:
            notice = await self.parent_view.cog.sns_remove_subscription(
                interaction.guild_id, self.values[0]
            )
        except Exception:
            logger.exception("SNS通知の登録解除に失敗しました")
            notice = "⚠️ 解除中にエラーが発生しました。Botのログを確認してください。"
        await self.parent_view.refresh(interaction, notice)


class SnsGithubKindSelect(discord.ui.Select):
    def __init__(self, parent: "SnsNotifyPanel"):
        self.parent_view = parent
        options = []
        for sub in parent.settings["subs"]:
            if sub["platform"] != "github":
                continue
            current = sub.get("options") or {}
            for kind, label in SNS_GITHUB_KINDS.items():
                on = current.get(kind, True)
                options.append(
                    discord.SelectOption(
                        label=f"{sub['name']}: {label}通知を{'オフ' if on else 'オン'}にする"[:100],
                        value=f"{sub['key']}|{kind}"[:100],
                        description=f"現在: {'オン' if on else 'オフ'}",
                    )
                )
        super().__init__(
            placeholder="GitHub通知の種類を変更（リポジトリ × 種類）",
            options=options[:25],
        )

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.defer()
        key, _, kind = self.values[0].rpartition("|")
        try:
            notice = await self.parent_view.cog.sns_toggle_github_option(
                interaction.guild_id, key, kind
            )
        except SnsError as exc:
            notice = f"⚠️ {exc}"
        except Exception:
            logger.exception("GitHub通知の種類変更に失敗しました")
            notice = "⚠️ 変更中にエラーが発生しました。Botのログを確認してください。"
        await self.parent_view.refresh(interaction, notice)


class SnsAddModal(discord.ui.Modal):
    def __init__(self, panel: "SnsNotifyPanel", platform: str):
        meta = SNS_PLATFORMS[platform]
        modal_title = f"{meta['label']}リポジトリを追加" if platform == "github" else f"{meta['label']}アカウントを追加"
        super().__init__(title=modal_title[:45])
        self.panel = panel
        self.platform = platform
        if platform == "youtube":
            label, placeholder = "チャンネル", "@ハンドル / チャンネルURL / チャンネルID(UC…)"
        elif platform == "github":
            label, placeholder = "リポジトリ", "owner/repo / リポジトリURL"
        else:
            label, placeholder = "Xアカウント", "@ユーザー名 / プロフィールURL"
        self.account = discord.ui.TextInput(label=label, placeholder=placeholder, max_length=200)
        self.add_item(self.account)

    async def on_submit(self, interaction: discord.Interaction):
        if not can_manage_support_panel(interaction):
            return await interaction.response.send_message(
                "この機能は管理者のみ利用できます。",
                ephemeral=True,
            )

        await interaction.response.defer()
        try:
            notice = await self.panel.cog.sns_add_subscription(
                interaction.guild_id, self.platform, self.account.value
            )
        except SnsError as exc:
            notice = f"⚠️ {exc}"
        except Exception:
            logger.exception("SNS通知の追加に失敗しました")
            notice = "⚠️ 追加中にエラーが発生しました。Botのログを確認してください。"
        await self.panel.refresh(interaction, notice)

    async def on_error(self, interaction: discord.Interaction, error: Exception):
        await report_callback_error(interaction, "SNS通知の追加モーダルでエラー")


class SnsNotifyPanel(discord.ui.LayoutView):
    """SNS通知の設定パネル（Components V2・管理者専用）。"""

    def __init__(self, cog: "SupportCog", settings: dict, notice: str | None = None):
        super().__init__(timeout=300)
        self.cog = cog
        self.settings = settings
        self.notice = notice
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
        logger.error("SNS通知パネルでエラー", exc_info=error)
        await report_callback_error(interaction, "SNS通知パネルでエラー")

    def _status_text(self) -> str:
        s = self.settings
        channel = f"<#{s['channel_id']}>" if s["channel_id"] else "未設定"
        role = f"<@&{s['role_id']}>" if s["role_id"] else "なし"
        live_role = f"<@&{s['live_role_id']}>" if s.get("live_role_id") else "通常と同じ"
        return (
            f"状態: **{'オン' if s['enabled'] else 'オフ'}**\n"
            f"送信先: {channel}\n"
            f"メンション: {role}\n"
            f"YouTube ライブ通知: {'オン' if s.get('live_enabled', True) else 'オフ'} / ライブ用メンション: {live_role}\n"
            f"YouTube 通常動画の通知: {'オン' if s.get('uploads_enabled', True) else 'オフ'}\n"
            f"確認間隔: 約{SNS_POLL_SECONDS // 60}分ごと\n"
        )

    def _subs_text(self) -> str:
        subs = self.settings["subs"]
        if not subs:
            return "登録なし。下のボタンからアカウントを追加してください。"
        lines = []
        for i, sub in enumerate(subs, 1):
            meta = SNS_PLATFORMS[sub["platform"]]
            line = f"{i}. {meta['emoji']} **{discord.utils.escape_markdown(sub['name'])}**"
            if sub["platform"] == "github":
                opts = sub.get("options") or {}
                kinds = " / ".join(
                    f"{label}: {'オン' if opts.get(kind, True) else 'オフ'}"
                    for kind, label in SNS_GITHUB_KINDS.items()
                )
                line += f"\n-# {kinds}"
            if sub["error"]:
                line += f"\n-# ⚠️ {sub['error']}"
            lines.append(line)
        return "\n".join(lines)

    def _build(self):
        self.clear_items()
        head = "## 📡 SNS新着通知\nX・YouTube・GitHubの新着をチャンネルへ通知します。（管理者専用）"
        if self.notice:
            head = f"{self.notice}\n\n{head}"

        children: list[discord.ui.Item] = [
            discord.ui.TextDisplay(head),
            discord.ui.TextDisplay(self._status_text()),
            discord.ui.Separator(),
            discord.ui.TextDisplay(f"### 登録アカウント ({len(self.settings['subs'])}/{SNS_MAX_SUBS})\n{self._subs_text()}"),
            discord.ui.Separator(),
            discord.ui.ActionRow(SnsChannelSelect(self)),
            discord.ui.ActionRow(SnsRoleSelect(self)),
            discord.ui.ActionRow(SnsLiveRoleSelect(self)),
            discord.ui.ActionRow(
                SnsAddButton(self, "youtube"),
                SnsAddButton(self, "x"),
                SnsAddButton(self, "github"),
                SnsToggleButton(self),
            ),
            discord.ui.ActionRow(
                SnsKindToggleButton(self, "live"),
                SnsKindToggleButton(self, "uploads"),
            ),
        ]
        if any(s["platform"] == "github" for s in self.settings["subs"]):
            children.append(discord.ui.ActionRow(SnsGithubKindSelect(self)))
        if self.settings["subs"]:
            children.append(discord.ui.ActionRow(SnsRemoveSelect(self)))

        self.add_item(discord.ui.Container(*children, accent_colour=0xFFFFFF))

    async def refresh(self, interaction: discord.Interaction, notice: str | None = None):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        self.settings = get_sns_settings(store, interaction.guild_id)
        self.notice = notice
        self._build()
        await edit_interaction_message(interaction, view=self)

    async def save(self, interaction: discord.Interaction, notice: str, **values):
        await interaction.response.defer()
        try:
            async with self.cog.sns_lock(interaction.guild_id):
                await guild_settings.get_store().update(interaction.guild_id, SNS_SECTION, **values)
        except Exception:
            logger.exception("SNS通知設定の更新に失敗しました")
            return await interaction.followup.send(
                "設定の更新に失敗しました。Botのログを確認してください。",
                ephemeral=True,
            )
        await self.refresh(interaction, notice)


class SnsSupportMixin:
    """SupportCog の一部。cogs/support.py で合成される。"""

    def sns_lock(self, guild_id: int) -> asyncio.Lock:
        return self._sns_locks.setdefault(guild_id, asyncio.Lock())


    async def show_sns_notify_settings(self, interaction: discord.Interaction):
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
        settings = get_sns_settings(store, interaction.guild.id)
        await interaction.response.send_message(
            view=SnsNotifyPanel(self, settings),
            ephemeral=True,
        )


    async def sns_add_subscription(self, guild_id: int, platform: str, raw: str) -> str:
        if self._sns is None:
            raise SnsError("通知機能の準備ができていません。少し待ってからやり直してください。")

        async with self.sns_lock(guild_id):
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_sns_settings(store, guild_id)
            subs = [dict(s) for s in settings["subs"]]

            if len(subs) >= SNS_MAX_SUBS:
                raise SnsError(f"登録できるのは{SNS_MAX_SUBS}件までです。")

            found = await self._sns.lookup(platform, raw)

            if any(s["platform"] == platform and s["key"] == found["key"] for s in subs):
                raise SnsError("そのアカウントはすでに登録されています。")

            subs.append(
                {
                    "platform": platform,
                    "key": found["key"],
                    "name": found["name"],
                    "uid": found["uid"],
                    "seen": [item.id for item in found["items"]][-SNS_MAX_SEEN:],
                    "error": None,
                }
            )
            await store.update(guild_id, SNS_SECTION, subs=subs)

        return f"{SNS_PLATFORMS[platform]['label']}「{found['name']}」を追加しました。"


    async def sns_remove_subscription(self, guild_id: int, value: str) -> str:
        async with self.sns_lock(guild_id):
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_sns_settings(store, guild_id)
            kept = [s for s in settings["subs"] if f"{s['platform']}:{s['key']}"[:100] != value]
            if len(kept) == len(settings["subs"]):
                return "⚠️ 対象のアカウントはすでに解除されています。"
            await store.update(guild_id, SNS_SECTION, subs=kept)
        return "登録を解除しました。"


    async def sns_toggle_github_option(self, guild_id: int, key: str, kind: str) -> str:
        if kind not in SNS_GITHUB_KINDS:
            raise SnsError("通知の種類が正しくありません。")
        async with self.sns_lock(guild_id):
            store = guild_settings.get_store()
            await store.ensure_loaded()
            settings = get_sns_settings(store, guild_id)
            subs = [dict(s) for s in settings["subs"]]
            target = next(
                (s for s in subs if s["platform"] == "github" and s["key"] == key), None
            )
            if target is None:
                return "⚠️ 対象のリポジトリはすでに解除されています。"
            options = normalize_github_options(target.get("options"))
            options[kind] = not options[kind]
            target["options"] = options
            await store.update(guild_id, SNS_SECTION, subs=subs)
        state = "オン" if options[kind] else "オフ"
        return f"GitHub「{key}」の{SNS_GITHUB_KINDS[kind]}通知を{state}にしました。"


    @tasks.loop(seconds=SNS_POLL_SECONDS)
    async def sns_poll(self):
        store = guild_settings.get_store()
        await store.ensure_loaded()
        cache: dict[tuple, object] = {}

        for guild in list(self.bot.guilds):
            try:
                await self._sns_poll_guild(guild, store, cache)
            except Exception:
                logger.exception("SNS通知の巡回に失敗しました (guild=%s)", guild.id)


    @sns_poll.before_loop
    async def _sns_poll_before(self):
        await self.bot.wait_until_ready()


    @sns_poll.error
    async def _sns_poll_error(self, error: BaseException):
        logger.error("SNS通知の巡回ループが異常終了しました", exc_info=error)


    async def _sns_poll_guild(self, guild: discord.Guild, store, cache: dict):
        settings = get_sns_settings(store, guild.id)
        if not (settings["enabled"] and settings["channel_id"] and settings["subs"]):
            return

        channel = guild.get_channel(settings["channel_id"])
        me = guild.me
        if not isinstance(channel, (discord.TextChannel,)) or me is None:
            return
        perms = channel.permissions_for(me)
        if not (perms.view_channel and perms.send_messages):
            logger.warning("SNS通知の送信先に投稿できません (guild=%s channel=%s)", guild.id, channel.id)
            return

        role_id = settings["role_id"]
        mentions = discord.AllowedMentions(
            everyone=False,
            users=False,
            roles=[discord.Object(id=role_id)] if role_id else False,
        )

        updates: dict[tuple[str, str], dict] = {}

        for sub in settings["subs"]:
            ident = (sub["platform"], sub["key"])
            seen = list(sub["seen"])
            since = sns_x_since_id(seen) if sub["platform"] == "x" else None
            cache_key = (sub["platform"], sub["key"], since)

            if cache_key not in cache:
                try:
                    cache[cache_key] = await self._sns.poll(sub)
                except SnsError as exc:
                    cache[cache_key] = exc
                except Exception:
                    logger.exception("SNS取得で予期しないエラー (%s)", ident)
                    cache[cache_key] = SnsError("取得中に内部エラーが発生しました。")

            result = cache[cache_key]
            if isinstance(result, SnsError):
                logger.warning("SNS取得に失敗 (guild=%s %s): %s", guild.id, ident, result)
                updates[ident] = {"error": str(result)[:200]}
                continue

            items, uid = result
            seen_set = set(seen)
            fresh = [i for i in items if i.id not in seen_set]
            fresh.reverse()
            fresh.sort(key=lambda i: sns_epoch(i.published) or 0)

            if sub["platform"] == "youtube":
                # ライブ/通常動画の設定で振り分け。対象外は既読にして再通知しない。
                skipped = [i for i in fresh if not sns_youtube_kind_allowed(i, settings)]
                seen.extend(i.id for i in skipped)
                fresh = [i for i in fresh if sns_youtube_kind_allowed(i, settings)]

            if len(fresh) > SNS_MAX_SEND_PER_CYCLE:
                seen.extend(i.id for i in fresh[:-SNS_MAX_SEND_PER_CYCLE])
                fresh = fresh[-SNS_MAX_SEND_PER_CYCLE:]

            live_role_id = settings.get("live_role_id") or role_id
            live_mentions = discord.AllowedMentions(
                everyone=False,
                users=False,
                roles=[discord.Object(id=live_role_id)] if live_role_id else False,
            )

            error = None
            for item in fresh:
                try:
                    await channel.send(
                        view=SnsNotifyMessage(
                            sub, item, live_role_id if item.live else role_id,
                        ),
                        allowed_mentions=live_mentions if item.live else mentions,
                    )
                except (discord.Forbidden, discord.HTTPException) as exc:
                    logger.warning("SNS通知の送信に失敗 (guild=%s %s): %s", guild.id, ident, exc)
                    error = "通知メッセージの送信に失敗しました。Botの権限を確認してください。"
                    break
                seen.append(item.id)

            updates[ident] = {
                "seen": seen[-SNS_MAX_SEEN:],
                "error": error,
                "uid": uid or sub.get("uid"),
            }

        if not updates:
            return

        async with self.sns_lock(guild.id):
            latest = get_sns_settings(store, guild.id)
            subs = [dict(s) for s in latest["subs"]]
            dirty = False
            for sub in subs:
                patch = updates.get((sub["platform"], sub["key"]))
                if not patch:
                    continue
                for key, value in patch.items():
                    if sub.get(key) != value:
                        sub[key] = value
                        dirty = True
            if dirty:
                await store.update(guild.id, SNS_SECTION, subs=subs)
