"""Bot に登録されているコマンドを調べて、共通の「コマンドカタログ」を作る。

カタログは /help と、Web サイト向けの書き出し（tools/export_commands.py）の両方で使う。
コマンド名・種類・説明・オプション・権限・サーバー限定かどうか・別名は Bot から自動で読み取り、
カテゴリ・使い方・非表示・ガイドなど人が決める情報は core/help/help/command_meta.py から合わせる。

形式（TYPETA の Web サイトと合意したもの）::

    {
      "generated_at": "2026-10-12T03:00:00+00:00",
      "categories": [{"id", "label", "description", "guide"}],
      "commands": [{
        "name": "wallet history",        # グループ名を含めた名前（先頭の / や ! は付けない）
        "kind": "slash" | "prefix",
        "category": "economy",
        "summary": "…", "usage": "/wallet history",
        "options": [{"name", "type", "required", "description"}],
        "permissions": ["manage_messages", …],   # Discord の権限名。Bot の持ち主だけなら "owner"
        "guild_only": true, "aliases": [], "hidden": false,
        "guide": "Markdown" | null
      }]
    }
"""

from __future__ import annotations

import inspect
import typing
from datetime import datetime, timezone

import discord
from discord import app_commands
from discord.ext import commands

from core.help.help import command_meta
KINDS = ("slash", "prefix")
PREFIX = "!"
OTHER_CATEGORY = {
    "id": "other",
    "label": "その他",
    "description": "まだカテゴリが決まっていないコマンドです。",
    "guide": None,
}

# /help で表示する権限名（Discord の権限名 → 日本語）
PERMISSION_LABELS = {
    "administrator": "管理者",
    "manage_guild": "サーバー管理",
    "manage_channels": "チャンネルの管理",
    "manage_messages": "メッセージの管理",
    "manage_roles": "ロールの管理",
    "manage_webhooks": "ウェブフックの管理",
    "moderate_members": "メンバーをタイムアウト",
    "kick_members": "メンバーをキック",
    "ban_members": "メンバーをBAN",
    "view_channel": "チャンネルを見る",
    "send_messages": "メッセージの送信",
    "embed_links": "埋め込みリンク",
    "attach_files": "ファイルの添付",
    "add_reactions": "リアクションの追加",
    "read_message_history": "メッセージ履歴を読む",
    "connect": "ボイスチャンネルに接続",
    "speak": "ボイスチャンネルで発言",
    "owner": "Bot の持ち主",
    "bot_admin": "Bot の管理者",
}

# オプションの型（Discord の型名 → 日本語）。usage の表示に使う
TYPE_LABELS = {
    "string": "文字",
    "integer": "整数",
    "number": "数値",
    "boolean": "はい/いいえ",
    "user": "ユーザー",
    "channel": "チャンネル",
    "role": "ロール",
    "mentionable": "ユーザー/ロール",
    "attachment": "ファイル",
    "flags": "オプション",
}


def command_key(kind: str, name: str) -> str:
    """command_meta で使うキー（"/wallet" や "!gvc join"）。"""
    return ("/" if kind == "slash" else PREFIX) + name


def permission_label(name: str) -> str:
    return PERMISSION_LABELS.get(name, name)


# ---------------------------------------------------------------- 権限の読み取り
def _flag_names(permissions: discord.Permissions | None) -> list[str]:
    if permissions is None:
        return []
    return [name for name, value in permissions if value]


def _check_info(check) -> tuple[list[str], bool]:
    """チェック関数から (必要な権限, サーバー限定か) を読み取る。読み取れないものは無視する。"""
    qualname = getattr(check, "__qualname__", "")
    owner = qualname.split(".<locals>")[0]
    if owner in ("has_permissions", "has_guild_permissions"):
        try:
            perms = inspect.getclosurevars(check).nonlocals.get("perms") or {}
        except (TypeError, ValueError):
            perms = {}
        return [name for name, value in perms.items() if value], owner == "has_guild_permissions"
    if owner == "is_owner":
        return ["owner"], False
    if owner == "guild_only":
        return [], True
    return [], False


def _merge_unique(*lists) -> list[str]:
    out: list[str] = []
    for items in lists:
        for item in items or []:
            if item not in out:
                out.append(item)
    return out


# ---------------------------------------------------------------- スラッシュコマンド
def _slash_root(command):
    root = command
    while getattr(root, "parent", None) is not None:
        root = root.parent
    return root


def _clean_description(text: str | None) -> str:
    text = (text or "").strip()
    return "" if text in ("…", "...") else text


def _slash_option(parameter) -> dict:
    description = _clean_description(parameter.description)
    extras = []
    if parameter.min_value is not None or parameter.max_value is not None:
        low = "" if parameter.min_value is None else f"{parameter.min_value:g}"
        high = "" if parameter.max_value is None else f"{parameter.max_value:g}"
        if f"{low}〜{high}" not in description:
            extras.append(f"{low}〜{high}")
    if parameter.choices:
        extras.append("選択肢: " + " / ".join(str(choice.name) for choice in parameter.choices))
    if extras:
        description = f"{description}（{'、'.join(extras)}）" if description else "、".join(extras)
    return {
        "name": parameter.display_name,
        "type": parameter.type.name,
        "required": bool(parameter.required),
        "description": description,
    }


def _slash_usage(name: str, options: list[dict]) -> str:
    parts = [f"/{name}"]
    for option in options:
        label = f"{option['name']}:<{TYPE_LABELS.get(option['type'], option['type'])}>"
        parts.append(label if option["required"] else f"[{label}]")
    return " ".join(parts)


def _slash_entry(command: app_commands.Command) -> dict:
    root = _slash_root(command)
    permissions: list[str] = _flag_names(root.default_permissions)
    guild_only = bool(getattr(root, "guild_only", False))
    contexts = getattr(root, "allowed_contexts", None)
    if contexts is not None and contexts.guild and not (contexts.dm_channel or contexts.private_channel):
        guild_only = True
    node = command
    while node is not None:
        for check in getattr(node, "checks", []):
            perms, only = _check_info(check)
            permissions = _merge_unique(permissions, perms)
            guild_only = guild_only or only
        node = getattr(node, "parent", None)
    options = [_slash_option(p) for p in command.parameters]
    return {
        "name": command.qualified_name,
        "kind": "slash",
        "summary": _clean_description(command.description),
        "usage": _slash_usage(command.qualified_name, options),
        "options": options,
        "permissions": permissions,
        "guild_only": guild_only,
        "aliases": [],
        "hidden": False,
    }


# ---------------------------------------------------------------- プレフィックスコマンド
def _annotation_type(annotation) -> str:
    origin = typing.get_origin(annotation)
    if origin is typing.Union or str(origin) == "types.UnionType":
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _annotation_type(args[0]) if args else "string"
    if origin is commands.Greedy:
        return _annotation_type(typing.get_args(annotation)[0])
    if inspect.isclass(annotation):
        if issubclass(annotation, commands.FlagConverter):
            return "flags"
        if annotation is bool:
            return "boolean"
        if annotation is int:
            return "integer"
        if annotation is float:
            return "number"
        if issubclass(annotation, (discord.Member, discord.User, discord.ClientUser)):
            return "user"
        if issubclass(annotation, discord.Role):
            return "role"
        if issubclass(annotation, (discord.abc.GuildChannel, discord.Thread)):
            return "channel"
        if issubclass(annotation, discord.Attachment):
            return "attachment"
    return "string"


def _prefix_summary(command: commands.Command) -> str:
    for text in (command.brief, command.short_doc, command.description):
        text = (text or "").strip()
        if text:
            return text.splitlines()[0]
    return ""


def _prefix_entry(command: commands.Command) -> dict:
    # プレフィックスコマンドは互換性・管理用に残すが、公開ヘルプには載せない。
    # hidden は /help の一覧・候補・通常の詳細検索すべてで共通して使われる。
    permissions: list[str] = []
    guild_only = False
    node = command
    while node is not None:
        for check in node.checks:
            perms, only = _check_info(check)
            permissions = _merge_unique(permissions, perms)
            guild_only = guild_only or only
        node = node.parent
    options = []
    for name, parameter in command.clean_params.items():
        options.append({
            "name": name,
            "type": _annotation_type(parameter.annotation),
            "required": bool(parameter.required),
            "description": (parameter.description or "").strip(),
        })
    signature = command.signature
    usage = f"{PREFIX}{command.qualified_name}" + (f" {signature}" if signature else "")
    return {
        "name": command.qualified_name,
        "kind": "prefix",
        "summary": _prefix_summary(command),
        "usage": usage,
        "options": options,
        "permissions": permissions,
        "guild_only": guild_only,
        "aliases": list(command.aliases),
        "hidden": True,
    }


# ---------------------------------------------------------------- カタログ
def registered_commands(bot: commands.Bot) -> dict[str, object]:
    """Bot に登録されている実行できるコマンド（"/name" / "!name" → コマンド）。"""
    found: dict[str, object] = {}
    for command in bot.tree.walk_commands():
        if not isinstance(command, app_commands.Group):
            found[command_key("slash", command.qualified_name)] = command
    for command in bot.walk_commands():
        found[command_key("prefix", command.qualified_name)] = command
    return found


def _apply_meta(entry: dict, meta: dict) -> dict:
    for field in ("summary", "usage"):
        if meta.get(field):
            entry[field] = meta[field]
    option_notes = meta.get("options") or {}
    for option in entry["options"]:
        if not option["description"] and option_notes.get(option["name"]):
            option["description"] = option_notes[option["name"]]
    entry["permissions"] = _merge_unique(entry["permissions"], meta.get("permissions"))
    if meta.get("guild_only"):
        entry["guild_only"] = True
    entry["hidden"] = bool(meta.get("hidden", entry["hidden"]))
    entry["category"] = meta.get("category")
    entry["guide"] = command_meta.resolve_guide(meta)
    return entry


def build_catalog(bot: commands.Bot, *, meta: dict | None = None, categories: list | None = None,
                  now: datetime | None = None) -> dict:
    """Bot からカタログを作る。カテゴリが決まっていないコマンドは「その他」にまとめる。"""
    meta = command_meta.COMMAND_META if meta is None else meta
    categories = [dict(c) for c in (command_meta.CATEGORIES if categories is None else categories)]
    category_ids = [c["id"] for c in categories]
    entries = []
    for key, command in registered_commands(bot).items():
        entry = _slash_entry(command) if key.startswith("/") else _prefix_entry(command)
        entry = _apply_meta(entry, meta.get(key, {}))
        if entry["category"] not in category_ids:
            entry["category"] = OTHER_CATEGORY["id"]
        entries.append(entry)
    if any(e["category"] == OTHER_CATEGORY["id"] for e in entries) and OTHER_CATEGORY["id"] not in category_ids:
        categories.append(dict(OTHER_CATEGORY))
        category_ids.append(OTHER_CATEGORY["id"])
    order = {cid: index for index, cid in enumerate(category_ids)}
    entries.sort(key=lambda e: (order[e["category"]], e["name"], KINDS.index(e["kind"])))
    for category in categories:
        category.setdefault("guide", None)
        category["guide"] = category["guide"] or None
    ordered = [{field: e[field] for field in COMMAND_FIELDS} for e in entries]
    return {
        "generated_at": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
        "categories": [{field: c.get(field) for field in CATEGORY_FIELDS} for c in categories],
        "commands": ordered,
    }


CATEGORY_FIELDS = ("id", "label", "description", "guide")
COMMAND_FIELDS = ("name", "kind", "category", "summary", "usage", "options", "permissions",
                  "guild_only", "aliases", "hidden", "guide")
OPTION_FIELDS = ("name", "type", "required", "description")


def visible_commands(catalog: dict, category: str | None = None) -> list[dict]:
    return [c for c in catalog["commands"]
            if not c["hidden"] and (category is None or c["category"] == category)]


def find_command(catalog: dict, query: str, *, include_hidden: bool = False) -> dict | None:
    """"/wallet"・"!gvc join"・"wallet" のような文字からコマンドを探す。完全一致だけ。"""
    query = " ".join((query or "").split())
    if not query:
        return None
    pool = catalog["commands"] if include_hidden else visible_commands(catalog)
    for command in pool:
        if command_key(command["kind"], command["name"]) == query:
            return command
    bare = query.lstrip("/!").strip()
    # 先頭に "/" か "!" がある場合はその種別だけを探す（"!vc" でスラッシュの
    # "/vc" がヒットするような、種別をまたいだ一致はしない）
    if query.startswith("/"):
        kinds = ("slash",)
    elif query.startswith("!"):
        kinds = ("prefix",)
    else:
        kinds = KINDS
    matches = [c for c in pool if c["name"] == bare and c["kind"] in kinds]
    matches.sort(key=lambda c: KINDS.index(c["kind"]))  # 同じ名前ならスラッシュを優先
    return matches[0] if matches else None


def validate_catalog(catalog: dict) -> list[str]:
    """形式に合っているかを調べて、問題点の一覧を返す（空なら合格）。"""
    problems = []

    def expect(condition, message):
        if not condition:
            problems.append(message)

    expect(set(catalog) == {"generated_at", "categories", "commands"}, f"最上位のキーが違います: {sorted(catalog)}")
    try:
        datetime.fromisoformat(catalog.get("generated_at", ""))
    except (TypeError, ValueError):
        problems.append("generated_at が ISO 8601 ではありません")
    ids = []
    for category in catalog.get("categories", []):
        expect(set(category) == set(CATEGORY_FIELDS), f"カテゴリのキーが違います: {category}")
        expect(isinstance(category.get("id"), str) and category.get("id"), f"カテゴリ id が空です: {category}")
        expect(isinstance(category.get("label"), str) and category.get("label"), f"label が空です: {category.get('id')}")
        expect(isinstance(category.get("description"), str), f"description が文字ではありません: {category.get('id')}")
        expect(category.get("guide") is None or isinstance(category.get("guide"), str), f"guide の型: {category.get('id')}")
        ids.append(category.get("id"))
    expect(len(ids) == len(set(ids)), f"カテゴリ id が重複しています: {ids}")
    seen = set()
    for command in catalog.get("commands", []):
        label = f"{command.get('kind')}:{command.get('name')}"
        expect(set(command) == set(COMMAND_FIELDS), f"{label}: キーが違います: {sorted(command)}")
        expect(command.get("kind") in KINDS, f"{label}: kind が不正です")
        expect(isinstance(command.get("name"), str) and command.get("name"), f"{label}: name が空です")
        expect(command.get("category") in ids, f"{label}: category {command.get('category')!r} がありません")
        for field in ("summary", "usage"):
            expect(isinstance(command.get(field), str), f"{label}: {field} が文字ではありません")
        for field in ("guild_only", "hidden"):
            expect(isinstance(command.get(field), bool), f"{label}: {field} が真偽値ではありません")
        for field in ("permissions", "aliases"):
            expect(isinstance(command.get(field), list) and all(isinstance(x, str) for x in command.get(field, [])),
                   f"{label}: {field} が文字のリストではありません")
        expect(command.get("guide") is None or isinstance(command.get("guide"), str), f"{label}: guide の型")
        for option in command.get("options", []) if isinstance(command.get("options"), list) else [None]:
            ok = (isinstance(option, dict) and set(option) == set(OPTION_FIELDS)
                  and isinstance(option["name"], str) and isinstance(option["type"], str)
                  and isinstance(option["required"], bool) and isinstance(option["description"], str))
            expect(ok, f"{label}: options の形式が違います: {option}")
        expect((command.get("kind"), command.get("name")) not in seen, f"{label}: 重複しています")
        seen.add((command.get("kind"), command.get("name")))
    return problems
