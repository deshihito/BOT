// AGO WORLD BOX の闘技場PvP（対人戦、バッチ7c）。
// 闘技場PvE（arena.ts）と同じ決済の型: マッチング待ち行列で2人を組み合わせ、
// 両者の参加費を spend（arena_pvp_entry）で先払いし、done 確認後に交互ターン
// の決闘を始める。勝者は賞金 earn（arena_pvp_prize、Plan A の原資ルール内）。
// 賞金は決定的 ID で冪等に積む（再試行・再処理でも1試合1件だけ）。
// このファイルは純粋ロジックのみ（乱数は注入する）。

/** 参加費。PvE の階級と同じ 2.4 倍の賞金比にする。 */
export const PVP_FEE = 100;
/** 勝者の賞金（参加費の 2.4 倍。PvE の slime 120/50・golem 720/300 と同率）。 */
export const PVP_PRIZE = 240;
/** 決闘中の HP（両者共通）。 */
export const PVP_PLAYER_HP = 100;
/** マッチング待ちの有効期限。これを過ぎた待ちは無効（参加費はまだ払っていない）。 */
export const PVP_QUEUE_TTL_MS = 5 * 60 * 1000;
/** 決闘の有効期限。これを過ぎた決闘は無効（参加費は戻らない、PvE と同じ）。 */
export const PVP_DUEL_TTL_MS = 10 * 60 * 1000;
/** 決闘ログの保持件数。 */
export const PVP_MAX_LOG = 6;

export type PvpMove = "attack" | "heavy" | "guard";

export interface PvpPlayer {
  ownerKey: string;
  discordId: string;
  /** 剣の腕前（playerAttack と同じ式で route 側が算出）。 */
  attack: number;
}

export interface PvpQueueEntry {
  ownerKey: string;
  discordId: string;
  attack: number;
  queuedAt: number;
}

export interface PvpDuel {
  kind: "pvp";
  /** `pvp-<先に並んだ側>-<後に並んだ側>-<開始ms>`。 */
  id: string;
  /** 経済オプ ID 用の短縮コード（`<a末6>-<b末6>-<開始ms>`）。 */
  code: string;
  players: [PvpPlayer, PvpPlayer];
  hp: [number, number];
  /** 次の被ダメージを半減させるか（まもる）。 */
  guarding: [boolean, boolean];
  /** 次に手を打つ側の添字。 */
  turn: 0 | 1;
  turnNo: number;
  /** paying = 参加費の spend オプ適用待ち。fighting = 決闘中。 */
  state: "paying" | "fighting";
  feeOpIds: [string, string];
  startedAt: number;
  /** 直近の経過（新しい順、最大6件）。 */
  log: string[];
  /**
   * 大会の対戦のときだけ付く。大会の対戦は参加費に含まれ、試合ごとの
   * 参加費・賞金は無い（決闘は fighting から始まり、賞金は優勝時に
   * 大会側が払う）。決着は pvp ルートが大会へ返す。
   */
  tournament?: { tournamentId: string; matchId: string };
}

export interface PvpStepResult {
  duel: PvpDuel;
  /** 決着したときの勝者の添字。 */
  winner: 0 | 1 | null;
  events: string[];
}

export function pvpDuelId(aDiscordId: string, bDiscordId: string, now: number): string {
  return `pvp-${aDiscordId}-${bDiscordId}-${now}`;
}

export function pvpDuelCode(aDiscordId: string, bDiscordId: string, now: number): string {
  return `${aDiscordId.slice(-6)}-${bDiscordId.slice(-6)}-${now}`;
}

/** 参加費オプの決定的 ID（1試合・1人1件）。 */
export function pvpFeeOpId(code: string, discordId: string): string {
  return `pvp-fee-${code}-${discordId}`;
}

/** 賞金オプの決定的 ID（1試合1件）。 */
export function pvpPrizeOpId(code: string): string {
  return `pvp-prize-${code}`;
}

/**
 * 参加費の返金オプの決定的 ID（決闘が不成立のときに1人1件。B3）。
 * 末尾は Discord ID の末6桁だけにする（code に両者の末6桁と開始msが
 * 入っているため1試合・1人で一意。フル ID だと OP_ID_RE の64文字を
 * 超えうる）。
 */
export function pvpFeeRefundOpId(code: string, discordId: string): string {
  return `pvp-fee-refund-${code}-${discordId.slice(-6)}`;
}

/** 期限切れの待ちを落とす（先着順は保つ）。 */
export function pruneQueue(queue: readonly PvpQueueEntry[], now: number): PvpQueueEntry[] {
  return queue.filter((e) => now - e.queuedAt <= PVP_QUEUE_TTL_MS);
}

/** 待ち行列の先頭2人を組み合わせる。2人未満なら null。 */
export function tryMatch(
  queue: readonly PvpQueueEntry[],
  now: number,
): { pair: [PvpQueueEntry, PvpQueueEntry]; rest: PvpQueueEntry[] } | null {
  const live = pruneQueue(queue, now);
  if (live.length < 2) return null;
  return { pair: [live[0], live[1]], rest: live.slice(2) };
}

/** 2人の決闘を作る（参加費は route 側が feeOpIds で先払いする）。 */
export function createDuel(a: PvpQueueEntry, b: PvpQueueEntry, now: number): PvpDuel {
  const code = pvpDuelCode(a.discordId, b.discordId, now);
  return {
    kind: "pvp",
    id: pvpDuelId(a.discordId, b.discordId, now),
    code,
    players: [
      { ownerKey: a.ownerKey, discordId: a.discordId, attack: a.attack },
      { ownerKey: b.ownerKey, discordId: b.discordId, attack: b.attack },
    ],
    hp: [PVP_PLAYER_HP, PVP_PLAYER_HP],
    guarding: [false, false],
    turn: 0,
    turnNo: 0,
    state: "paying",
    feeOpIds: [pvpFeeOpId(code, a.discordId), pvpFeeOpId(code, b.discordId)],
    startedAt: now,
    log: [],
  };
}

/** 大会の対戦を作る（参加費は大会の参加時に払い済みのため fighting から始める）。 */
export function createTournamentDuel(
  a: PvpQueueEntry, b: PvpQueueEntry, now: number,
  tournamentId: string, matchId: string,
): PvpDuel {
  const duel = createDuel(a, b, now);
  return { ...duel, state: "fighting", tournament: { tournamentId, matchId } };
}

export function duelExpired(duel: PvpDuel, now: number): boolean {
  return now - duel.startedAt > PVP_DUEL_TTL_MS;
}

function dmg(base: number, rng: () => number): number {
  return Math.max(1, Math.round(base * (0.85 + rng() * 0.3)));
}

/**
 * 1手進める。手番でない側の手は ok:false で返す（決闘は変えない）。
 * まもるは次の被ダメージを半減させ、攻撃は相手の手番へ渡す。
 * PvE（arenaStep）と違い、反撃は無い（相手の手で殴り返す）。
 */
export function pvpStep(
  duel: PvpDuel,
  mover: 0 | 1,
  move: PvpMove,
  rng: () => number,
): { ok: true; result: PvpStepResult } | { ok: false; error: "not_your_turn" } {
  if (mover !== duel.turn) return { ok: false, error: "not_your_turn" };
  const foe = (1 - mover) as 0 | 1;
  const d: PvpDuel = {
    ...duel,
    hp: [...duel.hp] as [number, number],
    guarding: [...duel.guarding] as [boolean, boolean],
    turnNo: duel.turnNo + 1,
  };
  const events: string[] = [];
  if (move === "guard") {
    d.guarding[mover] = true;
    events.push("身を守った");
  } else {
    const hitChance = move === "heavy" ? 0.6 : 0.85;
    if (rng() < hitChance) {
      let dealt = dmg(duel.players[mover].attack * (move === "heavy" ? 1.9 : 1), rng);
      if (d.guarding[foe]) {
        dealt = Math.max(1, Math.round(dealt * 0.5));
        d.guarding[foe] = false;
      }
      d.hp[foe] = Math.max(0, d.hp[foe] - dealt);
      events.push(`${move === "heavy" ? "強攻撃" : "攻撃"} ${dealt}`);
    } else {
      events.push("外れた");
    }
  }
  if (d.hp[foe] <= 0) {
    return { ok: true, result: { duel: d, winner: mover, events } };
  }
  d.turn = foe;
  return { ok: true, result: { duel: d, winner: null, events } };
}

/** クライアントへ出す決闘表示（相手の Discord ID は出さない）。 */
export function publicPvpView(duel: PvpDuel, viewerDiscordId: string) {
  const you = duel.players[0].discordId === viewerDiscordId ? 0 : 1;
  const foe = (1 - you) as 0 | 1;
  return {
    state: duel.state,
    yourHp: duel.hp[you],
    yourHpMax: PVP_PLAYER_HP,
    opponentHp: duel.hp[foe],
    opponentHpMax: PVP_PLAYER_HP,
    yourTurn: duel.turn === you,
    turnNo: duel.turnNo,
    fee: duel.tournament ? 0 : PVP_FEE,
    prize: duel.tournament ? 0 : PVP_PRIZE,
    log: duel.log,
  };
}

/** 保存→復元の往復で形を検証する（壊れた値は null）。 */
export function parsePvpDuel(raw: unknown): PvpDuel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (v.kind !== "pvp" || typeof v.id !== "string" || typeof v.code !== "string") return null;
  if (!Array.isArray(v.players) || v.players.length !== 2) return null;
  if (!Array.isArray(v.hp) || v.hp.length !== 2) return null;
  if (!Array.isArray(v.guarding) || v.guarding.length !== 2) return null;
  if (v.turn !== 0 && v.turn !== 1) return null;
  if (v.state !== "paying" && v.state !== "fighting") return null;
  if (!Array.isArray(v.feeOpIds) || v.feeOpIds.length !== 2) return null;
  if (v.tournament !== undefined) {
    if (typeof v.tournament !== "object" || v.tournament === null) return null;
    const t = v.tournament as Record<string, unknown>;
    if (typeof t.tournamentId !== "string" || typeof t.matchId !== "string") return null;
  }
  if (typeof v.startedAt !== "number" || typeof v.turnNo !== "number") return null;
  if (!Array.isArray(v.log)) return null;
  for (const p of v.players as unknown[]) {
    if (typeof p !== "object" || p === null) return null;
    const q = p as Record<string, unknown>;
    if (typeof q.ownerKey !== "string" || typeof q.discordId !== "string" || typeof q.attack !== "number") return null;
  }
  return v as unknown as PvpDuel;
}

/** 待ち行列の保存形を検証する（壊れた値は落とす）。 */
export function parsePvpQueue(raw: unknown): PvpQueueEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PvpQueueEntry[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.ownerKey !== "string" || typeof v.discordId !== "string") continue;
    if (typeof v.attack !== "number" || typeof v.queuedAt !== "number") continue;
    out.push({ ownerKey: v.ownerKey, discordId: v.discordId, attack: v.attack, queuedAt: v.queuedAt });
  }
  return out;
}
