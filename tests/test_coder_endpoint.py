from concurrent.futures import Future
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


def test_coder_endpoint_requires_shared_secret(monkeypatch):
    monkeypatch.setenv("CODER_SERVICE_SHARED_SECRET", "shared-secret")
    client = keep_alive.app.test_client()
    response = client.post("/internal/coder/run", json={"prompt": "test", "user": {"id": "123"}})
    assert response.status_code == 401


def test_coder_endpoint_runs_on_bot_loop(monkeypatch):
    monkeypatch.setenv("CODER_SERVICE_SHARED_SECRET", "shared-secret")
    keep_alive.configure_coder(ReadyBot())
    client = keep_alive.app.test_client()
    with patch("keep_alive.asyncio.run_coroutine_threadsafe", side_effect=completed_future):
        response = client.post(
            "/internal/coder/run",
            headers={"Authorization": "Bearer shared-secret"},
            json={"prompt": "コードを確認して", "user": {"id": "987654321"}},
        )

    assert response.status_code == 200
    assert response.json == {"answer": "answer", "provider": "logfare", "model": "logfare/auto"}
