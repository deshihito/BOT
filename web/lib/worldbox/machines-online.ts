// AGO WORLD BOX の装置状態の保存（bot_kv）。
// キーは空間修飾つき（"world|x,y"、収納コンテナと同じ方式）。旧形式の
// 素の "x,y" で残っている分は読み取り時にフォールバックで拾い、次回
// 書き込みで新キーへ移行する（装置はワールドにしか置けないため空間は
// world 固定だが、キー形式をコンテナと揃えて将来の空間追加に備える）。
// 検証と評価は machines.ts が担い、ここは読み書きだけ。
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "../bot-api";
import { parseMachineState, type MachineState } from "./machines";
import { tileKey } from "./tiles";

export const WORLDBOX_MACHINES_NAMESPACE = "worldbox_machines";

export function isMachinesEnabled(): boolean {
  return isBotApiConfigured();
}

/** 装置状態の保存キー（空間修飾つき）。 */
export function machineKey(x: number, y: number): string {
  return `world|${tileKey(x, y)}`;
}

export async function loadMachine(x: number, y: number): Promise<MachineState | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const stored = await kvGet(WORLDBOX_MACHINES_NAMESPACE, machineKey(x, y));
    if (stored !== null) return parseMachineState(stored);
    // 旧形式（空間なし "x,y"）の分を拾う。移行済みなら空。
    return parseMachineState(await kvGet(WORLDBOX_MACHINES_NAMESPACE, tileKey(x, y)));
  } catch {
    return null;
  }
}

export async function storeMachine(x: number, y: number, state: MachineState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_MACHINES_NAMESPACE, machineKey(x, y), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export async function deleteMachine(x: number, y: number): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_MACHINES_NAMESPACE, machineKey(x, y));
    // 旧形式の残存も一緒に消す。
    await kvDelete(WORLDBOX_MACHINES_NAMESPACE, tileKey(x, y));
  } catch {
    /* noop */
  }
}
