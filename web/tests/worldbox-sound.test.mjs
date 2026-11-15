// AGO WORLD BOX 音響基盤（BGM/SE）の検証:
// - BGM 譜面の整合（32ステップ・度数の範囲・場面ごとの密度とテンポ）
// - 場面選択（カジノ > ロビー > 夜 > 昼）
// - 周波数計算（半音・度数）
// - SE の優先度階層と fx バースト → SE の対応
// - opus っぽさ回避（音声ファイルを使わない・BGM にパッド wash を使わない）
// - クライアント配線（解錠・場面切替・行為→SE・経済パネル・ミュート切替）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
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

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const sound = await loadBundle(
  ["worldbox/sound.ts"],
  [
    "BGM_STEPS", "BGM_TRACKS", "bgmSceneFor", "semitoneFreq", "degreeFreq", "leadNoteCount",
    "tensionFor", "BGM_CROSSFADE_MS", "setWbBgmTension", "currentWbBgmTension",
    "WB_SE_TIER_GAIN", "WB_SE_TIERS", "WB_SE_MIN_INTERVAL_MS", "seForFxBurst",
    "footstepMaterialFor", "distanceGain", "seVariation",
    "SE_BURST_WINDOW_MS", "SE_BURST_MAX", "SE_DISTANCE_MAX_TILES", "SE_DISTANCE_MIN_GAIN",
    "loadWbSoundSettings",
  ],
);

const SCENES = ["field-day", "field-night", "lobby", "casino", "cave", "dungeon", "ruins"];

test("sound: 全曲が32ステップで、度数と半音が範囲内に収まる", () => {
  for (const scene of SCENES) {
    const track = sound.BGM_TRACKS[scene];
    assert.equal(track.bass.length, sound.BGM_STEPS, scene);
    assert.equal(track.lead.length, sound.BGM_STEPS, scene);
    assert.equal(track.hat.length, sound.BGM_STEPS, scene);
    assert.equal(track.kick.length, sound.BGM_STEPS, scene);
    for (const d of track.lead) {
      if (d === null) continue;
      assert.ok(d >= 0 && d < track.scale.length, `${scene}: 度数 ${d}`);
    }
    for (const s of track.bass) {
      if (s === null) continue;
      assert.ok(s >= -12 && s <= 24, `${scene}: ベース半音 ${s}`);
    }
    // 音階はペンタトニック（5音＋オクターブ展開）で単調増加
    for (let i = 1; i < track.scale.length; i++) {
      assert.ok(track.scale[i] > track.scale[i - 1], `${scene}: 音階が単調`);
    }
    assert.ok(track.bpm >= 60 && track.bpm <= 160, scene);
  }
});

test("sound: 場面選択は カジノ > ロビー > 夜 > 昼", () => {
  assert.equal(sound.bgmSceneFor({ space: "world", night: 0, casinoOpen: false }), "field-day");
  assert.equal(sound.bgmSceneFor({ space: "world", night: 0.9, casinoOpen: false }), "field-night");
  assert.equal(sound.bgmSceneFor({ space: "lobby", night: 0.9, casinoOpen: false }), "lobby");
  assert.equal(sound.bgmSceneFor({ space: "tent", night: 0.9, casinoOpen: false }), "lobby", "テント内装は屋内としてロビー曲");
  assert.equal(sound.bgmSceneFor({ space: "lobby", night: 0, casinoOpen: true }), "casino");
  assert.equal(sound.bgmSceneFor({ space: "world", night: 0.9, casinoOpen: true }), "casino");
  assert.equal(sound.bgmSceneFor({ space: "cave:10,20:0", night: 0, casinoOpen: false }), "cave");
  assert.equal(sound.bgmSceneFor({ space: "dungeon:10,20:0", night: 0, casinoOpen: false }), "dungeon");
  assert.equal(sound.bgmSceneFor({ space: "ruins:10,20:0", night: 0, casinoOpen: false }), "ruins", "遺跡は専用曲");
  assert.equal(sound.bgmSceneFor({ space: "ruins:10,20:0", night: 0, casinoOpen: true }), "casino", "カジノが最優先");
});

test("sound: 緊張レイヤーは敵の接近か HP25%以下で入る（遺跡は洞窟より速くキックなし）", () => {
  assert.equal(sound.tensionFor({ hostileNear: true, hpFrac: 1 }), true, "敵が近い");
  assert.equal(sound.tensionFor({ hostileNear: false, hpFrac: 0.25 }), true, "HP25%");
  assert.equal(sound.tensionFor({ hostileNear: false, hpFrac: 0.1 }), true, "HP10%");
  assert.equal(sound.tensionFor({ hostileNear: false, hpFrac: 0.26 }), false, "HP26%は平常");
  assert.equal(sound.tensionFor({ hostileNear: false, hpFrac: 1 }), false, "平常");
  const ruins = sound.BGM_TRACKS.ruins;
  assert.ok(ruins.bpm > sound.BGM_TRACKS.cave.bpm, "遺跡は洞窟より速い");
  assert.ok(ruins.kick.every((k) => !k), "遺跡はキックなし");
  assert.ok(sound.leadNoteCount(ruins) < sound.leadNoteCount(sound.BGM_TRACKS["field-day"]), "遺跡のリードは昼より疎ら");
});

test("sound: 場面遷移はクロスフェードで、SE/BGM はマスターで統一する", () => {
  const src = fs.readFileSync(path.join(libDir, "worldbox/sound.ts"), "utf8");
  assert.ok(sound.BGM_CROSSFADE_MS >= 800 && sound.BGM_CROSSFADE_MS <= 2000, "クロスフェードは 0.8〜2 秒");
  assert.match(src, /fadeOutVoice\(activeVoice\)/, "旧声を絞る");
  assert.match(src, /gain\.gain\.setTargetAtTime\(BGM_VOLUME/, "新声を 0 から立ち上げる");
  assert.match(src, /masterBus/, "マスターバスがある");
  assert.match(src, /seBus\.connect\(masterBus\)/, "SE はマスター経由");
  assert.match(src, /gain\.connect\(masterBus\)/, "BGM の声はマスター経由");
  // タイマー遅延時は過去のステップを束で鳴らさない（ループ継ぎ目の段差を消す）
  assert.match(src, /nextStepAt < ctx\.currentTime - stepSec/, "遅延分の飛ばしがある");
  assert.equal(sound.currentWbBgmTension(), false, "初期状態は平常");
  sound.setWbBgmTension(true);
  assert.equal(sound.currentWbBgmTension(), true, "ON にできる");
  sound.setWbBgmTension(false);
  assert.equal(sound.currentWbBgmTension(), false, "OFF に戻せる");
  assert.match(src, /step % 8 === 0/, "心拍は小節単位");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /setWbBgmTension\(/, "場面判定で緊張レイヤーを更新する");
  assert.match(client, /tensionFor\(\{ hostileNear, hpFrac \}\)/, "敵の接近と HP で危険度を決める");
  assert.match(client, /dangerRef/, "危険度は描画ループからの ref で渡す");
});

test("sound: 夜が一番静かで、カジノが一番速い", () => {
  const day = sound.BGM_TRACKS["field-day"];
  const night = sound.BGM_TRACKS["field-night"];
  const casino = sound.BGM_TRACKS.casino;
  assert.ok(sound.leadNoteCount(night) < sound.leadNoteCount(day), "夜のリードは疎ら");
  assert.ok(night.hat.every((h) => !h), "夜はハットなし");
  assert.ok(night.kick.every((k) => !k), "夜はキックなし");
  assert.ok(night.bpm < day.bpm, "夜は遅い");
  assert.ok(casino.bpm > day.bpm, "カジノは速い");
  assert.ok(casino.hat.filter(Boolean).length >= 16, "カジノはハットが密");
});

test("sound: 周波数計算（半音は2の12乗根、度数は音階を引く）", () => {
  assert.equal(sound.semitoneFreq(440, 0), 440);
  assert.ok(Math.abs(sound.semitoneFreq(440, 12) - 880) < 0.001);
  assert.ok(Math.abs(sound.semitoneFreq(440, -12) - 220) < 0.001);
  const track = sound.BGM_TRACKS["field-day"];
  assert.equal(sound.degreeFreq(track, 0), track.root);
  assert.ok(sound.degreeFreq(track, 5) > sound.degreeFreq(track, 4), "度数が上がれば音も上がる");
  assert.ok(Math.abs(sound.degreeFreq(track, 0, 1) - track.root * 2) < 0.001, "オクターブ指定");
  // 範囲外の度数は端に丸める（落ちない）
  assert.equal(sound.degreeFreq(track, 999), sound.degreeFreq(track, track.scale.length - 1));
});

test("sound: SE の階層ゲインは単調に下がり、全語彙に階層がある", () => {
  const gains = [1, 2, 3, 4, 5].map((t) => sound.WB_SE_TIER_GAIN[t]);
  for (let i = 1; i < gains.length; i++) assert.ok(gains[i] < gains[i - 1]);
  const names = Object.keys(sound.WB_SE_TIERS);
  assert.ok(names.length >= 24, `SE 語彙は24以上 (実際 ${names.length})`);
  for (const name of names) {
    assert.ok([1, 2, 3, 4, 5].includes(sound.WB_SE_TIERS[name]), name);
  }
  assert.equal(sound.WB_SE_TIERS.kill, 1, "撃破が最優先");
  assert.equal(sound.WB_SE_TIERS.step, 5, "足音が最下位");
  assert.ok(sound.WB_SE_MIN_INTERVAL_MS.step >= 100, "足音には連打防止がある");
});

test("sound: fx バースト → SE の対応（死亡=撃破、出現=煙）", () => {
  assert.equal(sound.seForFxBurst("death"), "kill");
  assert.equal(sound.seForFxBurst("spawn"), "poof");
  assert.equal(sound.seForFxBurst("hit"), "hit");
  for (const kind of ["chop", "mine", "till", "plant", "harvest", "place", "build", "debris", "splash", "step", "dash", "warp", "poof"]) {
    assert.equal(sound.seForFxBurst(kind), kind, kind);
    assert.ok(sound.WB_SE_TIERS[kind], `${kind} の SE がある`);
  }
});

test("sound: B4 足音はバイオーム/空間で素材が変わる", () => {
  const f = sound.footstepMaterialFor;
  assert.equal(f({ biome: "plains", space: "world" }), "grass", "草原は草");
  assert.equal(f({ biome: "forest", space: "world" }), "grass", "森も草");
  assert.equal(f({ biome: "dense_forest", space: "world" }), "grass");
  assert.equal(f({ biome: "snowfield", space: "world" }), "snow", "雪原は雪");
  assert.equal(f({ biome: "snow_forest", space: "world" }), "snow");
  assert.equal(f({ biome: "beach", space: "world" }), "sand", "浜は砂");
  assert.equal(f({ biome: "dryland", space: "world" }), "sand");
  assert.equal(f({ biome: "lake", space: "world" }), "water", "湖は水");
  assert.equal(f({ biome: "wetland", space: "world" }), "water");
  assert.equal(f({ biome: "highland", space: "world" }), "stone", "高地は石");
  assert.equal(f({ biome: "plains", space: "world", swimming: true }), "water", "泳ぎは水が最優先");
  assert.equal(f({ space: "lobby" }), "stone", "ロビーは石");
  assert.equal(f({ space: "tent" }), "wood", "テント内は木の床");
  assert.equal(f({ space: "cave:1,2:0" }), "stone", "洞窟は石");
  assert.equal(f({ space: "dungeon:1,2:0" }), "stone");
  assert.equal(f({ space: "ruins:1,2:0" }), "stone");
  assert.equal(f({}), "grass", "未指定は草");
});

test("sound: B4 距離減衰は 0 で 1、12 タイル以上で下限に張り付く", () => {
  assert.equal(sound.distanceGain(0), 1);
  assert.equal(sound.distanceGain(-3), 1, "負の距離は 1");
  assert.ok(sound.distanceGain(6) > sound.distanceGain(9), "遠いほど小さい");
  assert.equal(sound.distanceGain(sound.SE_DISTANCE_MAX_TILES), sound.SE_DISTANCE_MIN_GAIN);
  assert.equal(sound.distanceGain(999), sound.SE_DISTANCE_MIN_GAIN, "上限を超えても下限で聞こえる");
  assert.ok(sound.SE_DISTANCE_MIN_GAIN > 0 && sound.SE_DISTANCE_MIN_GAIN < 0.5, "下限は 0 より大きく小さい");
});

test("sound: B4 再生ごとのゆらぎはピッチ±6%・音量±8%の範囲に収まる", () => {
  for (let i = 0; i < 200; i++) {
    const v = sound.seVariation();
    assert.ok(v.pitch >= 0.94 && v.pitch <= 1.06, `pitch ${v.pitch}`);
    assert.ok(v.gain >= 0.92 && v.gain <= 1.08, `gain ${v.gain}`);
  }
});

test("sound: B4 同時発音の整理と連打防止の間隔", () => {
  assert.ok(sound.SE_BURST_WINDOW_MS >= 50 && sound.SE_BURST_WINDOW_MS <= 150, "整理の窓は 50〜150ms");
  assert.ok(sound.SE_BURST_MAX >= 4 && sound.SE_BURST_MAX <= 10, "窓内の上限は 4〜10 発");
  assert.ok(sound.WB_SE_MIN_INTERVAL_MS.hit >= 30, "命中にも連打防止がある");
  assert.ok(sound.WB_SE_MIN_INTERVAL_MS.kill >= 100, "撃破の連打防止");
  assert.ok(sound.WB_SE_MIN_INTERVAL_MS.coin >= 50, "コインの連打防止");
  const src = fs.readFileSync(path.join(libDir, "worldbox/sound.ts"), "utf8");
  assert.match(src, /recentSeTimes/, "同時発音の窓を持つ");
  assert.match(src, /WB_SE_TIERS\[name\] >= 4/, "tier 4 以下だけを落とす");
  assert.match(src, /distanceGain\(opts\.distance/, "距離でゲインを絞る");
  assert.match(src, /playWbStep/, "素材別足音の入口がある");
});

test("sound: opus っぽさ回避（音声ファイルなし・BGM パッドなし・ローパスで曇らせない）", () => {
  const src = fs.readFileSync(path.join(libDir, "worldbox/sound.ts"), "utf8");
  assert.ok(!/\.(opus|mp3|ogg|wav|m4a)["'`]/i.test(src), "音声ファイルの参照を持たない");
  assert.ok(!/new Audio\(|<audio/i.test(src), "ファイル再生を使わない");
  assert.ok(!/function pad\(/.test(src), "BGM にパッド wash を使わない");
  // BGM バスにローパスを掛ける記述がない（SE の素材ノイズの lowpass は対象外）
  assert.ok(!/bgmFilter/.test(src), "BGM 専用ローパスを持たない");
});

test("sound: クライアント配線（解錠・場面・行為SE・足音・経済・切替）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /from "@\/lib\/worldbox\/sound"/, "sound 基盤を使う");
  assert.match(client, /unlockWbAudio\(\)/, "最初の操作で AudioContext を解錠する");
  assert.match(client, /setWbBgmScene\(bgmSceneFor\(/, "場面で BGM を切り替える");
  assert.match(client, /playWbSe\(seForFxBurst\(ev\.kind\), \{ distance: evDist \}\)/, "モブ演出の SE は距離で減衰する");
  assert.match(client, /playWbSe\(seForFxBurst\(ev\.kind\), \{ distance: Math\.max/, "行為イベントの SE も距離で減衰する");
  assert.match(client, /playWbSe\("swing"\)/, "振りに風切り");
  assert.match(client, /playWbSe\("warp"\)/, "ワープ音");
  assert.match(client, /playWbStep\(footstepMaterialFor\(/, "足音は素材別");
  assert.match(client, /biomeAt\(MAP_SEED, Math\.floor\(player\.x\), Math\.floor\(player\.y\)\)/, "足音の素材は現在地のバイオームから決める");
  assert.match(client, /playWbSe\(menuOpen \? "close" : "open"\)/, "≡ メニューの開閉音");
  assert.match(client, /playWbSe\("click"\)/, "メニュー項目のクリック音");
  assert.match(client, /BGMを切る|BGMを入れる/, "≡ メニューに BGM 切替");
  assert.match(client, /効果音を切る|効果音を入れる/, "≡ メニューに SE 切替");
  const eco = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.match(eco, /from "@\/lib\/worldbox\/sound"/, "経済パネルも sound 基盤を使う");
  assert.match(eco, /ACTION_SE/, "経済アクションの成功音マップがある");
  assert.match(eco, /playWbSe\(se\)/, "経済アクション成功で SE");
});
