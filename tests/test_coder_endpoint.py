from concurrent.futures import Future
import hashlib
import hmac
import json
import time
from unittest.mock import patch

import keep_alive
from core.coder_service import CoderReply


class ReadyBot:
    coder_loop = object()

    def is_ready(self):
        return True


def completed_future(coroutine, loop):
    coroutine.close()
    future = Future()
    future.set_result(CoderReply(text="answer", provider="logfare", model="logfare/auto"))
    return future


def signed_headers(secret, body, nonce="a" * 48):
    timestamp = str(int(time.time()))
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    signature = hmac.new(
        secret.encode(),
        f"POST\n/internal/coder/run\n{timestamp}\n{nonce}\n{body_hash}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-AGO-Coder-Timestamp": timestamp,
        "X-AGO-Coder-Nonce": nonce,
        "X-AGO-Coder-Signature": signature,
    }


def test_coder_endpoint_requires_a_valid_signature(monkeypatch):
    monkeypatch.setenv("CODER_SERVICE_SHARED_SECRET", "shared-secret")
    client = keep_alive.app.test_client()
    response = client.post("/internal/coder/run", json={"prompt": "test", "user": {"id": "123"}})
    assert response.status_code == 401


def test_coder_endpoint_runs_on_bot_loop(monkeypatch):
    secret = "shared-secret"
    monkeypatch.setenv("CODER_SERVICE_SHARED_SECRET", secret)
    keep_alive.configure_coder(ReadyBot())
    body = json.dumps({"prompt": "コードを確認して", "user": {"id": "987654321"}}, separators=(",", ":"))
    client = keep_alive.app.test_client()
    with patch("keep_alive.asyncio.run_coroutine_threadsafe", side_effect=completed_future):
        response = client.post("/internal/coder/run", headers=signed_headers(secret, body), data=body)

    assert response.status_code == 200
    assert response.json == {"answer": "answer", "provider": "logfare", "model": "logfare/auto"}
