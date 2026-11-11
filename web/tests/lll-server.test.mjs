// LLL のサーバー統合（lib/lll-server.ts）の検証。
// balku-room.test.mjs と同じ方式: bot-api は未設定スタブ、
// logfareApiKeys は空スタブ（= Logfare 未設定 → 決定的フォールバック経路）を差し込み、
// メモリのみモードでセッション→鑑定→編成→対戦→報酬の全ループを通す。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

function transpile(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
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
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

async function loadBundle(files, exportNames, prefix = "") {
  const code =
    prefix +
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const PREFIX = `
import { createHash, randomBytes } from "node:crypto";
function isBotApiConfigured() { return false; }
async function kvGet() { return null; }
async function kvSet() {}
async function tableSelect() { return []; }
async function tableUpsert() {}
function logfareApiKeys() { return []; }
`;

const server = await loadBundle(
  ["lll-game.ts", "lll-tactics.ts", "lll-battle.ts", "lll-server.ts"],
  [
    "LllError",
    "getOrCreateProfile",
    "getProfile",
    "appraise",
    "setTeam",
    "growCard",
    "exchangeLumen",
    "startBattle",
    "battleAction",
    "battleTactic",
    "getBattle",
    "parsePlayerAction",
    "parseFeatures",
    "parseBattleStartBody",
    "parseBattleActionBody",
  ],
  PREFIX,
);

const FEATURES = {
  hue: 20,
  saturation: 0.8,
  brightness: 0.5,
  colorVariance: 0.35,
  edgeComplexity: 0.45,
  warmth: 0.9,
  coolness: 0.1,
  pixelHash: "ff00",
};
// 1x1 JPEG 風のダミー data URL（バイト列が決まればよい）
const IMG_A = "data:image/jpeg;base64," + Buffer.from("lll-test-image-A").toString("base64");
const IMG_B = "data:image/jpeg;base64," + Buffer.from("lll-test-image-B").toString("base64");

test("セッション: 新規プロフィールにスターター3枚とチームが付く", async () => {
  const { token, profile } = await server.getOrCreateProfile(null);
  assert.ok(token.length >= 16);
  assert.equal(profile.cards.length, 3);
  assert.equal(profile.teamIds.length, 3);
  const again = await server.getOrCreateProfile(token);
  assert.equal(again.profile.cards.length, 3, "再訪でスターターが重複付与されない");
});

test("鑑定: Logfare未設定でもフォールバックでカードが完成し aiUsed=false", async () => {
  const { token } = await server.getOrCreateProfile(null);
  const res = await server.appraise(token, FEATURES, IMG_A);
  assert.equal(res.duplicated, false);
  assert.ok(res.card);
  assert.equal(res.aiUsed, false);
  assert.equal(res.card.imageDataUrl, IMG_A);
  assert.equal(res.profile.cards.length, 4);
});

test("鑑定: 同じ画像の再スカウトは欠片変換になる", async () => {
  const { token } = await server.getOrCreateProfile(null);
  const first = await server.appraise(token, FEATURES, IMG_B);
  const shardsBefore = first.profile.shards;
  const second = await server.appraise(token, FEATURES, IMG_B);
  assert.equal(second.duplicated, true);
  assert.ok(second.shardsGained >= 5);
  assert.equal(second.profile.shards, shardsBefore + second.shardsGained);
  assert.equal(second.profile.cards.length, 4, "カードは増えない");
});

test("鑑定: 不正な入力は LllError", async () => {
  const { token } = await server.getOrCreateProfile(null);
  await assert.rejects(() => server.appraise(token, FEATURES, "https://example.com/x.png"), server.LllError);
  await assert.rejects(() => server.appraise("no-such-token", FEATURES, IMG_A), server.LllError);
  assert.throws(() => server.parseFeatures({ saturation: 2 }), server.LllError);
});

test("編成と強化: 3枚ちょうど必須、欠片でレベルが上がる", async () => {
  const { token, profile } = await server.getOrCreateProfile(null);
  await assert.rejects(() => server.setTeam(token, profile.teamIds.slice(0, 2)), server.LllError);
  const ok = await server.setTeam(token, [...profile.teamIds]);
  assert.equal(ok.teamIds.length, 3);
  // 欠片を貯めてから強化（重複スカウトで稼ぐ）
  await server.appraise(token, FEATURES, IMG_A);
  await server.appraise(token, FEATURES, IMG_A);
  const dup = await server.appraise(token, FEATURES, IMG_A);
  const target = dup.profile.cards[0];
  const levelBefore = target.level;
  if (dup.profile.shards >= 8) {
    const grown = await server.growCard(token, target.id);
    assert.equal(grown.card.level, levelBefore + 1);
  }
});

test("対戦: スターターで試し切りを開始し、最後まで進行して報酬が1回だけ付く", async () => {
  const { token } = await server.getOrCreateProfile(null);
  const started = await server.startBattle(token, 0);
  const battleId = started.battle.id ?? started.battleId;
  assert.ok(battleId);
  let battle = started.battle;
  let profile = started.profile;
  let guard = 0;
  while (battle.phase !== "finished" && guard++ < 500) {
    const actor = battle.actors.find((a) => a.key === battle.queue[battle.queuePos]);
    assert.ok(actor, "手番アクターがいる");
    assert.equal(actor.side, "player", "返ってくる状態は常にプレイヤー手番");
    const enemies = battle.actors.filter((a) => a.side === "cpu" && a.alive);
    const res = await server.battleAction(token, battleId, {
      skill: "basic",
      targetKey: enemies.sort((x, y) => x.hp - y.hp)[0].key,
    });
    battle = res.battle;
    profile = res.profile;
  }
  assert.equal(battle.phase, "finished");
  assert.ok(["player", "cpu", "draw"].includes(battle.winner));
  const shardsAfter = profile.shards;
  // 終了後に再送しても報酬は増えない
  const again = await server.battleAction(token, battleId, { skill: "defend" }).catch(() => null);
  if (again) assert.equal(again.profile.shards, shardsAfter);
  const fetched = await server.getBattle(token, battleId);
  assert.equal(fetched.phase, "finished");
});

test("対戦: 未解放ティアは開始できない", async () => {
  const { token } = await server.getOrCreateProfile(null);
  await assert.rejects(() => server.startBattle(token, 5), server.LllError);
});

test("鑑定モデルチェーン: 既定モデルが失敗したら画像対応モデルへ進み aiUsed=true になる", async () => {
  const PREFIX_WITH_KEY = `
import { createHash, randomBytes } from "node:crypto";
function isBotApiConfigured() { return false; }
async function kvGet() { return null; }
async function kvSet() {}
async function tableSelect() { return []; }
async function tableUpsert() {}
function logfareApiKeys() { return ["test-key"]; }
`;
  const withAi = await loadBundle(
    ["lll-game.ts", "lll-battle.ts", "lll-server.ts"],
    ["getOrCreateProfile", "appraise", "appraiseWordsWithLogfare"],
    PREFIX_WITH_KEY,
  );
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push(payload.model);
    if (payload.model === "gemma-4-26b") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  name: "夕焼けの番人",
                  flavor: "茜色の空を見守る者。",
                  skillNames: ["残照斬", "茜の盾"],
                  traitName: "夕凪",
                }),
              },
            },
          ],
        }),
      };
    }
    return { ok: false, status: 400, json: async () => ({}) };
  };
  try {
    const words = await withAi.appraiseWordsWithLogfare(IMG_A);
    assert.ok(words, "どこかのモデルで言葉が取れる");
    assert.equal(words.name, "夕焼けの番人");
    assert.equal(calls[0], "claude-haiku-5-5", "最初は既定モデルを試す");
    assert.equal(calls[calls.length - 1], "gemma-4-26b", "失敗したら画像対応モデルへ進む");
    const { token } = await withAi.getOrCreateProfile(null);
    const res = await withAi.appraise(token, FEATURES, IMG_A);
    assert.equal(res.aiUsed, true);
    assert.equal(res.card.name, "夕焼けの番人");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parsePlayerAction: 契約 {skill,targetKey} を検証し type 併記も受ける", () => {
  assert.deepEqual(server.parsePlayerAction({ skill: "basic", targetKey: "cpu_0" }), {
    skill: "basic",
    targetKey: "cpu_0",
  });
  assert.deepEqual(server.parsePlayerAction({ skill: 1, type: "skill" }), { skill: 1, targetKey: undefined });
  assert.throws(() => server.parsePlayerAction({ skill: "fireball" }), server.LllError);
  assert.throws(() => server.parsePlayerAction({ type: "basic" }), server.LllError);
});

test("高密度化: 新規プロフィールは戦術デッキ chain を持ち、開始状態は秘匿部がマスクされる", async () => {
  const { token, profile } = await server.getOrCreateProfile(null);
  assert.equal(profile.tacticDeckId, "chain");
  const started = await server.startBattle(token, 0);
  const t = started.battle.tactics;
  assert.ok(t, "戦術層がある");
  assert.equal(t.player.hand.length, 4, "自分の手札は見える");
  assert.equal(t.player.deck.length, 0, "山札の並びは返さない");
  assert.equal(t.player.deckCount, 26);
  assert.equal(t.player.tp, 5);
  assert.equal(t.cpu.handCount, 0, "Tier0 の敵は戦術デッキを持たない");
  assert.equal(t.cpu.deckCount, 0);
  assert.deepEqual(t.stack, []);
});

test("高密度化: デッキ指定は保存され、不正な指定は 400", async () => {
  const { token } = await server.getOrCreateProfile(null);
  const started = await server.startBattle(token, 0, "echo");
  assert.ok(started.battle.tactics);
  const profile = await server.getProfile(token);
  assert.equal(profile.tacticDeckId, "echo");
  await assert.rejects(() => server.startBattle(token, 0, "nope"), server.LllError);
  assert.throws(
    () => server.parseBattleStartBody({ token: "x".repeat(24), tierIndex: 0, tacticDeckId: "nope" }),
    server.LllError,
  );
  const ok = server.parseBattleStartBody({ token: "x".repeat(24), tierIndex: 0, tacticDeckId: "pursuit" });
  assert.equal(ok.tacticDeckId, "pursuit");
});

test("高密度化: battleTactic は手番を進めず、手札に無いカードは拒否される", async () => {
  let played = false;
  for (let attempt = 0; attempt < 3 && !played; attempt++) {
    const { token } = await server.getOrCreateProfile(null);
    const started = await server.startBattle(token, 0);
    const battleId = started.battle.id;
    await assert.rejects(() => server.battleTactic(token, battleId, "A12"), (e) => {
      // 手札に偶然 A12 がある場合はこの検証はスキップ扱い（別カードで判定）
      return e instanceof server.LllError;
    });
    const before = started.battle;
    const actorKey = before.queue[before.queuePos];
    for (const cardId of [...new Set(before.tactics.player.hand)]) {
      try {
        const res = await server.battleTactic(token, battleId, cardId);
        assert.equal(res.battle.queue[res.battle.queuePos], actorKey, "戦術プレイで手番が進んでいない");
        played = true;
        break;
      } catch (e) {
        assert.ok(e instanceof server.LllError, "検証エラーは LllError");
      }
    }
  }
  assert.ok(played, "3回の開始で1回も戦術カードをプレイできなかった");
});

test("高密度化: parseBattleActionBody は tactic 形式を判別する", () => {
  const token = "x".repeat(24);
  const tactic = server.parseBattleActionBody({ token, battleId: "b1", action: { type: "tactic", cardId: "A8" } });
  assert.equal(tactic.kind, "tactic");
  assert.equal(tactic.cardId, "A8");
  assert.throws(
    () => server.parseBattleActionBody({ token, battleId: "b1", action: { type: "tactic", cardId: "Z9" } }),
    server.LllError,
  );
  const action = server.parseBattleActionBody({ token, battleId: "b1", action: { skill: "basic" } });
  assert.equal(action.kind, "action");
});

test("高密度化: Tier4 の敵は戦術デッキを持つ（手札はマスクされる）", async () => {
  const { token, profile } = await server.getOrCreateProfile(null);
  profile.clearedTiers = [0, 1, 2, 3]; // メモリモードでは返却オブジェクトが正本
  const started = await server.startBattle(token, 4);
  const t = started.battle.tactics;
  // 初手で CPU が先行して戦術を切る場合があるため、総量（30枚）側で判定する
  assert.ok(t.cpu.deckCount >= 20, `敵の山札がある: ${t.cpu.deckCount}`);
  assert.ok(t.cpu.handCount >= 1 && t.cpu.handCount <= 8, `敵の手札がある: ${t.cpu.handCount}`);
  assert.equal(t.cpu.hand.length, 0, "敵の手札の中身は返さない");
});

test("DB永続化: 専用テーブルへの保存・読み戻しと bot_kv フォールバック", async () => {
  const PREFIX_DB = `
import { createHash, randomBytes } from "node:crypto";
function isBotApiConfigured() { return true; }
const __tables = { lll_profiles: new Map(), lll_battles: new Map() };
const __kv = new Map();
async function tableUpsert(table, values) {
  const key = table === "lll_profiles" ? values.token : values.id;
  __tables[table].set(key, values.data);
}
async function tableSelect(table, columns, filters) {
  const key = filters[0].value;
  return __tables[table].has(key) ? [{ data: __tables[table].get(key) }] : [];
}
async function kvGet(ns, key) { return __kv.get(ns + ":" + key) ?? null; }
async function kvSet(ns, key, value) { __kv.set(ns + ":" + key, value); }
function logfareApiKeys() { return []; }
`;
  const db = await loadBundle(
    ["lll-game.ts", "lll-tactics.ts", "lll-battle.ts", "lll-server.ts"],
    ["getOrCreateProfile", "getProfile", "__tables", "__kv"],
    PREFIX_DB,
  );
  // 新規プロフィールは専用テーブルへ書かれる（bot_kv ではない）
  const { token } = await db.getOrCreateProfile(null);
  assert.ok(db.__tables.lll_profiles.has(token), "プロフィールがテーブルに保存される");
  assert.equal(db.__kv.size, 0, "bot_kv へは書かない");
  // テーブルにだけあるプロフィールは読み戻せる（コールド読み）
  db.__tables.lll_profiles.set("cold-token", {
    token: "cold-token", cards: [], teamIds: [], tacticDeckId: "echo",
  });
  const cold = await db.getProfile("cold-token");
  assert.equal(cold.tacticDeckId, "echo");
  // 移行前の bot_kv にだけ残っているプロフィールもフォールバックで読める
  db.__kv.set("lll_profiles:kv-only-token", {
    token: "kv-only-token", cards: [], teamIds: [], tacticDeckId: "pursuit",
  });
  const legacy = await db.getProfile("kv-only-token");
  assert.equal(legacy.tacticDeckId, "pursuit");
});
