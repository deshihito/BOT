"""VC カテゴリの入口（cogs/vc.py）。

このファイルは VC 系すべての機能をまとめて読み込む唯一の extension。
実装は全て core/vc/ 側にあり、ここでは「どの機能が・どこに実装されて
いるか」の対応表と、各機能の setup の呼び出しだけを持つ。

対応表（機能 → 実装モジュール → 登録される Cog）
    music         core/vc/music/entry.py          VoiceCog
    voice         core/vc/voice_entry.py          VoiceHub / TTSCog / VoiceTriggerCog
    global_vc     core/vc/globalvc/entry.py       GlobalVCCog
    rec           core/vc/rec/entry.py            RecordingCog
    saito         core/vc/saito.py                SaitoRelay
    transcription core/vc/transcription/entry.py  TranscriptionCog
    voicechanger  core/vc/voicechanger/entry.py   VoiceChangerCog
    karaoke       core/vc/karaoke/entry.py        KaraokeCog

旧 cogs/sio_*.py の入口ファイルは廃止され、その本体（Cog の合成クラスや
setup）は各機能フォルダの entry.py へ移設した（saito のみ実装本体
core/vc/saito.py に setup を同居）。他モジュールから入口経由で参照
されていた名前は、このファイルから再輸出する。
"""

from __future__ import annotations

import discord  # noqa: F401  (テストが cogs.vc.discord を patch する)
from discord.ext import commands  # noqa: F401

# ============================================================
# music（音楽再生）
#   実装: core/vc/music/（本体は entry.py が旧入口の合成クラスを持つ）
# ============================================================
from core.vc.music.entry import VoiceCog  # noqa: F401
from core.vc.music.common import niconico_url_kind  # noqa: F401

# ============================================================
# voice（VCハブ / 読み上げ / 音声トリガー）
#   実装: core/vc/hub.py, core/vc/tts.py, core/vc/trigger.py
#   入口本体: core/vc/voice_entry.py
# ============================================================
from core.vc.voice_entry import (  # noqa: F401
    VOICE_ACTIONS_BY_GENRE,
    VOICE_GENRES,
    TTSCog,
    VoiceHub,
    VoicePanelView,
    VoiceTriggerCog,
)

# ============================================================
# global_vc（グローバルVC）
#   実装: core/vc/globalvc/（本体は entry.py）
# ============================================================
from core.vc.globalvc.entry import GlobalVCCog  # noqa: F401

# ============================================================
# rec（録音）
#   実装: core/vc/rec/（本体は entry.py）
# ============================================================
from core.vc.rec.entry import RecordingCog, ensure_opus  # noqa: F401

# ============================================================
# saito（ランダム通話マッチング）
#   実装: core/vc/saito.py（setup も同居）
# ============================================================
from core.vc.saito import SaitoRelay  # noqa: F401

# ============================================================
# transcription（文字起こし）
#   実装: core/vc/transcription/（本体は entry.py）
# ============================================================
from core.vc.transcription.entry import TranscriptionCog  # noqa: F401
from core.vc.transcription.buffer import UserAudioBuffer  # noqa: F401

# ============================================================
# voicechanger（ボイスチェンジャー）
#   実装: core/vc/voicechanger/（本体は entry.py）
# ============================================================
from core.vc.voicechanger.entry import VoiceChangerCog  # noqa: F401
from core.vc.voicechanger.common import CHUNK_BYTES, FRAME_SIZE  # noqa: F401
from core.vc.voicechanger.shifter import AdaptiveWSOLAPitchShifter  # noqa: F401
from core.vc.voicechanger.source import WaitAndConnectAudioSource  # noqa: F401

# ============================================================
# karaoke（カラオケ）
#   実装: core/vc/karaoke/（本体は entry.py）
# ============================================================
from core.vc.karaoke.entry import KaraokeCog  # noqa: F401
from core.vc.karaoke.dsp import clean_text, resample_48k_to_16k  # noqa: F401

# ============================================================
# 登録テーブル（機能 → その機能の setup）
#   並び順が読み込み順。各 setup は対応する entry / 実装モジュール側にあり、
#   Cog の生成と bot.add_cog を行う。
# ============================================================
from core.vc import saito as _saito
from core.vc import voice_entry as _voice_entry
from core.vc.globalvc import entry as _globalvc_entry
from core.vc.karaoke import entry as _karaoke_entry
from core.vc.music import entry as _music_entry
from core.vc.rec import entry as _rec_entry
from core.vc.transcription import entry as _transcription_entry
from core.vc.voicechanger import entry as _voicechanger_entry

_FEATURE_SETUPS = (
    ("music", _music_entry.setup),
    ("voice", _voice_entry.setup),
    ("global_vc", _globalvc_entry.setup),
    ("rec", _rec_entry.setup),
    ("saito", _saito.setup),
    ("transcription", _transcription_entry.setup),
    ("voicechanger", _voicechanger_entry.setup),
    ("karaoke", _karaoke_entry.setup),
)


async def setup(bot: commands.Bot):
    for _feature, _setup in _FEATURE_SETUPS:
        await _setup(bot)
