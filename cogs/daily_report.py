"""Slim entry point for the daily_report cog.

The implementation lives in core.support.daily_report.cog; this module only
re-exports its names so existing imports and patch targets on
cogs.daily_report keep working."
"""
from core.support.daily_report.cog import (
    annotations,
    asyncio,
    logging,
    datetime,
    discord,
    commands,
    tasks,
    config,
    report_core,
    wallet_module,
    logger,
    DailyReportCog,
    setup,
)
