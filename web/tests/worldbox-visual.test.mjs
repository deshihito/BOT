// AGO WORLD BOX v2.1 見た目刷新の検証:
// - タイルは用意済みテクスチャ素材（lib/worldbox/textures.ts）で描く
// - プレイヤーは公式あごむに画像 /img/nomal.png、敵は公式の人狼あごむに /img/jinrou.png
// - 旧来の図形描きキャラ/敵（drawAgo・紫ブロブ）は残っていない
// - 遠景の丘パララックスと深層の石の暗がりが入っている
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.join(import.meta.dirname, "..");
const clientSrc = fs.readFileSync(path.join(rootDir, "app", "games", "worldbox", "WorldBoxClient.tsx"), "utf8");
const texturesSrc = fs.readFileSync(path.join(rootDir, "lib", "worldbox", "textures.ts"), "utf8");

test("テクスチャ素材: タイル9種が揃い、敵エントリは無い（敵は public 画像を使う）", () => {
  for (const key of ["grass", "dirt", "stone", "bedrock", "wood", "leaves", "coal", "copper", "sand"]) {
    assert.ok(texturesSrc.includes(`${key}: "data:image/png;base64,`), `テクスチャ ${key} がない`);
  }
  assert.ok(!/^\s+enemy:/m.test(texturesSrc), "textures.ts に enemy エントリが残っている");
  assert.ok(texturesSrc.includes("export function loadTextures()"), "loadTextures がない");
  assert.ok(texturesSrc.includes("export const TEXTURE_DATA"), "TEXTURE_DATA がない");
});

test("クライアント: タイル描画に TEXTURE_DATA / loadTextures を使う", () => {
  assert.ok(clientSrc.includes("loadTextures"), "loadTextures を呼んでいない");
  assert.ok(clientSrc.includes("TEXTURE_DATA"), "TEXTURE_DATA を参照していない");
  assert.ok(clientSrc.includes("TEXTURE_KEY_BY_BLOCK"), "ブロック→テクスチャの対応表がない");
  for (const pair of ['[GRASS]: "grass"', '[DIRT]: "dirt"', '[STONE]: "stone"', '[WOOD]: "wood"', '[LEAVES]: "leaves"', '[SAND]: "sand"', '[COAL_ORE]: "coal"', '[COPPER_ORE]: "copper"', '[BEDROCK]: "bedrock"']) {
    assert.ok(clientSrc.includes(pair), `対応 ${pair} がない`);
  }
  assert.ok(clientSrc.includes("drawImage(tex"), "テクスチャを drawImage していない");
  // 読み込み前はフラット描画に落ちる（真っ白なタイルを作らない）
  assert.ok(clientSrc.includes("texReady"), "読み込み判定 texReady がない");
});

test("クライアント: プレイヤーは公式あごむに画像 /img/nomal.png で描く", () => {
  assert.ok(clientSrc.includes('"/img/nomal.png"'), "/img/nomal.png を読み込んでいない");
  assert.ok(clientSrc.includes("drawPlayer"), "drawPlayer がない");
  assert.ok(clientSrc.includes("drawImage(img, -size / 2, -size, size, size)"), "足元アンカーの drawImage がない");
});

test("クライアント: 敵は公式の人狼あごむに画像 /img/jinrou.png で描く", () => {
  assert.ok(clientSrc.includes('"/img/jinrou.png"'), "/img/jinrou.png を読み込んでいない");
  assert.ok(clientSrc.includes("人狼あごむに"), "敵の呼称が人狼あごむにになっていない");
});

test("クライアント: 旧来の図形描きキャラ/敵は残っていない", () => {
  assert.ok(!clientSrc.includes("drawAgo"), "旧 drawAgo（図形描きあごむに）が残っている");
  assert.ok(!clientSrc.includes("#aebfc6"), "旧キャラの首元の影色が残っている");
  assert.ok(!clientSrc.includes("#46335e"), "旧敵（紫ブロブ）の体色が残っている");
  assert.ok(!clientSrc.includes("footSwing"), "旧キャラの足描画が残っている");
});

test("クライアント: 遠景の丘パララックスと深層の石の暗がりがある", () => {
  assert.ok(clientSrc.includes("drawHills"), "遠景の丘 drawHills がない");
  assert.ok(clientSrc.includes("DEEP_STONE_Y"), "深層の石の暗がりに DEEP_STONE_Y を使っていない");
});

test("公開画像: nomal.png と jinrou.png が public に存在する", () => {
  for (const name of ["nomal.png", "jinrou.png"]) {
    const p = path.join(rootDir, "public", "img", name);
    assert.ok(fs.existsSync(p), `${name} がない`);
    const buf = fs.readFileSync(p);
    assert.ok(buf.length > 1000 && buf.subarray(1, 4).toString("latin1") === "PNG", `${name} が PNG でない`);
  }
});
