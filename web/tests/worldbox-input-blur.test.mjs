// WORLD BOX: タブ切替・フォーカス喪失で移動入力が残らないことの配線テスト。
// 移動キー入力中に別タブへ切り替えて戻ると、離したはずの keyup がページへ
// 届かず keys Set に押下状態が残って移動し続けた（スティックも同様）。
// blur / visibilitychange で移動入力を全クリアする配線と、クリーンアップで
// リスナーを外すことを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.join(import.meta.dirname, "..");
const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");

test("入力クリア: クリア関数が移動入力の状態をすべて落とす", () => {
  const block = [
    "const clearMoveInput = () => {",
    "      keys.clear();",
    "      dashKey = null;",
    "      joy.active = false;",
    "      joy.pointerId = -1;",
    "      joy.dx = 0;",
    "      joy.dy = 0;",
    "    };",
  ].join("\n");
  assert.ok(client.includes(block), "clearMoveInput がキー・ダッシュ・スティックを全て落とす");
});

test("入力クリア: blur と visibilitychange（hidden のとき）で発火する", () => {
  assert.ok(client.includes('window.addEventListener("blur", clearMoveInput);'));
  assert.ok(client.includes('document.addEventListener("visibilitychange", onVisibilityChange);'));
  assert.ok(client.includes("if (document.hidden) clearMoveInput();"));
});

test("入力クリア: クリーンアップで両リスナーを外す", () => {
  assert.ok(client.includes('window.removeEventListener("blur", clearMoveInput);'));
  assert.ok(client.includes('document.removeEventListener("visibilitychange", onVisibilityChange);'));
});
