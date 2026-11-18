// AGO WORLD BOX の機械基盤（バッチ10a + Phase 1 自動化拡張）。
// 統一されたアイテム/ブロック構造の上に載る「プログラム可能な装置」の土台。
// 装置 = 設置ブロック（facility）に紐づく DeviceProgram（トリガー+動作+
// パラメータ）と、その実行状態（バッファ等）。プログラムは共有コードとして
// 書き出し/読み込みでき、他人の作った装置設定をそのまま使える（共有基盤）。
// 評価は遅延式（読み取り/操作のタイミングで経過分を解決する）で、
// サーバー側の常駐ループは持たない。

import { cropById, cropBySeedId } from "./items";
import type { TileOverride } from "./tiles";

/** 装置として扱う施設アイテム。 */
export const MACHINE_ITEM_ID = "auto_harvester";
export function isMachineItem(itemId: string): boolean {
  return itemId === MACHINE_ITEM_ID;
}

export type DeviceTrigger = "mature" | "intruder" | "buffer_full";
export type DeviceAction = "harvest" | "harvest_replant" | "discord_alert";

export const DEVICE_TRIGGERS: readonly DeviceTrigger[] = ["mature", "intruder", "buffer_full"];
export const DEVICE_ACTIONS: readonly DeviceAction[] = ["harvest", "harvest_replant", "discord_alert"];

export const MACHINE_SENSOR_RADIUS = 4;
export const MACHINE_ALERT_COOLDOWN_MS = 300_000;
export const MACHINE_BUFFER_ALERT_THRESHOLD = 20;

export interface DeviceProgram {
  version: 1;
  trigger: DeviceTrigger;
  action: DeviceAction;
  /** 評価の最小間隔（秒）。これより細かくは動かない。 */
  intervalSec: number;
  enabled: boolean;
  /** true のとき、隣接するアクセス可能なコンテナへ収穫物を自動で移す。 */
  autoStore: boolean;
}

export const DEVICE_INTERVAL_CHOICES: readonly number[] = [30, 60, 300];

export function defaultProgram(): DeviceProgram {
  return {
    version: 1,
    trigger: "mature",
    action: "harvest",
    intervalSec: 60,
    enabled: true,
    autoStore: false,
  };
}

export function parseProgram(raw: unknown): DeviceProgram {
  const base = defaultProgram();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const v = raw as Record<string, unknown>;
  const trigger: DeviceTrigger =
    v.trigger === "mature" || v.trigger === "intruder" || v.trigger === "buffer_full"
      ? v.trigger
      : base.trigger;
  const action: DeviceAction =
    v.action === "harvest" || v.action === "harvest_replant" || v.action === "discord_alert"
      ? v.action
      : base.action;
  return {
    version: 1,
    trigger,
    action,
    intervalSec: DEVICE_INTERVAL_CHOICES.includes(v.intervalSec as number)
      ? (v.intervalSec as number)
      : base.intervalSec,
    enabled: v.enabled !== false,
    autoStore: v.autoStore === true,
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
  { id: "replant", name: "自動種まき", program: { ...defaultProgram(), action: "harvest_replant" } },
  { id: "chest", name: "箱へ自動収納", program: { ...defaultProgram(), action: "harvest_replant", autoStore: true } },
  { id: "sentinel", name: "侵入警戒通知", program: { ...defaultProgram(), trigger: "intruder", action: "discord_alert", intervalSec: 60 } },
  { id: "buffer_alert", name: "満杯通知", program: { ...defaultProgram(), trigger: "buffer_full", action: "discord_alert", intervalSec: 300 } },
];

export interface MachineState {
  /** 設置者の不透明 ID（presenceId 形式）。 */
  ownerId: string;
  program: DeviceProgram;
  /** 収穫済みで未回収の作物・補充された種。 */
  buffer: Record<string, number>;
  lastEvalAt: number;
  updatedAt: number;
  /** 直近の Discord 通知時刻（クールダウン判定用）。 */
  lastAlertAt?: number;
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
  const out: MachineState = {
    ownerId: v.ownerId,
    program: parseProgram(v.program),
    buffer,
    lastEvalAt: typeof v.lastEvalAt === "number" && Number.isFinite(v.lastEvalAt) ? v.lastEvalAt : 0,
    updatedAt: typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) ? v.updatedAt : 0,
  };
  if (typeof v.lastAlertAt === "number" && Number.isFinite(v.lastAlertAt) && v.lastAlertAt > 0) {
    out.lastAlertAt = v.lastAlertAt;
  }
  return out;
}

export function machineBufferCount(state: MachineState): number {
  return Object.values(state.buffer).reduce((sum, n) => sum + n, 0);
}

/** 装置のバッファへ種を補充する（再植用）。種以外・0以下なら null。 */
export function depositSeedToBuffer(
  state: MachineState,
  seedId: unknown,
  countRaw: unknown,
  now: number,
): MachineState | null {
  if (typeof seedId !== "string" || !cropBySeedId(seedId)) return null;
  if (typeof countRaw !== "number" || !Number.isFinite(countRaw)) return null;
  const count = Math.floor(countRaw);
  if (count <= 0 || count > 99) return null;
  const buffer = { ...state.buffer, [seedId]: (state.buffer[seedId] ?? 0) + count };
  return { ...state, buffer, updatedAt: now };
}

/**
 * 装置バッファ内の作物（種以外）をコンテナ等のスロット列へ詰める（純粋関数）。
 * 戻り値は更新後のスロット列・残バッファ・移動個数。
 */
export function transferItemsToSlots(
  slotsIn: readonly ({ id: string; count: number } | null)[],
  bufferIn: Readonly<Record<string, number>>,
  stackMax = 99,
): { slots: ({ id: string; count: number } | null)[]; buffer: Record<string, number>; moved: number } {
  const slots: ({ id: string; count: number } | null)[] = slotsIn.map((s) => (s ? { ...s } : null));
  const buffer: Record<string, number> = { ...bufferIn };
  let moved = 0;
  for (const [itemId, countRaw] of Object.entries(buffer)) {
    if (cropBySeedId(itemId)) continue; // 補充した種は再植用に残す
    let remain = Math.floor(countRaw);
    if (remain <= 0) {
      delete buffer[itemId];
      continue;
    }
    // 1) 同種の既存スタックへ積む
    for (let i = 0; i < slots.length && remain > 0; i++) {
      const s = slots[i];
      if (!s || s.id !== itemId || s.count >= stackMax) continue;
      const take = Math.min(remain, stackMax - s.count);
      slots[i] = { id: itemId, count: s.count + take };
      remain -= take;
      moved += take;
    }
    // 2) 空き枠へ新規配置
    for (let i = 0; i < slots.length && remain > 0; i++) {
      if (slots[i] !== null) continue;
      const take = Math.min(remain, stackMax);
      slots[i] = { id: itemId, count: take };
      remain -= take;
      moved += take;
    }
    if (remain > 0) buffer[itemId] = remain;
    else delete buffer[itemId];
  }
  return { slots, buffer, moved };
}

export interface MachineEvalResult {
  state: MachineState;
  /** 変更が必要な隣接タイル（キー → 新しい上書き）。 */
  changed: Map<string, TileOverride>;
  /** 今回収穫した数。 */
  harvested: number;
  /** 今回自動で植え直した数。 */
  replanted: number;
  /** 通知トリガーが発火したか（クールダウン確認後、呼び出し側で送信）。 */
  alertTriggered: boolean;
  /** 評価が走ったか（間隔未満なら false で状態は不変）。 */
  evaluated: boolean;
}

/**
 * 装置を評価する。neighbors は装置タイルの周囲8タイルの上書き（キー付き）。
 * trigger="mature" かつ action="harvest"|"harvest_replant" のとき、育ち切った
 * 自分の作物を収穫してバッファへ移す。action="harvest_replant" かつバッファに
 * 対応する種があれば即座に植え直す。
 */
export function evaluateMachine(
  state: MachineState,
  neighbors: ReadonlyMap<string, TileOverride>,
  now: number,
  options?: { growthDurationMs?: (cropId: string, tileKey: string) => number },
): MachineEvalResult {
  const unchanged: MachineEvalResult = {
    state,
    changed: new Map(),
    harvested: 0,
    replanted: 0,
    alertTriggered: false,
    evaluated: false,
  };
  if (!state.program.enabled) return unchanged;
  if (now - state.lastEvalAt < state.program.intervalSec * 1000) return unchanged;

  const buffer = { ...state.buffer };
  const changed = new Map<string, TileOverride>();
  let harvested = 0;
  let replanted = 0;

  if (
    state.program.trigger === "mature" &&
    (state.program.action === "harvest" || state.program.action === "harvest_replant")
  ) {
    for (const [key, ov] of neighbors) {
      if (!ov.crop || ov.ownerId !== state.ownerId) continue;
      if (ov.crop.readyAt > now) continue;
      const crop = cropById(ov.crop.cropId);
      if (!crop) continue;
      buffer[crop.produceId] = (buffer[crop.produceId] ?? 0) + crop.produceCount;
      harvested += crop.produceCount;
      if (state.program.action === "harvest_replant" && (buffer[crop.seedId] ?? 0) >= 1) {
        const left = buffer[crop.seedId] - 1;
        if (left > 0) buffer[crop.seedId] = left;
        else delete buffer[crop.seedId];
        const duration = options?.growthDurationMs?.(crop.id, key) ?? crop.growthMinutes * 60_000;
        changed.set(key, {
          ...ov,
          crop: { cropId: crop.id, plantedAt: now, readyAt: now + duration },
        });
        replanted += 1;
      } else {
        changed.set(key, { ...ov, crop: null });
      }
    }
  }

  const nextState: MachineState = { ...state, buffer, lastEvalAt: now, updatedAt: now };
  const alertTriggered =
    state.program.trigger === "buffer_full" &&
    state.program.action === "discord_alert" &&
    machineBufferCount(nextState) >= MACHINE_BUFFER_ALERT_THRESHOLD &&
    now - (state.lastAlertAt ?? 0) >= MACHINE_ALERT_COOLDOWN_MS;

  return {
    state: nextState,
    changed,
    harvested,
    replanted,
    alertTriggered,
    evaluated: true,
  };
}
