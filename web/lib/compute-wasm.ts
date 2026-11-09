// 分散コンピューティングの WASM 実行エンジン。
// AssemblyScript 製の perft (web/native/perft.ts をコンパイルし、
// compute-wasm-bytes.ts に base64 で埋め込み) を Web Worker から使う。
// 着手生成の意味は lib/chess-perft.ts と同一で、公開既知値とカタログの
// 正解値で検証済み（tests/compute-wasm.test.mjs）。対応環境では
// JavaScript 実装より高速に計算できる。
import { parseFen } from "./chess-perft";
import { WASM_BASE64 } from "./compute-wasm-bytes";

type PerftWasmExports = {
  setSquare: (index: number, value: number) => void;
  setState: (side: number, castling: number, ep: number) => void;
  perftNow: (depth: number) => bigint;
};

/** この環境で WebAssembly が使えるか。 */
export function isWasmSupported(): boolean {
  return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let exportsPromise: Promise<PerftWasmExports> | null = null;

function getExports(): Promise<PerftWasmExports> {
  if (!exportsPromise) {
    exportsPromise = (async () => {
      const bytes = decodeBase64(WASM_BASE64);
      const { instance } = await WebAssembly.instantiate(bytes, {
        env: {
          abort: () => {
            throw new Error("wasm abort");
          },
        },
      });
      return instance.exports as unknown as PerftWasmExports;
    })();
    exportsPromise.catch(() => {
      exportsPromise = null;
    });
  }
  return exportsPromise;
}

/** FEN 局面の perft を WASM で計算する。 */
export async function perftFenWasm(fen: string, depth: number): Promise<number> {
  const wasm = await getExports();
  const pos = parseFen(fen);
  for (let i = 0; i < 128; i++) wasm.setSquare(i, pos.board[i]);
  wasm.setState(pos.side, pos.castling, pos.ep);
  return Number(wasm.perftNow(depth));
}
