// 計算ワーカーの単一ファイルバンドルを生成する。
//
// 背景: ワーカーのエントリが lib の TS モジュールを import すると、
// Next のビルドが「./chess-perft」のような相対 import を残したまま
// 成果物を出し、その実ファイルが .next/static/media に存在しないため
// 本番で 404 になりワーカーが起動しなかった（CPU / WASM 両方）。
// そのため、依存モジュールを TS からトランスパイルして1ファイルに
// 同梱した自己完結ワーカーを lib/compute.worker.js /
// lib/compute-wasm.worker.js として生成し、コミットする。
// 依存元を編集したら `npm run build:workers` で再生成すること
// （npm run build の前にも prebuild で自動実行される）。
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.join(import.meta.dirname, "..");
const libDir = path.join(root, "lib");

function transpile(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

/** import 文を取り除き、export を剥がして「同一スコープの宣言」に変える。 */
function flatten(code, allowedImports, label) {
  const lines = code.split("\n");
  const kept = [];
  for (const line of lines) {
    const importMatch = line.match(/^import\s+.*?\s+from\s+"([^"]+)";?\s*$/);
    if (importMatch) {
      if (!allowedImports.includes(importMatch[1])) {
        throw new Error(`${label}: 想定外の import があります: ${line}`);
      }
      continue;
    }
    if (/^import\s/.test(line)) throw new Error(`${label}: 想定外の import があります: ${line}`);
    kept.push(line.replace(/^export\s+(?=(const|let|var|function|class)\s)/, "").replace(/^export\s+(?=async\s+function)/, ""));
  }
  const joined = kept.join("\n");
  if (/^\s*(import|export)\s/m.test(joined)) {
    throw new Error(`${label}: import/export が残っています`);
  }
  return joined;
}

const HEADER = `// このファイルは自動生成です。編集しないでください。
// 生成元: lib/chess-perft.ts / lib/compute-wasm.ts / lib/compute-wasm-bytes.ts と
// lib/workers-src/*.entry.js。再生成は \`npm run build:workers\`。
// ※ ファイル名が .js でなければならない: ビルド成果物は元ファイルの拡張子を
//   引き継ぎ、.ts だと配信サーバーが video/mp2t を返して読めなくなるため。
// ※ import を含めてはならない: Next のビルドが相対 import の実ファイルを
//   成果物に出さず、本番で 404 になるため、依存はすべて同梱している。
`;

function buildWorker({ outName, entryName, parts }) {
  const bundle = HEADER + "\n" + parts.join("\n") + "\n" +
    fs.readFileSync(path.join(libDir, "workers-src", entryName), "utf8");
  if (/^\s*(import|export)\s/m.test(bundle.replace(HEADER, ""))) {
    throw new Error(`${outName}: バンドルに import/export が残っています`);
  }
  fs.writeFileSync(path.join(libDir, outName), bundle);
  console.log(`generated lib/${outName} (${bundle.length} bytes)`);
}

const chessPerft = flatten(transpile("chess-perft.ts"), [], "chess-perft.ts");
const wasmBytes = flatten(transpile("compute-wasm-bytes.ts"), [], "compute-wasm-bytes.ts");
const computeWasm = flatten(
  transpile("compute-wasm.ts"),
  ["./chess-perft", "./compute-wasm-bytes"],
  "compute-wasm.ts",
);
const chessEngine = flatten(transpile("chess-engine.ts"), ["./chess-perft"], "chess-engine.ts");

buildWorker({
  outName: "compute.worker.js",
  entryName: "compute.worker.entry.js",
  parts: [chessPerft],
});
buildWorker({
  outName: "compute-wasm.worker.js",
  entryName: "compute-wasm.worker.entry.js",
  parts: [wasmBytes, chessPerft, computeWasm],
});
buildWorker({
  outName: "chess-cpu.worker.js",
  entryName: "chess-cpu.worker.entry.js",
  parts: [chessPerft, chessEngine],
});
