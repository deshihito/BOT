import discord  # noqa: F401  (tests patch cogs.sio_saito.discord)
from discord.ext import commands  # noqa: F401

from core.voice.saito import _RelaySink, SaitoRelay  # noqa: F401


async def setup(bot):
    await bot.add_cog(SaitoRelay(bot))
