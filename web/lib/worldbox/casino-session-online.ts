// WORLD BOX カジノのセッション永続化（bot_kv "worldbox_casino"）。
// キー: session:<ownerKey> / state:<ownerKey>。値は JSON 文字列。
import { kvDelete, kvGet, kvSet } from "../bot-api";
import { cleanCasinoSession, type CasinoSession } from "./casino-session";
import { cleanCasinoUserState, emptyCasinoUserState, type CasinoUserState } from "./casino-games";

const NAMESPACE = "worldbox_casino";

function parseJson(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadCasinoSession(ownerKey: string): Promise<CasinoSession | null> {
  try {
    return cleanCasinoSession(parseJson(await kvGet(NAMESPACE, `session:${ownerKey}`)));
  } catch {
    return null;
  }
}

export async function saveCasinoSession(ownerKey: string, session: CasinoSession): Promise<void> {
  await kvSet(NAMESPACE, `session:${ownerKey}`, JSON.stringify(session));
}

export async function clearCasinoSession(ownerKey: string): Promise<void> {
  try {
    await kvDelete(NAMESPACE, `session:${ownerKey}`);
  } catch {
    // 削除失敗は次回ロード時の整形で吸収する。
  }
}

export async function loadCasinoUserState(ownerKey: string): Promise<CasinoUserState> {
  try {
    return cleanCasinoUserState(parseJson(await kvGet(NAMESPACE, `state:${ownerKey}`)));
  } catch {
    return emptyCasinoUserState();
  }
}

export async function saveCasinoUserState(ownerKey: string, state: CasinoUserState): Promise<void> {
  await kvSet(NAMESPACE, `state:${ownerKey}`, JSON.stringify(state));
}
