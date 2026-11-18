import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { tileIvsAt, WORLD_COORD_LIMIT } from "@/lib/worldbox/mapgen";
import { cropById, cropBySeedId } from "@/lib/worldbox/items";
import { loadProfile, storeProfile } from "@/lib/worldbox/profile-online";
import { addItem, removeItem, STACK_MAX } from "@/lib/worldbox/profile";
import { listPresence } from "@/lib/worldbox/presence-online";
import { presenceIdFor } from "@/lib/worldbox/presence";
import { parseSave } from "@/lib/worldbox/save";
import { loadWorldBoxSave } from "@/lib/worldbox/save-online";
import { fertilityGrowthFactor, isOverrideActive, parseTileKey, tileKey, type TileOverride } from "@/lib/worldbox/tiles";
import { seasonGrowthMult } from "@/lib/worldbox/seasons";
import { weatherGrowthMult } from "@/lib/worldbox/weather";
import { isTilesEnabled, loadTileOverride, loadTileOverrides, storeTileOverride } from "@/lib/worldbox/tiles-online";
import { canAccessScope } from "@/lib/worldbox/acl";
import { emptyContainer, isContainerItem } from "@/lib/worldbox/containers";
import { loadContainer, storeContainer } from "@/lib/worldbox/containers-online";
import { loadNationsState } from "@/lib/worldbox/nations-online";
import { nationIdForPresenceId } from "@/lib/worldbox/nations";
import { enqueueUnionDiscordEvent } from "@/lib/worldbox/chat-online";
import {
  decodeProgram, defaultProgram, depositSeedToBuffer, encodeProgram, evaluateMachine, isMachineItem,
  MACHINE_ALERT_COOLDOWN_MS, MACHINE_BUFFER_ALERT_THRESHOLD, MACHINE_SENSOR_RADIUS,
  machineBufferCount, parseProgram, transferItemsToSlots, type MachineState,
} from "@/lib/worldbox/machines";
import { isMachinesEnabled, loadMachine, storeMachine } from "@/lib/worldbox/machines-online";
import { withUserLock } from "@/lib/worldbox/user-lock";

export const runtime = "nodejs";

// AGO WORLD BOX の機械（自動収穫機・侵入センサー）。
// 状態は bot_kv（worldbox_machines、キー "x,y"）、設置ブロック（タイル上書き）が
// 所有と存在の正。評価は遅延式: GET/POST のたびに経過分を解決する。
// GET ?x&y: 評価してから状態を返す（所有者のみ中身が見える）。
// POST { action: "set_program" | "apply_code" | "collect" | "deposit_seed" | "ping_sensors", ... }

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const MAX_ACTION_DISTANCE = 2;

function err(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

function checkedCoord(xRaw: unknown, yRaw: unknown): { x: number; y: number } | null {
  if (typeof xRaw !== "number" || typeof yRaw !== "number") return null;
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;
  const x = Math.floor(xRaw);
  const y = Math.floor(yRaw);
  if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return null;
  return { x, y };
}

async function actorWorldPosition(ownerKey: string): Promise<{ x: number; y: number } | null> {
  const selfId = presenceIdFor(ownerKey);
  const entries = await listPresence();
  const now = Date.now();
  const entry = entries.find((e) => e.id === selfId && e.space === "world" && now - e.ts <= 15_000);
  if (entry) return { x: entry.x, y: entry.y };
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (saved && saved.space === "world") return { x: saved.x, y: saved.y };
  return null;
}

async function nearMachine(request: Request, ownerKey: string, x: number, y: number) {
  const pos = await actorWorldPosition(ownerKey);
  if (!pos) return err("position_unknown", 409);
  if (Math.max(Math.abs(Math.floor(pos.x) - x), Math.abs(Math.floor(pos.y) - y)) > MAX_ACTION_DISTANCE) {
    return err("too_far", 409);
  }
  return null;
}

/** 設置ブロックを確認し、装置状態を用意する（無ければ所有者で新規作成）。 */
async function ensureMachine(
  ownerKey: string,
  x: number,
  y: number,
): Promise<{ state: MachineState } | { response: NextResponse }> {
  const ov = await loadTileOverride(x, y);
  const now = Date.now();
  if (!ov || !isOverrideActive(ov, now) || !ov.block || !isMachineItem(ov.block.itemId)) {
    return { response: err("no_machine", 404) };
  }
  const selfId = presenceIdFor(ownerKey);
  if (ov.block.ownerId !== selfId) return { response: err("not_owner", 403) };
  let state = await loadMachine(x, y);
  if (!state) {
    state = { ownerId: selfId, program: defaultProgram(), buffer: {}, lastEvalAt: now, updatedAt: now };
    await storeMachine(x, y, state);
  }
  return { state };
}

/** 遅延評価: 隣接タイルを読み、収穫/種まき/隣接コンテナ搬出/バッファ満杯通知を解決する。 */
async function runEvaluation(x: number, y: number, state: MachineState): Promise<MachineState> {
  const now = Date.now();
  if (!state.program.enabled || now - state.lastEvalAt < state.program.intervalSec * 1000) return state;
  const all = await loadTileOverrides();
  const neighbors = new Map<string, TileOverride>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const key = tileKey(x + dx, y + dy);
      const ov = all[key];
      if (ov && isOverrideActive(ov, now)) neighbors.set(key, ov);
    }
  }
  const result = evaluateMachine(state, neighbors, now, {
    growthDurationMs: (cropId, key) => {
      const def = cropById(cropId);
      if (!def) return 60_000;
      const coord = parseTileKey(key);
      const fertility = coord ? fertilityGrowthFactor(tileIvsAt(coord.x, coord.y).fertility) : 1;
      const seasonMult = seasonGrowthMult(def.season, now);
      const rainMult = weatherGrowthMult(Math.floor(now / 1000));
      return Math.round(def.growthMinutes * 60_000 * seasonMult * fertility * rainMult);
    },
  });
  if (!result.evaluated) return state;
  for (const [key, next] of result.changed) {
    const [tx, ty] = key.split(",").map(Number);
    await storeTileOverride(tx, ty, next);
  }

  let nextState = result.state;
  let movedToChest = 0;
  let nationsState: Awaited<ReturnType<typeof loadNationsState>> | null = null;
  const getNations = async () => {
    if (!nationsState) nationsState = await loadNationsState();
    return nationsState;
  };

  if (nextState.program.autoStore) {
    const hasHarvestToMove = Object.entries(nextState.buffer).some(([id, n]) => !cropBySeedId(id) && n > 0);
    if (hasHarvestToMove) {
      for (const [key, ov] of neighbors) {
        if (!ov.block || !isContainerItem(ov.block.itemId)) continue;
        const coord = parseTileKey(key);
        if (!coord) continue;
        const ns = await getNations();
        const ownerNationId = nationIdForPresenceId(ns, nextState.ownerId);
        const containerOwnerNationId = nationIdForPresenceId(ns, ov.block.ownerId);
        const itemId = ov.block.itemId;
        const blockOwnerId = ov.block.ownerId;
        await withUserLock(`container:world:${coord.x},${coord.y}`, async () => {
          const cur = (await loadContainer("world", coord.x, coord.y, itemId))
            ?? emptyContainer(blockOwnerId, itemId);
          const allowed = canAccessScope(cur.access, {
            actorId: nextState.ownerId,
            ownerId: cur.ownerId,
            actorNationId: ownerNationId,
            ownerNationId: containerOwnerNationId,
          });
          if (!allowed) return;
          const transfer = transferItemsToSlots(cur.slots, nextState.buffer, STACK_MAX);
          if (transfer.moved <= 0) return;
          const saved = await storeContainer("world", coord.x, coord.y, {
            ...cur,
            slots: transfer.slots,
          });
          if (saved) {
            nextState = { ...nextState, buffer: transfer.buffer, updatedAt: now };
            movedToChest += transfer.moved;
          }
        });
        if (!Object.entries(nextState.buffer).some(([id, n]) => !cropBySeedId(id) && n > 0)) break;
      }
    }
  }

  const bufferedAfter = machineBufferCount(nextState);
  const alertDue = result.alertTriggered && bufferedAfter >= MACHINE_BUFFER_ALERT_THRESHOLD;
  if (alertDue) {
    const ns = await getNations();
    const ownerNationId = nationIdForPresenceId(ns, nextState.ownerId);
    nextState = { ...nextState, lastAlertAt: now, updatedAt: now };
    if (ownerNationId) {
      void enqueueUnionDiscordEvent(
        ownerNationId,
        "自動収穫機",
        `(${x}, ${y}) のバッファが満杯です（${bufferedAfter}個）`,
        `m-full-${x}-${y}-${now}`,
      );
    }
  }

  if (result.harvested > 0 || result.replanted > 0 || movedToChest > 0 || alertDue || nextState.lastEvalAt !== state.lastEvalAt) {
    await storeMachine(x, y, nextState);
  }
  return nextState;
}

function publicState(state: MachineState) {
  return {
    program: state.program,
    code: encodeProgram(state.program),
    buffer: state.buffer,
    buffered: machineBufferCount(state),
  };
}

export async function GET(request: Request) {
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isMachinesEnabled() || !isTilesEnabled()) return err("machines_unavailable", 503);
  const url = new URL(request.url);
  if (!url.searchParams.get("x")?.trim() || !url.searchParams.get("y")?.trim()) {
    return err("invalid_coord", 400);
  }
  const coord = checkedCoord(Number(url.searchParams.get("x")), Number(url.searchParams.get("y")));
  if (!coord) return err("invalid_coord", 400);
  const ownerKey = sessionOwnerKey(session);
  const far = await nearMachine(request, ownerKey, coord.x, coord.y);
  if (far) return far;
  const ensured = await ensureMachine(ownerKey, coord.x, coord.y);
  if ("response" in ensured) return ensured.response;
  const state = await runEvaluation(coord.x, coord.y, ensured.state);
  return NextResponse.json({ machine: publicState(state) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return err("forbidden", 403);
  const session = getRequestSession(request);
  if (!session) return err("unauthorized", 401);
  if (!isMachinesEnabled() || !isTilesEnabled()) return err("machines_unavailable", 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("invalid_request", 400);
  }
  const fields = (body ?? {}) as {
    action?: unknown; x?: unknown; y?: unknown;
    program?: unknown; code?: unknown; itemId?: unknown; count?: unknown;
  };
  const ownerKey = sessionOwnerKey(session);

  if (fields.action === "ping_sensors") {
    const pos = await actorWorldPosition(ownerKey);
    if (!pos) return NextResponse.json({ ok: true, alerts: 0 }, { headers: NO_STORE });
    const now = Date.now();
    const selfId = presenceIdFor(ownerKey);
    const px = Math.floor(pos.x);
    const py = Math.floor(pos.y);
    const [allTiles, nationsState] = await Promise.all([loadTileOverrides(), loadNationsState()]);
    const actorNationId = nationIdForPresenceId(nationsState, selfId);
    let alerts = 0;

    for (const [key, ov] of Object.entries(allTiles)) {
      if (!isOverrideActive(ov, now) || !ov.block || !isMachineItem(ov.block.itemId)) continue;
      if (ov.block.ownerId === selfId) continue;
      const coord = parseTileKey(key);
      if (!coord) continue;
      if (Math.max(Math.abs(px - coord.x), Math.abs(py - coord.y)) > MACHINE_SENSOR_RADIUS) continue;
      const ownerNationId = nationIdForPresenceId(nationsState, ov.block.ownerId);
      if (actorNationId && ownerNationId && actorNationId === ownerNationId) continue;

      await withUserLock(`machine:${coord.x},${coord.y}`, async () => {
        const m = await loadMachine(coord.x, coord.y);
        if (!m || !m.program.enabled) return;
        if (m.program.trigger !== "intruder" || m.program.action !== "discord_alert") return;
        if (now - (m.lastAlertAt ?? 0) < MACHINE_ALERT_COOLDOWN_MS) return;
        const nextM: MachineState = { ...m, lastAlertAt: now, updatedAt: now };
        if (await storeMachine(coord.x, coord.y, nextM)) {
          alerts += 1;
          if (ownerNationId) {
            void enqueueUnionDiscordEvent(
              ownerNationId,
              "侵入センサー",
              `${session.username || "誰か"} が (${coord.x}, ${coord.y}) 付近に接近`,
              `m-intr-${coord.x}-${coord.y}-${now}`,
            );
          }
        }
      });
    }
    return NextResponse.json({ ok: true, alerts }, { headers: NO_STORE });
  }

  if ((typeof fields.x === "string" && !fields.x.trim()) || (typeof fields.y === "string" && !fields.y.trim())) {
    return err("invalid_coord", 400);
  }
  const coord = checkedCoord(
    typeof fields.x === "number" ? fields.x : Number(fields.x),
    typeof fields.y === "number" ? fields.y : Number(fields.y),
  );
  if (!coord) return err("invalid_coord", 400);
  const far = await nearMachine(request, ownerKey, coord.x, coord.y);
  if (far) return far;

  return withUserLock(`machine:${coord.x},${coord.y}`, async () => {
    const ensured = await ensureMachine(ownerKey, coord.x, coord.y);
    if ("response" in ensured) return ensured.response;
    let state = await runEvaluation(coord.x, coord.y, ensured.state);
    const now = Date.now();

    if (fields.action === "set_program") {
      state = { ...state, program: parseProgram(fields.program), updatedAt: now };
      await storeMachine(coord.x, coord.y, state);
      return NextResponse.json({ machine: publicState(state) }, { headers: NO_STORE });
    }
    if (fields.action === "apply_code") {
      const program = decodeProgram(fields.code);
      if (!program) return err("bad_code", 400);
      state = { ...state, program, updatedAt: now };
      await storeMachine(coord.x, coord.y, state);
      return NextResponse.json({ machine: publicState(state) }, { headers: NO_STORE });
    }
    if (fields.action === "deposit_seed") {
      const crop = cropBySeedId(fields.itemId);
      if (!crop) return err("unknown_seed", 400);
      const count = typeof fields.count === "number" && Number.isFinite(fields.count) ? Math.floor(fields.count) : 1;
      if (count < 1 || count > 99) return err("invalid_count", 400);
      return withUserLock(ownerKey, async () => {
        const profile = await loadProfile(ownerKey);
        const nextProfile = removeItem(profile, crop.seedId, count);
        if (!nextProfile) return err("not_enough_items", 409);
        if (!(await storeProfile(ownerKey, nextProfile))) return err("store_failed", 503);
        const nextMachine = depositSeedToBuffer(state, crop.seedId, count, now);
        if (!nextMachine) {
          await storeProfile(ownerKey, profile);
          return err("unknown_seed", 400);
        }
        state = nextMachine;
        if (!(await storeMachine(coord.x, coord.y, state))) {
          await storeProfile(ownerKey, profile);
          return err("machines_failed", 500);
        }
        return NextResponse.json({ machine: publicState(state), profile: nextProfile }, { headers: NO_STORE });
      });
    }
    if (fields.action === "collect") {
      if (machineBufferCount(state) <= 0) return err("empty", 409);
      return withUserLock(ownerKey, async () => {
        let profile = await loadProfile(ownerKey);
        const before = profile;
        for (const [itemId, count] of Object.entries(state.buffer)) {
          profile = addItem(profile, itemId, count);
        }
        if (!(await storeProfile(ownerKey, profile))) return err("store_failed", 503);
        state = { ...state, buffer: {}, updatedAt: now };
        if (!(await storeMachine(coord.x, coord.y, state))) {
          await storeProfile(ownerKey, before);
          return err("machines_failed", 500);
        }
        return NextResponse.json({ machine: publicState(state), profile }, { headers: NO_STORE });
      });
    }
    return err("invalid_action", 400);
  });
}
