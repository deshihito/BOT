"""voice_recv の DAVE パッチ集約（監査 #6）のテスト。Discord には接続しない。

以前は同じパッチが sio 系4ファイルに重複定義され、最初に import された版だけが
効いていた（読込順依存）。core.vc.voice_recv_patch への集約で、

- どの cog を import しても同じ（core 由来の）メソッドが付くこと
- 何回適用しても二重適用されない（メソッドが差し替わらない）こと
- dave_is_ready が常に存在すること（旧 sio_rec 版だけにあった）
- dave_decrypt の基本挙動（セッション無し／無音フレームは素通し、候補での復号、
  キャッシュの型不一致時の再探索、失敗時の RuntimeError）
を確認する。
"""

import importlib
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

for _name, _value in {'BOT_API_BASE_URL': 'http://127.0.0.1:8787', 'BOT_API_KEY': 'dummy-key'}.items():
    os.environ.setdefault(_name, _value)

from discord.ext import voice_recv  # noqa: E402

from core.vc import voice_recv_patch as vrp  # noqa: E402

VC_CLS = voice_recv.VoiceRecvClient
SIO_COGS = ('core.vc.globalvc.entry', 'core.vc.karaoke.entry', 'core.vc.rec.entry', 'core.vc.transcription.entry')


def _make_client(session=None, connection_attrs=None):
    """VoiceRecvClient のインスタンスを接続なしで作り、偽の _connection を差す。"""
    client = object.__new__(VC_CLS)
    if session is None and not connection_attrs:
        client._connection = None
        return client
    connection = type('FakeConnection', (), {})()
    connection.dave_session = session
    for key, value in (connection_attrs or {}).items():
        setattr(connection, key, value)
    client._connection = connection
    return client


class FakeSession:
    """decrypt の呼ばれ方を記録する偽 DAVE セッション。"""

    def __init__(self, behavior):
        self.behavior = behavior  # callable(user_id, args tuple) -> bytes
        self.calls = []
        self.ready = True

    def decrypt(self, user_id, *args):
        self.calls.append((user_id, args))
        return self.behavior(user_id, args)


class PatchApplicationTest(unittest.TestCase):
    def test_patch_adds_all_methods(self):
        vrp.patch_voice_recv_client()
        self.assertTrue(getattr(VC_CLS, '_dave_patch_applied', False))
        for name in ('dave_is_active', 'dave_is_ready', 'dave_decrypt'):
            self.assertTrue(hasattr(VC_CLS, name), name)
            self.assertEqual(getattr(VC_CLS, name).__module__, 'core.vc.voice_recv_patch')

    def test_patch_is_idempotent(self):
        vrp.patch_voice_recv_client()
        before = (VC_CLS.dave_is_active, VC_CLS.dave_is_ready, VC_CLS.dave_decrypt)
        vrp.patch_voice_recv_client()
        vrp.patch_voice_recv_client()
        after = (VC_CLS.dave_is_active, VC_CLS.dave_is_ready, VC_CLS.dave_decrypt)
        self.assertEqual(before, after)

    def test_importing_sio_cogs_keeps_single_core_patch(self):
        vrp.patch_voice_recv_client()
        before = VC_CLS.dave_decrypt
        for name in SIO_COGS:
            importlib.import_module(name)
            self.assertIs(VC_CLS.dave_decrypt, before, name)
            self.assertEqual(VC_CLS.dave_decrypt.__module__, 'core.vc.voice_recv_patch')
        # 旧 sio_rec 版だけにあったメソッドが、どの cog 経由でも使える
        self.assertTrue(hasattr(VC_CLS, 'dave_is_ready'))


class DaveMethodBehaviorTest(unittest.TestCase):
    def setUp(self):
        vrp.patch_voice_recv_client()
        vrp._media_type_audio = vrp._UNSET
        vrp._candidates_cache = []

    def tearDown(self):
        vrp._media_type_audio = vrp._UNSET
        vrp._candidates_cache = []

    def test_no_session_passthrough(self):
        client = _make_client()
        self.assertFalse(client.dave_is_active())
        self.assertFalse(client.dave_is_ready())
        self.assertEqual(client.dave_decrypt(42, b'\x01\x02'), b'\x01\x02')

    def test_is_active_and_ready_with_session(self):
        session = FakeSession(lambda uid, args: b'')
        client = _make_client(session=session)
        self.assertTrue(client.dave_is_active())
        # is_e2ee が無い接続では session.ready を見る
        self.assertTrue(client.dave_is_ready())

    def test_is_ready_prefers_is_e2ee_flag(self):
        session = FakeSession(lambda uid, args: b'')
        client = _make_client(session=session, connection_attrs={'is_e2ee': False})
        self.assertFalse(client.dave_is_ready())
        client = _make_client(session=session, connection_attrs={'is_e2ee': lambda: True})
        self.assertTrue(client.dave_is_ready())

    def test_silence_frame_passthrough_without_decrypt(self):
        session = FakeSession(lambda uid, args: b'decrypted')
        client = _make_client(session=session)
        self.assertEqual(client.dave_decrypt(42, b'\xf8\xff\xfe'), b'\xf8\xff\xfe')
        self.assertEqual(session.calls, [])

    def test_decrypt_success_caches_media_type(self):
        def behavior(uid, args):
            if len(args) == 2:
                return b'plain:' + args[1]
            raise ValueError('bad media type')

        session = FakeSession(behavior)
        client = _make_client(session=session)
        self.assertEqual(client.dave_decrypt(42, b'data'), b'plain:data')
        # 成功した候補がキャッシュされ、次回は候補探索なしで使われる
        self.assertIsNot(vrp._media_type_audio, vrp._UNSET)
        calls_before = len(session.calls)
        self.assertEqual(client.dave_decrypt(42, b'more'), b'plain:more')
        self.assertEqual(len(session.calls), calls_before + 1)

    def test_cached_type_error_falls_back_to_candidates(self):
        vrp._media_type_audio = 'stale-type'

        def behavior(uid, args):
            if args and args[0] == 'stale-type':
                raise TypeError('wrong type')
            if len(args) == 2:
                return b'ok:' + args[1]
            raise ValueError('bad media type')

        session = FakeSession(behavior)
        client = _make_client(session=session)
        self.assertEqual(client.dave_decrypt(42, b'data'), b'ok:data')

    def test_cached_other_error_raises_and_keeps_cache(self):
        vrp._media_type_audio = 'good-type'

        def behavior(uid, args):
            raise ValueError('epoch mismatch')

        session = FakeSession(behavior)
        client = _make_client(session=session)
        with self.assertRaises(RuntimeError):
            client.dave_decrypt(42, b'data')
        # 型は合っている前提なので、キャッシュは捨てない
        self.assertEqual(vrp._media_type_audio, 'good-type')
        # 候補探索にも進まない（このパケットだけ落とす）
        self.assertEqual(len(session.calls), 1)

    def test_all_candidates_fail_raises_runtime_error(self):
        def behavior(uid, args):
            raise ValueError('nope')

        session = FakeSession(behavior)
        client = _make_client(session=session)
        with self.assertRaises(RuntimeError):
            client.dave_decrypt(42, b'data')


if __name__ == '__main__':
    unittest.main()
