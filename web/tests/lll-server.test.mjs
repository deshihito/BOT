// LLL のサーバー統合（lib/lll/lll-server.ts）の検証。
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
  ["lll/lll-game.ts", "lll/lll-tactics.ts", "lll/lll-battle.ts", "lll/lll-server.ts"],
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
    "ticketSummon",
    "limitBreakCard",
    "awakenCard",
    "dismantleCards",
    "toggleLockCard",
    "setFavoriteCard",
    "setPlayerName",
    "setCustomTacticDeck",
    "claimMission",
    "startAbyssBattle",
    "listPvpRivals",
    "startPvpBattle",
    "battleAutoStep",
    "craftRelic",
    "equipRelics",
    "tuneCardTrait",
    "tuneCardSkill2",
    "parseGrowBody",
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

test("鑑定モデル: gemma-4-26b で言葉が取れ aiUsed=true になる", async () => {
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
    ["lll/lll-game.ts", "lll/lll-battle.ts", "lll/lll-server.ts"],
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
    assert.equal(calls[0], "gemma-4-26b", "既定モデルは gemma-4-26b");
    assert.equal(calls[calls.length - 1], "gemma-4-26b", "最後まで gemma-4-26b のみを使う");
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
  // 初手で CPU が先行して戦術を切り、手札を使い切ったりドローで山札が
  // 大きく減ったりするため、個別の枚数ではなく総量の保存で判定する:
  // 山札30枚は 山札+手札+捨て札+設置 のどこかに必ず存在する
  const total = t.cpu.deckCount + t.cpu.handCount + t.cpu.discard.length + t.cpu.reserveCount;
  assert.equal(total, 30, `敵の戦術デッキ30枚の所在が全て確認できる: ${total}`);
  assert.equal(t.cpu.hand.length, 0, "敵の手札の中身は返さない");
  assert.equal(t.cpu.deck.length, 0, "敵の山札の並びは返さない");
  assert.equal(t.cpu.reserves.length, 0, "敵の設置内容は返さない");
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
    ["lll/lll-game.ts", "lll/lll-tactics.ts", "lll/lll-battle.ts", "lll/lll-server.ts"],
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

test("ソシャゲ化: チケット召喚・重複自動凸・限界突破・覚醒・ロック・推し・分解・カスタムデッキ", async () => {
  const { token, profile, loginBonus } = await server.getOrCreateProfile(null);
  assert.ok(loginBonus, "初回セッションでログインボーナスが付く");
  assert.ok(profile.tickets >= 3, "初期スカウト券が付与される");

  // チケット召喚
  const summoned = await server.ticketSummon(token);
  assert.ok(summoned.card);
  assert.ok(summoned.card.tier === "elite" || summoned.card.tier === "legend");
  assert.equal(summoned.profile.cards.length, 4);

  // 重複スカウトで自動限界突破
  await server.appraise(token, FEATURES, IMG_A);
  const dup = await server.appraise(token, FEATURES, IMG_A);
  assert.equal(dup.duplicated, true);
  assert.equal(dup.limitBroken, true);
  const dupCard = dup.profile.cards.find((c) => c.imageDataUrl === IMG_A);
  assert.equal(dupCard.limitBreak, 1);

  // ロック・推し・名前変更
  const locked = await server.toggleLockCard(token, dupCard.id);
  assert.equal(locked.locked, true);
  await assert.rejects(() => server.dismantleCards(token, [dupCard.id]), server.LllError);
  await server.toggleLockCard(token, dupCard.id);

  const fav = await server.setFavoriteCard(token, dupCard.id);
  assert.equal(fav.favoriteCardId, dupCard.id);
  const named = await server.setPlayerName(token, "星導士");
  assert.equal(named.playerName, "星導士");

  // 分解で欠片を増やし、限界突破・覚醒
  const dis = await server.dismantleCards(token, [dupCard.id]);
  assert.ok(dis.shardsGained >= 5);

  const starterId = dis.profile.teamIds[0];
  // チケット消費分と欠片補充のため追加重複
  for (let i = 0; i < 6; i++) {
    await server.appraise(token, FEATURES, IMG_B);
  }
  const lb = await server.limitBreakCard(token, starterId);
  assert.equal(lb.card.limitBreak, 1);

  // デイリースカウトミッション受取（scout >= 1 は達成済み）
  const claimed = await server.claimMission(token, "daily", "daily_scout_1");
  assert.ok(claimed.reward.shards > 0);
  await assert.rejects(() => server.claimMission(token, "daily", "daily_scout_1"), server.LllError);

  // カスタム30枚デッキ保存
  const counts = { A1: 3, A2: 3, A3: 3, A4: 3, A5: 3, A6: 3, A7: 3, A8: 3, B1: 3, B2: 3 };
  const decked = await server.setCustomTacticDeck(token, counts);
  assert.equal(decked.tacticDeckId, "custom");
  await assert.rejects(() => server.setCustomTacticDeck(token, { A1: 3 }), server.LllError);
});

test("深淵の試練 & 模擬PvP & オート進行", async () => {
  const { token } = await server.getOrCreateProfile(null);
  await assert.rejects(() => server.startAbyssBattle(token, 2), server.LllError);

  const abyss = await server.startAbyssBattle(token, 1);
  assert.equal(abyss.battle.mode, "abyss");
  assert.equal(abyss.battle.floor, 1);

  // オート進行で終局まで進める
  let cur = abyss.battle;
  let guard = 0;
  while (cur.phase === "battle" && guard++ < 80) {
    const res = await server.battleAutoStep(token, abyss.battleId);
    cur = res.battle;
  }
  assert.equal(cur.phase, "finished");

  // 模擬PvPライバル取得＆開始＆オート進行
  const rivals = await server.listPvpRivals(token);
  assert.ok(rivals.length >= 3);
  const pvp = await server.startPvpBattle(token, rivals[0].id);
  assert.equal(pvp.battle.mode, "pvp");
  let pvpCur = pvp.battle;
  let pvpGuard = 0;
  let latestProfile = null;
  while (pvpCur.phase === "battle" && pvpGuard++ < 80) {
    const res = await server.battleAutoStep(token, pvp.battleId);
    pvpCur = res.battle;
    latestProfile = res.profile;
  }
  assert.equal(pvpCur.phase, "finished");
  assert.ok(latestProfile);
});

test("遺物鍛造・2枠装備・カード調律（特性/技2）・地脈とバースト契約", async () => {
  const { token, profile } = await server.getOrCreateProfile(null);
  // 鍛造＆調律に必要なリソースを補充（テスト用メモリ正本）
  profile.shards += 200;
  profile.lumen += 800;

  // 遺物を3つ鍛造して、最大2枠装備・未所持/3枠拒否を検証
  const c1 = await server.craftRelic(token, "relic_aegis");
  assert.ok(c1.profile.unlockedRelics.includes("relic_aegis"));
  await assert.rejects(() => server.craftRelic(token, "relic_aegis"), server.LllError);
  await server.craftRelic(token, "relic_chronometer");
  await server.craftRelic(token, "relic_ember_core");

  await assert.rejects(
    () => server.equipRelics(token, ["relic_aegis", "relic_chronometer", "relic_ember_core"]),
    server.LllError,
  );
  await assert.rejects(() => server.equipRelics(token, ["relic_vampire_fang"]), server.LllError);
  const eq = await server.equipRelics(token, ["relic_aegis", "relic_chronometer"]);
  assert.deepEqual(eq.profile.equippedRelics, ["relic_aegis", "relic_chronometer"]);

  // 特性調律＆技2調律
  const card = eq.profile.cards[0];
  const nextTrait = card.trait.kind === "focus" ? "haste" : "focus";
  const tunedTrait = await server.tuneCardTrait(token, card.id, nextTrait);
  assert.equal(tunedTrait.card.trait.kind, nextTrait);
  await assert.rejects(() => server.tuneCardTrait(token, card.id, nextTrait), server.LllError);

  const nextSkill2 = card.skills[1].kind === "burn" ? "guard_break" : "burn";
  const tunedSkill = await server.tuneCardSkill2(token, card.id, nextSkill2);
  assert.equal(tunedSkill.card.skills[1].kind, nextSkill2);
  await assert.rejects(() => server.tuneCardSkill2(token, card.id, nextSkill2), server.LllError);

  // parseGrowBody & parsePlayerAction burst 契約
  assert.equal(server.parseGrowBody({ token, action: "craftRelic", relicId: "relic_aegis" }).action, "craftRelic");
  assert.equal(server.parseGrowBody({ token, action: "equipRelics", relicIds: ["relic_aegis"] }).action, "equipRelics");
  assert.equal(server.parseGrowBody({ token, action: "tuneTrait", cardId: card.id, traitKind: "guard" }).action, "tuneTrait");
  assert.equal(server.parseGrowBody({ token, action: "tuneSkill2", cardId: card.id, skillKind: "heal" }).action, "tuneSkill2");
  assert.deepEqual(server.parsePlayerAction({ skill: "burst", targetKey: "cpu_0" }), {
    skill: "burst",
    targetKey: "cpu_0",
  });

  // バトル開始時に fieldId・resonance・relics・burst が正しく伝播する
  const started = await server.startBattle(token, 0);
  assert.equal(started.battle.fieldId, "neutral");
  assert.ok(started.battle.resonance?.player?.id);
  assert.deepEqual(started.battle.relics?.player, ["relic_aegis", "relic_chronometer"]);
  assert.equal(typeof started.battle.burst?.player, "number");
  assert.equal(started.battle.tactics.player.tp, 6);
  assert.equal(started.battle.tactics.player.hand.length, 5);
});


