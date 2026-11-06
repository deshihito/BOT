import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import export_jinrou_roles as exporter  # noqa: E402


class JinrouRolesExportTest(unittest.TestCase):
    def test_exported_file_is_up_to_date(self):
        current = exporter.OUT_TS.read_text(encoding="utf-8")
        self.assertEqual(current, exporter.render_ts(exporter.build_roles()),
                         "web/lib/jinrou-roles.ts が古いです。python scripts/export_jinrou_roles.py を実行してください。")

    def test_matches_bot_help_roles(self):
        from cogs import jinrou
        from core.game import jinrou_guide
        text = exporter.OUT_TS.read_text(encoding="utf-8")
        data = json.loads(re.search(r"JINROU_ROLES: JinrouRole\[\] = (\[.*\]);", text, re.S).group(1))
        self.assertEqual(len(data), len(jinrou.HELP_ROLES))
        for row, entry in zip(data, jinrou.HELP_ROLES):
            r = exporter.normalize(entry, use_slug=exporter.USE_SLUG)
            self.assertEqual(row["id"], r["id"])
            self.assertEqual(row["name"], r["name"])
            self.assertEqual(row["teamLabel"], r["teamLabel"])
            self.assertEqual(row["ability"], r["ability"])
            self.assertEqual(row["win"], jinrou_guide.win_condition(r["name"]))
            self.assertEqual(row["id"], jinrou_guide.role_id(r["name"]))

    def test_ids_unique_and_images_exist(self):
        roles = exporter.build_roles()
        ids = [r["id"] for r in roles]
        self.assertEqual(len(ids), len(set(ids)))
        for r in roles:
            if r["image"]:
                self.assertTrue((ROOT / "web" / "public" / r["image"].lstrip("/")).exists(), r["image"])

    def test_id_field_preferred(self):
        self.assertEqual(exporter.normalize(("人狼", "人狼陣営", "x", "JINROU.PNG", "werewolf"))["id"], "werewolf")
        self.assertEqual(exporter.normalize({"id": "seer", "name": "占い師", "faction": "村人陣営", "desc": "x"})["id"], "seer")
        self.assertEqual(exporter.normalize(("人狼", "人狼陣営", "x", "JINROU.PNG"))["id"], "人狼")


if __name__ == "__main__":
    unittest.main()
