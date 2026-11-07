import random
import types
import unittest
from unittest.mock import AsyncMock

from cogs.game import DiceCog, MAX_DICE_COUNT, MAX_SIDES, MAX_SIDES_DIGITS, parse_dice_message, roll_dice


class DiceParsingTest(unittest.TestCase):
    def test_parses_count_and_alias(self):
        self.assertEqual(parse_dice_message("1d100"), (1, "d", 100, False))
        self.assertEqual(parse_dice_message("3d8"), (3, "d", 8, False))
        self.assertEqual(parse_dice_message("4id7"), (4, "id", 7, False))
        self.assertEqual(parse_dice_message("1d8 int8"), (1, "d", 8, True))

    def test_parses_any(self):
        self.assertEqual(parse_dice_message("1dany"), (1, "d", None, False))
        self.assertEqual(parse_dice_message("4idany int8"), (4, "id", None, True))

    def test_non_matching_messages_are_ignored(self):
        for content in ("d100", "-1d10", "1D100", "1dany please", "hello1d6", "1d"):
            self.assertIsNone(parse_dice_message(content))

    def test_invalid_limits_are_marked(self):
        self.assertEqual(parse_dice_message("0d6"), (0, "d", -1, False))
        self.assertEqual(parse_dice_message("1d0"), (1, "d", -1, False))
        self.assertEqual(parse_dice_message(f"{MAX_DICE_COUNT + 1}d6"), (MAX_DICE_COUNT + 1, "d", -1, False))
        self.assertEqual(parse_dice_message("1d" + "9" * (MAX_SIDES_DIGITS + 1))[2], -1)

    def test_roll_is_inclusive(self):
        rng = random.Random(4)
        for _ in range(100):
            result = roll_dice(6, rng)
            self.assertTrue(1 <= result <= 6)


class DiceCogTest(unittest.IsolatedAsyncioTestCase):
    def message(self, content):
        return types.SimpleNamespace(
            content=content,
            author=types.SimpleNamespace(bot=False),
            reply=AsyncMock(),
        )

    async def test_explicit_dice_replies_with_result(self):
        cog = DiceCog(None, rng=random.Random(1))
        message = self.message("1d6")
        await cog.on_message(message)
        text = message.reply.await_args.args[0]
        self.assertIn("1d6", text)
        value = int(text.split("**")[1].split("**")[0])
        self.assertTrue(1 <= value <= 6)

    async def test_multiple_dice_are_summed(self):
        cog = DiceCog(None, rng=random.Random(1))
        message = self.message("-1d10")
        await cog.on_message(message)
        message.reply.assert_not_awaited()

        message = self.message("3d8")
        await cog.on_message(message)
        text = message.reply.await_args.args[0]
        self.assertIn("3d8", text)
        self.assertIn("内訳", text)
        value = int(text.split("**")[1].split("**")[0])
        self.assertTrue(3 <= value <= 24)

    async def test_id_alias_replies(self):
        cog = DiceCog(None, rng=random.Random(1))
        message = self.message("4id7")
        await cog.on_message(message)
        text = message.reply.await_args.args[0]
        self.assertIn("4id7", text)
        self.assertIn("内訳", text)

    async def test_int8_replies_in_octal(self):
        cog = DiceCog(None, rng=random.Random(1))
        message = self.message("1d8 int8")
        await cog.on_message(message)
        text = message.reply.await_args.args[0]
        self.assertIn("int8", text)
        self.assertRegex(text, r"\*\*0o[0-7]+\*\*")

    async def test_any_selects_sides_and_rolls_within_limit(self):
        cog = DiceCog(None, rng=random.Random(2))
        message = self.message("3dany")
        await cog.on_message(message)
        text = message.reply.await_args.args[0]
        sides = int(text.split("3d")[1].split("`")[0])
        value = int(text.split("**")[1].split("**")[0])
        self.assertTrue(3 <= sides <= MAX_SIDES)
        self.assertTrue(3 <= value <= sides * 3)

    async def test_bot_messages_are_ignored(self):
        cog = DiceCog(None, rng=random.Random(1))
        message = self.message("1d6")
        message.author.bot = True
        await cog.on_message(message)
        message.reply.assert_not_awaited()

    async def test_invalid_sides_get_feedback(self):
        cog = DiceCog(None, rng=random.Random(1))
        message = self.message("1d0")
        await cog.on_message(message)
        self.assertIn("1以上", message.reply.await_args.args[0])


if __name__ == "__main__":
    unittest.main()
