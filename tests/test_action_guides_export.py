"""Web コマンド解説の生成データ（tools/export_action_guides）の整合性テスト。

- 生成結果がレジストリ全件と一致すること（ID・件数・ルート別内訳）
- リポジトリにコミットされた web/data/action-guides.json が生成結果と
  完全一致すること（ズレていたら、エクスポートの再実行が必要だと分かる）
を確かめる。Web 側の解説はこの JSON を正として描画するので、ここが
「手書きリストが古くなる」再発防止の固定点になる。
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.general.action_registry import default_registry  # noqa: E402
from tools.export_action_guides import build_action_guides  # noqa: E402

COMMITTED = ROOT / "web" / "data" / "action-guides.json"


class ActionGuidesExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.guides = build_action_guides()
        cls.registry = default_registry()

    def test_total_matches_registry(self):
        self.assertEqual(self.guides["total"], len(self.registry))
        for root, specs in (
            (root, self.registry.by_root(root))
            for root in ("general", "vc", "game", "support", "help")
        ):
            self.assertEqual(self.guides["counts"][root], len(specs), root)

    def test_ids_match_registry(self):
        exported = [
            fn["id"]
            for root in self.guides["roots"]
            for genre in root["genres"]
            for fn in genre["functions"]
        ]
        self.assertEqual(len(exported), len(set(exported)))
        self.assertEqual(set(exported), {spec.id for spec in self.registry.all()})
        for root in self.guides["roots"]:
            for genre in root["genres"]:
                self.assertTrue(genre["label"], (root["root"], genre["key"]))
                for fn in genre["functions"]:
                    self.assertTrue(fn["title"], fn["id"])

    def test_committed_json_matches_generated(self):
        self.assertTrue(
            COMMITTED.exists(),
            "web/data/action-guides.json がありません。"
            "python -m tools.export_action_guides -o web/data/action-guides.json を実行してください。",
        )
        committed = json.loads(COMMITTED.read_text(encoding="utf-8"))
        self.assertEqual(
            committed, self.guides,
            "web/data/action-guides.json がレジストリとズレています。"
            "python -m tools.export_action_guides -o web/data/action-guides.json で再生成してください。",
        )


if __name__ == "__main__":
    unittest.main()
