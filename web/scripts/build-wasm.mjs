// WASM 実行方式のバイナリ再生成スクリプト（通常の npm run build には含めない）。
// 前提: AssemblyScript が使えること（例: 一時ディレクトリで `npm i assemblyscript`）。
// 使い方: node scripts/build-wasm.mjs <asc へのパス>
//   例: node scripts/build-wasm.mjs /tmp/wasm-build/node_modules/.bin/asc
// web/native/perft.ts をコンパイルし、web/lib/compute-wasm-bytes.ts を書き換える。
// 生成後は tests/compute-wasm.test.mjs で正しさを必ず確認すること。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const asc = process.argv[2];
if (!asc) {
  console.error("使い方: node scripts/build-wasm.mjs <asc へのパス>");
  process.exit(1);
}
const webRoot = path.join(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perft-wasm-"));
const outWasm = path.join(tmp, "perft.wasm");
execFileSync(asc, [
  path.join(webRoot, "native", "perft.ts"),
  "--outFile",
  outWasm,
  "--runtime",
  "stub",
  "--optimize",
  "--noAssert",
], { stdio: "inherit" });

const bytes = fs.readFileSync(outWasm);
const base64 = bytes.toString("base64");
const lines = base64.match(/.{1,100}/g) ?? [];
const content =
  "// AssemblyScript 製 perft (web/native/perft.ts) をコンパイルした WASM バイナリ。\n" +
  "// 再生成手順は web/scripts/build-wasm.mjs を参照。\n" +
  `// 元バイナリ: ${bytes.length} bytes\n` +
  "export const WASM_BASE64 =\n" +
  lines.map((line) => `  "${line}"`).join(" +\n") +
  ";\n";
fs.writeFileSync(path.join(webRoot, "lib", "compute-wasm-bytes.ts"), content);
console.log(`compute-wasm-bytes.ts を更新しました (${bytes.length} bytes)`);
