"""Cross-feature invariants for the server-assist integration branch."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from core.server_assist import discover_features

FEATURES = Path(__file__).resolve().parents[1] / "core" / "server_assist" / "features"
NEW_KEYS = {"applications", "polls", "autothread", "embed", "warnings", "autoreact"}


class IntegrationInvariantTest(unittest.TestCase):
    def test_new_features_are_discovered_without_duplicate_keys(self):
        keys = [feature.key for feature in discover_features(refresh=True)]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(NEW_KEYS.issubset(set(keys)))

    def test_custom_ids_are_unique(self):
        seen: dict[str, str] = {}
        for path in FEATURES.glob("*.py"):
            text = path.read_text(encoding="utf-8")
            for match in re.finditer(r'custom_id="([^"]+)"', text):
                custom_id = match.group(1)
                self.assertNotIn(
                    custom_id, seen,
                    f"duplicate custom_id {custom_id} in {path.name} and {seen.get(custom_id)}",
                )
                seen[custom_id] = path.name

    def test_feature_modules_add_no_slash_commands(self):
        for path in FEATURES.glob("*.py"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("@app_commands.command", text, path.name)
            self.assertNotIn("tree.command", text, path.name)


if __name__ == "__main__":
    unittest.main()

