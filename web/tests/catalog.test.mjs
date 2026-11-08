// commands.json（とサンプル）が、サイトが期待する形と公開コマンド構成になっているかを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(import.meta.dirname, "..", "data");
const files = ["commands.sample.json", "commands.json"].filter((f) => fs.existsSync(path.join(dataDir, f)));
// 公開スラッシュコマンドの構成はファイルごとに固定する。
// commands.json は 2026-11-08 の再書き出しで /quick が独立した公開コマンドになった。
// commands.sample.json はフォールバック用の旧スナップショットなので旧構成のまま。
const publicCommandsByFile = {
  "commands.sample.json": ["game", "general", "help", "vc", "support"],
  "commands.json": ["help", "quick", "support", "game", "vc", "general"],
};

for (const file of files) {
  test(`${file} の形と公開コマンド`, () => {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
    assert.ok(Array.isArray(data.categories) && data.categories.length > 0);
    assert.ok(Array.isArray(data.commands));
    const ids = new Set(data.categories.map((c) => c.id));
    for (const c of data.categories) {
      assert.equal(typeof c.label, "string");
      assert.equal(typeof c.description, "string");
    }
    const seen = new Set();
    for (const cmd of data.commands) {
      assert.ok(["slash", "prefix"].includes(cmd.kind), `${cmd.name}: kind`);
      assert.ok(ids.has(cmd.category), `${cmd.name}: 未定義のカテゴリ ${cmd.category}`);
      assert.equal(typeof cmd.summary, "string");
      assert.ok(Array.isArray(cmd.options) && Array.isArray(cmd.permissions) && Array.isArray(cmd.aliases));
      const key = `${cmd.kind}:${cmd.name}`;
      assert.ok(!seen.has(key), `重複: ${key}`);
      seen.add(key);
    }
    assert.deepEqual(
      data.commands.filter((cmd) => cmd.kind === "slash" && !cmd.hidden).map((cmd) => cmd.name),
      publicCommandsByFile[file],
    );
  });
}
