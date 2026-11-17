// AGO WORLD BOX 修正バッチ1（戦闘・同期の実害）の回帰テスト。
// - 接触ダメージの実位置ルール: 追跡してきたモブがアンカー基準で
//   too_far になりダメージが無効化されていた（攻撃側は PR #989 で是正済み、
//   接触側が未適用だった）
// - 中立モブ: provoked 中は接触ダメージを与える（サーバーの受け付け条件
//   = passive 以外、とクライアントの送信条件を一致させる）
// - watch: worldbox_instances を対象に加え、宛先をキーから解決する
// - 配線: vitals / roles / party ルート、クライアント、中継の接続
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const require = createRequire(import.meta.url);
const watch = require(path.join(rootDir, "realtime", "watch-core.js"));

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

function stripModuleSyntax(code) {
  const lines = code.split("\n");
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return dataUrl(`${code}\nexport { ${names.join(", ")} };`);
}

const combat = await import(bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/combat.ts", "worldbox/arena.ts"],
  ["mobById", "MOBS", "mobDistance", "resolveMobPosition", "MOB_ATTACK_MAX_DISTANCE"],
));

test("接触ダメージ: 追跡してきたモブは申告位置で距離検証され、アンカー基準では too_far", () => {
  // vitals ルートの damage 検証と同じ合成（申告→実位置→占有範囲までの距離）
  const anchor = { mobId: "slime", x: 100, y: 100, size: 1 };
  const player = { x: 108, y: 103 };
  // アンカー基準（従来）: 足元まで追ってきたモブでも 8 マス先に見えて弾かれる
  assert.ok(combat.mobDistance(player.x, player.y, anchor) > combat.MOB_ATTACK_MAX_DISTANCE);
  // 申告あり（是正後）: 現在タイルが採用され、接触が通る
  const eff = combat.resolveMobPosition(anchor, { x: 108, y: 103 });
  assert.ok(combat.mobDistance(player.x, player.y, eff) <= combat.MOB_ATTACK_MAX_DISTANCE);
  // リーシュ外の申告は採用されず、アンカー検証へ落ちる（チート申告の無効化）
  const forged = combat.resolveMobPosition(anchor, { x: 108, y: 103, });
  assert.equal(forged.x, 108);
  const outside = combat.resolveMobPosition(anchor, { x: 150, y: 150 });
  assert.equal(outside.x, 100);
  assert.ok(combat.mobDistance(player.x, player.y, outside) > combat.MOB_ATTACK_MAX_DISTANCE);
});

test("中立モブ: 監査対象の10種は全て neutral かつ attack > 0（サーバーの受け付け条件と一致）", () => {
  const neutralIds = ["cave_bat", "treant", "bear", "boar", "bee", "crab", "fox", "mushroom", "goat", "octopus"];
  for (const id of neutralIds) {
    const def = combat.mobById(id);
    assert.ok(def, `${id} の定義が無い`);
    assert.equal(def.temperament, "neutral", `${id} は neutral のはず`);
    assert.ok(def.attack > 0, `${id} は attack > 0 のはず（サーバーが unknown_mob で弾かない）`);
  }
  // neutral 全種が attack > 0（provoked 中に送った接触をサーバーが弾かない）
  for (const def of combat.MOBS) {
    if (def.temperament === "neutral") assert.ok(def.attack > 0, `${def.id} は neutral なのに attack が 0`);
  }
});

test("watch: WATCH_PLAN に worldbox_instances（速い系・poke）が入っている", () => {
  const plan = watch.WATCH_PLAN.find((p) => p.namespace === "worldbox_instances");
  assert.ok(plan, "worldbox_instances が watch 対象に無い");
  assert.equal(plan.kind, "instances");
  assert.equal(plan.intervalMs, 2_000);
});

test("watch: instanceKeyScope はキー形式ごとに宛先を解決する", () => {
  // 洞窟/遺跡の共有状態はその空間
  assert.deepEqual(watch.instanceKeyScope("cave:10,20:0"), { space: "cave:10,20:0" });
  assert.deepEqual(watch.instanceKeyScope("ruins:-9999,-9999:0"), { space: "ruins:-9999,-9999:0" });
  // 遺跡の個人状態は本人だけ
  assert.deepEqual(
    watch.instanceKeyScope("ruins:10,20:0#discord:123"),
    { pid: watch.presenceIdFor("discord:123") },
  );
  // ダンジョンのセッションは入口でまとめる（partyKey を pid と誤読しない）
  assert.deepEqual(watch.instanceKeyScope("dungeon:10,20:0#party-abc"), { spacePrefix: "dungeon:10,20:" });
  assert.deepEqual(watch.instanceKeyScope("dungeon:10,20:0#solo:discord:123"), { spacePrefix: "dungeon:10,20:" });
  // 週次クリア記録と未知キーは対象外
  assert.equal(watch.instanceKeyScope("dungeonclear:discord:123"), null);
  assert.equal(watch.instanceKeyScope("something:else"), null);
});

test("配線: vitals の接触ダメージが申告位置（mx/my）で距離検証する", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/vitals/route.ts"), "utf8");
  assert.ok(route.includes("resolveMobPosition"), "resolveMobPosition を使っていない");
  assert.ok(route.includes("data.mx"), "mx の申告を読んでいない");
  assert.ok(route.includes("data.my"), "my の申告を読んでいない");
});

test("配線: クライアントが接触時に現在タイルを送り、中立 provoked でも発火する", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("{ mx, my }"), "接触ダメージに現在タイルを添えていない");
  assert.ok(client.includes('def.temperament === "neutral" && provoked'), "中立 provoked の送信条件が無い");
  assert.ok(client.includes("provokedUntil"), "provoked 判定が無い");
});

test("配線: 技で番人を倒してもダンジョンの鍵が落ちる", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/roles/route.ts"), "utf8");
  assert.ok(route.includes("dungeonKeyHolder"), "番人の解決が無い");
  assert.ok(route.includes("gainedAll.dungeon_key"), "技経路の鍵付与が無い");
  // 通常攻撃側の既存付与も残っている
  const mobs = fs.readFileSync(path.join(rootDir, "app/api/worldbox/mobs/route.ts"), "utf8");
  assert.ok(mobs.includes("result.gained.dungeon_key"), "通常攻撃側の鍵付与が消えている");
});

test("配線: パーティ accept は二重所属を拒否し、leave はセッションを畳む", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/party/route.ts"), "utf8");
  assert.ok(route.includes("already_in_party"), "二重所属の拒否が無い");
  assert.ok(route.includes("settleDungeonSessionOnLeave"), "退出時のセッション後始末が無い");
  assert.ok(route.includes("deleteDungeonSession"), "解散時のセッション削除が無い");
  assert.ok(route.includes("pendingTeleport"), "中にいる人の入口前への帰還予約が無い");
});

test("配線: 中継が instances を poke し、クライアントが取り直す", () => {
  const server = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");
  assert.ok(server.includes('kind === "instances"'), "中継に instances の配信分岐が無い");
  assert.ok(server.includes("instanceKeyScope"), "宛先解決を使っていない");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes('msg.kind === "instances"'), "クライアントに instances poke の適用が無い");
  // パーティ取得がダンジョン要約（?space=）を取りに行き、階段ゲートへ反映する
  assert.ok(client.includes("party?space="), "パーティ取得が ?space= を付けていない");
  assert.ok(client.includes("floorBossDead: data.dungeon.floorBossDead"), "ダンジョン要約の反映が無い");
  // インスタンス行為の失敗時にも状態を取り直す（成功時と合わせて2経路）
  const refetches = client.split("void refreshCaveState(space);").length - 1;
  assert.ok(refetches >= 2, "洞窟状態の再取得が成功時にしか無い");
});
