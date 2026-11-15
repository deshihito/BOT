// AGO WORLD BOX: モバイル対応（フルスクリーン＋ホットバーのスケーリング）の配線テスト。
// ソース文字列ベースで、ステージのフルスクリーン化と、縦画面ではみ出さない
// スロットサイズの可変化が入っていることを確認する。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/games/worldbox/WorldBoxClient.tsx", import.meta.url), "utf8");

test("ステージをフルスクリーン化できる（ボタンは対応環境でのみ出す）", () => {
  assert.match(client, /const stageRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(client, /ref={stageRef}/);
  assert.match(client, /stageRef\.current\?\.requestFullscreen\(\)/);
  assert.match(client, /document\.exitFullscreen\(\)/);
  assert.match(client, /addEventListener\("fullscreenchange"/);
  assert.match(client, /canFullscreen && \(/);
  assert.match(client, /isFullscreen \? "戻す" : "全画面"/);
});

test("フルスクリーン中はキャンバスがステージいっぱいになる", () => {
  assert.match(client, /height: isFullscreen \? "100%" : "min\(62vh, 560px\)"/);
  assert.match(client, /minHeight: isFullscreen \? 0 : 340/);
  assert.match(client, /isFullscreen \? \{ width: "100%", height: "100%"/);
});

test("ホットバーのスロットは画面幅でスケーリングする（縦画面ではみ出さない）", () => {
  // スロット枠は --slot 変数に従う
  assert.match(client, /width: "var\(--slot, 42px\)"/);
  // ホットバー側で画面幅ベースのクランプを決める
  assert.match(client, /"--slot": "clamp\(30px, 10\.5vw, 42px\)"/);
  // インベントリボタンは潰さず、バー全体はステージ幅に収める
  assert.match(client, /flexShrink: 0, whiteSpace: "nowrap"/);
  assert.match(client, /maxWidth: "calc\(100% - 16px\)"/);
});
