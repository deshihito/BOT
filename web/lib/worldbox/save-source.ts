// AGO WORLD BOX の保存先選択（純粋ロジック）。
// ログイン中はサーバー（bot_kv）のセーブを正とし、端末を跨いで続きが遊べる。
// サーバーに無くてローカルにある場合はローカルを採用し、オンラインへ
// 移行保存する。ゲスト（未ログイン）は従来どおり localStorage のみ。
import type { WorldBoxState } from "./save";

export type InitialSaveChoice = {
  /** 採用する状態。新規プレイヤーなら null（マップ中央スポーン）。 */
  state: WorldBoxState | null;
  source: "online" | "local" | "new";
  /** ローカルを採用した場合にオンラインへ移行保存すべきか。 */
  pushLocalToOnline: boolean;
};

export function chooseInitialSave(
  online: WorldBoxState | null,
  local: WorldBoxState | null,
  loggedIn: boolean,
): InitialSaveChoice {
  if (loggedIn && online) return { state: online, source: "online", pushLocalToOnline: false };
  if (local) return { state: local, source: "local", pushLocalToOnline: loggedIn };
  return { state: null, source: "new", pushLocalToOnline: false };
}
