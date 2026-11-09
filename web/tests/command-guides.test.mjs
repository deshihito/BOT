// コマンド解説の生成データ（web/data/action-guides.json）と、その利用側
// （lib/command-guides.ts が生成データを正として描画すること）を確かめる。
// 機能の一覧は Bot 側レジストリからの生成物が正で、手書きリストは持たない。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webRoot = path.join(import.meta.dirname, "..");
const data = JSON.parse(
  fs.readFileSync(path.join(webRoot, "data", "action-guides.json"), "utf8"),
);

test("action-guides.json の形と件数の整合", () => {
  assert.ok(Array.isArray(data.roots) && data.roots.length > 0);
  const ids = new Set();
  let total = 0;
  const counts = {};
  for (const root of data.roots) {
    assert.equal(typeof root.command, "string");
    assert.ok(Array.isArray(root.genres) && root.genres.length > 0);
    counts[root.root] = 0;
    for (const genre of root.genres) {
      assert.equal(typeof genre.key, "string");
      assert.equal(typeof genre.label, "string");
      assert.ok(genre.label.length > 0);
      for (const fn of genre.functions) {
        assert.ok(!ids.has(fn.id), `重複: ${fn.id}`);
        ids.add(fn.id);
        assert.equal(typeof fn.title, "string");
        assert.ok(fn.title.length > 0, fn.id);
        assert.equal(typeof fn.description, "string");
        counts[root.root] += 1;
        total += 1;
      }
    }
  }
  assert.equal(data.total, total);
  assert.deepEqual(data.counts, counts);
  // game_count はゲームのタイトル数（GAME_GUIDES 由来）。
  // タイトルには人数／所要時間の note が付き、今月のゲーム王には付かない。
  const gameTitles = data.roots
    .find((r) => r.root === "game")
    .genres.flatMap((g) => g.functions)
    .filter((fn) => fn.note).length;
  assert.equal(data.game_count, gameTitles);
});

test("command-guides.ts は生成データを正とし、手書きの機能一覧を持たない", () => {
  const src = fs.readFileSync(path.join(webRoot, "lib", "command-guides.ts"), "utf8");
  assert.match(src, /action-guides\.json/);
  assert.match(src, /TOTAL_FUNCTIONS = DATA\.total/);
  // 旧来の手書きリスト（CommandGuide のリテラル配列）に戻っていないこと
  assert.doesNotMatch(src, /const COMMAND_GUIDES: CommandGuide\[\] = \[/);
});
