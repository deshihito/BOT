// 戦艦ゲーム（バトルシップ）: 10x10 盤面に艦隊を配置し、交互に1発ずつ撃ち合う2人対戦。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type BattleshipShip = { cells: number[]; sunk: boolean };
export type BattleshipFleet = { ships: BattleshipShip[]; ready: boolean };
export type BattleshipShot = { index: number; result: "hit" | "miss" };
export type BattleshipPhase = "placing" | "battle" | "finished";

export interface BattleshipState {
  players: SeatInfo[];
  phase: BattleshipPhase;
  fleets: [BattleshipFleet, BattleshipFleet];
  shots: [BattleshipShot[], BattleshipShot[]];
  turn: number;
  winner: number | null;
  lastShot: { seat: number; index: number; result: "hit" | "miss" } | null;
}

export type BattleshipAction =
  | { type: "placeShips"; ships: number[][] }
  | { type: "fire"; index: number };

export interface BattleshipView {
  phase: BattleshipPhase;
  turn: number;
  winner: number | null;
  lastShot: { seat: number; index: number; result: "hit" | "miss" } | null;
  you: {
    ships: BattleshipShip[];
    incoming: BattleshipShot[];
  };
  opponent: {
    shots: BattleshipShot[];
    sunkShips: number[][];
    afloatCount: number;
  };
  players: SeatInfo[];
}

const BOARD_SIZE = 100;
const FLEET_SIZES = [5, 4, 3, 3, 2];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateShips(ships: number[][]): void {
  if (!Array.isArray(ships) || ships.length !== FLEET_SIZES.length) {
    throw new Error("艦はちょうど5隻配置してください");
  }
  const sizes = ships.map((s) => (Array.isArray(s) ? s.length : 0)).sort((a, b) => a - b);
  const expected = [...FLEET_SIZES].sort((a, b) => a - b);
  if (sizes.some((v, i) => v !== expected[i])) {
    throw new Error("艦のサイズ構成が正しくありません（5・4・3・3・2）");
  }
  const seen = new Set<number>();
  for (const ship of ships) {
    if (!Array.isArray(ship) || ship.length === 0) {
      throw new Error("艦の配置が不正です");
    }
    for (const cell of ship) {
      if (!Number.isInteger(cell) || cell < 0 || cell >= BOARD_SIZE) {
        throw new Error("盤面の範囲外に艦は配置できません");
      }
      if (seen.has(cell)) {
        throw new Error("艦同士が重なっています");
      }
      seen.add(cell);
    }
    const rows = ship.map((c) => Math.floor(c / 10));
    const cols = ship.map((c) => c % 10);
    const sameRow = rows.every((r) => r === rows[0]);
    const sameCol = cols.every((c) => c === cols[0]);
    if (!sameRow && !sameCol) {
      throw new Error("艦は縦か横の一直線に配置してください");
    }
    const line = (sameRow ? cols : rows).slice().sort((a, b) => a - b);
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== line[0] + i) {
        throw new Error("艦は連続したマスに配置してください");
      }
    }
  }
}

function createState(
  players: SeatInfo[],
  rng: Rng,
  options: Record<string, unknown>,
): BattleshipState {
  void rng;
  void options;
  if (!Array.isArray(players) || players.length !== 2) {
    throw new Error("戦艦ゲームは2人専用です");
  }
  return {
    players: clone(players),
    phase: "placing",
    fleets: [
      { ships: [], ready: false },
      { ships: [], ready: false },
    ],
    shots: [[], []],
    turn: 0,
    winner: null,
    lastShot: null,
  };
}

function applyAction(
  state: BattleshipState,
  seat: number,
  action: BattleshipAction,
  rng: Rng,
): BattleshipState {
  void rng;
  if (seat !== 0 && seat !== 1) {
    throw new Error("不正な席です");
  }
  if (state.phase === "finished") {
    throw new Error("ゲームは終了しています");
  }
  if (!action || typeof action !== "object") {
    throw new Error("不正なアクションです");
  }

  if (action.type === "placeShips") {
    if (state.phase !== "placing") {
      throw new Error("配置フェーズではありません");
    }
    if (state.fleets[seat].ready) {
      throw new Error("既に配置済みです");
    }
    validateShips(action.ships);
    const next = clone(state);
    next.fleets[seat] = {
      ships: action.ships.map((cells) => ({ cells: [...cells], sunk: false })),
      ready: true,
    };
    if (next.fleets[0].ready && next.fleets[1].ready) {
      next.phase = "battle";
      next.turn = 0;
    }
    return next;
  }

  if (action.type === "fire") {
    if (state.phase !== "battle") {
      throw new Error("攻撃フェーズではありません");
    }
    if (seat !== state.turn) {
      throw new Error("手番ではありません");
    }
    const index = action.index;
    if (!Number.isInteger(index) || index < 0 || index >= BOARD_SIZE) {
      throw new Error("盤面の範囲外は攻撃できません");
    }
    if (state.shots[seat].some((s) => s.index === index)) {
      throw new Error("既に攻撃したマスです");
    }
    const foe = 1 - seat;
    const result: "hit" | "miss" = state.fleets[foe].ships.some((ship) =>
      ship.cells.includes(index),
    )
      ? "hit"
      : "miss";
    const next = clone(state);
    next.shots[seat].push({ index, result });
    const hitCells = new Set(next.shots[seat].filter((s) => s.result === "hit").map((s) => s.index));
    for (const ship of next.fleets[foe].ships) {
      ship.sunk = ship.cells.every((c) => hitCells.has(c));
    }
    next.lastShot = { seat, index, result };
    if (next.fleets[foe].ships.every((ship) => ship.sunk)) {
      next.phase = "finished";
      next.winner = seat;
    } else {
      next.turn = foe;
    }
    return next;
  }

  throw new Error("不正なアクションです");
}

function viewFor(state: BattleshipState, seat: number): BattleshipView {
  const foe = 1 - seat;
  const myFleet = state.fleets[seat];
  const foeFleet = state.fleets[foe];
  return {
    phase: state.phase,
    turn: state.turn,
    winner: state.winner,
    lastShot: state.lastShot ? { ...state.lastShot } : null,
    you: {
      ships: myFleet.ships.map((s) => ({ cells: [...s.cells], sunk: s.sunk })),
      incoming: state.shots[foe].map((s) => ({ ...s })),
    },
    opponent: {
      shots: state.shots[seat].map((s) => ({ ...s })),
      sunkShips: foeFleet.ships.filter((s) => s.sunk).map((s) => [...s.cells]),
      afloatCount: foeFleet.ships.filter((s) => !s.sunk).length,
    },
    players: clone(state.players),
  };
}

function parseAction(raw: unknown): BattleshipAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "placeShips") {
    if (!Array.isArray(r.ships)) return null;
    const ships: number[][] = [];
    for (const ship of r.ships) {
      if (!Array.isArray(ship)) return null;
      const cells: number[] = [];
      for (const c of ship) {
        if (typeof c !== "number") return null;
        cells.push(c);
      }
      ships.push(cells);
    }
    return { type: "placeShips", ships };
  }
  if (r.type === "fire") {
    if (typeof r.index !== "number") return null;
    return { type: "fire", index: r.index };
  }
  return null;
}

function onPlayerLeft(state: BattleshipState, seat: number): BattleshipState {
  if (seat !== 0 && seat !== 1) {
    throw new Error("不正な席です");
  }
  if (state.phase === "finished") return clone(state);
  const next = clone(state);
  next.phase = "finished";
  next.winner = 1 - seat;
  return next;
}

export const gameModule: OnlineGameModule<BattleshipState, BattleshipAction, BattleshipView> = {
  id: "battleship",
  title: "戦艦ゲーム",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state) => state.phase,
  isFinished: (state) => state.phase === "finished",
  onPlayerLeft,
};
