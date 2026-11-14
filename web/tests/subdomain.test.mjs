// lib/subdomain.ts の純粋ロジック（専用サブドメインの振り分け）を確かめる。
// 2026-11-10 の障害の回帰テスト: Tunnel 配下（Host=localhost /
// X-Forwarded-Host=oneprompter.agobot.app / X-Forwarded-Proto=https）で
// middleware rewrite が外部プロキシ扱いになり 500 になった。飛ばし先は
// rewrite ではなく公開 URL への redirect で、localhost を含まないこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "subdomain.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("effectiveHost は X-Forwarded-Host の先頭を優先し、無ければホスト名に倒す", () => {
  assert.equal(m.effectiveHost("oneprompter.agobot.app", "localhost"), "oneprompter.agobot.app");
  assert.equal(m.effectiveHost("oneprompter.agobot.app, agobot.app", "localhost"), "oneprompter.agobot.app");
  assert.equal(m.effectiveHost(" oneprompter.agobot.app ", "localhost"), "oneprompter.agobot.app");
  assert.equal(m.effectiveHost(null, "agobot.app"), "agobot.app");
  assert.equal(m.effectiveHost(undefined, "agobot.app"), "agobot.app");
  assert.equal(m.effectiveHost("", "agobot.app"), "agobot.app");
});

test("専用サブドメインのルートは公開 URL の /one-prompter へ飛ばす", () => {
  // Tunnel 配下の実リクエスト形（今回 500 になった組み合わせ）
  assert.equal(
    m.onePrompterRedirectUrl({
      pathname: "/",
      forwardedHost: "oneprompter.agobot.app",
      hostname: "localhost",
      search: "",
    }),
    "https://oneprompter.agobot.app/one-prompter",
  );
  // 直接ホストが一致する形（Tunnel を介さないアクセス）
  assert.equal(
    m.onePrompterRedirectUrl({
      pathname: "/",
      forwardedHost: null,
      hostname: "oneprompter.agobot.app",
      search: "",
    }),
    "https://oneprompter.agobot.app/one-prompter",
  );
});

test("飛ばし先は localhost を含まず、クエリ文字列を引き継ぐ", () => {
  const url = m.onePrompterRedirectUrl({
    pathname: "/",
    forwardedHost: "oneprompter.agobot.app",
    hostname: "localhost",
    search: "?src=x",
  });
  assert.equal(url, "https://oneprompter.agobot.app/one-prompter?src=x");
  assert.ok(!url.includes("localhost"));
});

test("対象外のリクエストは null（通常表示に倒す）", () => {
  // 本体ドメインのルート
  assert.equal(
    m.onePrompterRedirectUrl({ pathname: "/", forwardedHost: "agobot.app", hostname: "localhost", search: "" }),
    null,
  );
  // 専用サブドメインでもルート以外は対象外
  assert.equal(
    m.onePrompterRedirectUrl({ pathname: "/one-prompter", forwardedHost: "oneprompter.agobot.app", hostname: "localhost", search: "" }),
    null,
  );
  // 無関係なホスト
  assert.equal(
    m.onePrompterRedirectUrl({ pathname: "/", forwardedHost: null, hostname: "example.com", search: "" }),
    null,
  );
});

test("ポートフォリオ枠のサブドメインは割り当てファイルの公開パスへ飛ばす", () => {
  assert.equal(
    m.subdomainRedirectUrl({
      pathname: "/",
      forwardedHost: "deshihito.agobot.app",
      hostname: "localhost",
      search: "",
    }),
    "https://deshihito.agobot.app/folio/deshihito",
  );
  assert.equal(
    m.subdomainRedirectUrl({
      pathname: "/",
      forwardedHost: "tadanoen.agobot.app",
      hostname: "localhost",
      search: "",
    }),
    "https://tadanoen.agobot.app/folio/tadanoen",
  );
  // クエリ文字列を引き継ぎ、localhost を含まない
  const url = m.subdomainRedirectUrl({
    pathname: "/",
    forwardedHost: "deshihito.agobot.app",
    hostname: "localhost",
    search: "?src=x",
  });
  assert.equal(url, "https://deshihito.agobot.app/folio/deshihito?src=x");
  assert.ok(!url.includes("localhost"));
  // ルート以外と無関係なホストは対象外
  assert.equal(
    m.subdomainRedirectUrl({ pathname: "/folio/deshihito", forwardedHost: "deshihito.agobot.app", hostname: "localhost", search: "" }),
    null,
  );
  assert.equal(
    m.subdomainRedirectUrl({ pathname: "/", forwardedHost: "agobot.app", hostname: "localhost", search: "" }),
    null,
  );
});

test("汎用振り分けは One Prompter も同じ割り当て表で飛ばす", () => {
  assert.equal(
    m.subdomainRedirectUrl({
      pathname: "/",
      forwardedHost: "oneprompter.agobot.app",
      hostname: "localhost",
      search: "",
    }),
    "https://oneprompter.agobot.app/one-prompter",
  );
  // 後方互換ラッパーは他ホストを対象外に戻す
  assert.equal(
    m.onePrompterRedirectUrl({ pathname: "/", forwardedHost: "deshihito.agobot.app", hostname: "localhost", search: "" }),
    null,
  );
});

test("middleware はサブドメイン振り分けに rewrite を使わない", () => {
  const middleware = fs.readFileSync(path.join(import.meta.dirname, "..", "middleware.ts"), "utf8");
  assert.ok(!middleware.includes("NextResponse.rewrite"), "rewrite は Tunnel 配下で 500 の原因になる");
  assert.ok(middleware.includes("subdomainRedirectUrl"));
  assert.ok(middleware.includes("NextResponse.redirect"));
});
