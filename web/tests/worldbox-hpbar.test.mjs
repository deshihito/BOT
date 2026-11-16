// AGO WORLD BOX の敵 HP バーの表示条件テスト:
// - HP バーは「自分が攻撃しようとした敵」にだけ出す（当てても外しても出す）
// - 攻撃していない敵・傷ついただけの敵には出さない（従来の hpFrac < 1 ゲートは廃止）
// - 倒した個体はリセットされ、復活後は再び攻撃するまで出ない
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/games/worldbox/WorldBoxClient.tsx", import.meta.url), "utf8");

test("HP バーは showHp フラグでのみ描かれ、旧来の被ダメージゲートは無い", () => {
  assert.doesNotMatch(client, /if \(hpFrac < 1\)/);
  assert.match(client, /HP バー（自分が攻撃しようとした個体だけ/);
  assert.match(client, /if \(showHp\) \{/);
  // 下地トラック＋割合フィルを整数座標で描く
  assert.match(client, /rgba\(255,255,255,0\.22\)/);
  assert.match(client, /Math\.round\(bw \* Math\.min\(1, Math\.max\(0, hpFrac\)\)\)/);
});

test("攻撃しようとした個体が revealedMobs に記録され、描画キューへ渡る", () => {
  assert.match(client, /const revealedMobs = new Set<string>\(\);/);
  // 剣の範囲方式で対象になった個体
  assert.match(client, /revealedMobs\.add\(mobKeyFor\(target\.placed\)\);/);
  // 直接タップ（届かない場合も含む）
  assert.match(client, /revealedMobs\.add\(key\);/);
  // 描画側は記録がある個体だけバーを出す
  assert.match(client, /showHp: revealedMobs\.has\(key\)/);
});

test("倒した個体と画面外の個体は revealedMobs から外れる", () => {
  assert.match(client, /revealedMobs\.delete\(key\);/);
  assert.match(client, /for \(const k of \[\.\.\.revealedMobs\]\) if \(!keys\.has\(k\)\) revealedMobs\.delete\(k\);/);
});
