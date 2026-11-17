// AGO WORLD BOX 望遠鏡の検証:
// - ロビー1F（競馬場北スタンド）と 3F 展望デッキに station "telescope" で配置される
// - スプライトが textures.ts に登録され、実ファイルが存在する
// - 望遠鏡の隣では stationNear が "telescope" を返す
// - クライアント配線: 開いている間は入力が視点へ回り、ドラッグでも視点が動く
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

const wb = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/lobby-floors.ts"],
  ["buildLobby", "stationNear", "buildLobby3", "LOBBY3_ENTRY"],
);

test("望遠鏡: ロビー1Fの競馬場北スタンドに配置され、隣で station が返る", () => {
  const lobby = wb.buildLobby();
  const scopes = lobby.objects.filter((o) => o.sprite === "telescope");
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].station, "telescope");
  assert.equal(scopes[0].x, 93);
  assert.equal(scopes[0].y, 6);
  // 望遠鏡の南隣（スタンド側）に立つと station "telescope"
  assert.equal(wb.stationNear(lobby.objects, 93, 7), "telescope");
});

test("望遠鏡: 3F展望デッキに配置され、隣で station が返る", () => {
  const l3 = wb.buildLobby3();
  const scopes = l3.objects.filter((o) => o.sprite === "telescope");
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].station, "telescope");
  assert.equal(scopes[0].x, 18);
  assert.equal(scopes[0].y, 4);
  assert.equal(wb.stationNear(l3.objects, 18, 5), "telescope");
});

test("望遠鏡: スプライト登録と実ファイル", () => {
  const tex = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  assert.match(tex, /telescope: "\/img\/worldbox\/lobby\/telescope\.png"/);
  const png = fs.readFileSync(path.join(rootDir, "public/img/worldbox/lobby/telescope.png"));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
});

test("望遠鏡: クライアントは開いている間だけ視点へ入力を回す", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /telescopeOpenRef\.current/);
  assert.match(client, /telescopeCam/);
  assert.match(client, /stationUi === "telescope"/);
  assert.match(client, /telescopeDrag/);
});
