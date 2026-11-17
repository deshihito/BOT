// AGO WORLD BOX 競馬の永続化と精算（bot_kv の worldbox_racing 名前空間）。
// レースそのもの（出走表・着順・オッズ）は racing.ts の決定的ロジックで
// いつでも再計算できるため、ここに保存するのは「馬券」と「人気集計」と
// 「オッズのキャッシュ」だけ。
// お金の移動は経済ブリッジのオプ経由のみ（Web が残高を直接動かさない）:
// - 購入: spend オプ race-bet-<betId>（先払い、理由 horse_racing_bet）
// - 的中: gamble オプ race-settle-<betId>（prepaid、理由 horse_racing）
// 精算は GET のたびに自分の分だけ遅延実行する。先払いが done の馬券だけを
// 精算し、failed の馬券は無効（お金は動いていない）、pending は次回に回す。
import { kvGet, kvSet } from "../bot-api";
import { findEconomyOp } from "./economy-bridge-online";
import {
  generateRaceCore, estimateOdds, payoutFor, RACE_DURATION_MS,
  type HorseOdds,
} from "./racing";

export const RACING_NAMESPACE = "worldbox_racing";

export type RaceBetType = "win" | "place";
export type BetSettleState = "open" | "settled" | "void";

export interface RaceBet {
  betId: string;
  postMs: number;
  horseId: number;
  type: RaceBetType;
  amount: number;
  oddsWin: number;
  oddsPlace: number;
  spendOpId: string;
  settle: BetSettleState;
  /** 精算結果（settled のとき）: 払戻額。0 はハズレ。 */
  payout: number | null;
  createdAt: number;
}

interface PopularityRow {
  horseId: number;
  type: RaceBetType;
  amount: number;
}

const MYBETS_KEEP = 60;

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cleanBet(value: unknown): RaceBet | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.betId !== "string" || typeof v.postMs !== "number") return null;
  if (typeof v.horseId !== "number" || (v.type !== "win" && v.type !== "place")) return null;
  if (typeof v.amount !== "number" || typeof v.spendOpId !== "string") return null;
  return {
    betId: v.betId,
    postMs: v.postMs,
    horseId: v.horseId,
    type: v.type,
    amount: v.amount,
    oddsWin: typeof v.oddsWin === "number" ? v.oddsWin : 0,
    oddsPlace: typeof v.oddsPlace === "number" ? v.oddsPlace : 0,
    spendOpId: v.spendOpId,
    settle: v.settle === "settled" || v.settle === "void" ? v.settle : "open",
    payout: typeof v.payout === "number" ? v.payout : null,
    createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
  };
}

export async function loadMyBets(ownerKey: string): Promise<RaceBet[]> {
  try {
    const raw = parseJson(await kvGet(RACING_NAMESPACE, `mybets:${ownerKey}`));
    if (!Array.isArray(raw)) return [];
    return raw.map(cleanBet).filter((b): b is RaceBet => b !== null);
  } catch {
    return [];
  }
}

export async function saveMyBets(ownerKey: string, bets: RaceBet[]): Promise<void> {
  const trimmed = [...bets].sort((a, b) => b.createdAt - a.createdAt).slice(0, MYBETS_KEEP);
  await kvSet(RACING_NAMESPACE, `mybets:${ownerKey}`, JSON.stringify(trimmed));
}

export async function loadPopularity(postMs: number): Promise<PopularityRow[]> {
  try {
    const raw = parseJson(await kvGet(RACING_NAMESPACE, `bets:${postMs}`));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is PopularityRow =>
        !!r && typeof r === "object" &&
        typeof (r as PopularityRow).horseId === "number" &&
        ((r as PopularityRow).type === "win" || (r as PopularityRow).type === "place") &&
        typeof (r as PopularityRow).amount === "number",
    );
  } catch {
    return [];
  }
}

export async function appendPopularity(postMs: number, row: PopularityRow): Promise<void> {
  const rows = await loadPopularity(postMs);
  rows.push(row);
  await kvSet(RACING_NAMESPACE, `bets:${postMs}`, JSON.stringify(rows));
}

/** 人気集計: 馬ごとの単勝/複勝の票数（実プレイヤーの馬券だけ。NPC はいない）。 */
export function popularityCounts(rows: readonly PopularityRow[]): Map<number, { win: number; place: number }> {
  const map = new Map<number, { win: number; place: number }>();
  for (const r of rows) {
    const cur = map.get(r.horseId) ?? { win: 0, place: 0 };
    cur[r.type] += 1;
    map.set(r.horseId, cur);
  }
  return map;
}

/** オッズはレース生成時に1回だけ推定してキャッシュする（仕様 §8）。 */
export async function loadOrEstimateOdds(postMs: number): Promise<Record<number, HorseOdds>> {
  try {
    const raw = parseJson(await kvGet(RACING_NAMESPACE, `odds:${postMs}`));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: Record<number, HorseOdds> = {};
      let ok = true;
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const o = v as { win?: unknown; place?: unknown };
        if (typeof o?.win !== "number" || typeof o?.place !== "number") { ok = false; break; }
        out[Number(k)] = { win: o.win, place: o.place };
      }
      if (ok && Object.keys(out).length > 0) return out;
    }
  } catch {
    // 読めなければ推定し直す（決定的なので同じ値になる）。
  }
  const odds = estimateOdds(generateRaceCore(postMs));
  try {
    await kvSet(RACING_NAMESPACE, `odds:${postMs}`, JSON.stringify(odds));
  } catch {
    // キャッシュ保存の失敗は致命的ではない（次回また推定する）。
  }
  return odds;
}

/**
 * 終了したレースの自分の馬券を精算する（呼び出し側でユーザーロック内）。
 * 戻り値: 更新があれば true。精算オプの登録は決定的 ID で冪等
 * （enqueueSettle は呼び出し側が渡す）。
 */
export async function settleMyBets(
  ownerKey: string,
  bets: RaceBet[],
  nowMs: number,
  enqueueSettle: (bet: RaceBet, payout: number) => Promise<boolean>,
): Promise<{ bets: RaceBet[]; changed: boolean }> {
  let changed = false;
  const out: RaceBet[] = [];
  for (const bet of bets) {
    if (bet.settle !== "open" || nowMs < bet.postMs + RACE_DURATION_MS) {
      out.push(bet);
      continue;
    }
    const spend = await findEconomyOp(ownerKey, bet.spendOpId);
    if (spend === null || spend.status === "pending") {
      out.push(bet); // まだ確定していない先払いは次回に回す
      continue;
    }
    if (spend.status === "failed") {
      out.push({ ...bet, settle: "void", payout: 0 });
      changed = true;
      continue;
    }
    const core = generateRaceCore(bet.postMs);
    const payout = payoutFor(bet.type, bet.horseId, bet.amount, { win: bet.oddsWin, place: bet.oddsPlace }, core);
    if (payout > 0) {
      const ok = await enqueueSettle(bet, payout);
      if (!ok) {
        out.push(bet); // 登録できなかったら未精算のまま次回リトライ
        continue;
      }
    }
    out.push({ ...bet, settle: "settled", payout });
    changed = true;
  }
  return { bets: out, changed };
}
