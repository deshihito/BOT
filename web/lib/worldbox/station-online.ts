// AGO WORLD BOX の場所検証（サーバー専用）。
// 行動の場所制約（購入=店、合成=作業台、送金=銀行、掲示板=掲示板前）は
// クライアントの表示制限だけでなく、サーバー側でも本人の現在位置で
// 検証する。位置の正はプレゼンス（サーバーが受け取ったハートビート）で、
// クライアントの自己申告は使わない。カジノ（casino ルート）と同じ方式。
// ロビー外・プレゼンス未送信・鮮度切れはすべて null（=どの施設の前でもない）。
import { buildLobby, stationNear, type LobbyStation } from "./lobby";
import { isPresenceEnabled, loadMyPresence } from "./presence-online";

/** 本人が今隣接しているロビーのステーション。無ければ null。 */
export async function loadMyLobbyStation(ownerKey: string): Promise<LobbyStation | null> {
  if (!isPresenceEnabled()) return null;
  const presence = await loadMyPresence(ownerKey);
  if (!presence || presence.space !== "lobby") return null;
  return stationNear(
    buildLobby().objects,
    Math.floor(presence.x),
    Math.floor(presence.y),
  );
}
