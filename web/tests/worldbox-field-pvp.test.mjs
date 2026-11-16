// AGO WORLD BOX のフィールド PvP と敵 HP バーの配線テスト:
// - モブの HP バーは常時表示（満タンでも出す。傷ついた時だけでは HP が分からない）
// - 剣を構えているときは他プレイヤーも剣の範囲の対象に入り、タップで殴れる
// - 素手・他道具でのタップは従来どおりプロフィールチップ（招待導線）を出す
// - サーバーは vitals ルートの pvp アクションでプレゼンス検証してから適用する
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/games/worldbox/WorldBoxClient.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/worldbox/vitals/route.ts", import.meta.url), "utf8");

test("モブの HP バーは常時表示で、満タン時は下地の上に満量の色が出る", () => {
  // 傷ついた個体だけ出すゲートは無い
  assert.doesNotMatch(client, /if \(hpFrac < 1\)/);
  assert.match(client, /HP バー（常時表示/);
  // 下地（残量が分かるトラック）と割合フィルを整数座標で描く
  assert.match(client, /rgba\(255,255,255,0\.22\)/);
  assert.match(client, /Math\.round\(bw \* Math\.min\(1, Math\.max\(0, hpFrac\)\)\)/);
});

test("クライアントは剣の範囲候補に他プレイヤーを含め、pvp アクションで攻撃する", () => {
  assert.match(client, /const attackPlayer = async/);
  assert.match(client, /action: "pvp", targetId/);
  assert.match(client, /playerId: oid/);
  assert.match(client, /target\.playerId\) void attackPlayerRef\.current/);
  // 剣＋PvP 空間のタップはプロフィールチップでなく攻撃へ流す
  assert.match(client, /if \(selTool === "sword" && pvpSpace\) break;/);
});

test("vitals ルートは pvp をプレゼンス検証＋対象ロックで適用し、死亡は pendingDeath で本人へ渡す", () => {
  assert.match(route, /action === "pvp"/);
  assert.match(route, /listPresenceWithOwners/);
  assert.match(route, /applyPlayerDamage/);
  assert.match(route, /withUserLock\(`pvp:\$\{targetKey\}`/);
  assert.match(route, /pendingDeath/);
  // ロビー/テント/ダンジョンでは許可しない
  assert.match(route, /pvp_not_allowed/);
});
