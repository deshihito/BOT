// AGO WORLD BOX シームレスローディング（B1）の検証:
// - ワープフェード: 140ms で暗転→頂点で切替→220ms で明ける、合計 360ms 以内
// - 初回入場は暗転から明けるだけ、再接続は薄いパルスだけ（暗転しない）
// - 先読み: 全枚成功・一部失敗・全体タイムアウトのいずれでも必ず解決する
// - クライアント配線（ワープ/テレポート/リスポーンのフェード経由・
//   入場前スプライト先読み・再接続パルス・描画ループの暗幕）
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
        .replace(/^export\s+(?=(async\s+function))/, "")
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

const tr = await loadBundle(
  ["worldbox/transition.ts"],
  [
    "TRANSITION_FADE_OUT_MS", "TRANSITION_FADE_IN_MS", "TRANSITION_TOTAL_MS",
    "TRANSITION_ENTER_MS", "RECONNECT_PULSE_MS", "RECONNECT_PULSE_ALPHA",
    "SPRITE_PRELOAD_TIMEOUT_MS", "TRANSITION_OVERLAY_RGB",
    "transitionTotalMs", "transitionAlpha", "transitionSwapDue", "transitionDone",
    "preloadImages",
  ],
);

test("transition: ワープ全体は 360ms 以内（遅さは罪）", () => {
  assert.equal(tr.TRANSITION_FADE_OUT_MS, 140);
  assert.equal(tr.TRANSITION_FADE_IN_MS, 220);
  assert.equal(tr.TRANSITION_TOTAL_MS, 360);
  assert.equal(tr.transitionTotalMs("warp"), 360);
});

test("transition: ワープは暗転→頂点→明ける。切替は頂点で1回だけ", () => {
  assert.equal(tr.transitionAlpha(0, "warp"), 0);
  assert.ok(tr.transitionAlpha(70, "warp") > 0 && tr.transitionAlpha(70, "warp") < 1);
  assert.equal(tr.transitionAlpha(140, "warp"), 1);
  assert.ok(tr.transitionAlpha(250, "warp") > 0 && tr.transitionAlpha(250, "warp") < 1);
  assert.equal(tr.transitionAlpha(360, "warp"), 0);
  assert.equal(tr.transitionAlpha(1000, "warp"), 0);
  assert.equal(tr.transitionSwapDue(139), false);
  assert.equal(tr.transitionSwapDue(140), true);
  assert.equal(tr.transitionDone(359, "warp"), false);
  assert.equal(tr.transitionDone(360, "warp"), true);
});

test("transition: 入場は暗転から明けるだけ（フェードアウトなし）", () => {
  assert.equal(tr.transitionAlpha(0, "enter"), 1);
  assert.ok(tr.transitionAlpha(110, "enter") > 0 && tr.transitionAlpha(110, "enter") < 1);
  assert.equal(tr.transitionAlpha(220, "enter"), 0);
  assert.equal(tr.transitionTotalMs("enter"), 220);
});

test("transition: 再接続は薄いパルスだけ（暗転しない・短い）", () => {
  assert.equal(tr.transitionAlpha(0, "reconnect"), tr.RECONNECT_PULSE_ALPHA);
  assert.ok(tr.transitionAlpha(0, "reconnect") <= 0.25, "目立たない薄さ");
  assert.ok(tr.transitionAlpha(150, "reconnect") < tr.RECONNECT_PULSE_ALPHA);
  assert.equal(tr.transitionAlpha(300, "reconnect"), 0);
  assert.equal(tr.transitionTotalMs("reconnect"), 300);
});

test("transition: 暗幕の色はシェル背景と同一（継ぎ目を消す）", () => {
  assert.equal(tr.TRANSITION_OVERLAY_RGB, "11,14,20");
});

function fakeImage(behavior) {
  // behavior: "ok" | "fail" | "hang"
  return () => {
    const img = { src: "", onload: null, onerror: null };
    if (behavior === "ok") {
      Object.defineProperty(img, "src", {
        set(v) {
          this._src = v;
          queueMicrotask(() => img.onload?.call(img, new Event("load")));
        },
        get() {
          return this._src;
        },
      });
    } else if (behavior === "fail") {
      Object.defineProperty(img, "src", {
        set(v) {
          this._src = v;
          queueMicrotask(() => img.onerror?.call(img, new Event("error")));
        },
        get() {
          return this._src;
        },
      });
    } else {
      Object.defineProperty(img, "src", {
        set(v) {
          this._src = v;
        },
        get() {
          return this._src;
        },
      });
    }
    return img;
  };
}

test("transition: 先読みは全枚成功で loaded に集まる", async () => {
  const r = await tr.preloadImages(["a.png", "b.png"], { imageFactory: fakeImage("ok"), timeoutMs: 1000 });
  assert.deepEqual(r.loaded.sort(), ["a.png", "b.png"]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.timedOut, false);
});

test("transition: 先読みは失敗が混ざっても残りを待って解決する", async () => {
  let n = 0;
  const mixed = () => {
    n += 1;
    return fakeImage(n === 1 ? "fail" : "ok")();
  };
  const r = await tr.preloadImages(["a.png", "b.png"], { imageFactory: mixed, timeoutMs: 1000 });
  assert.deepEqual(r.failed, ["a.png"]);
  assert.deepEqual(r.loaded, ["b.png"]);
  assert.equal(r.timedOut, false);
});

test("transition: 先読みは応答がなくてもタイムアウトで必ず解決する", async () => {
  const r = await tr.preloadImages(["a.png", "b.png"], { imageFactory: fakeImage("hang"), timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.loaded, []);
});

test("transition: 先読みは重複 URL を1回にまとめる", async () => {
  let calls = 0;
  const counting = () => {
    calls += 1;
    return fakeImage("ok")();
  };
  const r = await tr.preloadImages(["a.png", "a.png", "a.png"], { imageFactory: counting, timeoutMs: 1000 });
  assert.equal(calls, 1);
  assert.deepEqual(r.loaded, ["a.png"]);
});

test("transition: 先読みの既定タイムアウトは 2.5秒", () => {
  assert.equal(tr.SPRITE_PRELOAD_TIMEOUT_MS, 2500);
});

const clientSrc = fs.readFileSync(
  path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"),
  "utf8",
);

test("transition: クライアントがワープ/テレポート/リスポーンをフェード経由にする", () => {
  assert.ok(clientSrc.includes("beginTransition"), "遷移開始の共通口がある");
  assert.ok(clientSrc.includes("transitionAlpha"), "描画ループが暗幕を重ねる");
  assert.ok(clientSrc.includes("TRANSITION_OVERLAY_RGB"), "暗幕色はシェル背景と同一");
  for (const name of ["doWarp", "warpToInstance"]) {
    const at = clientSrc.indexOf(`const ${name}`);
    assert.ok(at >= 0, `${name} がある`);
    const body = clientSrc.slice(at, at + 4000);
    assert.ok(body.includes("beginTransition"), `${name} がフェード経由`);
  }
  assert.ok(clientSrc.includes("teleportActionRef.current ="), "テレポートがある");
  assert.ok(clientSrc.includes("respawnActionRef.current ="), "リスポーンがある");
});

test("transition: クライアントが入場前にスプライトを先読みする", () => {
  assert.ok(clientSrc.includes("preloadImages"), "先読みを呼ぶ");
  assert.ok(clientSrc.includes("LOBBY_SPRITE_SRC") || clientSrc.includes("loadLobbySprites"), "ロビー素材が対象");
  assert.ok(clientSrc.includes("booted") || clientSrc.includes("spritesReady"), "先読み完了までワールドを出さない");
  assert.ok(clientSrc.includes("SPRITE_PRELOAD_TIMEOUT_MS"), "先読みに上限がある");
});

test("transition: 再接続時に復帰パルスを出す（入力は止めない）", () => {
  assert.ok(clientSrc.includes("\"reconnect\""), "再接続種別がある");
  assert.ok(clientSrc.includes("rtEverConnected") || clientSrc.includes("everConnected"), "初回接続と再接続を区別する");
});
