// lib/site-chrome.ts の純粋ロジック（共通クロームの出し分け）を確かめる。
// One Prompter は独立サービス化を前提にした別サービスのデモのため、
// /one-prompter では AGO BOT サイト共通のヘッダー/フッターを出さない。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "site-chrome.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("One Prompter のパスでは共通クロームを出さない", () => {
  assert.equal(m.isChromelessPath("/one-prompter"), true);
  assert.equal(m.isChromelessPath("/one-prompter/"), true);
  assert.equal(m.isChromelessPath("/one-prompter/extra"), true);
});

test("それ以外のページでは共通クロームを出す", () => {
  assert.equal(m.isChromelessPath("/"), false);
  assert.equal(m.isChromelessPath("/games"), false);
  assert.equal(m.isChromelessPath("/features"), false);
  assert.equal(m.isChromelessPath("/one-prompterx"), false);
});

test("最終CTA帯は主要な公開ページで出す", () => {
  for (const path of [
    "/", "/features", "/commands", "/commands/general", "/commands/general/game",
    "/games", "/games/chess", "/ranking", "/faq", "/compute", "/status",
    "/jinrou/roles", "/jinrou/roles/some-role",
  ]) {
    assert.equal(m.showsCtaBand(path), true, `${path} でCTA帯が出ない`);
  }
});

test("最終CTA帯はアプリ画面・ポリシー系・審査用・分離ページで出さない", () => {
  for (const path of [
    "/one-prompter", "/dashboard", "/dashboard/123", "/admin", "/admin/ads",
    "/login", "/activity/music", "/coder", "/map", "/nation",
    "/terms", "/privacy", "/credits", "/intents",
  ]) {
    assert.equal(m.showsCtaBand(path), false, `${path} でCTA帯が出てしまう`);
  }
});

test("アクティビティのプロキシ配下でも公開ページ判定は通常パスと同じ", () => {
  assert.equal(m.showsCtaBand("/.proxy/games"), true);
  assert.equal(m.showsCtaBand("/.proxy/games/chess"), true);
  assert.equal(m.showsCtaBand("/.proxy/dashboard"), false);
});
