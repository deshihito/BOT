// AGO WORLD BOX の収納コンテナの保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_containers"、キー = "x,y"）。
// 中身はタイルに設置されたコンテナ（樽・宝箱）と対で存在し、
// 容量の解釈には設置ブロックのアイテム ID が要る。
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "../bot-api";
import {
  parseContainerState, serializeContainerState, type ContainerState,
} from "./containers";
import { tileKey } from "./tiles";

export const WORLDBOX_CONTAINERS_NAMESPACE = "worldbox_containers";

export function isContainersEnabled(): boolean {
  return isBotApiConfigured();
}

/** 1タイルのコンテナ状態を読む。無い・読めない・未設定なら null。 */
export async function loadContainer(
  x: number,
  y: number,
  itemId: string,
): Promise<ContainerState | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseContainerState(await kvGet(WORLDBOX_CONTAINERS_NAMESPACE, tileKey(x, y)), itemId);
  } catch {
    return null;
  }
}

/** 1タイルのコンテナ状態を保存する（null は削除）。成功したら true。 */
export async function storeContainer(
  x: number,
  y: number,
  state: ContainerState | null,
): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    if (state === null) await kvDelete(WORLDBOX_CONTAINERS_NAMESPACE, tileKey(x, y));
    else await kvSet(WORLDBOX_CONTAINERS_NAMESPACE, tileKey(x, y), serializeContainerState(state));
    return true;
  } catch {
    return false;
  }
}
