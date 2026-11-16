// ヘッダーのログイン中ユーザーアイコンの配線テスト:
// - ログインしたら「Discordに追加」（InviteButton）の右隣にアバターアイコンが出る
// - 未ログインでは出ない（/api/auth/me が user: null を返し、クライアントは描かない）
// - アイコンはダッシュボードへのリンクで、画像が無い場合は頭文字で代替する
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const nav = await readFile(new URL("../app/SiteNav.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/auth/me/route.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("SiteNav は InviteButton の右隣にログイン中ユーザーのアイコンを出す", () => {
  const inviteAt = nav.indexOf("<InviteButton />");
  const iconAt = nav.indexOf("nav-user-icon");
  assert.ok(inviteAt >= 0 && iconAt > inviteAt);
  assert.match(nav, /fetch\("\/api\/auth\/me"/);
  assert.match(nav, /href="\/dashboard"/);
  assert.match(nav, /user\.avatarUrl/);
  assert.match(nav, /nav-user-fallback/);
});

test("/api/auth/me はセッションから名前とアバター URL を返し、未ログインは user: null", () => {
  assert.match(route, /getRequestSession/);
  assert.match(route, /user: null/);
  assert.match(route, /userAvatarUrl/);
  // Google のプロフィール画像（完全な URL）はそのまま使う
  assert.match(route, /startsWith\("http"\)/);
});

test("アイコンの CSS（丸型・ナビ右端の並び）がある", () => {
  assert.match(css, /\.nav-user-icon/);
  assert.match(css, /\.nav-user-fallback/);
});
