import unittest
from unittest.mock import patch

from core.supabase_retry import is_transient_error, run_with_retry


class PostgrestError(Exception):
    def __init__(self, code):
        super().__init__({"code": code})
        self.code = code


class SupabaseRetryTest(unittest.TestCase):
    def test_retries_schema_cache_error_and_returns_result(self):
        calls = 0

        def operation():
            nonlocal calls
            calls += 1
            if calls < 3:
                raise PostgrestError("PGRST002")
            return "ok"

        with patch("core.supabase_retry.time.sleep") as sleep:
            self.assertEqual(run_with_retry(operation, delays=(0.1, 0.2)), "ok")

        self.assertEqual(calls, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.1, 0.2])

    def test_reraises_after_retry_budget(self):
        error = PostgrestError("PGRST002")
        with patch("core.supabase_retry.time.sleep"):
            with self.assertRaises(type(error)) as raised:
                run_with_retry(lambda: (_ for _ in ()).throw(error), delays=(0,))
        self.assertIs(raised.exception, error)

    def test_does_not_retry_non_transient_error(self):
        error = PostgrestError("PGRST205")
        with patch("core.supabase_retry.time.sleep") as sleep:
            with self.assertRaises(type(error)):
                run_with_retry(lambda: (_ for _ in ()).throw(error))
        sleep.assert_not_called()
        self.assertTrue(is_transient_error(PostgrestError("PGRST002")))
        self.assertFalse(is_transient_error(error))


if __name__ == "__main__":
    unittest.main()
