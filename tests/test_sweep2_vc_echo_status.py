"""sweep2 VC-12 回帰テスト: vc:echo_status が dispatch に到達すること。

監査で判明した不具合: hub.voice_studio の valid 集合に echo の "status" が無く、
レジストリに登録された vc:echo_status が常に組み合わせエラーで弾かれていた
（status は record 側にしか無かった）。

注: test_voice_group.Base.voice() は hub.voice_group（現行コードに存在しない）
前提でベースラインから壊れているため、ここでは voice_studio を直接呼ぶ。
"""
import unittest
from unittest.mock import AsyncMock, patch

from test_voice_group import Base
from tests.test_music_group import choice


class EchoStatusDispatchTest(Base):
    async def test_echo_status_reaches_impl(self):
        with patch.object(type(self.rec), "_echo_impl", AsyncMock()) as mock:
            interaction = self.interaction()
            await self.hub.voice_studio(
                interaction, feature=choice("echo"), action=choice("status")
            )
        self.assertEqual(mock.await_count, 1, "/voice studio echo status")
        args, kwargs = mock.await_args
        self.assertEqual(args[1], "status")
        self.assertIsNone(args[2] if len(args) > 2 else kwargs.get("delay"))


if __name__ == "__main__":
    unittest.main()
