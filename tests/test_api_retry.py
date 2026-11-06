import unittest
from unittest.mock import patch

from core.support.api_client import APIError
from core.support.api_retry import is_transient_error, run_with_retry


class APIRetryTest(unittest.TestCase):
    def test_retries_only_explicit_pre_execution_unavailable(self):
        calls = 0

        def operation():
            nonlocal calls
            calls += 1
            if calls < 3:
                raise APIError("pool busy", code="API_UNAVAILABLE", status_code=503)
            return "ok"

        with patch("core.support.api_retry.time.sleep") as sleep:
            self.assertEqual(run_with_retry(operation, delays=(0.1, 0.2)), "ok")
        self.assertEqual(calls, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.1, 0.2])

    def test_reraises_after_retry_budget(self):
        error = APIError("pool busy", code="API_UNAVAILABLE", status_code=503)
        with patch("core.support.api_retry.time.sleep"):
            with self.assertRaises(APIError) as raised:
                run_with_retry(lambda: (_ for _ in ()).throw(error), delays=(0,))
        self.assertIs(raised.exception, error)

    def test_does_not_retry_ambiguous_transport_or_other_errors(self):
        error = APIError("connection timed out", code="API_CONNECTION_ERROR")
        with patch("core.support.api_retry.time.sleep") as sleep:
            with self.assertRaises(APIError):
                run_with_retry(lambda: (_ for _ in ()).throw(error))
        sleep.assert_not_called()
        self.assertTrue(is_transient_error(APIError("pool busy", code="API_UNAVAILABLE")))
        self.assertFalse(is_transient_error(error))


if __name__ == "__main__":
    unittest.main()
