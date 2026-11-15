// クライアント側ポーリングのガード（S6）のテスト。
// - createPollGuard: in-flight 重複のスキップ、古いチケットの無効化、
//   force 開始、end の安全性
// - 配線（ソース確認）: WorldBoxClient / CasinoPanel / BuildStatusBanner の
//   各ポーリングがガードを通っていること
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function loadBundle(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return new Function(`${code}\nreturn { ${names.join(", ")} };`)();
}

const { createPollGuard } = loadBundle(["poll-guard.ts"], ["createPollGuard"]);

test("poll-guard: 進行中は begin() が null を返し、end 後に再開できる", () => {
  const g = createPollGuard();
  const t1 = g.begin();
  assert.notEqual(t1, null);
  assert.equal(g.begin(), null);
  assert.equal(g.isCurrent(t1), true);
  g.end(t1);
  const t2 = g.begin();
  assert.notEqual(t2, null);
  assert.notEqual(t2, t1);
  g.end(t2);
});

test("poll-guard: force 開始は古いチケットを無効化し、その end は進行中を解かない", () => {
  const g = createPollGuard();
  const t1 = g.begin();
  const t2 = g.begin({ force: true });
  assert.notEqual(t2, null);
  assert.equal(g.isCurrent(t1), false);
  assert.equal(g.isCurrent(t2), true);
  // 古い取得の完了が新しい取得の進行中を解いてはいけない
  g.end(t1);
  assert.equal(g.begin(), null);
  g.end(t2);
  assert.notEqual(g.begin(), null);
});

test("poll-guard: 古いレスポンスは適用せず、新しい取得だけが通る", () => {
  const g = createPollGuard();
  const t1 = g.begin();
  const t2 = g.begin({ force: true });
  assert.equal(g.isCurrent(t1), false);
  assert.equal(g.isCurrent(t2), true);
  g.end(t2);
  // t2 終了後に t1 が最新になることはない
  assert.equal(g.isCurrent(t1), false);
});

test("poll-guard: end は最新チケットのときだけ進行中を解く", () => {
  const g = createPollGuard();
  const t1 = g.begin();
  g.end(9999);
  assert.equal(g.begin(), null);
  g.end(t1);
  assert.notEqual(g.begin(), null);
});

test("poll-guard: WorldBoxClient の各ポーリングがガードを通っている", () => {
  const src = fs.readFileSync(
    path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"),
    "utf8",
  );
  assert.ok(src.includes('import { createPollGuard'), "createPollGuard を import している");
  for (const name of [
    "chatGuardRef", "partyGuardRef", "boardGuardRef", "nationsGuardRef",
    "invGuardRef", "vitalsGuardRef", "deathsGuardRef", "instanceGuardRef",
  ]) {
    assert.ok(src.includes(name), `${name} がある`);
    assert.ok(src.includes(`${name}.current.begin(`), `${name} で begin している`);
    assert.ok(src.includes(`${name}.current.isCurrent(`), `${name} で isCurrent を確認している`);
    assert.ok(src.includes(`${name}.current.end(`), `${name} で end している`);
  }
  // タイルとモブは世代ガード（ローカル行為で進む version と取得開始時の比較）
  assert.ok(src.includes("tilesGen !== tilesVersionRef.current"), "タイルは世代で古い応答を捨てる");
  assert.ok(src.includes("mobsGen !== mobsVersionRef.current"), "モブは世代で古い応答を捨てる");
  assert.ok(src.includes("mobsVersionRef.current += 1"), "攻撃でモブ世代が進む");
  assert.ok(src.includes("presenceGuard.begin()"), "プレゼンスポーリングがガードを通る");
});

test("poll-guard: カジノパネルとビルドバナーがガードを通っている", () => {
  const panel = fs.readFileSync(
    path.join(rootDir, "app/games/worldbox/WorldBoxCasinoPanel.tsx"),
    "utf8",
  );
  assert.ok(panel.includes("refreshGuardRef.current.begin("), "カジノ refresh が begin する");
  assert.ok(panel.includes("refreshGuardRef.current.isCurrent("), "カジノ refresh が isCurrent を確認する");
  assert.ok(panel.includes("void refresh(true)"), "プレイ後の再取得は force");
  const banner = fs.readFileSync(
    path.join(rootDir, "app/BuildStatusBanner.tsx"),
    "utf8",
  );
  assert.ok(banner.includes("guard.begin()"), "ビルドバナーが begin する");
  assert.ok(banner.includes("guard.isCurrent("), "ビルドバナーが isCurrent を確認する");
});
