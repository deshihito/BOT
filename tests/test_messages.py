"""共通文の単一化（監査 #8）のテスト。

- core/messages.py 等の定数が、従来各 cog にコピペされていたリテラルと
  1文字も違わず一致すること
- 置換した使用箇所が、従来どおりの文字列を組み立てること
を固定する。文言の内容は core/locales の翻訳キーそのものなので、
ここがずれると翻訳も追随しなくなる。
"""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core import api_client, messages  # noqa: E402
from core.general import ai_input
from core.emojis import BACK, CROCK, FAILED, MUSIC, SUCCESS, TICKET  # noqa: E402


class SharedMessageValuesTest(unittest.TestCase):
    """定数・整形ヘルパの値が従来のリテラルと完全一致すること。"""

    def test_voice_not_joined(self):
        # HCD監査 quick fix #9 で ⚠️ から FAILED カスタム絵文字へ統一した
        self.assertEqual(
            messages.VOICE_NOT_JOINED,
            f"{FAILED} ボイスチャンネルに参加してから実行してください。",
        )

    def test_voice_connection_failed(self):
        self.assertEqual(
            messages.voice_connection_failed(Exception("boom")),
            "<:failed:1490986584676368535> ボイス接続に失敗しました: `boom`",
        )

    def test_recruit_join_prompt(self):
        self.assertEqual(
            messages.recruit_join_prompt(30),
            "30秒以内に「参加」を押してください",
        )
        # 募集文の組み立て全体が従来どおりになること（括弧書きが続く形）
        self.assertEqual(
            f"{messages.recruit_join_prompt(30)}（2〜5人）。",
            "30秒以内に「参加」を押してください（2〜5人）。",
        )

    def test_role_hierarchy_messages(self):
        self.assertEqual(
            messages.ROLE_HIERARCHY_ALREADY_SET,
            "ロールの管理権限、または自分より上のロールが設定されています。",
        )
        self.assertEqual(
            messages.ROLE_HIERARCHY_CANNOT_SET,
            "ロールの管理権限、または自分より上のロールを設定しようとしています。",
        )

    def test_image_unsupported_message(self):
        self.assertEqual(
            ai_input.IMAGE_UNSUPPORTED_MESSAGE,
            "選択中のモデルは画像入力に対応していません。画像対応モデルを選んでください。",
        )

    def test_api_not_configured_message(self):
        self.assertEqual(
            api_client.API_NOT_CONFIGURED_MESSAGE,
            "BOT_API_BASE_URL または BOT_API_KEY が設定されていません",
        )

    def test_emoji_values(self):
        self.assertEqual(SUCCESS, "<:success:1490985168100659322>")
        self.assertEqual(FAILED, "<:failed:1490986584676368535>")
        self.assertEqual(TICKET, "<:PREMIUM_AGO_TICKET:1559334882809872474>")
        self.assertEqual(CROCK, "<:crock:1561710960387956757>")
        self.assertEqual(BACK, "<:Back:1561700549236097034>")
        self.assertEqual(MUSIC, "<:music:1561710964238450809>")


class UnifiedCallSitesTest(unittest.TestCase):
    """置換した使用箇所が従来どおりの文字列を生むこと。"""

    async def _build_content_error(self):
        attachment = SimpleNamespace(
            filename="image.png", content_type="image/png", size=10,
        )
        await ai_input.build_user_content("本文", [attachment], images_supported=False)

    def test_ai_input_raises_shared_message(self):
        import asyncio

        with self.assertRaises(ai_input.AttachmentInputError) as ctx:
            asyncio.run(self._build_content_error())
        self.assertEqual(
            str(ctx.exception),
            "選択中のモデルは画像入力に対応していません。画像対応モデルを選んでください。",
        )

    def test_d1_endpoint_default(self):
        from core.autoplay import DEFAULT_D1_ENDPOINT

        self.assertEqual(DEFAULT_D1_ENDPOINT, "http://127.0.0.1:8082/v1/systemone")
        # 利用側 cog も同じ既定値を指すこと（生成には bot が要るためソースで確認）
        import inspect

        from cogs.d1_test import D1TestCog
        from cogs.judge_comment import JudgeCommentCog

        self.assertIn("DEFAULT_D1_ENDPOINT", inspect.getsource(D1TestCog.__init__))
        self.assertIn("DEFAULT_D1_ENDPOINT", inspect.getsource(JudgeCommentCog.__init__))

    def test_help_summary_comes_from_command_meta(self):
        from cogs.help import CatalogHelpCommand
        from core.help.command_meta import COMMAND_META

        cmd = CatalogHelpCommand()
        self.assertEqual(
            cmd.command_attrs["help"],
            "コマンドの一覧と使い方を表示します（詳しくは /help）",
        )
        self.assertEqual(cmd.command_attrs["help"], COMMAND_META["!help"]["summary"])


if __name__ == "__main__":
    unittest.main()
