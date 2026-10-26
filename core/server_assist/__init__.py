"""ProBot-compatible server assist features, grouped under /support.

Each feature lives in ``core.server_assist.features`` and exports a
``FEATURE`` object plus optional event hooks.  The small registry below lets
us add a feature without adding another top-level slash command.
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass, replace
from typing import Any

from core import guild_settings

logger = logging.getLogger(__name__)

SECTION_PREFIX = "assist_"
FEATURE_PACKAGE = "core.server_assist.features"


@dataclass(frozen=True)
class Feature:
    """A server-assist feature shown in the unified settings panel."""

    key: str
    label: str
    description: str
    order: int = 100
    module_name: str = ""

    def build_view(self, cog: Any, guild_id: int):
        module = importlib.import_module(self.module_name)
        factory = getattr(module, "build_view", None)
        if factory is None:
            raise RuntimeError(f"{self.module_name} に build_view がありません")
        return factory(cog, guild_id)


def section(key: str) -> str:
    return f"{SECTION_PREFIX}{key}"


def get_settings(guild_id: int, key: str) -> dict[str, Any]:
    return guild_settings.get_store().get(guild_id, section(key))


async def update_settings(guild_id: int, key: str, **values: Any) -> dict[str, Any]:
    return await guild_settings.get_store().update(guild_id, section(key), **values)


def has_manage_permission(interaction: Any) -> bool:
    permissions = getattr(getattr(interaction, "user", None), "guild_permissions", None)
    return bool(
        getattr(permissions, "administrator", False)
        or getattr(permissions, "manage_guild", False)
    )


def can_assign_roles(interaction: Any, guild: Any, role_ids: list[int]) -> bool:
    """Check that the actor can actually manage the configured roles."""
    permissions = getattr(getattr(interaction, "user", None), "guild_permissions", None)
    if getattr(permissions, "administrator", False):
        return True
    if not getattr(permissions, "manage_roles", False):
        return False
    top_role = getattr(getattr(interaction, "user", None), "top_role", None)
    if top_role is None:
        return True
    for role_id in role_ids:
        role = guild.get_role(int(role_id)) if guild is not None else None
        if role is None:
            continue
        try:
            if role >= top_role:
                return False
        except TypeError:
            continue
    return True


def format_template(template: str, member: Any, guild: Any) -> str:
    """Replace the small, documented placeholder set without str.format.

    str.format would let user supplied templates raise KeyError/IndexError and
    would also expose object attributes.  This replacement is deliberately
    literal and safe.
    """
    text = template if isinstance(template, str) and template.strip() else ""
    values = {
        "{user}": getattr(member, "mention", None) or f"<@{getattr(member, 'id', 0)}>",
        "{name}": getattr(member, "display_name", None) or getattr(member, "name", "メンバー"),
        "{id}": str(getattr(member, "id", "")),
        "{server}": getattr(guild, "name", "サーバー"),
        "{count}": str(getattr(guild, "member_count", "") or ""),
    }
    for placeholder, value in values.items():
        text = text.replace(placeholder, str(value))
    return text[:2000]


_features: list[Feature] | None = None


def discover_features(*, refresh: bool = False) -> list[Feature]:
    """Import every feature module once and return them in display order."""
    global _features
    if _features is not None and not refresh:
        return list(_features)

    try:
        package = importlib.import_module(FEATURE_PACKAGE)
    except Exception:
        logger.exception("サーバーアシスト機能のパッケージを読み込めませんでした")
        _features = []
        return []

    found: list[Feature] = []
    for info in sorted(pkgutil.iter_modules(package.__path__), key=lambda item: item.name):
        if info.name.startswith("_"):
            continue
        module_name = f"{FEATURE_PACKAGE}.{info.name}"
        try:
            module = importlib.import_module(module_name)
            feature = getattr(module, "FEATURE", None)
            if not isinstance(feature, Feature):
                logger.warning("%s に Feature が定義されていません", module_name)
                continue
            if not feature.module_name:
                feature = replace(feature, module_name=module_name)
            found.append(feature)
        except Exception:
            logger.exception("サーバーアシスト機能を読み込めませんでした: %s", module_name)
    _features = sorted(found, key=lambda item: (item.order, item.label))
    return list(_features)


def find_feature(key: str) -> Feature | None:
    for feature in discover_features():
        if feature.key == key:
            return feature
    return None
