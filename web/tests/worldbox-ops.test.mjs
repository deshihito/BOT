// WORLD BOX バッチ9b: 運用（タイルジャーナル・巻き戻し・通報）のテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  const lines = code.split("\n");
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const O = await loadBundle(
  ["worldbox/ops.ts"],
  ["parseJournal", "appendJournal", "stateAtTime", "parseReports", "JOURNAL_DAILY_CAP"],
);

const block = (itemId) => ({ ownerId: "p1", block: { itemId, ownerId: "p1" } });

test("ops: journal append caps and parses defensively", () => {
  let entries = [];
  for (let i = 0; i < O.JOURNAL_DAILY_CAP + 5; i++) {
    entries = O.appendJournal(entries, { key: "1,2", prev: null, next: null, actor: "a", at: i });
  }
  assert.equal(entries.length, O.JOURNAL_DAILY_CAP);
  assert.equal(entries[0].at, 5);
  assert.deepEqual(O.parseJournal("junk"), []);
  assert.deepEqual(O.parseJournal([{ key: "1,2", actor: "a", at: 3 }]).length, 1);
});

test("ops: stateAtTime reconstructs the tile state at a moment", () => {
  const entries = [
    { key: "3,4", prev: null, next: block("wood_block"), actor: "a", at: 100 },
    { key: "3,4", prev: block("wood_block"), next: block("stone_block"), actor: "b", at: 200 },
    { key: "3,4", prev: block("stone_block"), next: null, actor: "a", at: 300 },
    { key: "9,9", prev: null, next: block("wood_block"), actor: "a", at: 150 },
  ];
  assert.equal(O.stateAtTime(entries, "3,4", 50), null);
  assert.equal(O.stateAtTime(entries, "3,4", 150).block.itemId, "wood_block");
  assert.equal(O.stateAtTime(entries, "3,4", 250).block.itemId, "stone_block");
  assert.equal(O.stateAtTime(entries, "3,4", 400), null);
  assert.equal(O.stateAtTime(entries, "0,0", 400), undefined);
});

test("ops: reports parse truncates long text and drops junk", () => {
  const reports = O.parseReports([
    { id: "r1", reporter: "discord:1", text: "x".repeat(400), at: 10 },
    { id: 42, reporter: "x", text: "bad", at: 10 },
    "junk",
  ]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].text.length, 300);
});
