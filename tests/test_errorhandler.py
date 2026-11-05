"""cogs/errorhandler.py のテスト（Discord には接続しない）。"""

import logging
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import discord  # noqa: E402
from discord import app_commands  # noqa: E402
from discord.ext import commands  # noqa: E402

from cogs import errorhandler as eh  # noqa: E402


def make_bot():
    intents = discord.Intents.none()
    return commands.Bot(command_prefix="!", intents=intents)


class Sample(commands.Cog):
    @commands.command(name="sample")
    async def sample(self, ctx, amount: int):
        """サンプル"""

    @commands.command(name="handled")
    async def handled(self, ctx):
        pass

    @handled.error
    async def handled_error(self, ctx, error):
        pass


class OwnHandlerCog(commands.Cog):
    async def cog_command_error(self, ctx, error):
        pass

    async def cog_app_command_error(self, interaction, error):
        pass

    @commands.command(name="own")
    async def own(self, ctx):
        pass


def fake_param(name="amount"):
    return types.SimpleNamespace(name=name, displayed_name=name)


class ClassifyTest(unittest.TestCase):
    def test_command_not_found_is_silent(self):
        self.assertEqual(eh.classify(commands.CommandNotFound('Command "wwww" is not found')), (None, False))
        self.assertEqual(eh.classify(app_commands.CommandNotFound("x", [])), (None, False))

    def test_not_owner_is_silent(self):
        self.assertEqual(eh.classify(commands.NotOwner()), (None, False))

    def test_cooldown(self):
        cooldown = commands.Cooldown(1, 10)
        message, unexpected = eh.classify(commands.CommandOnCooldown(cooldown, 3.25, commands.BucketType.user))
        self.assertIn("3.2", message)
        self.assertFalse(unexpected)
        message, _ = eh.classify(app_commands.CommandOnCooldown(app_commands.Cooldown(1, 10), 5.0))
        self.assertIn("5.0", message)

    def test_permissions_are_japanese(self):
        message, _ = eh.classify(commands.MissingPermissions(["manage_messages"]))
        self.assertIn("メッセージの管理", message)
        self.assertNotIn("manage_messages", message)
        message, _ = eh.classify(commands.BotMissingPermissions(["manage_roles"]))
        self.assertIn("Bot に", message)
        message, _ = eh.classify(app_commands.MissingPermissions(["administrator"]))
        self.assertIn("管理者", message)

    def test_no_dm(self):
        self.assertIn("サーバーの中", eh.classify(commands.NoPrivateMessage())[0])
        self.assertIn("サーバーの中", eh.classify(app_commands.NoPrivateMessage("x"))[0])

    def test_arguments_show_usage(self):
        message, _ = eh.classify(commands.MissingRequiredArgument(fake_param()), usage="!sample <amount>")
        self.assertIn("`amount` が足りません", message)
        self.assertIn("使い方: `!sample <amount>`", message)
        message, _ = eh.classify(commands.BadArgument("Converting to int failed"), usage="!sample <amount>")
        self.assertIn("引数の形", message)
        self.assertNotIn("Converting", message)

    def test_check_failure(self):
        self.assertIn("条件", eh.classify(commands.CheckFailure("secret"))[0])
        self.assertIn("条件", eh.classify(app_commands.CheckFailure())[0])

    def test_unexpected(self):
        error = commands.CommandInvokeError(ValueError("token=abc"))
        self.assertEqual(eh.classify(error), (None, True))
        self.assertEqual(eh.classify(app_commands.CommandInvokeError(MagicMock(), KeyError("x"))), (None, True))


class PrefixHandlerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot = make_bot()
        await self.bot.add_cog(Sample())
        await self.bot.add_cog(OwnHandlerCog())
        self.handler = eh.ErrorHandler(self.bot)

    def ctx(self, command=None):
        return types.SimpleNamespace(command=command, cog=getattr(command, "cog", None), clean_prefix="!",
                                     author=types.SimpleNamespace(id=1), send=AsyncMock())

    async def test_command_not_found_sends_nothing(self):
        ctx = self.ctx()
        await self.handler.on_command_error(ctx, commands.CommandNotFound('Command "w" is not found'))
        ctx.send.assert_not_awaited()

    async def test_usage_from_signature(self):
        ctx = self.ctx(self.bot.get_command("sample"))
        await self.handler.on_command_error(ctx, commands.MissingRequiredArgument(fake_param()))
        text = ctx.send.await_args.args[0]
        self.assertIn("!sample <amount>", text)

    async def test_usage_from_command_meta(self):
        self.assertEqual(eh.prefix_usage(types.SimpleNamespace(qualified_name="logs", signature="x")),
                         "!logs [行数] [重要度]")

    async def test_unexpected_hides_details_and_logs_traceback(self):
        ctx = self.ctx(self.bot.get_command("sample"))
        try:
            raise RuntimeError("secret-token-123")
        except RuntimeError as exc:
            error = commands.CommandInvokeError(exc)
        with self.assertLogs("cogs.errorhandler", level=logging.ERROR) as logs:
            await self.handler.on_command_error(ctx, error)
        text = ctx.send.await_args.args[0]
        self.assertNotIn("secret-token-123", text)
        error_id = text.split("`")[1]
        self.assertEqual(len(error_id), 8)
        self.assertIn(error_id, logs.output[0])
        self.assertIn("secret-token-123", logs.output[0])  # トレースバックはログに残る
        self.assertIn("Traceback", logs.output[0])

    async def test_respects_command_and_cog_handlers(self):
        for name in ("handled", "own"):
            ctx = self.ctx(self.bot.get_command(name))
            await self.handler.on_command_error(ctx, commands.CommandInvokeError(RuntimeError("x")))
            ctx.send.assert_not_awaited()

    async def test_music_listener_is_gone(self):
        from cogs import sio_music
        self.assertNotIn("on_command_error", [name for name, _ in sio_music.VoiceCog.__cog_listeners__])

    async def test_only_one_command_error_listener(self):
        import ast
        count = 0
        for path in list((ROOT / "cogs").glob("*.py")) + [ROOT / "main.py"]:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            count += sum(1 for node in ast.walk(tree)
                         if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == "on_command_error")
        self.assertEqual(count, 1)


class AppHandlerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot = make_bot()
        self.handler = eh.ErrorHandler(self.bot)

    def interaction(self, command=None, done=False):
        response = types.SimpleNamespace(is_done=lambda: done, send_message=AsyncMock())
        return types.SimpleNamespace(command=command, user=types.SimpleNamespace(id=1), response=response,
                                     followup=types.SimpleNamespace(send=AsyncMock()))

    async def test_tree_on_error_installed_and_restored(self):
        self.assertEqual(self.bot.tree.on_error, self.handler.on_app_command_error)
        await self.handler.cog_unload()
        self.assertNotEqual(self.bot.tree.on_error, self.handler.on_app_command_error)

    async def test_friendly_message_ephemeral(self):
        interaction = self.interaction()
        await self.handler.on_app_command_error(interaction, app_commands.MissingPermissions(["manage_guild"]))
        args, kwargs = interaction.response.send_message.await_args
        self.assertIn("サーバー管理", args[0])
        self.assertTrue(kwargs["ephemeral"])

    async def test_followup_when_already_responded(self):
        interaction = self.interaction(done=True)
        with self.assertLogs("cogs.errorhandler", level=logging.ERROR):
            await self.handler.on_app_command_error(interaction, app_commands.CommandInvokeError(MagicMock(), RuntimeError("boom")))
        args, kwargs = interaction.followup.send.await_args
        self.assertIn("エラーID", args[0])
        self.assertNotIn("boom", args[0])

    async def test_respects_command_and_cog_handlers(self):
        @app_commands.command(name="x", description="x")
        async def x(interaction):
            pass

        @x.error
        async def x_error(interaction, error):
            pass
        interaction = self.interaction(command=x)
        await self.handler.on_app_command_error(interaction, app_commands.CheckFailure())
        interaction.response.send_message.assert_not_awaited()

        bound = types.SimpleNamespace(on_error=None, parent=None, binding=OwnHandlerCog())
        interaction = self.interaction(command=bound)
        await self.handler.on_app_command_error(interaction, app_commands.CheckFailure())
        interaction.response.send_message.assert_not_awaited()

        plain = types.SimpleNamespace(on_error=None, parent=None, binding=Sample())
        interaction = self.interaction(command=plain)
        await self.handler.on_app_command_error(interaction, app_commands.CheckFailure())
        interaction.response.send_message.assert_awaited()


if __name__ == "__main__":
    unittest.main()
