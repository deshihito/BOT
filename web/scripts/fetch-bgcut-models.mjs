// 背景透過ページの資産を用意する（prebuild から呼ばれる）。
// - 背景除去モデル（ONNX）をピン留め URL から sha256 検証つきで取得し、
//   public/models/ に置く（バイナリはリポジトリに入れない。bot 側モデル
//   自動DLの前例と同じ考え方）。取得済みで検証が通れば何もしない。
// - ONNX Runtime Web の WASM 資産を node_modules から public/ort/ へコピーする。
// - 用意できたモデルだけを public/models/manifest.json に書く。
// モデル取得に失敗してもビルド自体は止めない（ページ側が残りのモデルで
// 動く／両方無い場合はその旨をページが表示する）。ただし失敗は必ず警告する。
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_DIR = path.join(WEB_ROOT, "public", "models");
const ORT_DIR = path.join(WEB_ROOT, "public", "ort");

const MODELS = [
  {
    name: "silueta",
    file: "silueta.onnx",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx",
    bytes: 44173029,
    sha256: "75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb",
  },
  {
    name: "u2netp",
    file: "u2netp.onnx",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
    bytes: 4574861,
    sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
  },
];

const ORT_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];

async function sha256OfFile(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function isValid(file, model) {
  try {
    const info = await stat(file);
    if (info.size !== model.bytes) return false;
    return (await sha256OfFile(file)) === model.sha256;
  } catch {
    return false;
  }
}

async function download(model, dest) {
  const res = await fetch(model.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  if (!(await isValid(dest, model))) {
    throw new Error("サイズ／sha256 が一致しません");
  }
}

async function main() {
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(ORT_DIR, { recursive: true });

  const available = [];
  for (const model of MODELS) {
    const dest = path.join(MODELS_DIR, model.file);
    if (await isValid(dest, model)) {
      available.push({ name: model.name, file: model.file, bytes: model.bytes });
      continue;
    }
    try {
      await download(model, dest);
      available.push({ name: model.name, file: model.file, bytes: model.bytes });
      console.log(`[bgcut] model fetched: ${model.file}`);
    } catch (error) {
      console.warn(
        `[bgcut] WARNING: モデル ${model.file} を取得できませんでした: ${error.message}`,
      );
    }
  }
  await writeFile(
    path.join(MODELS_DIR, "manifest.json"),
    JSON.stringify({ models: available }, null, 2),
  );
  if (available.length === 0) {
    console.warn("[bgcut] WARNING: 利用できる背景除去モデルがありません");
  }

  const ortDist = path.join(WEB_ROOT, "node_modules", "onnxruntime-web", "dist");
  for (const file of ORT_FILES) {
    await copyFile(path.join(ortDist, file), path.join(ORT_DIR, file));
  }
  console.log("[bgcut] ort wasm assets copied");
}

await main();
