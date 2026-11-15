// AGO WORLD BOX の場所検証（サーバー専用）。
// 行動の場所制約（購入=店、合成=作業台、送金=銀行、掲示板=掲示板前）は
// クライアントの表示制限だけでなく、サーバー側でも本人の現在位置で
// 検証する。位置の正はプレゼンス（サーバーが受け取ったハートビート）で、
// クライアントの自己申告は使わない。カジノ（casino ルート）と同じ方式。
// 室内（ロビー・テント）外・プレゼンス未送信・鮮度切れはすべて null
// （=どの施設の前でもない）。プレゼンスが無い/古い場合は、ワープ時に
// 保存されるセーブ（空間と入口位置）で代替する。
import { buildLobby, stationNear, type LobbyStation } from "./lobby";
import { buildTent } from "./tent";
import { isPresenceEnabled, loadMyPresence } from "./presence-online";
import { parseSave } from "./save";
import { loadWorldBoxSave } from "./save-online";

/** 本人が今隣接している室内のステーション。無ければ null。 */
export async function loadMyLobbyStation(ownerKey: string): Promise<LobbyStation | null> {
  if (!isPresenceEnabled()) return null;
  const presence = await loadMyPresence(ownerKey);
  if (presence) {
    if (presence.space === "lobby") {
      return stationNear(buildLobby().objects, Math.floor(presence.x), Math.floor(presence.y));
    }
    if (presence.space === "tent") {
      return stationNear(buildTent().objects, Math.floor(presence.x), Math.floor(presence.y));
    }
    return null;
  }
  const saved = parseSave(await loadWorldBoxSave(ownerKey));
  if (!saved) return null;
  if (saved.space === "lobby") {
    return stationNear(buildLobby().objects, Math.floor(saved.x), Math.floor(saved.y));
  }
  if (saved.space === "tent") {
    return stationNear(buildTent().objects, Math.floor(saved.x), Math.floor(saved.y));
  }
  return null;
}
