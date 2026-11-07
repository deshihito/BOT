"""Slim entry point for the clan cog.

The implementation lives in core.game.clan.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.clan keep working."
"""
from core.game.clan.cog import (
    annotations,
    asyncio,
    logging,
    discord,
    commands,
    tasks,
    config,
    clan_core,
    prison_core,
    cached_display_name,
    resolve_display_names,
    as_panel_v2,
    edit_panel_v2,
    wallet_module,
    logger,
    CLAN_COLOR,
    _wrap,
    clan_embed,
    ClanView,
    CreateClanModal,
    JoinClanView,
    CodeJoinModal,
    RenameClanModal,
    InviteCodeView,
    KickMemberView,
    ClanCog,
    setup,
)
