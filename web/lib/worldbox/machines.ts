// AGO WORLD BOX の機械基盤（バッチ10a）。
// 統一されたアイテム/ブロック構造の上に載る「プログラム可能な装置」の土台。
// 装置 = 設置ブロック（facility）に紐づく DeviceProgram（トリガー+動作+
// パラメータ）と、その実行状態（バッファ等）。プログラムは共有コードとして
// 書き出し/読み込みでき、他人の作った装置設定をそのまま使える（共有基盤）。
// 最小の実働装置として「自動収穫機」を実装する: 隣接する自分の畑で作物が
// 育ち切ったら自動で収穫し、装置内バッファに貯める（回収は所有者がタップ）。
// 評価は遅延式（読み取り/操作のタイミングで経過分を解決する）で、
// サーバー側の常駐ループは持たない。

import { cropById } from "./items";
import type { TileOverride } from "./tiles";

/** 装置として扱う施設アイテム。 */
export const MACHINE_ITEM_ID = "auto_harvester";
export function isMachineItem(itemId: string): boolean {
  return itemId === MACHINE_ITEM_ID;
}

export type DeviceTrigger = "mature";
export type DeviceAction = "harvest";

export interface DeviceProgram {
  version: 1;
  trigger: DeviceTrigger;
  action: DeviceAction;
  /** 評価の最小間隔（秒）。これより細かくは動かない。 */
  intervalSec: number;
  enabled: boolean;
}

export const DEVICE_INTERVAL_CHOICES: readonly number[] = [30, 60, 300];

export function defaultProgram(): DeviceProgram {
  return { version: 1, trigger: "mature", action: "harvest", intervalSec: 60, enabled: true };
}

export function parseProgram(raw: unknown): DeviceProgram {
  const base = defaultProgram();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const v = raw as Record<string, unknown>;
  return {
    version: 1,
    trigger: "mature",
    action: "harvest",
    intervalSec: DEVICE_INTERVAL_CHOICES.includes(v.intervalSec as number)
      ? (v.intervalSec as number)
      : base.intervalSec,
    enabled: v.enabled !== false,
  };
}

/** 共有コード: "WB1." + base64url(JSON)。他人のプログラムを取り込める。 */
export function encodeProgram(program: DeviceProgram): string {
  const json = JSON.stringify(parseProgram(program));
  return "WB1." + Buffer.from(json, "utf8").toString("base64url");
}

export function decodeProgram(code: unknown): DeviceProgram | null {
  if (typeof code !== "string" || !code.startsWith("WB1.")) return null;
  try {
    const raw = JSON.parse(Buffer.from(code.slice(4), "base64url").toString("utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    return parseProgram(raw);
  } catch {
    return null;
  }
}

/** 組み込みプリセット（共有の出発点）。 */
export const DEVICE_PRESETS: readonly { id: string; name: string; program: DeviceProgram }[] = [
  { id: "standard", name: "標準収穫", program: defaultProgram() },
  { id: "swift", name: "こまめ収穫", program: { ...defaultProgram(), intervalSec: 30 } },
  { id: "eco", name: "のんびり収穫", program: { ...defaultProgram(), intervalSec: 300 } },
];

export interface MachineState {
  /** 設置者の不透明 ID（presenceId 形式）。 */
  ownerId: string;
  program: DeviceProgram;
  /** 収穫済みで未回収の作物。 */
  buffer: Record<string, number>;
  lastEvalAt: number;
  updatedAt: number;
}

export function parseMachineState(raw: unknown): MachineState | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.ownerId !== "string" || v.ownerId.length === 0) return null;
  const buffer: Record<string, number> = {};
  if (v.buffer && typeof v.buffer === "object" && !Array.isArray(v.buffer)) {
    for (const [itemId, count] of Object.entries(v.buffer as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count) && count > 0) {
        buffer[itemId] = Math.floor(count);
      }
    }
  }
  return {
    ownerId: v.ownerId,
    program: parseProgram(v.program),
    buffer,
    lastEvalAt: typeof v.lastEvalAt === "number" && Number.isFinite(v.lastEvalAt) ? v.lastEvalAt : 0,
    updatedAt: typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : 0,
  };
}

export function machineBufferCount(state: MachineState): number {
  return Object.values(state.buffer).reduce((sum, n) => sum + n, 0);
}

export interface MachineEvalResult {
  state: MachineState;
  /** 変更が必要な隣接タイル（キー → 新しい上書き）。 */
  changed: Map<string, TileOverride>;
  /** 今回収穫した数。 */
  harvested: number;
  /** 評価が走ったか（間隔未満なら false で状態は不変）。 */
  evaluated: boolean;
}

/**
 * 装置を評価する。neighbors は装置タイルの周囲8タイルの上書き（キー付き）。
 * 所有者が同じで、育ち切った作物があれば収穫してバッファへ移す。
 */
export function evaluateMachine(
  state: MachineState,
  neighbors: ReadonlyMap<string, TileOverride>,
  now: number,
): MachineEvalResult {
  const unchanged: MachineEvalResult = { state, changed: new Map(), harvested: 0, evaluated: false };
  if (!state.program.enabled) return unchanged;
  if (now - state.lastEvalAt < state.program.intervalSec * 1000) return unchanged;
  const buffer = { ...state.buffer };
  const changed = new Map<string, TileOverride>();
  let harvested = 0;
  for (const [key, ov] of neighbors) {
    if (!ov.crop || ov.ownerId !== state.ownerId) continue;
    if (ov.crop.readyAt > now) continue;
    const crop = cropById(ov.crop.cropId);
    if (!crop) continue;
    buffer[crop.produceId] = (buffer[crop.produceId] ?? 0) + crop.produceCount;
    harvested += crop.produceCount;
    changed.set(key, { ...ov, crop: null });
  }
  return {
    state: { ...state, buffer, lastEvalAt: now, updatedAt: now },
    changed,
    harvested,
    evaluated: true,
  };
}
