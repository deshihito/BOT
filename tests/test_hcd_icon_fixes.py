"""HCD監査 quick fix #9（失敗アイコンの一次統一）の回帰テスト。

ユーザ向け失敗文の接頭辞 ⚠️ を core/emojis の FAILED に寄せた。
警告そのものに意味がある箇所（UNO のドロー警告、ハニーポットの警告文、
市場の取引停止の見出し、統計行、設定プレビューの注意書き等）は対象外として残す。
"""

from __future__ import annotations

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core.support import messages  # noqa: E402
from core.support.emojis import FAILED  # noqa: E402

#: ⚠️ を FAILED 化したファイル（失敗・拒否メッセージの接頭辞があったもの）
CONVERTED_FILES = [
    "core/support/globalchat/cog.py",
    "core/support/server_setup/cog.py",
    "core/game/shiritori/cog.py",
    "core/vc/karaoke/entry.py",
    "core/vc/rec/entry.py",
    "core/vc/saito.py",
    "core/vc/transcription/entry.py",
    "core/vc/voicechanger/entry.py",
    "core/support/messages.py",
    "core/vc/music/connection.py",
    "core/vc/globalvc/chat.py",
    "core/vc/globalvc/manage.py",
    "core/support/quest.py",
    "core/support/sns.py",
    "core/support/voice_trigger.py",
    "core/vc/hub.py",
    "core/vc/trigger.py",
    "core/vc/tts.py",
    "core/vc/voice_session.py",
]

#: 変換後も ⚠️ が残ってよい行（行内のキーワードで判定）
ALLOWED_MARKERS = ("アンダーラン",)  # sio_voicechanger の統計行


class IconUnificationTest(unittest.TestCase):
    def test_converted_files_have_no_warning_prefix(self):
        offenders = []
        for rel in CONVERTED_FILES:
            text = open(os.path.join(ROOT, rel), encoding="utf-8").read()
            for lineno, line in enumerate(text.splitlines(), 1):
                if "⚠" in line and not any(m in line for m in ALLOWED_MARKERS):
                    offenders.append(f"{rel}:{lineno}")
        self.assertEqual(offenders, [])

    def test_voice_not_joined_uses_failed_icon(self):
        self.assertTrue(messages.VOICE_NOT_JOINED.startswith(FAILED))


if __name__ == "__main__":
    unittest.main()
