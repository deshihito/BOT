import json
import unittest
from unittest.mock import Mock, patch

from core.api_client import APIClient, APIError, create_client_from_env


class APIClientTest(unittest.TestCase):
    def setUp(self):
        self.client = APIClient("http://127.0.0.1:8787/", "test-secret", timeout=3)
        self.response = Mock(ok=True, status_code=200)
        self.response.json.return_value = {"data": [{"balance": 10}]}

    @patch("core.api_client.requests.post")
    def test_select_filters_and_range(self, post):
        post.return_value = self.response
        result = self.client.table("users").select("balance").eq("user_id", "123").range(10, 19).execute()
        self.assertEqual(result.data, [{"balance": 10}])
        args, kwargs = post.call_args
        self.assertEqual(args[0], "http://127.0.0.1:8787/v1/query")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-secret")
        body = json.loads(kwargs["data"])
        self.assertEqual(body["table"], "users")
        self.assertEqual(body["columns"], "balance")
        self.assertEqual(body["filters"], [{"column": "user_id", "op": "eq", "value": "123"}])
        self.assertEqual((body["offset"], body["limit"]), (10, 10))
        self.assertEqual(kwargs["timeout"], 3)

    @patch("core.api_client.requests.post")
    def test_select_after_mutation_preserves_mutation_action(self, post):
        post.return_value = self.response
        self.client.table("users").update({"balance": 15}).eq("user_id", "123").select("balance").execute()
        body = json.loads(post.call_args.kwargs["data"])
        self.assertEqual(body["action"], "update")
        self.assertEqual(body["columns"], "balance")

    @patch("core.api_client.requests.post")
    def test_upsert_and_rpc(self, post):
        post.return_value = self.response
        self.client.table("bot_kv").upsert(
            {"namespace": "test", "key": "one", "value": {"n": 1}},
            on_conflict="namespace,key",
        ).execute()
        body = json.loads(post.call_args.kwargs["data"])
        self.assertEqual(body["action"], "upsert")
        self.assertEqual(body["on_conflict"], "namespace,key")
        self.assertEqual(body["values"]["value"], {"n": 1})

        self.client.rpc("transfer_coins", {"p_amount": 4}).execute()
        self.assertEqual(post.call_args.args[0], "http://127.0.0.1:8787/v1/rpc")
        self.assertEqual(json.loads(post.call_args.kwargs["data"])["name"], "transfer_coins")

    @patch("core.api_client.requests.post")
    def test_rpc_scalar_is_preserved(self, post):
        response = Mock(ok=True, status_code=200)
        response.json.return_value = {"data": False}
        post.return_value = response
        result = self.client.rpc("dungeon_apply_coins", {"p_user_id": "1", "p_delta": -1}).execute()
        self.assertIs(result.data, False)

    @patch("core.api_client.requests.post")
    def test_server_error_becomes_api_error_without_leaking_key(self, post):
        post.return_value = Mock(ok=False, status_code=401)
        post.return_value.json.return_value = {"detail": {"code": "UNAUTHORIZED", "message": "Invalid API credentials"}}
        with self.assertRaises(APIError) as raised:
            self.client.table("users").select("*").execute()
        self.assertEqual(raised.exception.code, "UNAUTHORIZED")
        self.assertEqual(raised.exception.status_code, 401)
        self.assertNotIn("test-secret", str(raised.exception))

    def test_missing_or_complete_environment(self):
        self.assertIsNone(create_client_from_env({}))
        client = create_client_from_env({
            "BOT_API_BASE_URL": "http://127.0.0.1:8787/",
            "BOT_API_KEY": "secret",
            "BOT_API_TIMEOUT": "4.5",
        })
        self.assertEqual(client.base_url, "http://127.0.0.1:8787")
        self.assertEqual(client.timeout, 4.5)

    def test_range_validation(self):
        with self.assertRaises(ValueError):
            self.client.table("users").range(5, 4)


if __name__ == "__main__":
    unittest.main()
