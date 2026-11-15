// ビルド状態（ビルド中の PR 番号表示）の純粋ロジックと配線を確かめる。
// - lib/build-status.ts: デプロイ側 JSON の検証、building の鮮度判定、PR リンク
// - deploy/write_build_status.py: git ログから PR 番号とタイトルを集める
// - deploy/deploy-web.sh: building/deployed/failed を書き出す配線
// - app 側: API ルート、共通バナー、/status のデプロイ欄
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const webRoot = path.join(import.meta.dirname, "..");
const repoRoot = path.join(webRoot, "..");

const src = fs.readFileSync(path.join(webRoot, "lib", "build-status.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const VALID = {
  state: "building",
  commit: "bd92ab2e56785f77dea6d9b1046d236dc6ce2eb3",
  prs: [{ number: 893, title: "すごい機能" }],
  started_at: "2026-11-15T09:53:25+00:00",
  finished_at: null,
  updated_at: "2026-11-15T09:53:25+00:00",
};

test("parseBuildStatus は正しい状態を通し、余分な項目を落とす", () => {
  const parsed = m.parseBuildStatus({ ...VALID, extra: "drop-me" });
  assert.deepEqual(parsed, VALID);
});

test("parseBuildStatus は壊れた入力を null にする", () => {
  assert.equal(m.parseBuildStatus(null), null);
  assert.equal(m.parseBuildStatus("building"), null);
  assert.equal(m.parseBuildStatus([]), null);
  assert.equal(m.parseBuildStatus({ ...VALID, state: "unknown" }), null);
  assert.equal(m.parseBuildStatus({ ...VALID, started_at: "not-a-date" }), null);
  assert.equal(m.parseBuildStatus({ ...VALID, updated_at: "" }), null);
});

test("parseBuildStatus は PR を検証し、重複と不正な番号を落とす", () => {
  const parsed = m.parseBuildStatus({
    ...VALID,
    prs: [
      { number: 893.9, title: "a" },
      { number: 893, title: "dup" },
      { number: -1, title: "bad" },
      { number: "894", title: "bad" },
      { number: 895 },
      "junk",
    ],
  });
  assert.deepEqual(parsed.prs, [
    { number: 893, title: "a" },
    { number: 895, title: "" },
  ]);
});

test("parseBuildStatus は不正な commit を空文字に寄せる", () => {
  assert.equal(m.parseBuildStatus({ ...VALID, commit: "xyz" }).commit, "");
  assert.equal(m.parseBuildStatus({ ...VALID, commit: 123 }).commit, "");
});

test("isActivelyBuilding は building かつ鮮度内だけ true", () => {
  const now = new Date("2026-11-15T10:00:00+00:00");
  assert.equal(m.isActivelyBuilding(m.parseBuildStatus(VALID), now), true);
  assert.equal(
    m.isActivelyBuilding(m.parseBuildStatus({ ...VALID, state: "deployed" }), now),
    false,
  );
  // 30分を超えた building は残骸として表示しない
  const stale = m.parseBuildStatus({
    ...VALID,
    started_at: "2026-11-15T09:00:00+00:00",
    updated_at: "2026-11-15T09:00:00+00:00",
  });
  assert.equal(m.isActivelyBuilding(stale, now), false);
});

test("prUrl は GitHub の PR ページを指す", () => {
  assert.equal(m.prUrl(893), "https://github.com/deshihito/BOT/pull/893");
  assert.equal(
    m.BUILD_STATUS_DEFAULT_PATH,
    "/srv/supabase-data/agobot-web/build-status.json",
  );
});

test("write_build_status.py は git ログから PR 番号とタイトルを集めて原子的に書く", (t) => {
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-status-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  // GitHub のマージコミット形式（件名 + 本文に PR タイトル）
  git(repo, "commit", "-m", "Merge pull request #901 from deshihito/feat/x", "-m", "すごい機能を追加");
  fs.writeFileSync(path.join(repo, "c.txt"), "c\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fix: 細かい修正 (#902)");
  const head = git(repo, "rev-parse", "HEAD");

  const out = path.join(tmp, "build-status.json");
  const script = path.join(repoRoot, "deploy", "write_build_status.py");
  const run = spawnSync(
    "python3",
    [script, "--path", out, "--repo", repo, "--state", "building", "--head", head, "--base", base],
    { encoding: "utf8" },
  );
  if (run.error) {
    t.skip("python3 が無い環境ではスキップ");
    return;
  }
  assert.equal(run.status, 0, run.stderr);
  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(written.state, "building");
  assert.equal(written.commit, head);
  assert.equal(written.finished_at, null);
  assert.deepEqual(written.prs, [
    { number: 902, title: "fix: 細かい修正" },
    { number: 901, title: "すごい機能を追加" },
  ]);

  // deployed へ進めても started_at は引き継がれ、finished_at が入る
  const run2 = spawnSync(
    "python3",
    [script, "--path", out, "--repo", repo, "--state", "deployed", "--head", head, "--base", base],
    { encoding: "utf8" },
  );
  assert.equal(run2.status, 0, run2.stderr);
  const done = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(done.state, "deployed");
  assert.equal(done.started_at, written.started_at);
  assert.ok(done.finished_at);
});

test("deploy-web.sh は building/deployed/failed を build-status.json へ書く", () => {
  const script = fs.readFileSync(path.join(repoRoot, "deploy", "deploy-web.sh"), "utf8");
  assert.ok(script.includes('STATUS_FILE="$ROOT/build-status.json"'));
  assert.ok(script.includes("write_build_status building"));
  assert.ok(script.includes("write_build_status deployed"));
  assert.ok(script.includes("write_build_status failed"));
  // 状態書き出しの失敗でビルドを落とさない
  assert.ok(script.includes("|| true"));
});

test("Web 側の配線: API・バナー・レイアウト・/status", () => {
  const route = fs.readFileSync(path.join(webRoot, "app", "api", "build-status", "route.ts"), "utf8");
  assert.ok(route.includes("loadBuildStatus"));
  assert.ok(route.includes("no-store"));

  const banner = fs.readFileSync(path.join(webRoot, "app", "BuildStatusBanner.tsx"), "utf8");
  assert.ok(banner.includes("/api/build-status"));
  assert.ok(banner.includes("isActivelyBuilding"));
  assert.ok(banner.includes("をビルド中"));

  const layout = fs.readFileSync(path.join(webRoot, "app", "layout.tsx"), "utf8");
  assert.ok(layout.includes("BuildStatusBanner"));

  const status = fs.readFileSync(path.join(webRoot, "app", "status", "page.tsx"), "utf8");
  assert.ok(status.includes("loadBuildStatus"));
  assert.ok(status.includes("Webデプロイ"));

  const server = fs.readFileSync(path.join(webRoot, "lib", "build-status-server.ts"), "utf8");
  assert.ok(server.includes("AGOBOT_BUILD_STATUS_PATH"));
});
