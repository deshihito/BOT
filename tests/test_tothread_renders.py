# -*- coding: utf-8 -*-
"""asyncio.to_thread 化（2026-11-14）の検証。

重い PIL 描画がイベントループ上ではなくワーカースレッドで実行されること、
および事前描画（prepare_png / load_async / _prepare_files）の後は同期側の
アクセサがキャッシュを返すだけになることを、代表経路で確認する。
"""
import random
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class _ThreadRecorder:
    """同期描画関数の代役。呼ばれたスレッドを記録して固定値を返す。"""

    def __init__(self, result):
        self.result = result
        self.threads: list[threading.Thread] = []

    def __call__(self, *args, **kwargs):
        self.threads.append(threading.current_thread())
        return self.result

    def assert_called_once_off_main(self, case: unittest.TestCase) -> None:
        case.assertEqual(len(self.threads), 1)
        case.assertIsNot(self.threads[0], threading.main_thread())


class ItemsPreparePngTest(unittest.IsolatedAsyncioTestCase):
    async def test_prepare_png_renders_off_loop_and_caches(self):
        from core.general.items.cog import ITEMS_FILENAME, ItemsView

        view = ItemsView(SimpleNamespace(store=object()), 42)
        recorder = _ThreadRecorder(b"fake-png")
        with patch("core.general.items.cog.items_panel_png", recorder):
            await view.prepare_png()
            files = view.panel_files()
            png = view.panel_png()
        recorder.assert_called_once_off_main(self)
        self.assertEqual(png, b"fake-png")
        self.assertIsNotNone(files)
        self.assertEqual(files[0].filename, ITEMS_FILENAME)


class GardenLoadAsyncTest(unittest.IsolatedAsyncioTestCase):
    async def test_load_async_renders_off_loop(self):
        from core.general.garden import garden as garden_core
        from core.general.garden.cog import GardenView

        with tempfile.TemporaryDirectory() as tmp:
            store = garden_core.GardenStore(
                Path(tmp) / "garden.json", rng=random.Random(7))
            view = GardenView(SimpleNamespace(store=store), 42)
            recorder = _ThreadRecorder(b"garden-png")
            with patch("core.general.garden.cog.render_garden_png", recorder):
                await view.load_async()
            recorder.assert_called_once_off_main(self)
            self.assertEqual(view._png, b"garden-png")
            self.assertIn("pots", view.snapshot)


class MinesweeperRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_renders_board_off_loop(self):
        from core.game.minesweeper.cog import BoardPanel
        from core.game.minesweeper.minesweeper import MinesweeperBoard

        board = MinesweeperBoard("easy", rng=random.Random(42))
        panel = BoardPanel(MagicMock(), SimpleNamespace(id=1), board)
        recorder = _ThreadRecorder(MagicMock(name="board-file"))
        with patch("core.game.minesweeper.cog.board_file", recorder), \
                patch("core.game.minesweeper.cog.edit_panel_v2",
                      new=AsyncMock()) as edit:
            await panel._refresh(MagicMock())
        recorder.assert_called_once_off_main(self)
        edit.assert_awaited_once()
        self.assertEqual(edit.await_args.kwargs["files"],
                         [recorder.result])


class Story54ThreadTest(unittest.IsolatedAsyncioTestCase):
    async def test_render_runs_off_loop(self):
        from core.general.story54 import Story54Mixin

        interaction = MagicMock()
        interaction.response.send_message = AsyncMock()
        recorder = _ThreadRecorder(b"story54-png")
        with patch("core.general.story54.render_story54_png", recorder):
            await Story54Mixin()._story54_text_done(interaction, "あ" * 54)
        recorder.assert_called_once_off_main(self)
        interaction.response.send_message.assert_awaited_once()
        sent_file = interaction.response.send_message.await_args.kwargs["file"]
        self.assertEqual(sent_file.filename, "story54.png")


class BlackjackPrepareTest(unittest.IsolatedAsyncioTestCase):
    async def test_prepare_files_renders_board_off_loop_and_caches(self):
        from core.game.gambling.cog import BlackjackView

        session = {
            "kind": "blackjack",
            "player": ["A♠", "K♥"],
            "dealer": ["Q♦", "5♣"],
            "bet": 100,
        }
        store = SimpleNamespace(session=lambda _key: session)
        cog = SimpleNamespace(
            store=store, bot=None,
            blackjack_final_state=lambda _uid: None)
        view = BlackjackView(cog, 1)
        recorder = _ThreadRecorder(b"board-png")
        with patch("core.game.gambling.blackjack_image.render_blackjack_png",
                   recorder):
            await view._prepare_files()
            files = view.panel_files()
        recorder.assert_called_once_off_main(self)
        self.assertIsNotNone(files)


class DungeonMapFilenameTest(unittest.TestCase):
    def test_filenames_unique_across_threads(self):
        from core.game.dungeon.render import d_next_map_filename

        names: list[str] = []
        lock = threading.Lock()

        def worker() -> None:
            local = [d_next_map_filename() for _ in range(50)]
            with lock:
                names.extend(local)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(names), 400)
        self.assertEqual(len(set(names)), 400)


if __name__ == "__main__":
    unittest.main()
