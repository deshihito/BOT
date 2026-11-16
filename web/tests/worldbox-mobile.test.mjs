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

test("キャンバスは常時ステージいっぱいになる（独立シェル 100svh）", () => {
  // ステージはシェルの残り全高を占め、キャンバスは常にその全面を使う
  assert.match(client, /flex: "1 1 auto", minHeight: 0/);
  assert.match(client, /width: "100%", height: "100%", display: "block"/);
  assert.match(client, /isFullscreen \? \{ height: "100%", background: "#0b0e14" \}/);
});

test("≡ メニューはステージ下端からはみ出さない（収まらない分はスクロール）", () => {
  assert.match(client, /maxHeight: "calc\(100% - 68px\)"/);
  assert.match(client, /overflowY: "auto", overscrollBehavior: "contain", touchAction: "pan-y"/);
});

test("ホットバーのスロットは画面幅でスケーリングする（縦画面ではみ出さない）", async () => {
  // スロット枠は --slot 変数に従う
  assert.match(client, /width: "var\(--slot, 42px\)"/);
  // ホットバー側の寸法はレイアウトモード（lib/worldbox/layout）が決める:
  // wide は従来の画面幅クランプ、縦持ちは 44px 級に広げる
  assert.match(client, /"--slot": hud\.hotbarSlotCss/);
  const layout = await readFile(new URL("../lib/worldbox/layout.ts", import.meta.url), "utf8");
  assert.match(layout, /"clamp\(30px, 10\.5vw, 42px\)"/);
  assert.match(layout, /"clamp\(38px, 12vw, 44px\)"/);
  // インベントリボタンは潰さず、バー全体はステージ幅に収める
  assert.match(client, /flexShrink: 0, whiteSpace: "nowrap"/);
  assert.match(client, /maxWidth: "calc\(100% - 16px\)"/);
});
