// 分散コンピューティングの WebGPU (GPGPU) 実行エンジン。
// lib/chess-perft.ts の着手生成を WGSL に移植し、GPU で perft を数える。
// ホスト側はタスク局面を合法手で数手展開して部分局面に割り、各インボケー
// ションが1部分局面を担当する。部分局面の合計は元の perft と厳密に一致する
// （分割の正しさは tests/compute-gpu.test.mjs が CPU 実装と突き合わせて検証）。
// 盤面表現 (0x88)・駒コード・着手パッキング・合法判定は TS 版と同一。
import { applyMove, generateLegalMoves, parseFen } from "./chess-perft";
import type { Position } from "./chess-perft";

/** GPU 側で扱える残り深さの上限。ホスト側の分割で必ずこの範囲に収める。 */
export const MAX_GPU_DEPTH = 6;

/** 1部分局面ぶんの入力レコード長 (u32 個数)。盤面128 + 手番 + キャスリング + EP + 深さ。 */
export const SUB_STRIDE = 132;

export type GpuSubPosition = {
  board: number[]; // 0x88 の128マス、駒コードは chess-perft と同じ
  side: number; // 0=白, 1=黒
  castling: number;
  ep: number; // 0x88 index、なしは -1
  depth: number;
};

function clonePosition(pos: Position): Position {
  return { board: new Int8Array(pos.board), side: pos.side, castling: pos.castling, ep: pos.ep };
}

/**
 * タスク局面を GPU 用の部分局面リストへ分割する。
 * 合法手を展開して frontier を広げ、targetSubs 程度まで増やす。
 * 残り深さが MAX_GPU_DEPTH を超える局面は目標数に達していても展開する。
 * baseCount は GPU に送らずに確定する分（深さ0のときの 1 のみ）。
 */
export function splitForGpu(
  fen: string,
  depth: number,
  targetSubs = 1024,
): { subs: GpuSubPosition[]; baseCount: number } {
  if (depth === 0) return { subs: [], baseCount: 1 };
  type Node = { pos: Position; depth: number };
  let frontier: Node[] = [{ pos: parseFen(fen), depth }];
  const needsSplit = (node: Node): boolean =>
    node.depth > 1 && (frontier.length < targetSubs || node.depth > MAX_GPU_DEPTH);
  while (frontier.length > 0 && frontier.some(needsSplit)) {
    const next: Node[] = [];
    for (const node of frontier) {
      if (!needsSplit(node)) {
        next.push(node);
        continue;
      }
      for (const { move } of generateLegalMoves(node.pos)) {
        const child = clonePosition(node.pos);
        applyMove(child, move);
        next.push({ pos: child, depth: node.depth - 1 });
      }
    }
    frontier = next;
  }
  return {
    subs: frontier.map((node) => ({
      board: Array.from(node.pos.board),
      side: node.pos.side,
      castling: node.pos.castling,
      ep: node.pos.ep,
      depth: node.depth,
    })),
    baseCount: 0,
  };
}

/** 部分局面リストを GPU 入力バッファ形式 (先頭に件数) へ詰める。 */
export function encodeSubPositions(subs: readonly GpuSubPosition[]): Uint32Array {
  const data = new Uint32Array(1 + subs.length * SUB_STRIDE);
  data[0] = subs.length;
  subs.forEach((sub, i) => {
    const base = 1 + i * SUB_STRIDE;
    for (let sq = 0; sq < 128; sq++) data[base + sq] = sub.board[sq] ?? 0;
    data[base + 128] = sub.side;
    data[base + 129] = sub.castling;
    data[base + 130] = sub.ep + 1; // なし (-1) を 0 で表す
    data[base + 131] = sub.depth;
  });
  return data;
}

export const WGSL_SOURCE = /* wgsl */ `
@group(0) @binding(0) var<storage, read> in_data: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_data: array<u32>;

const SUB_STRIDE: u32 = 132u;
const MAX_MOVES: i32 = 256;

const FLAG_CAPTURE: i32 = 1 << 17;
const FLAG_DOUBLE: i32 = 1 << 18;
const FLAG_EP: i32 = 1 << 19;
const FLAG_CASTLE: i32 = 1 << 20;

const KNIGHT_DELTAS: array<i32, 8> = array<i32, 8>(31, 33, 14, 18, -31, -33, -14, -18);
const KING_DELTAS: array<i32, 8> = array<i32, 8>(16, -16, 1, -1, 15, 17, -15, -17);
const BISHOP_DELTAS: array<i32, 4> = array<i32, 4>(15, 17, -15, -17);
const ROOK_DELTAS: array<i32, 4> = array<i32, 4>(16, -16, 1, -1);
const PROMOS: array<i32, 4> = array<i32, 4>(5, 4, 3, 2);

// 駒コード: 白 1..6 (P,N,B,R,Q,K)、黒 9..14。0x88 盤面は TS 版と同一。
var<private> board: array<i32, 128>;
var<private> side: i32;
var<private> castling: i32;
var<private> ep: i32;

var<private> move_stack: array<i32, 1536>; // 6 ply x 256 手
var<private> move_count: array<i32, 6>;
var<private> move_index: array<i32, 6>;
var<private> undo_captured: array<i32, 6>;
var<private> undo_castling: array<i32, 6>;
var<private> undo_ep: array<i32, 6>;

fn castle_clear(sq: i32) -> i32 {
  switch sq {
    case 0: { return 2; }
    case 4: { return 3; }
    case 7: { return 1; }
    case 112: { return 8; }
    case 116: { return 12; }
    case 119: { return 4; }
    default: { return 0; }
  }
}

fn is_attacked(sq: i32, by: i32) -> bool {
  if (by == 0) {
    let a = sq - 15;
    let c = sq - 17;
    if ((a & 0x88) == 0 && board[a] == 1) { return true; }
    if ((c & 0x88) == 0 && board[c] == 1) { return true; }
  } else {
    let a = sq + 15;
    let c = sq + 17;
    if ((a & 0x88) == 0 && board[a] == 9) { return true; }
    if ((c & 0x88) == 0 && board[c] == 9) { return true; }
  }
  let knight = select(10, 2, by == 0);
  for (var i = 0; i < 8; i++) {
    let t = sq + KNIGHT_DELTAS[i];
    if ((t & 0x88) == 0 && board[t] == knight) { return true; }
  }
  let king = select(14, 6, by == 0);
  for (var i = 0; i < 8; i++) {
    let t = sq + KING_DELTAS[i];
    if ((t & 0x88) == 0 && board[t] == king) { return true; }
  }
  let bishop = select(11, 3, by == 0);
  let queen = select(13, 5, by == 0);
  for (var i = 0; i < 4; i++) {
    var t = sq + BISHOP_DELTAS[i];
    while ((t & 0x88) == 0) {
      let p = board[t];
      if (p != 0) {
        if (p == bishop || p == queen) { return true; }
        break;
      }
      t += BISHOP_DELTAS[i];
    }
  }
  let rook = select(12, 4, by == 0);
  for (var i = 0; i < 4; i++) {
    var t = sq + ROOK_DELTAS[i];
    while ((t & 0x88) == 0) {
      let p = board[t];
      if (p != 0) {
        if (p == rook || p == queen) { return true; }
        break;
      }
      t += ROOK_DELTAS[i];
    }
  }
  return false;
}

fn king_square(color: i32) -> i32 {
  let king = select(14, 6, color == 0);
  for (var i = 0; i < 128; i++) {
    if ((i & 0x88) == 0 && board[i] == king) { return i; }
  }
  return -1;
}

fn is_enemy(target_piece: i32) -> bool {
  return select((target_piece <= 6), (target_piece >= 9), side == 0);
}

fn make_move(m: i32, ply: i32) {
  let from_sq = m & 0x7f;
  let to = (m >> 7) & 0x7f;
  let piece = board[from_sq];
  undo_captured[ply] = board[to];
  undo_castling[ply] = castling;
  undo_ep[ply] = ep;
  ep = -1;
  castling = castling & ~castle_clear(from_sq) & ~castle_clear(to) & 0xf;
  if ((m & FLAG_EP) != 0) {
    let cap_sq = select(to + 16, to - 16, side == 0);
    undo_captured[ply] = board[cap_sq];
    board[cap_sq] = 0;
  }
  board[to] = piece;
  board[from_sq] = 0;
  let promo = (m >> 14) & 0x7;
  if (promo != 0) {
    board[to] = select(promo + 8, promo, side == 0);
  }
  if ((m & FLAG_DOUBLE) != 0) {
    ep = select(from_sq - 16, from_sq + 16, side == 0);
  }
  if ((m & FLAG_CASTLE) != 0) {
    if (to == 6) { board[5] = board[7]; board[7] = 0; }
    else if (to == 2) { board[3] = board[0]; board[0] = 0; }
    else if (to == 118) { board[117] = board[119]; board[119] = 0; }
    else if (to == 114) { board[115] = board[112]; board[112] = 0; }
  }
  side = 1 - side;
}

fn unmake_move(m: i32, ply: i32) {
  side = 1 - side;
  let from_sq = m & 0x7f;
  let to = (m >> 7) & 0x7f;
  var piece = board[to];
  let promo = (m >> 14) & 0x7;
  if (promo != 0) {
    piece = select(9, 1, side == 0);
  }
  board[from_sq] = piece;
  board[to] = 0;
  if ((m & FLAG_CASTLE) != 0) {
    if (to == 6) { board[7] = board[5]; board[5] = 0; }
    else if (to == 2) { board[0] = board[3]; board[3] = 0; }
    else if (to == 118) { board[119] = board[117]; board[117] = 0; }
    else if (to == 114) { board[112] = board[115]; board[115] = 0; }
  }
  if ((m & FLAG_EP) != 0) {
    let cap_sq = select(to + 16, to - 16, side == 0);
    board[cap_sq] = undo_captured[ply];
  } else if (undo_captured[ply] != 0) {
    board[to] = undo_captured[ply];
  }
  castling = undo_castling[ply];
  ep = undo_ep[ply];
}

fn gen_moves(ply: i32) -> i32 {
  let base = ply * MAX_MOVES;
  var n = 0;
  for (var from_sq = 0; from_sq < 128; from_sq++) {
    if ((from_sq & 0x88) != 0) { continue; }
    let piece = board[from_sq];
    if (piece == 0) { continue; }
    if (select((piece < 9), (piece > 6), side == 0)) { continue; }
    let ptype = piece & 7;
    if (ptype == 1) {
      // ポーン
      let up = select(-16, 16, side == 0);
      let start_rank = select(6, 1, side == 0);
      let promo_rank = select(1, 6, side == 0);
      let rank = from_sq >> 4;
      let one = from_sq + up;
      if (board[one] == 0) {
        if (rank == promo_rank) {
          for (var pi = 0; pi < 4; pi++) {
            move_stack[base + n] = from_sq | (one << 7) | (PROMOS[pi] << 14);
            n += 1;
          }
        } else {
          move_stack[base + n] = from_sq | (one << 7);
          n += 1;
          let two = from_sq + 2 * up;
          if (rank == start_rank && board[two] == 0) {
            move_stack[base + n] = from_sq | (two << 7) | FLAG_DOUBLE;
            n += 1;
          }
        }
      }
      for (var di = 0; di < 2; di++) {
        let d = select(up + 1, up - 1, di == 0);
        let to = from_sq + d;
        if ((to & 0x88) != 0) { continue; }
        let target_piece = board[to];
        if (target_piece != 0 && is_enemy(target_piece)) {
          if (rank == promo_rank) {
            for (var pi = 0; pi < 4; pi++) {
              move_stack[base + n] = from_sq | (to << 7) | (PROMOS[pi] << 14) | FLAG_CAPTURE;
              n += 1;
            }
          } else {
            move_stack[base + n] = from_sq | (to << 7) | FLAG_CAPTURE;
            n += 1;
          }
        } else if (to == ep) {
          move_stack[base + n] = from_sq | (to << 7) | FLAG_CAPTURE | FLAG_EP;
          n += 1;
        }
      }
    } else if (ptype == 2 || ptype == 6) {
      // ナイト / キング
      for (var i = 0; i < 8; i++) {
        let d = select(KING_DELTAS[i], KNIGHT_DELTAS[i], ptype == 2);
        let to = from_sq + d;
        if ((to & 0x88) != 0) { continue; }
        let target_piece = board[to];
        if (target_piece == 0) {
          move_stack[base + n] = from_sq | (to << 7);
          n += 1;
        } else if (is_enemy(target_piece)) {
          move_stack[base + n] = from_sq | (to << 7) | FLAG_CAPTURE;
          n += 1;
        }
      }
      if (ptype == 6) {
        // キャスリング
        if (side == 0 && from_sq == 4) {
          if ((castling & 1) != 0 && board[5] == 0 && board[6] == 0 && board[7] == 4 &&
              !is_attacked(4, 1) && !is_attacked(5, 1) && !is_attacked(6, 1)) {
            move_stack[base + n] = from_sq | (6 << 7) | FLAG_CASTLE;
            n += 1;
          }
          if ((castling & 2) != 0 && board[3] == 0 && board[2] == 0 && board[1] == 0 && board[0] == 4 &&
              !is_attacked(4, 1) && !is_attacked(3, 1) && !is_attacked(2, 1)) {
            move_stack[base + n] = from_sq | (2 << 7) | FLAG_CASTLE;
            n += 1;
          }
        } else if (side == 1 && from_sq == 116) {
          if ((castling & 4) != 0 && board[117] == 0 && board[118] == 0 && board[119] == 12 &&
              !is_attacked(116, 0) && !is_attacked(117, 0) && !is_attacked(118, 0)) {
            move_stack[base + n] = from_sq | (118 << 7) | FLAG_CASTLE;
            n += 1;
          }
          if ((castling & 8) != 0 && board[115] == 0 && board[114] == 0 && board[113] == 0 && board[112] == 12 &&
              !is_attacked(116, 0) && !is_attacked(115, 0) && !is_attacked(114, 0)) {
            move_stack[base + n] = from_sq | (114 << 7) | FLAG_CASTLE;
            n += 1;
          }
        }
      }
    } else {
      // スライダー (3=ビショップ, 4=ルーク, 5=クイーン)
      for (var set_idx = 0; set_idx < 2; set_idx++) {
        if (ptype == 3 && set_idx == 1) { continue; }
        if (ptype == 4 && set_idx == 0) { continue; }
        for (var i = 0; i < 4; i++) {
          let d = select(ROOK_DELTAS[i], BISHOP_DELTAS[i], set_idx == 0);
          var to = from_sq + d;
          while ((to & 0x88) == 0) {
            let target_piece = board[to];
            if (target_piece == 0) {
              move_stack[base + n] = from_sq | (to << 7);
              n += 1;
            } else {
              if (is_enemy(target_piece)) {
                move_stack[base + n] = from_sq | (to << 7) | FLAG_CAPTURE;
                n += 1;
              }
              break;
            }
            to += d;
          }
        }
      }
    }
  }
  return n;
}

// 反復型 DFS で perft を数える。結果は u32 の (lo, hi) ペア。
fn perft_count(depth: i32) -> vec2<u32> {
  if (depth == 0) { return vec2<u32>(1u, 0u); }
  var lo: u32 = 0u;
  var hi: u32 = 0u;
  var ply = 0;
  move_count[0] = gen_moves(0);
  move_index[0] = 0;
  loop {
    if (move_index[ply] >= move_count[ply]) {
      if (ply == 0) { break; }
      ply -= 1;
      unmake_move(move_stack[ply * MAX_MOVES + move_index[ply]], ply);
      move_index[ply] += 1;
      continue;
    }
    let m = move_stack[ply * MAX_MOVES + move_index[ply]];
    let mover = side;
    make_move(m, ply);
    let ksq = king_square(mover);
    if (ksq >= 0 && !is_attacked(ksq, side)) {
      if (ply + 1 == depth) {
        lo += 1u;
        if (lo == 0u) { hi += 1u; }
        unmake_move(m, ply);
        move_index[ply] += 1;
      } else {
        ply += 1;
        move_count[ply] = gen_moves(ply);
        move_index[ply] = 0;
      }
    } else {
      unmake_move(m, ply);
      move_index[ply] += 1;
    }
  }
  return vec2<u32>(lo, hi);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let sub_count = in_data[0];
  if (idx >= sub_count) { return; }
  let base = 1u + idx * SUB_STRIDE;
  for (var i = 0; i < 128; i++) {
    board[i] = i32(in_data[base + u32(i)]);
  }
  side = i32(in_data[base + 128u]);
  castling = i32(in_data[base + 129u]);
  ep = i32(in_data[base + 130u]) - 1;
  let depth = i32(in_data[base + 131u]);
  let count = perft_count(depth);
  out_data[idx * 2u] = count.x;
  out_data[idx * 2u + 1u] = count.y;
}
`;

// ---- ホスト側 WebGPU ランナー ----
// WebGPU の型は @webgpu/types に依存せず、使う範囲だけ最小限の構造型で表す。

type GpuBufferLike = {
  mapAsync: (mode: number) => Promise<void>;
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
  destroy: () => void;
};

type GpuDeviceLike = {
  queue: {
    writeBuffer: (buffer: GpuBufferLike, offset: number, data: Uint32Array) => void;
    submit: (commandBuffers: unknown[]) => void;
  };
  createBuffer: (desc: { size: number; usage: number }) => GpuBufferLike;
  createShaderModule: (desc: { code: string }) => {
    getCompilationInfo: () => Promise<{
      messages: { type: string; message: string; lineNum: number }[];
    }>;
  };
  createComputePipeline: (desc: {
    layout: string;
    compute: { module: unknown; entryPoint: string };
  }) => { getBindGroupLayout: (index: number) => unknown };
  pushErrorScope: (filter: string) => void;
  popErrorScope: () => Promise<{ message: string } | null>;
  createBindGroup: (desc: {
    layout: unknown;
    entries: { binding: number; resource: { buffer: GpuBufferLike } }[];
  }) => unknown;
  createCommandEncoder: () => {
    beginComputePass: () => {
      setPipeline: (pipeline: unknown) => void;
      setBindGroup: (index: number, group: unknown) => void;
      dispatchWorkgroups: (x: number) => void;
      end: () => void;
    };
    copyBufferToBuffer: (src: GpuBufferLike, srcOffset: number, dst: GpuBufferLike, dstOffset: number, size: number) => void;
    finish: () => unknown;
  };
  lost: Promise<unknown>;
};

type GpuLike = {
  requestAdapter: () => Promise<{ requestDevice: () => Promise<GpuDeviceLike> } | null>;
};

// GPUBufferUsage の値（WebGPU 仕様の定数）
const USAGE_MAP_READ = 0x0001;
const USAGE_COPY_SRC = 0x0004;
const USAGE_COPY_DST = 0x0008;
const USAGE_STORAGE = 0x0080;
const MAP_MODE_READ = 0x0001;
const WORKGROUP_SIZE = 64;

function getGpu(): GpuLike | null {
  if (typeof navigator === "undefined") return null;
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  return gpu ?? null;
}

/** このブラウザが WebGPU を使えそうか（同期チェック。実際のアダプタ可否は実行時に確定する）。 */
export function isWebGpuSupported(): boolean {
  return getGpu() !== null;
}

let devicePromise: Promise<GpuDeviceLike> | null = null;

function getDevice(): Promise<GpuDeviceLike> {
  if (devicePromise) return devicePromise;
  const gpu = getGpu();
  if (!gpu) return Promise.reject(new Error("WebGPU is not available"));
  devicePromise = (async () => {
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter is not available");
    const device = await adapter.requestDevice();
    device.lost.then(
      () => {
        devicePromise = null;
      },
      () => {
        devicePromise = null;
      },
    );
    return device;
  })();
  devicePromise.catch(() => {
    devicePromise = null;
  });
  return devicePromise;
}

let pipelineCache: { device: GpuDeviceLike; pipeline: ReturnType<GpuDeviceLike["createComputePipeline"]> } | null =
  null;

/**
 * パイプラインを用意する。WGSL のコンパイルエラーを getCompilationInfo で
 * 明示的に拾い、失敗したら例外にする（WebGPU の検証エラーは通常の例外に
 * ならないため、放置すると無効なパイプラインで 0 ノードを返し続けてしまう）。
 */
async function getPipeline(device: GpuDeviceLike) {
  if (pipelineCache && pipelineCache.device === device) return pipelineCache.pipeline;
  const module = device.createShaderModule({ code: WGSL_SOURCE });
  const info = await module.getCompilationInfo();
  const compileError = info.messages.find((m) => m.type === "error");
  if (compileError) {
    throw new Error(
      `WGSL compile error (line ${compileError.lineNum}): ${compileError.message}`,
    );
  }
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  pipelineCache = { device, pipeline };
  return pipeline;
}

/**
 * 1タスク分の perft を WebGPU で計算する。
 * WebGPU が使えない環境では例外を投げるので、呼び出し側で CPU 方式へ切り替えること。
 */
export async function runPerftOnGpu(
  fen: string,
  depth: number,
): Promise<{ nodes: number; elapsedMs: number }> {
  const started = performance.now();
  const { subs, baseCount } = splitForGpu(fen, depth);
  if (subs.length === 0) return { nodes: baseCount, elapsedMs: performance.now() - started };

  const device = await getDevice();
  const pipeline = await getPipeline(device);
  const input = encodeSubPositions(subs);
  const inputBuffer = device.createBuffer({ size: input.byteLength, usage: USAGE_STORAGE | USAGE_COPY_DST });
  device.queue.writeBuffer(inputBuffer, 0, input);
  const outputSize = subs.length * 8;
  const outputBuffer = device.createBuffer({ size: outputSize, usage: USAGE_STORAGE | USAGE_COPY_SRC });
  const readbackBuffer = device.createBuffer({ size: outputSize, usage: USAGE_MAP_READ | USAGE_COPY_DST });
  try {
    // 検証エラーを例外として拾い、無効な実行結果を送信しないようにする
    device.pushErrorScope("validation");
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: outputBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(subs.length / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputSize);
    device.queue.submit([encoder.finish()]);
    const validationError = await device.popErrorScope();
    if (validationError) {
      pipelineCache = null;
      throw new Error(`WebGPU validation error: ${validationError.message}`);
    }

    await readbackBuffer.mapAsync(MAP_MODE_READ);
    const counts = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();
    let nodes = baseCount;
    for (let i = 0; i < subs.length; i++) {
      nodes += counts[i * 2] + counts[i * 2 + 1] * 4294967296;
    }
    // 部分局面が1つ以上ある（＝合法手が存在する）局面で 0 はあり得ない。
    // GPU 側の異常を結果として送信せず、呼び出し側の自動切り替えに任せる。
    if (nodes === 0 && subs.length > 0) {
      throw new Error("WebGPU returned zero nodes for a non-terminal position");
    }
    return { nodes, elapsedMs: performance.now() - started };
  } finally {
    inputBuffer.destroy();
    outputBuffer.destroy();
    readbackBuffer.destroy();
  }
}
