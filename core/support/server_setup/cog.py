"""サーバーに入ったときのあいさつと、旧管理者向け初期設定画面の表示部品。

Slash の /setup コマンド登録は廃止済み。
  1. 認証: 付けるロール・自己紹介チャンネル・フォームの有効/無効（cogs/auth.py が使う）
  2. グローバルチャット: このチャンネルをつなぐ / 外す（cogs/globalchat.py の保存先をそのまま使う）
  3. ミュート管理ロール: muted.py が設定を保存できる場合だけ表示する
  4. 国づくり: 参加する/しない・お知らせチャンネル・通知の量（core.support.guild_settings.nation_settings で読める）
  5. まとめ: 設定内容と、機能ごとに Bot に足りない権限
設定は core/support/guild_settings.py（Supabase の bot_kv。使えないときはローカルの JSON）に保存する。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import discord
from discord.ext import commands

from core.channel_safety import is_hidden_channel
from core.help.help.command_catalog import permission_label
from core.support.emojis import BOOK, COIN, FAILED, GAME, GEAR, MUSIC, SUCCESS
from core.support.guild_settings import NATION_SECTION, NOTIFY_LEVELS, NOTIFY_MAJOR, get_store, nation_settings
from core.support.panel_v2 import as_panel_v2
from core.support.localization import localization
from core.support.panel_recovery.cog import build_panel

logger = logging.getLogger(__name__)

EMBED_COLOR = 0x5865F2

#: Discord の Embed フィールド値の上限。
FIELD_VALUE_LIMIT = 1024


def channel_list_text(channel_ids, limit: int = FIELD_VALUE_LIMIT) -> str:
    """チャンネルメンションの列挙をフィールド上限に収まる形で返す。

    全件を並べると 1024 字を超えて Embed 送信自体が失敗するため、
    収まる分だけ並べて残りは「…他N件」で示す。1件も収まらない場合は
    件数だけの表示にフォールバックする。
    """
    ids = list(channel_ids)
    if not ids:
        return "なし"
    shown: list[str] = []
    best = None
    for cid in ids:
        shown.append(cid)
        remaining = len(ids) - len(shown)
        suffix = f" …他{remaining}件" if remaining else ""
        candidate = " ".join(f"<#{c}>" for c in shown) + suffix
        if len(candidate) > limit:
            break
        best = candidate
    if best is not None:
        return best
    return f"{len(ids)}件のチャンネル"


# ---------------------------------------------------------------- あいさつ
def can_post(channel, me) -> bool:
    if channel is None or me is None:
        return False
    if is_hidden_channel(channel):
        # 閲覧できないチャンネルは権限フィールドも信頼できないため書き込めないものとして扱う
        return False
    perms = channel.permissions_for(me)
    return bool(perms.view_channel and perms.send_messages and perms.embed_links)


def pick_welcome_channel(guild):
    """システムチャンネル → 上から順のテキストチャンネルのうち、Bot が書き込める最初のもの。なければ None。"""
    me = getattr(guild, "me", None)
    system = getattr(guild, "system_channel", None)
    if can_post(system, me):
        return system
    for channel in sorted(getattr(guild, "text_channels", []), key=lambda c: (getattr(c, "position", 0), c.id)):
        if can_post(channel, me):
            return channel
    return None


def can_post_v2(channel, me) -> bool:
    """導入メッセージ（Components V2）専用の書き込み条件。Embed ではないため埋め込み権限は不要。"""
    if channel is None or me is None:
        return False
    if is_hidden_channel(channel):
        return False
    perms = channel.permissions_for(me)
    return bool(perms.view_channel and perms.send_messages)


def pick_welcome_channel_v2(guild):
    """pick_welcome_channel と同じ決定順で、V2 導入メッセージが送れる最初のチャンネル。なければ None。"""
    me = getattr(guild, "me", None)
    system = getattr(guild, "system_channel", None)
    if can_post_v2(system, me):
        return system
    for channel in sorted(getattr(guild, "text_channels", []), key=lambda c: (getattr(c, "position", 0), c.id)):
        if can_post_v2(channel, me):
            return channel
    return None


# ---------------------------------------------------------------- 導入メッセージ (v2)
#: 導入メッセージの保存先セクション（guild_settings）。
ONBOARDING_SECTION = "onboarding"
#: 導入メッセージの版。文面・構成を改訂したら上げる（自動再送には使わない）。
WELCOME_VERSION = 2
#: 同一参加イベントの二重発火・再送ループを防ぐガード幅。
WELCOME_RESEND_GUARD = timedelta(minutes=10)

SITE_URL = "https://agobot.app"
SUPPORT_SERVER_URL = "https://discord.gg/dCAQzJUaa9"

#: welcome:* ボタンのうち、ルートパネルを開くもの（ボタン名 -> (root, 案内用コマンド名)）。
_WELCOME_PANELS = {
    "game": ("game", "/game"),
    "music": ("vc", "/vc"),
    "help": ("help", "/help"),
    "support": ("support", "/support"),
}


def welcome_stats() -> Optional[dict]:
    """見出しの数字を単一の真実（レジストリ等）から算出する。失敗時は None（数字の節ごと省略する）。

    導入メッセージで示すのは総量だけ（コマンド数・機能総数・ゲーム数）。
    個別機能の数字は出さない（文面方針 2026-11-07）。
    """
    try:
        from core.general.action_registry import ROOT_ORDER, default_registry
        from core.game.game.game_guides import GAME_ORDER

        return {
            "commands": len(ROOT_ORDER) + 1,  # 5ルート + /quick
            "actions": len(default_registry()),
            "games": len(GAME_ORDER),
        }
    except Exception:
        logger.warning("導入メッセージの数字生成に失敗しました（数字なしで送信します）", exc_info=True)
        return None


def _welcome_texts(locale: str) -> dict:
    """導入メッセージの確定文（ja / en の2版のみ。他ロケールは ja 版で送る）。"""
    if localization.normalize_locale(locale) == "en":
        return {
            "title": "## 👋 Thanks for adding {bot_name}!",
            "catchphrase": "One bot for everything you want to do.",
            "stats": "-# {commands} commands · {actions} features · {games} games",
            "body": (
                "Just pick from buttons and panels — no setup required to start.\n"
                "Reach your favorite features instantly with /quick, and manage server settings from the web dashboard too."
            ),
            "missing_permissions": f'-# {FAILED} Some permissions are missing. See "Check permissions" for details.',
            "footer": f"-# [Terms]({SITE_URL}/terms) ・ [Privacy]({SITE_URL}/privacy) ・ Run /help if you get stuck",
            "labels": {
                "game": "Games", "money": "Money", "music": "Music", "help": "How to use",
                "support": "Server settings", "permissions": "Check permissions",
                "site": "Official site", "dashboard": "Web dashboard", "support_server": "Support server",
            },
            "placeholder": "🌐 Language / 言語",
            "locale_descriptions": {"ja": "Default (Japanese)", "en": "Some screens in English", "other": "Coming soon (shown in Japanese)"},
        }
    return {
        "title": "## 👋 {bot_name} を追加してくれてありがとう！",
        "catchphrase": "使いたいこと、全部このボットでいい。",
        "stats": "-# コマンド{commands}つ ・ 機能{actions} ・ ゲーム{games}種",
        "body": (
            "操作はボタンとパネルで選ぶだけ。設定なしでも使い始められます。\n"
            "よく使う機能は /quick からすぐ呼び出せて、サーバーの設定は Webダッシュボードからもできます。"
        ),
        "missing_permissions": f"-# {FAILED} 不足している権限があります。「権限チェック」で詳細が見られます",
        "footer": f"-# [利用規約]({SITE_URL}/terms) ・ [プライバシーポリシー]({SITE_URL}/privacy) ・ 困ったときは /help",
        "labels": {
            "game": "ゲーム", "money": "マネー", "music": "音楽", "help": "使い方",
            "support": "サーバー設定", "permissions": "権限チェック",
            "site": "公式サイト", "dashboard": "Webで設定", "support_server": "サポートサーバー",
        },
        "placeholder": "🌐 言語 / Language",
        "locale_descriptions": {"ja": "標準", "en": "一部の表示が英語になります", "other": "準備中（表示は日本語）"},
    }


def _app_emoji(markup: str):
    try:
        return discord.PartialEmoji.from_str(markup)
    except Exception:
        return None


class WelcomeView(discord.ui.LayoutView):
    """導入メッセージ本体（Components V2・単一 Container）。

    状態を持たない見た目だけの器。ボタン／セレクトの実処理は ServerSetup の
    on_interaction リスナーが固定 custom_id ``welcome:*`` で受けるため、
    Bot が再起動しても押せる（認証パネルと同じ方式）。
    """

    def __init__(self, bot_name: str = "AGOBOT", locale: str = localization.DEFAULT_LOCALE, *,
                 guild_id: Optional[int] = None, stats: Optional[dict] = None,
                 permissions_button: bool = False, missing_permissions: bool = False):
        super().__init__(timeout=None)
        locale = localization.normalize_locale(locale)
        texts = _welcome_texts(locale)
        labels = texts["labels"]
        if stats is None:
            stats = welcome_stats()

        heading = [texts["title"].format(bot_name=bot_name), texts["catchphrase"]]
        if stats:
            heading.append(texts["stats"].format(**stats))
        items: list = [discord.ui.TextDisplay("\n".join(heading)), discord.ui.Separator()]

        body = texts["body"]
        if missing_permissions:
            body = f"{body}\n{texts['missing_permissions']}"
        items.append(discord.ui.TextDisplay(body))
        if locale not in ("ja", "en"):
            # 選べるが表示は日本語のままであることを、その場で正直に出す。
            items.append(discord.ui.TextDisplay(f"-# {localization.text('language_support_note', 'ja')}"))

        items.append(discord.ui.ActionRow(
            discord.ui.Button(label=labels["game"], style=discord.ButtonStyle.primary,
                              custom_id="welcome:game", emoji=_app_emoji(GAME)),
            discord.ui.Button(label=labels["money"], style=discord.ButtonStyle.primary,
                              custom_id="welcome:money", emoji=_app_emoji(COIN)),
            discord.ui.Button(label=labels["music"], style=discord.ButtonStyle.primary,
                              custom_id="welcome:music", emoji=_app_emoji(MUSIC)),
            discord.ui.Button(label=labels["help"], style=discord.ButtonStyle.primary,
                              custom_id="welcome:help", emoji=_app_emoji(BOOK)),
        ))
        admin_row = [
            discord.ui.Button(label=labels["support"], style=discord.ButtonStyle.secondary,
                              custom_id="welcome:support", emoji=_app_emoji(GEAR)),
        ]
        if permissions_button:
            admin_row.append(
                discord.ui.Button(label=labels["permissions"], style=discord.ButtonStyle.secondary,
                                  custom_id="welcome:permissions", emoji=_app_emoji(SUCCESS)))
        items.append(discord.ui.ActionRow(*admin_row))

        descriptions = texts["locale_descriptions"]
        select = discord.ui.Select(
            custom_id="welcome:language",
            placeholder=texts["placeholder"],
            options=[
                discord.SelectOption(
                    label=localization.LOCALE_LABELS[loc],
                    value=loc,
                    emoji=localization.LOCALE_FLAGS[loc],
                    description=descriptions.get(loc, descriptions["other"]),
                    default=loc == locale,
                )
                for loc in localization.SUPPORTED_LOCALES
            ],
            min_values=1, max_values=1,
        )
        items.append(discord.ui.ActionRow(select))
        items.append(discord.ui.Separator())

        dashboard_url = f"{SITE_URL}/dashboard/{guild_id}" if guild_id else f"{SITE_URL}/dashboard"
        items.append(discord.ui.ActionRow(
            discord.ui.Button(label=labels["site"], style=discord.ButtonStyle.link, url=SITE_URL),
            discord.ui.Button(label=labels["dashboard"], style=discord.ButtonStyle.link, url=dashboard_url),
            discord.ui.Button(label=labels["support_server"], style=discord.ButtonStyle.link, url=SUPPORT_SERVER_URL),
        ))
        items.append(discord.ui.TextDisplay(texts["footer"]))
        self.add_item(discord.ui.Container(*items, accent_colour=EMBED_COLOR))


def build_welcome_view(bot_name: str = "AGOBOT", locale: str = localization.DEFAULT_LOCALE, **kwargs) -> WelcomeView:
    return WelcomeView(bot_name, locale, **kwargs)


def _welcomed_recently(onboarding: dict, now: Optional[datetime] = None) -> bool:
    """直近（WELCOME_RESEND_GUARD 以内）に送っていれば True（再送ガード）。"""
    raw = (onboarding or {}).get("welcomed_at")
    if not isinstance(raw, str):
        return False
    try:
        welcomed_at = datetime.fromisoformat(raw)
    except ValueError:
        return False
    if welcomed_at.tzinfo is None:
        welcomed_at = welcomed_at.replace(tzinfo=timezone.utc)
    return (now or datetime.now(timezone.utc)) - welcomed_at < WELCOME_RESEND_GUARD


# ---------------------------------------------------------------- 権限チェック
def _missing(perms, names) -> list[str]:
    return [name for name in names if not getattr(perms, name, False)]


def _channel_missing(channel, me, names) -> list[str]:
    """チャンネルに対する不足権限。隠しチャンネルは権限フィールドが
    信頼できないため、閲覧権限が常に不足しているものとして扱う。"""
    missing = _missing(channel.permissions_for(me), names)
    if is_hidden_channel(channel) and "view_channel" in names and "view_channel" not in missing:
        missing.append("view_channel")
    return missing


def check_permissions(guild, channel, *, auth: dict, global_channel_ids=(), mute_supported: bool = True,
                      nation: Optional[dict] = None) -> list[dict]:
    """機能ごとに、Bot に足りない権限を調べる。

    戻り値: [{"label": 機能名, "missing": [権限名(日本語)], "notes": [補足], "skipped": 未設定で確認しなかったか}]
    """
    me = guild.me
    guild_perms = me.guild_permissions
    results = []

    def add(label, missing=(), notes=(), skipped=False):
        results.append({
            "label": label,
            "missing": [permission_label(name) for name in missing],
            "notes": list(notes),
            "skipped": skipped,
        })

    # 基本（このチャンネル）
    add("基本（このチャンネル）", _missing(channel.permissions_for(me), ["view_channel", "send_messages", "embed_links"]))

    # 認証
    role = guild.get_role(auth["role_id"]) if auth.get("role_id") else None
    if not auth.get("enabled", True):
        add("認証", skipped=True, notes=["フォームは停止中です"])
    elif role is None:
        add("認証", skipped=True, notes=["付けるロールが未設定です"])
    else:
        missing = _missing(guild_perms, ["manage_roles"])
        notes = []
        if role >= me.top_role:
            notes.append(f"Bot のロールを「{role.name}」より上に移動してください")
        intro = guild.get_channel(auth["intro_channel_id"]) if auth.get("intro_channel_id") else None
        if intro is None:
            notes.append("自己紹介チャンネルが未設定です（自己紹介は投稿されません）")
        else:
            for name in _channel_missing(intro, me, ["view_channel", "manage_webhooks"]):
                if name not in missing:
                    missing.append(name)
        add("認証", missing, notes)

    # グローバルチャット
    channels = [c for c in (guild.get_channel(cid) for cid in global_channel_ids) if c is not None]
    if not channels:
        add("グローバルチャット", skipped=True, notes=["つないでいるチャンネルはありません"])
    else:
        missing = []
        for c in channels:
            for name in _channel_missing(c, me, ["view_channel", "manage_webhooks", "add_reactions"]):
                if name not in missing:
                    missing.append(name)
        add("グローバルチャット", missing)

    # ミュート
    if mute_supported:
        add("ミュート（/support）", _missing(guild_perms, ["manage_roles", "manage_channels"]))

    # 国づくり
    if nation is not None:
        target = guild.get_channel(nation["channel_id"]) if nation.get("channel_id") else None
        if not nation.get("enabled", True):
            add("国づくり", skipped=True, notes=["参加していません"])
        elif target is None:
            add("国づくり", skipped=True, notes=["お知らせチャンネルが未設定です"])
        else:
            add("国づくり", _channel_missing(target, me, ["view_channel", "send_messages", "embed_links"]))

    # ボイス
    add("ボイス・音楽", _missing(guild_perms, ["connect", "speak"]))
    return results


def format_permission_report(results: list[dict]) -> str:
    lines = []
    for r in results:
        if r["skipped"]:
            lines.append(f"➖ **{r['label']}**: 確認していません（{'・'.join(r['notes'])}）")
        elif r["missing"] or r["notes"]:
            parts = []
            if r["missing"]:
                parts.append("足りない権限: " + "、".join(r["missing"]))
            parts.extend(r["notes"])
            lines.append(f"{FAILED} **{r['label']}**: " + " / ".join(parts))
        else:
            lines.append(f"{SUCCESS} **{r['label']}**: OK")
    return "\n".join(lines)


# ---------------------------------------------------------------- 導入時の権限チェック
def check_onboarding_permissions(guild, channel) -> list[dict]:
    """導入時点専用の軽量権限チェック。「入れた直後に効くかどうか」の範囲だけを見る。

    check_permissions() は旧ウィザード専用の引数（認証設定・接続チャンネル等）を
    要求し、参加直後は未設定だらけになるため流用しない。部品（_missing /
    permission_label / 整形作法）だけを再利用する。
    戻り値は check_permissions と同じ形（skipped は常に False）。
    """
    me = guild.me
    guild_perms = me.guild_permissions
    results = []

    def add(label, missing=()):
        results.append({
            "label": label,
            "missing": [permission_label(name) for name in missing],
            "notes": [],
            "skipped": False,
        })

    add("基本（このチャンネル）", _missing(channel.permissions_for(me), ["view_channel", "send_messages"]))
    add("メッセージの管理（削除ログ・自動翻訳）", _missing(guild_perms, ["manage_messages"]))
    add("ウェブフックの管理（グローバルチャット・自動翻訳）", _missing(guild_perms, ["manage_webhooks"]))
    add("ロールの管理（認証・ミュート・ロールショップ）", _missing(guild_perms, ["manage_roles"]))
    add("チャンネルの管理", _missing(guild_perms, ["manage_channels"]))
    add("ボイス・音楽", _missing(guild_perms, ["connect", "speak"]))
    return results


def has_missing_permissions(results: list[dict]) -> bool:
    return any(r["missing"] for r in results)


def format_onboarding_report(results: list[dict]) -> str:
    return (format_permission_report(results)
            + "\n\n足りない権限は「サーバー設定 → ロール」で Bot のロールに付けてください")


class ServerSetup(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    def globalchat_cog(self):
        cog = self.bot.get_cog("GlobalChatCog")
        return cog if cog is not None and hasattr(cog, "active_channels") and hasattr(cog, "save_channels") else None

    def mute_cog(self):
        """muted.py の管理ロール（保存は muted.py 側の save が行う）。"""
        cog = self.bot.get_cog("Muted")
        return cog if cog is not None and hasattr(cog, "admin_roles") and callable(getattr(cog, "save", None)) else None

    # ---------------------------------------------------------------- 導入メッセージ
    def _saved_locale(self, guild_id: int) -> str:
        """保存済みロケール。未保存なら既定 ja（再参加時に上書きしないための読み取り）。"""
        try:
            raw = get_store().get(guild_id, localization.LANGUAGE_SECTION)
        except Exception:
            raw = None
        if isinstance(raw, dict) and raw.get("locale"):
            return localization.normalize_locale(raw["locale"])
        return localization.DEFAULT_LOCALE

    @commands.Cog.listener()
    async def on_guild_join(self, guild: discord.Guild):
        store = get_store()
        try:
            await store.ensure_loaded()
        except Exception:
            logger.debug("guild_settings の読み込みに失敗しました（導入メッセージは続行します）", exc_info=True)
        try:
            onboarding = store.get(guild.id, ONBOARDING_SECTION) or {}
        except Exception:
            onboarding = {}
        if _welcomed_recently(onboarding):
            logger.info("導入メッセージは直近に送信済みのためスキップします: guild=%s", guild.id)
            return
        channel = pick_welcome_channel_v2(guild)
        if channel is None:
            logger.info("あいさつを送れるチャンネルがありません: guild=%s", guild.id)
            return
        locale = self._saved_locale(guild.id)
        bot_name = getattr(self.bot.user, "name", None) or "AGOBOT"
        try:
            missing = has_missing_permissions(check_onboarding_permissions(guild, channel))
        except Exception:
            logger.debug("導入時の権限チェックに失敗しました（状態行なしで続行します）", exc_info=True)
            missing = False
        view = build_welcome_view(bot_name, locale, guild_id=guild.id,
                                  permissions_button=True, missing_permissions=missing)
        try:
            message = await channel.send(view=view)
        except discord.HTTPException:
            logger.warning("あいさつを送れませんでした: guild=%s", guild.id, exc_info=True)
            return
        message_id = getattr(message, "id", None)
        try:
            await store.update(
                guild.id,
                ONBOARDING_SECTION,
                welcome_message_id=message_id if isinstance(message_id, int) and not isinstance(message_id, bool) else None,
                channel_id=channel.id,
                welcomed_at=datetime.now(timezone.utc).isoformat(),
                version=WELCOME_VERSION,
            )
            if isinstance(message_id, int) and not isinstance(message_id, bool):
                # 言語変更の検証対象を新しい導入メッセージへ移す（locale 自体は触らない）。
                await store.update(guild.id, localization.LANGUAGE_SECTION, panel_message_id=message_id)
        except Exception:
            # 保存は冗長情報。失敗してもボタン・セレクトはメッセージIDに依存せず動作する。
            logger.warning("導入メッセージの保存に失敗しました: guild=%s", guild.id, exc_info=True)

    # ---------------------------------------------------------------- 導入メッセージの受け口
    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return
        data = interaction.data or {}
        custom_id = data.get("custom_id") or ""
        if not custom_id.startswith("welcome:"):
            return
        action = custom_id[len("welcome:"):]
        try:
            if action in _WELCOME_PANELS:
                root, command = _WELCOME_PANELS[action]
                await self._open_welcome_panel(interaction, root, command)
            elif action == "money":
                await self._open_welcome_money(interaction)
            elif action == "permissions":
                await self._handle_welcome_permissions(interaction)
            elif action == "language":
                await self._handle_welcome_language(interaction, data)
        except discord.InteractionResponded:
            logger.debug("welcome: 応答済みのため処理を中止しました (%s)", custom_id)
        except Exception:
            logger.exception("welcome: 処理に失敗しました (%s)", custom_id)
            try:
                if not interaction.response.is_done():
                    await interaction.response.send_message(
                        "処理に失敗しました。お手数ですが、コマンドから開き直してください。", ephemeral=True)
            except Exception:
                logger.debug("welcome: 失敗通知の送信にも失敗しました", exc_info=True)

    async def _open_welcome_panel(self, interaction: discord.Interaction, root: str, command: str):
        panel = build_panel(self.bot, root)
        if panel is None:
            await interaction.response.send_message(
                f"パネルを再表示できませんでした。お手数ですが、{command} コマンドを実行してください。",
                ephemeral=True)
            return
        await interaction.response.send_message(view=as_panel_v2(panel), ephemeral=True)

    async def _open_welcome_money(self, interaction: discord.Interaction):
        cog = self.bot.get_cog("GeneralCog")
        if cog is None:
            await interaction.response.send_message(
                "パネルを再表示できませんでした。お手数ですが、/general コマンドを実行してください。",
                ephemeral=True)
            return
        from core.general.panel import GeneralPanel

        panel = GeneralPanel(cog, genre="money", owner_id=interaction.user.id)
        await interaction.response.send_message(view=as_panel_v2(panel), ephemeral=True)

    async def _handle_welcome_permissions(self, interaction: discord.Interaction):
        guild = interaction.guild
        if guild is None:
            return
        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False)):
            message = ("Only server admins can run the permission check."
                       if self._saved_locale(guild.id) == "en"
                       else "権限チェックはサーバーの管理者だけが使えます。")
            await interaction.response.send_message(message, ephemeral=True)
            return
        results = check_onboarding_permissions(guild, interaction.channel)
        await interaction.response.send_message(format_onboarding_report(results), ephemeral=True)

    async def _handle_welcome_language(self, interaction: discord.Interaction, data: dict):
        guild_id = interaction.guild_id
        if guild_id is None:
            return
        permissions = getattr(interaction.user, "guild_permissions", None)
        if not (getattr(permissions, "administrator", False) or getattr(permissions, "manage_guild", False)):
            message = ("You need the Manage Server permission to change the language."
                       if self._saved_locale(guild_id) == "en"
                       else "言語の変更にはサーバー管理権限が必要です。")
            await interaction.response.send_message(message, ephemeral=True)
            return
        values = data.get("values") or []
        if not values:
            return
        locale = localization.normalize_locale(values[0])
        cog = self.bot.get_cog("LocalizationCog")
        if cog is not None and hasattr(cog, "set_locale"):
            await cog.set_locale(guild_id, locale)
        else:
            await get_store().update(guild_id, localization.LANGUAGE_SECTION, locale=locale)
        note = localization.text("language_saved", locale, language=localization.LOCALE_LABELS[locale])
        if locale not in ("ja", "en"):
            note = f"{note}\n{localization.text('language_support_note', 'ja')}"
            await interaction.response.send_message(note, ephemeral=True)
            return
        # ja / en は本体の文面も切り替える。
        bot_name = getattr(self.bot.user, "name", None) or "AGOBOT"
        missing = False
        if interaction.guild is not None and interaction.channel is not None:
            try:
                missing = has_missing_permissions(
                    check_onboarding_permissions(interaction.guild, interaction.channel))
            except Exception:
                logger.debug("言語切り替え時の権限チェックに失敗しました", exc_info=True)
        view = build_welcome_view(bot_name, locale, guild_id=guild_id,
                                  permissions_button=True, missing_permissions=missing)
        try:
            await interaction.response.edit_message(view=view)
        except discord.HTTPException:
            logger.info("導入メッセージの言語切り替え編集に失敗しました", exc_info=True)
            await interaction.response.send_message(note, ephemeral=True)
            return
        await interaction.followup.send(note, ephemeral=True)

async def setup(bot: commands.Bot):
    await bot.add_cog(ServerSetup(bot))
