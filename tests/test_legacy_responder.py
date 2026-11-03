import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from core.legacy import Responder


class ResponderTest(unittest.IsolatedAsyncioTestCase):
    async def test_send_can_skip_automatic_localization(self):
        source = SimpleNamespace(send=AsyncMock())
        responder = Responder(source)

        await responder.send("ユーザー入力", skip_localization=True)

        source.send.assert_awaited_once_with(
            content="ユーザー入力",
            _agobot_skip_localization=True,
        )


if __name__ == "__main__":
    unittest.main()
