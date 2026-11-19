// WEB ゲーム「dreaming」の純粋モデル・ゲームメカニクス・配線検証テスト。
// - lib/games/dreaming-model.ts: 小型 LSTM、文字レベル n-gram 言語モデル、2D 条件付きマルコフ場
// - lib/games/dreaming.ts: 忘却・記憶のしおり（FIFO 3枠）・変質反復・滲み・パルス・潜行・終わりなさ
// - カタログ / [id]/page.tsx / site-chrome / globals.css 配線と外部API・AIスロップ非混入
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");
const libDir = path.join(webDir, "lib");

function transpile(relPath) {
  const src = fs.readFileSync(path.join(libDir, relPath), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  return code
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const model = await loadBundle(
  ["games/dreaming-model.ts"],
  [
    "createRng",
    "DOMAIN_IDS",
    "DOMAIN_PALETTES",
    "softmax",
    "normalizedEntropy",
    "RNN_DIM",
    "createRnnState",
    "stepRnn",
    "domainProbsFromRnn",
    "trainCharLM",
    "getDreamLanguageModels",
    "sampleCharSequence",
    "generateDreamPlaceName",
    "mutateDreamName",
    "generateDreamFragment",
    "TILE_KINDS",
    "isWalkableTile",
    "computeTileLogits",
    "sampleNextTile",
  ],
);

const game = await loadBundle(
  ["games/dreaming-model.ts", "games/dreaming.ts"],
  [
    "DOMAIN_IDS",
    "DREAM_MOTIFS",
    "MAX_ANCHORS",
    "ANCHOR_RADIUS",
    "VIEW_RADIUS",
    "tileKey",
    "chebyshev",
    "memoryWindowForDepth",
    "createDreamGame",
    "moveDream",
    "pulseDream",
    "toggleAnchor",
    "setDreamTemperature",
    "ambientTemperatureFor",
    "isInVisionCone",
    "computeDread",
    "syncStalkerVisibility",
    "driftDreamTick",
    "descendDream",
    "redriftDream",
    "findNearestSignal",
    "getAdjacentContext",
    "parseDreamRecord",
    "mergeRecordWithSession",
    "isWalkableTile",
  ],
);

const catalog = await loadBundle(["games-catalog.ts"], ["WEB_GAMES", "getWebGame", "playableGames"]);
const chrome = await loadBundle(["site-chrome.ts"], ["isChromelessPath", "showsCtaBand"]);

// ============================================================
// 1. 小型ゲート付き LSTM & 確率サンプリング
// ============================================================

test("LSTM: 8次元隠れ状態が更新され、領域確率分布の和は常に 1、温度上昇でエントロピーが増える", () => {
  const rng = model.createRng(42);
  let rnn = model.createRnnState(0, rng);
  assert.equal(rnn.h.length, model.RNN_DIM);
  assert.equal(rnn.c.length, model.RNN_DIM);

  rnn = model.stepRnn(rnn, [0.9, 0, 0, 0.2, 0, 0, 0.1, -0.1], 1, 0.92);
  assert.equal(rnn.steps, 1);

  const probsLow = model.domainProbsFromRnn(rnn, 0.45);
  const probsMid = model.domainProbsFromRnn(rnn, 0.95);
  const probsHigh = model.domainProbsFromRnn(rnn, 1.75);

  const vals = (w) => model.DOMAIN_IDS.map((d) => w[d]);
  for (const w of [probsLow, probsMid, probsHigh]) {
    const sum = vals(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `確率和が 1 でない: ${sum}`);
  }
  const eLow = model.normalizedEntropy(vals(probsLow));
  const eMid = model.normalizedEntropy(vals(probsMid));
  const eHigh = model.normalizedEntropy(vals(probsHigh));
  assert.ok(eLow < eMid && eMid < eHigh, `温度上昇でエントロピーが増えていない: ${eLow} / ${eMid} / ${eHigh}`);
});

test("LSTM: 深い層ほど忘却ゲートが低く、古い強い入力は時間経過で減衰する", () => {
  let shallow = model.createRnnState(0);
  let deep = model.createRnnState(0);
  const zero = [0, 0, 0, 0, 0, 0, 0, 0];
  const initialC0 = shallow.c[0];

  for (let i = 0; i < 6; i++) {
    shallow = model.stepRnn(shallow, zero, 1, 0.92);
    deep = model.stepRnn(deep, zero, 8, 0.92);
  }
  assert.ok(
    deep.lastForgetMean < shallow.lastForgetMean,
    `深層の方が忘却ゲートが低いはず: deep=${deep.lastForgetMean}, shallow=${shallow.lastForgetMean}`,
  );
  assert.ok(
    deep.c[0] < initialC0 && deep.c[0] < shallow.c[0],
    `深層ほど古い細胞記憶が早く減衰するはず: init=${initialC0}, shallow=${shallow.c[0]}, deep=${deep.c[0]}`,
  );
});

// ============================================================
// 2. 文字レベル n-gram 言語モデル
// ============================================================

test("文字 n-gram: コーパスから逐次生成でき、同じシードで決定的に再現する", () => {
  const models = model.getDreamLanguageModels();
  const weights = { station: 0.85, school: 0.05, library: 0.04, arcade: 0.02, harbor: 0.02, meadow: 0.02 };

  const a = model.generateDreamPlaceName(models, weights, 0.8, model.createRng(12345));
  const b = model.generateDreamPlaceName(models, weights, 0.8, model.createRng(12345));
  assert.equal(a, b);
  assert.ok(Array.from(a).length >= 4, `地名が短すぎる: ${a}`);

  const frag = model.generateDreamFragment(models, weights, 0.9, model.createRng(777));
  assert.ok(Array.from(frag).length >= 8, `夢の断片が短すぎる: ${frag}`);
});

test("文字 n-gram: 高温ほど生成語彙の多様性（崩れ）が増え、mutateDreamName が変質させる", () => {
  const models = model.getDreamLanguageModels();
  const weights = { station: 0.4, school: 0.05, library: 0.05, arcade: 0.2, harbor: 0.25, meadow: 0.05 };
  const lowSet = new Set();
  const highSet = new Set();
  const rngLow = model.createRng(101);
  const rngHigh = model.createRng(101);

  for (let i = 0; i < 40; i++) {
    lowSet.add(model.generateDreamPlaceName(models, weights, 0.42, rngLow));
    highSet.add(model.generateDreamPlaceName(models, weights, 1.72, rngHigh));
  }
  assert.ok(highSet.size >= lowSet.size, `高温で多様性が下がっている: low=${lowSet.size}, high=${highSet.size}`);

  const origin = "あかいでんわ";
  const gen2 = model.mutateDreamName(models, weights, origin, 2, 1.0, model.createRng(9001));
  assert.notEqual(gen2, origin, "変質反復で名前が変化していない");
  assert.ok(Array.from(gen2).length >= 4);
});

// ============================================================
// 3. 2D 局所条件付きマルコフ場
// ============================================================

test("2D マルコフ場: 近傍タイルで遷移ロジットが変化し、3方閉塞時は通路へ引き戻す", () => {
  const harborWeights = { station: 0.05, school: 0.05, library: 0.05, arcade: 0.05, harbor: 0.75, meadow: 0.05 };
  const waterIdx = model.TILE_KINDS.indexOf("water");
  const railIdx = model.TILE_KINDS.indexOf("rail");
  const floorIdx = model.TILE_KINDS.indexOf("floor");
  const riftIdx = model.TILE_KINDS.indexOf("rift");

  const nextToWater = model.computeTileLogits(harborWeights, {
    north: "water",
    west: "water",
    bleedEntropy: 0.3,
    stepsSinceDescend: 5,
    hasNearbyRift: false,
  });
  const nextToRail = model.computeTileLogits(harborWeights, {
    north: "rail",
    south: "rail",
    bleedEntropy: 0.3,
    stepsSinceDescend: 5,
    hasNearbyRift: false,
  });
  assert.ok(nextToWater[waterIdx] > nextToRail[waterIdx], "水面近傍で水面ロジットが上がらない");
  assert.ok(nextToRail[railIdx] > nextToWater[railIdx], "線路近傍で線路ロジットが上がらない");

  // 3 方向が壁のときは床ロジットが強く持ち上がり閉塞を防ぐ
  const boxed = model.computeTileLogits(harborWeights, {
    north: "wall",
    south: "wall",
    west: "wall",
    bleedEntropy: 0.3,
    stepsSinceDescend: 5,
    hasNearbyRift: true,
  });
  const open = model.computeTileLogits(harborWeights, {
    north: "floor",
    bleedEntropy: 0.3,
    stepsSinceDescend: 5,
    hasNearbyRift: true,
  });
  assert.ok(boxed[floorIdx] > open[floorIdx], "3方壁のとき床ロジットが補正されていない");

  // 境界干渉や高滲みで rift ロジットが上昇する
  const calm = model.computeTileLogits(harborWeights, {
    north: "floor",
    bleedEntropy: 0.15,
    boundaryShock: 0,
    stepsSinceDescend: 5,
    hasNearbyRift: false,
  });
  const shocked = model.computeTileLogits(harborWeights, {
    north: "floor",
    bleedEntropy: 0.85,
    boundaryShock: 0.9,
    stepsSinceDescend: 5,
    hasNearbyRift: false,
  });
  assert.ok(shocked[riftIdx] > calm[riftIdx] + 2.0, "滲み・境界干渉で裂け目が出やすくなっていない");
});

// ============================================================
// 4. ゲームメカニクス（忘却・しおり・変質反復・パルス・終わりなさ）
// ============================================================

test("忘却: 歩き離れると背後タイルがマップから忘却（evict）され、戻ると再生成される", () => {
  let s = game.createDreamGame(2026);
  assert.equal(s.status, "drifting");
  assert.ok(s.tiles.has(game.tileKey(0, 0)));

  // 右へ 16 歩進む（障害物があればパルスで拓きつつ前進）
  for (let i = 0; i < 24 && s.player.x < 14; i++) {
    const prevX = s.player.x;
    const next = game.moveDream(s, "right");
    if (next.lastEvent.kind === "blocked") {
      s = game.pulseDream(next);
      // それでも塞がっていたら上下へ迂回しつつ右を目指す
      const retry = game.moveDream(s, "right");
      s = retry.player.x > prevX ? retry : game.moveDream(s, i % 2 === 0 ? "down" : "up");
    } else {
      s = next;
    }
    if (s.depth > 1) break;
  }

  assert.ok(s.forgottenCount > 0, `歩いて離れたのに忘却が起きていない: forgotten=${s.forgottenCount}`);
  if (s.depth === 1 && s.player.x >= 10) {
    assert.equal(
      s.tiles.has(game.tileKey(0, 0)),
      false,
      "遠く離れた開始地点 (0,0) がまだ忘却されず残っている",
    );
  }
});

test("記憶のしおり（Anchor）: 保護域は忘却されず、4つ目を留めると最古が FIFO で押し出される", () => {
  let s = game.createDreamGame(888);
  // 1 つ目を (0,0) に留める
  s = game.toggleAnchor(s);
  assert.equal(s.anchors.length, 1);
  assert.equal(s.lastEvent.kind, "anchor");
  const firstAnchorId = s.anchors[0].id;

  // テストの決定性を保つため、東方向の正面タイルが壁や裂け目なら床へ整えてから直進する
  const walkEast = (st, count) => {
    let cur = st;
    for (let k = 0; k < count; k++) {
      const ahead = cur.tiles.get(game.tileKey(cur.player.x + 1, cur.player.y));
      if (ahead && (!model.isWalkableTile(ahead.kind) || ahead.kind === "rift")) {
        ahead.kind = "floor";
      }
      cur = game.moveDream(cur, "right");
    }
    return cur;
  };

  s = walkEast(s, 3);
  assert.equal(s.player.x, 3);
  s = game.toggleAnchor(s);
  assert.equal(s.anchors.length, 2);

  s = walkEast(s, 3);
  assert.equal(s.player.x, 6);
  s = game.toggleAnchor(s);
  assert.equal(s.anchors.length, game.MAX_ANCHORS);

  // 視界外（x=16）まで遠く歩いても (0,0) のアンカー保護タイルは忘却されない
  s = walkEast(s, 10);
  assert.equal(s.depth, 1);
  assert.equal(s.player.x, 16);
  assert.ok(s.forgottenCount > 0, "未保護の遠方タイルは忘却されているはず");
  assert.ok(s.tiles.has(game.tileKey(0, 0)), "しおりで留めた地点が忘却されてしまった");
  assert.equal(s.tiles.get(game.tileKey(0, 0)).memory, 1);

  // 4 つ目を留めると最古のしおりが FIFO で押し出され、遠方にあった旧保護域も即座に忘却される
  s = game.toggleAnchor(s);
  assert.equal(s.anchors.length, game.MAX_ANCHORS);
  assert.equal(s.lastEvent.kind, "anchor_evict");
  assert.ok(!s.anchors.some((a) => a.id === firstAnchorId), "最古のしおりが押し出されていない");
  assert.equal(s.tiles.has(game.tileKey(0, 0)), false, "FIFO 押し出し後の遠方旧アンカー地点が忘却されていない");
});

test("変質反復: モチーフ採集でエコーキューに入り、歩数を進めると第2世代に変質して再出現する", () => {
  let s = game.createDreamGame(31415);
  // 視界内の最初のモチーフを探して隣接へ寄せるのではなく、パルスまたは直接配置タイルへ歩いて採集
  const firstTile = Array.from(s.tiles.values()).find((t) => t.motif !== null);
  assert.ok(firstTile, "初期視界にモチーフが配置されていない");

  // テストのため、開始地点の隣 (1, 0) に確実にモチーフを置いてパルス共鳴で採集する
  const adj = s.tiles.get(game.tileKey(1, 0));
  assert.ok(adj);
  adj.kind = "floor";
  adj.motif = {
    id: "payphone",
    generation: 1,
    name: "あかいでんわ",
    originDomain: "arcade",
    domain: s.dominantDomain,
  };

  s = game.pulseDream(s);
  assert.equal(s.lastEvent.kind, "collect");
  assert.equal(s.archive.length, 1);
  assert.equal(s.echoQueue.length, 1);
  assert.equal(s.echoQueue[0].motifId, "payphone");
  assert.equal(s.echoQueue[0].generation, 2);

  // エコー満期（dueStep）まで歩くと、第2世代の変質 payphone が視界に出現する
  const due = s.echoQueue[0].dueStep;
  const dirs = ["right", "down", "left", "up"];
  for (let i = 0; i < 30 && s.step <= due + 2; i++) {
    const dir = dirs[i % 2]; // 右・下中心に進む
    let next = game.moveDream(s, dir);
    if (next.lastEvent.kind === "blocked") {
      s = game.pulseDream(next);
      next = game.moveDream(s, dirs[(i + 1) % 4]);
    }
    s = next;
    if (Array.from(s.tiles.values()).some((t) => t.motif?.id === "payphone" && t.motif.generation >= 2)) {
      break;
    }
  }

  const echoedTile = Array.from(s.tiles.values()).find(
    (t) => t.motif?.id === "payphone" && t.motif.generation >= 2,
  );
  assert.ok(echoedTile, "歩数を進めても変質反復モチーフ（第2世代）が再出現しなかった");
  assert.notEqual(echoedTile.motif.name, "あかいでんわ", "再出現モチーフの名前が変質していない");

  // 再出現モチーフを隣に持ってきて共鳴すると「再会（reunion）」としてチェインが伸びる
  const px = s.player.x;
  const py = s.player.y;
  const neighbor = s.tiles.get(game.tileKey(px + 1, py));
  neighbor.kind = "floor";
  neighbor.motif = echoedTile.motif;
  echoedTile.motif = null;
  s = game.pulseDream(s);
  assert.equal(s.lastEvent.kind, "reunion");
  assert.equal(s.echoChain, 1);
  assert.equal(s.maxGeneration, 2);
});

test("パルス詰まり救済 & 終わりがないこと: 4方壁でもパルスで道が開き、何度潜行しても終わらない", () => {
  let s = game.createDreamGame(7777);
  // 周囲 4 方向を意図的に壁で塞ぐ
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const t = s.tiles.get(game.tileKey(dx, dy));
    if (t) {
      t.kind = "wall";
      t.motif = null;
    }
  }
  s = game.pulseDream(s);
  const openDirs = [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dy]) =>
    game.isWalkableTile(s.tiles.get(game.tileKey(dx, dy)).kind),
  );
  assert.ok(openDirs.length >= 1, "4方閉塞から記憶パルスで道が開かなかった");

  // 何度潜行しても終わり（gameover / won）にならず深度と忘却が増え続ける
  for (let d = 0; d < 6; d++) {
    s = game.descendDream(s);
    assert.equal(s.status, "drifting");
    assert.equal(s.depth, d + 2);
  }
  assert.ok(game.memoryWindowForDepth(s.depth) < game.memoryWindowForDepth(1));

  // 浅い層へ漂い直しても標本帳と発見済み原型は失われない
  const preserved = game.redriftDream(
    { ...s, discoveredMotifs: ["payphone", "clock"] },
    99999,
  );
  assert.equal(preserved.status, "drifting");
  assert.equal(preserved.depth, 1);
  assert.deepEqual(preserved.discoveredMotifs, ["payphone", "clock"]);
});

test("永続記録: parseDreamRecord と mergeRecordWithSession が破損値を弾き統計を合算する", () => {
  const broken = game.parseDreamRecord({ maxDepth: -5, discoveredMotifs: ["payphone", "invalid"], recentArchive: "bad" });
  assert.equal(broken.maxDepth, 1);
  assert.deepEqual(broken.discoveredMotifs, ["payphone"]);
  assert.deepEqual(broken.recentArchive, []);

  let s = game.createDreamGame(123);
  s = game.descendDream(s);
  const merged = game.mergeRecordWithSession(broken, s, 12, 34);
  assert.equal(merged.maxDepth, 2);
  assert.equal(merged.totalSteps, 12);
  assert.equal(merged.totalForgotten, 34);
});

// ============================================================
// 5. カタログ・ルーティング・独立シェル・非API/非スロップ検証
// ============================================================

test("配線: dreaming がカタログ・[id] ページ・CHROMELESS_PATHS・globals.css に正しく登録されている", () => {
  const entry = catalog.getWebGame("dreaming");
  assert.ok(entry, "games-catalog.ts に dreaming がない");
  assert.equal(entry.slug, "dreaming");
  assert.equal(entry.status, "playable");
  assert.equal(entry.activity, true);
  assert.equal(entry.genre, undefined);
  assert.ok(catalog.playableGames().some((g) => g.slug === "dreaming"));

  assert.equal(chrome.isChromelessPath("/games/dreaming"), true);
  assert.equal(chrome.isChromelessPath("/games/dreaming/"), true);
  assert.equal(chrome.showsCtaBand("/games/dreaming"), false);

  const pageSrc = fs.readFileSync(path.join(webDir, "app/games/[id]/page.tsx"), "utf8");
  assert.match(pageSrc, /import DreamingClient from "\.\.\/dreaming\/DreamingClient"/);
  const branchStart = pageSrc.indexOf('game.slug === "dreaming"');
  assert.ok(branchStart >= 0, "[id]/page.tsx に dreaming 分岐がない");
  const branch = pageSrc.slice(branchStart, pageSrc.indexOf("\n  }", branchStart));
  assert.match(branch, /<DreamingClient \/>/);
  assert.doesNotMatch(branch, /GameDetailHeader/);

  const globalsCss = fs.readFileSync(path.join(webDir, "app/globals.css"), "utf8");
  assert.match(globalsCss, /body:has\(\.dreaming-shell\) > main \{ max-width:none;/);
  assert.match(globalsCss, /\.games-shell\[data-activity-root\]:has\(\.dreaming-shell\)/);
});

test("品質制約: 外部 AI API・Transformer・ネオン紫AIスロップ・終了画面を使っていない", () => {
  const files = [
    "lib/games/dreaming-model.ts",
    "lib/games/dreaming.ts",
    "app/games/dreaming/DreamingClient.tsx",
    "app/games/dreaming/dreaming.css",
    "app/games/dreaming/dreaming-sfx.ts",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(webDir, rel), "utf8");
    const codeOnly = src
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    assert.doesNotMatch(codeOnly, /\bfetch\s*\(/, `${rel}: 外部通信 fetch を含んではならない`);
    assert.doesNotMatch(codeOnly, /openai|anthropic|gemini|onnxruntime/i, `${rel}: 外部 AI API/モデル参照を含んではならない`);
    assert.doesNotMatch(src, /#7c5cff|#a78bfa|#f472b6/i, `${rel}: ネオン紫AIスロップ色を含んではならない`);
    assert.doesNotMatch(codeOnly, /EndScreen|ゲームオーバー|クリア！/, `${rel}: 勝敗・クリアで閉じる仕組みを含んではならない`);
  }
});

test("ゼロUI＆ジョイスティック構成 + 温度の自律呼吸: ボタンや設定UIを置かずジョイスティック移動と自律温度呼吸で動く", () => {
  let s = game.createDreamGame(2026);
  const initialCtx = game.getAdjacentContext(s);
  assert.equal(initialCtx.hasAnchor, false);

  s = game.toggleAnchor(s);
  assert.equal(game.getAdjacentContext(s).hasAnchor, true);

  // 深度と RNN ステップで温度が安全範囲内で自然に呼吸し、深層ほど高温寄りになる
  const shallowAvg =
    Array.from({ length: 40 }, (_, i) => game.ambientTemperatureFor(1, i)).reduce((a, b) => a + b, 0) / 40;
  const deepAvg =
    Array.from({ length: 40 }, (_, i) => game.ambientTemperatureFor(6, i)).reduce((a, b) => a + b, 0) / 40;
  assert.ok(shallowAvg >= 0.45 && shallowAvg <= 1.85);
  assert.ok(deepAvg > shallowAvg, `深層ほど自律温度が高まるはず: shallow=${shallowAvg}, deep=${deepAvg}`);

  // クライアントにボタン・スライダー・設定パネル・ヘッダー・フッターなどのUIを一切置かない
  const clientSrc = fs.readFileSync(path.join(webDir, "app/games/dreaming/DreamingClient.tsx"), "utf8");
  assert.match(clientSrc, /className="dreaming-joystick"/, "最低限のジョイスティック移動UIがない");
  assert.doesNotMatch(clientSrc, /<button\b|<input\b|<header\b|<footer\b|<aside\b|<Link\b/, "不要なボタン・設定・HUD要素が残っている");
});

test("リアルタイム自律夢遊（driftDreamTick）: 立ち止まったまま LSTM が漂流し、しおり保護域を保ちつつ周辺地形が変容する", () => {
  let s = game.createDreamGame(202607);
  s = game.setDreamTemperature(s, 1.48);
  s = game.toggleAnchor(s); // (0,0) を中心に 5×5 を保護

  // 保護域タイルと未保護周辺タイルの初期スナップショットを取る
  const protectedSnapshot = new Map();
  const outerSnapshot = new Map();
  for (const [k, t] of s.tiles) {
    const dist = game.chebyshev(0, 0, t.x, t.y);
    if (dist <= game.ANCHOR_RADIUS) {
      protectedSnapshot.set(k, { kind: t.kind, glyph: t.glyph, memory: t.memory });
    } else if (dist <= game.VIEW_RADIUS && !t.motif && t.kind !== "rift") {
      outerSnapshot.set(k, { kind: t.kind, glyph: t.glyph });
    }
  }
  const initialRnnSteps = s.rnn.steps;
  const initialStep = s.step;

  // 12 ティック分、立ち止まったまま自律夢遊させる
  for (let i = 0; i < 12; i++) {
    s = game.driftDreamTick(s);
    assert.equal(s.status, "drifting");
    assert.equal(s.lastEvent.kind, "drift");
    assert.equal(s.step, initialStep, "自律夢遊ティックでプレイヤー歩数 step が増えてはならない");
  }

  assert.equal(s.rnn.steps, initialRnnSteps + 12, "自律夢遊で LSTM 隠れ状態が進んでいない");

  // しおり保護域（5×5）は 1 マスも書き換わらない
  for (const [k, snap] of protectedSnapshot) {
    const after = s.tiles.get(k);
    assert.ok(after, `保護域タイル ${k} が消えている`);
    assert.equal(after.kind, snap.kind, `保護域タイル ${k} の種別が書き換わった`);
    assert.equal(after.glyph, snap.glyph, `保護域タイル ${k} の文字が書き換わった`);
    assert.equal(after.memory, 1, `保護域タイル ${k} の記憶が維持されていない`);
  }

  // 未保護の周辺タイルはリアルタイムで変容している
  let changedOuter = 0;
  for (const [k, snap] of outerSnapshot) {
    const after = s.tiles.get(k);
    if (after && (after.kind !== snap.kind || after.glyph !== snap.glyph)) {
      changedOuter++;
    }
  }
  assert.ok(changedOuter > 0, "未保護の周辺タイルが 12 ティック後も一切変容していない");
});

test("ホラー機構（残響の影・視線凍結・しおり結界・終わりなき呑み込み）: 光錐で止まり背後から迫り、呑まれても終わらず深層へ落ちる", () => {
  let s = game.createDreamGame(6661);
  // 東西の直線を歩行可能な床へ整える
  for (let x = -4; x <= 4; x++) {
    const t = s.tiles.get(game.tileKey(x, 0));
    if (t) t.kind = "floor";
  }

  // 東側 (3,0) に影を 1 体配置。プレイヤーは東向き（0 rad）なので光錐に捉えられて静止する
  const stalkerEast = {
    id: 1,
    x: 3,
    y: 0,
    name: "うしろのかげ",
    originMotifId: "payphone",
    generation: 2,
    domain: s.dominantDomain,
    seen: false,
    stareTicks: 0,
  };
  s = { ...s, stalkers: [stalkerEast], nextStalkerId: 2 };

  // 光錐を東（0 rad）に向けると即座に spotted となり、複数回 drift しても静止し続ける
  const vis = game.syncStalkerVisibility(s, 0);
  assert.equal(vis.newlySpotted, true);
  assert.equal(vis.state.stalkers[0].seen, true);
  s = vis.state;
  for (let i = 0; i < 4; i++) {
    s = game.driftDreamTick(s, 0);
    assert.equal(s.stalkers[0].x, 3, "光を当てているのに影が動いてしまった");
    assert.equal(s.stalkers[0].y, 0);
  }
  assert.ok(s.stalkers[0].stareTicks >= 4);

  // 高 dread で自律温度が上昇する
  const calmT = game.ambientTemperatureFor(1, 5, 0);
  const panicT = game.ambientTemperatureFor(1, 5, 0.9);
  assert.ok(panicT > calmT + 0.3, `恐怖度 dread で温度が上がっていない: calm=${calmT}, panic=${panicT}`);

  // しおり保護域（5×5）を (0,0) に結ぶと dread が和らぎ、西を向いて背を向けても影は x=2 以内へ侵入できない
  s = game.toggleAnchor(s);
  const dreadInSanctuary = s.dread;
  const dreadExposed = game.computeDread(0, 0, s.depth, s.stalkers, []);
  assert.ok(dreadInSanctuary < dreadExposed, "しおり結界内で恐怖度が和らいでいない");

  for (let i = 0; i < 8; i++) {
    s = game.driftDreamTick(s, Math.PI); // 西向き（影に背を向ける）
  }
  assert.ok(
    game.chebyshev(0, 0, s.stalkers[0].x, s.stalkers[0].y) > game.ANCHOR_RADIUS,
    `しおり結界（半径 ${game.ANCHOR_RADIUS}）内に影が侵入してしまった`,
  );

  // しおりを外して背を向け続けると影が忍び寄り、接触すると終わらず一段深い層へ引きずり込まれる
  s = game.toggleAnchor(s);
  assert.equal(s.anchors.length, 0);
  let consumed = false;
  for (let i = 0; i < 20; i++) {
    s = game.driftDreamTick(s, Math.PI);
    if (s.lastEvent.kind === "consumed") {
      consumed = true;
      break;
    }
  }
  assert.equal(consumed, true, "背を向け続けたのに影に呑み込まれなかった");
  assert.equal(s.status, "drifting", "呑み込まれてもゲームオーバーで終了してはならない");
  assert.equal(s.depth, 2, "呑み込みで一段深い悪夢層へ落ちていない");
  assert.equal(s.consumedCount, 1);
});
