import asyncio
import hashlib
import hmac
import importlib
import json
import os
import secrets
import sys
import threading
import time
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch


# keep_alive imports the unrelated AI service at module load; stub only that
# boundary so these route tests do not need credentials or an LLM dependency.
_previous_coder_service = sys.modules.get("core.coder_service")
if _previous_coder_service is None:
    coder_service_stub = types.ModuleType("core.coder_service")
    async def _unused_reply(*_args, **_kwargs):
        raise AssertionError("Activity state requests must never call the AI service")
    coder_service_stub.reply = _unused_reply
    sys.modules["core.coder_service"] = coder_service_stub

try:
    keep_alive = importlib.import_module("keep_alive")
finally:
    if _previous_coder_service is None:
        sys.modules.pop("core.coder_service", None)


class FakeCog:
    def activity_snapshot(self, guild_id, *, is_playing, now=None):
        return {
            "status": "playing" if is_playing else "idle",
            "videoId": "dQw4w9WgXcQ",
            "positionSeconds": 12.5,
            "serverTime": now or time.time(),
        }


class FakeBot:
    def __init__(self, guild):
        self.guild = guild
        self.coder_loop = None

    def is_ready(self):
        return True

    def get_guild(self, guild_id):
        return self.guild if guild_id == self.guild.id else None

    def get_cog(self, name):
        return FakeCog() if name == "VoiceCog" else None


class MusicActivityApiTest(unittest.TestCase):
    guild_id = 100000000000000001
    channel_id = 100000000000000002
    user_id = 100000000000000003
    secret = "activity-test-secret"

    @classmethod
    def setUpClass(cls):
        cls.loop = asyncio.new_event_loop()
        cls.loop_thread = threading.Thread(target=cls.loop.run_forever, daemon=True)
        cls.loop_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.loop.call_soon_threadsafe(cls.loop.stop)
        cls.loop_thread.join(timeout=2)
        cls.loop.close()

    def setUp(self):
        channel = SimpleNamespace(id=self.channel_id)
        member = SimpleNamespace(id=self.user_id, voice=SimpleNamespace(channel=channel))
        voice_client = SimpleNamespace(
            channel=channel,
            is_connected=lambda: True,
            is_playing=lambda: True,
        )
        guild = SimpleNamespace(
            id=self.guild_id,
            get_member=lambda user_id: member if user_id == self.user_id else None,
            voice_client=voice_client,
        )
        self.bot = FakeBot(guild)
        self.bot.coder_loop = self.loop
        keep_alive._bot = self.bot
        keep_alive._used_nonces.clear()
        keep_alive._activity_requests.clear()
        self.client = keep_alive.app.test_client()
        self.environment = patch.dict(os.environ, {"CODER_SERVICE_SHARED_SECRET": self.secret})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def tearDown(self):
        keep_alive._bot = None

    def post_signed(self, payload, *, nonce=None, signed_path="/internal/activity/music-state", request_path=None):
        body = json.dumps(payload, separators=(",", ":")).encode()
        timestamp = str(int(time.time()))
        nonce = nonce or secrets.token_hex(24)
        body_hash = hashlib.sha256(body).hexdigest()
        signed_payload = f"POST\n{signed_path}\n{timestamp}\n{nonce}\n{body_hash}".encode()
        signature = hmac.new(self.secret.encode(), signed_payload, hashlib.sha256).hexdigest()
        return self.client.post(
            request_path or signed_path,
            data=body,
            content_type="application/json",
            headers={
                "X-AGO-Coder-Timestamp": timestamp,
                "X-AGO-Coder-Nonce": nonce,
                "X-AGO-Coder-Signature": signature,
            },
        )

    def valid_payload(self):
        return {
            "guild_id": str(self.guild_id),
            "channel_id": str(self.channel_id),
            "user_id": str(self.user_id),
        }

    def test_hmac_authorized_state_contains_only_video_metadata(self):
        response = self.post_signed(self.valid_payload())
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["status"], "playing")
        self.assertEqual(data["videoId"], "dQw4w9WgXcQ")
        self.assertNotIn("stream_url", data)
        self.assertNotIn("headers", data)
        self.assertEqual(response.headers.get("Cache-Control"), "no-store, max-age=0")

    def test_unsigned_or_wrong_path_requests_are_rejected(self):
        response = self.client.post("/internal/activity/music-state", json=self.valid_payload())
        self.assertEqual(response.status_code, 401)
        response = self.post_signed(
            self.valid_payload(), signed_path="/internal/coder/run",
            request_path="/internal/activity/music-state",
        )
        self.assertEqual(response.status_code, 401)

    def test_nonce_replay_is_rejected(self):
        nonce = secrets.token_hex(24)
        self.assertEqual(self.post_signed(self.valid_payload(), nonce=nonce).status_code, 200)
        self.assertEqual(self.post_signed(self.valid_payload(), nonce=nonce).status_code, 401)

    def test_only_members_in_the_same_voice_channel_can_read(self):
        self.bot.guild.get_member = lambda _user_id: None
        response = self.post_signed(self.valid_payload())
        self.assertEqual(response.status_code, 403)

    def test_invalid_identifiers_are_rejected(self):
        payload = self.valid_payload()
        payload["channel_id"] = "not-a-snowflake"
        response = self.post_signed(payload)
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
