// AGO WORLD BOX の場所検証（サーバー専用）。
// 行動の場所制約（購入=店、合成=作業台、送金=銀行、掲示板=掲示板前）は
// クライアントの表示制限だけでなく、サーバー側でも本人の現在位置で
// 検証する。位置の正はプレゼンス（サーバーが受け取ったハートビート）で、
// クライアントの自己申告は使わない。カジノ（casino ルート）と同じ方式。
// 室内（ロビー・テント）外・プレゼンス未送信・鮮度切れはすべて null
// （=どの施設の前でもない）。プレゼンスが無い/古い場合は、ワープ時に
// 保存されるセーブ（空間と入口位置）で代替する。
import { buildLobby, stationGenreNear, stationNear, type LobbyObject, type LobbyStation } from "./lobby";
import type { ShopGenreId } from "./shops";
import { buildTent } from "./tent";
import { isPresenceEnabled, loadMyPresence } from "./presence-online";
import { parseSave } from "./save";
import { loadWorldBoxSave } from "./save-online";

/** 本人の現在位置（室内オブジェクト一覧＋タイル座標）。室内にいなければ null。 */
async function loadMyIndoorPosition(
  ownerKey: string,
): Promise<{ objects: readonly LobbyObject[]; tx: number; ty: number } | null> {
  if (!isPresenceEnabled()) return null;
  const presence = await loadMyPresence(ownerKey);
  if (presence) {
    if (presence.space === "lobby") {
      return { objects: buildLobby().objects, tx: Math.floor(presence.x), ty: Math.floor(presence.y) };
    }
    if (presence.space === "tent") {
      return { objects: buildTent().objects, tx: Math.floor(presence.x), ty: Math.floor(presence.y) };
    }
    return null;
  }
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (!saved) return null;
  if (saved.space === "lobby") {
    return { objects: buildLobby().objects, tx: Math.floor(saved.x), ty: Math.floor(saved.y) };
  }
  if (saved.space === "tent") {
    return { objects: buildTent().objects, tx: Math.floor(saved.x), ty: Math.floor(saved.y) };
  }
  return null;
}

/** 本人が今隣接している室内のステーション。無ければ null。 */
export async function loadMyLobbyStation(ownerKey: string): Promise<LobbyStation | null> {
  const pos = await loadMyIndoorPosition(ownerKey);
  if (!pos) return null;
  return stationNear(pos.objects, pos.tx, pos.ty);
}

/**
 * 本人が今いる店の品目ジャンル（shops.ts）。鍛冶屋（station "smith"）は
 * ジャンル "smith"。店の前にいない／接した店がジャンルを持たなければ null。
 */
export async function loadMyLobbyShopGenre(ownerKey: string): Promise<ShopGenreId | null> {
  const pos = await loadMyIndoorPosition(ownerKey);
  if (!pos) return null;
  const station = stationNear(pos.objects, pos.tx, pos.ty);
  if (station === "smith") return "smith";
  if (station !== "shop") return null;
  return stationGenreNear(pos.objects, pos.tx, pos.ty);
}
