// AGO WORLD BOX の収納コンテナの保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_containers"）。
// キーは空間修飾つき（"<space>|x,y"、world は "world|x,y"）。旧形式の
// 素の "x,y"（空間なし）で残っているワールドのコンテナは読み取り時に
// フォールバックで拾い、次回書き込みで新キーへ移行する（S4: 空間を
// 増やすたびに同座標のコンテナが衝突するのを防ぐ）。
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

/** コンテナ状態の保存キー（空間修飾つき）。 */
export function containerKey(space: string, x: number, y: number): string {
  return `${space}|${tileKey(x, y)}`;
}

/** 1タイルのコンテナ状態を読む。無い・読めない・未設定なら null。 */
export async function loadContainer(
  space: string,
  x: number,
  y: number,
  itemId: string,
): Promise<ContainerState | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const stored = await kvGet(WORLDBOX_CONTAINERS_NAMESPACE, containerKey(space, x, y));
    if (stored !== null) return parseContainerState(stored, itemId);
    // 旧形式（空間なし "x,y"）のワールド分を拾う。移行済みなら空。
    if (space === "world") {
      return parseContainerState(await kvGet(WORLDBOX_CONTAINERS_NAMESPACE, tileKey(x, y)), itemId);
    }
    return null;
  } catch {
    return null;
  }
}

/** 1タイルのコンテナ状態を保存する（null は削除）。成功したら true。 */
export async function storeContainer(
  space: string,
  x: number,
  y: number,
  state: ContainerState | null,
): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    if (state === null) {
      await kvDelete(WORLDBOX_CONTAINERS_NAMESPACE, containerKey(space, x, y));
      // 旧形式の残存も一緒に消す（ワールド分のみ）。
      if (space === "world") await kvDelete(WORLDBOX_CONTAINERS_NAMESPACE, tileKey(x, y));
    } else {
      await kvSet(WORLDBOX_CONTAINERS_NAMESPACE, containerKey(space, x, y), serializeContainerState(state));
    }
    return true;
  } catch {
    return false;
  }
}
