// AGO WORLD BOX パネルの開閉の検証:
// - 全パネルにパネル内の「閉じる」がある（特に経済は ≡ メニューだけに頼らない）
// - ≡ ボタンとメニューがパネルより手前に出る（パネルに覆われて開閉不能にならない）
// - Esc でも全部閉じられる
// - 旧「建築」パネル（showNations）はプレハブ建物の廃止に伴い撤去済み
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.join(import.meta.dirname, "..");
const client = fs.readFileSync(
  path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"),
  "utf8",
);
const economy = fs.readFileSync(
  path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"),
  "utf8",
);

/** client の中で marker 以降 limit 文字以内に対象文字列があるか。 */
function near(src, marker, needle, limit = 1200) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `marker が無い: ${marker}`);
  return src.slice(i, i + limit).includes(needle);
}

test("旧建築パネル: showNations パネルは撤去済み（中身はプレハブ建物だけだった）", () => {
  assert.ok(!client.includes("showNations"), "旧建築パネルが残っている");
  assert.ok(!client.includes("setShowNations"), "旧建築パネルの状態が残っている");
});

test("経済パネル: onClose を受け取り全状態に閉じるボタンがある", () => {
  assert.match(economy, /onClose: \(\) => void/);
  assert.match(economy, /onClick=\{onClose\}/);
  // 読込中・ゲスト・利用不可の早期 return でも閉じられる（panelHead 経由）
  assert.match(economy, /panelHead\("読み込み中…"\)/);
  assert.ok(
    near(client, "{showEconomy &&", "onClose={() => setShowEconomy(false)}", 200),
    "クライアントが経済パネルへ onClose を渡していない",
  );
});

test("≡ メニューはパネルより手前に出る（開閉の一本化ルートを塞がない）", () => {
  // パネルは zIndex 6。≡ ボタン 7 / メニュー 8 で常に届く。
  assert.match(client, /minWidth: 44, zIndex: 7/);
  assert.match(client, /color: "#fff", zIndex: 8/);
});

test("Esc で開いているパネルとメニューを全部閉じる", () => {
  assert.ok(near(client, 'e.key !== "Escape"', "setShowEconomy(false)", 600));
  assert.ok(near(client, 'e.key !== "Escape"', "setMenuOpen(false)", 600));
});

test("既存パネルの閉じるボタンが残っている", () => {
  // クラフトは PR #903 で独立パネルを廃止し経済パネルの「合成」タブへ
  // 一本化したため、setCraftOpen は存在しないのが正しい状態。
  for (const setter of ["setStorageOpen(false)", "setBoardOpen(false)", "setMapView(false)"]) {
    assert.ok(client.includes(setter), `${setter} が無い`);
  }
  assert.ok(economy.includes('tabBtn("craft", "合成")'), "合成タブが経済パネルに無い");
});
