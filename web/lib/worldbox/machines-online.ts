// AGO WORLD BOX の装置状態の保存（bot_kv）。
// キーはワールド座標 "x,y"（収納コンテナと同じ方式）。検証と評価は
// machines.ts が担い、ここは読み書きだけ。
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "../bot-api";
import { parseMachineState, type MachineState } from "./machines";

export const WORLDBOX_MACHINES_NAMESPACE = "worldbox_machines";

export function isMachinesEnabled(): boolean {
  return isBotApiConfigured();
}

export async function loadMachine(x: number, y: number): Promise<MachineState | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseMachineState(await kvGet(WORLDBOX_MACHINES_NAMESPACE, `${x},${y}`));
  } catch {
    return null;
  }
}

export async function storeMachine(x: number, y: number, state: MachineState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_MACHINES_NAMESPACE, `${x},${y}`, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export async function deleteMachine(x: number, y: number): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_MACHINES_NAMESPACE, `${x},${y}`);
  } catch {
    /* noop */
  }
}
