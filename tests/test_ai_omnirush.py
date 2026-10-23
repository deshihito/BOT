import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core import ai_omnirush


class OmniRushCliTest(unittest.IsolatedAsyncioTestCase):
    def make_cli(self, source):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        executable = Path(temp.name) / "omnirush"
        executable.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
        executable.chmod(0o755)
        return str(executable)

    async def test_cli_uses_careful_permissions_clean_workspace_and_clean_env(self):
        executable = self.make_cli(
            "import json, os, sys\n"
            "print(json.dumps({'args': sys.argv[1:], 'cwd': os.listdir('.'), "
            "'bot_secret': os.getenv('BOT_SECRET'), 'path': os.getenv('PATH')}))\n"
        )
        with patch.dict(os.environ, {"BOT_SECRET": "must-not-leak"}), \
             patch.object(ai_omnirush, "cli_path", return_value=executable):
            result = await ai_omnirush.chat(
                "omnirush::gpt-6-sol", "質問", reasoning_effort="medium"
            )
        payload = json.loads(result)
        self.assertIn("careful", payload["args"])
        self.assertEqual(payload["args"][payload["args"].index("--model") + 1], "gpt-6-sol")
        self.assertEqual(payload["args"][payload["args"].index("--thinking") + 1], "medium")
        self.assertEqual(payload["cwd"], [])
        self.assertIsNone(payload["bot_secret"])
        self.assertIn("--print", payload["args"])

    async def test_default_model_uses_official_default_without_model_override(self):
        executable = self.make_cli(
            "import sys\n"
            "print(' '.join(sys.argv[1:]))\n"
        )
        with patch.object(ai_omnirush, "cli_path", return_value=executable):
            result = await ai_omnirush.chat("omnirush::gpt-6-astra", "質問")
        self.assertNotIn("--model", result)
        self.assertEqual(ai_omnirush.model_name("omnirush::gpt-6-astra"), "GPT 6 Astra")

    async def test_login_error_is_reported_without_forwarding_stderr(self):
        executable = self.make_cli(
            "import sys\n"
            "print('Please log in first', file=sys.stderr)\n"
            "raise SystemExit(1)\n"
        )
        with patch.object(ai_omnirush, "cli_path", return_value=executable):
            with self.assertRaises(ai_omnirush.OmniRushLoginRequired):
                await ai_omnirush.chat("omnirush::gpt-6-astra", "質問")

    async def test_only_allowlisted_models_are_executable(self):
        with self.assertRaises(ai_omnirush.OmniRushError):
            await ai_omnirush.chat("omnirush::made-up-model", "質問")

    def test_cli_timeout_defaults_and_is_bounded_by_environment_setting(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(ai_omnirush.cli_timeout_seconds(), 300)
        with patch.dict(os.environ, {"OMNIRUSH_TIMEOUT_SECONDS": "420"}, clear=True):
            self.assertEqual(ai_omnirush.cli_timeout_seconds(), 420)
        with patch.dict(os.environ, {"OMNIRUSH_TIMEOUT_SECONDS": "5"}, clear=True):
            self.assertEqual(ai_omnirush.cli_timeout_seconds(), 30)
        with patch.dict(os.environ, {"OMNIRUSH_TIMEOUT_SECONDS": "900"}, clear=True):
            self.assertEqual(ai_omnirush.cli_timeout_seconds(), 600)
        with patch.dict(os.environ, {"OMNIRUSH_TIMEOUT_SECONDS": "invalid"}, clear=True):
            self.assertEqual(ai_omnirush.cli_timeout_seconds(), 300)


if __name__ == "__main__":
    unittest.main()
