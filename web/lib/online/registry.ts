// オンライン対戦ゲームのモジュール登録。
// 各ゲームは web/lib/online/games/<id>.ts で `export const gameModule` を提供する。
import type { OnlineGameModule } from "./types";
import { gameModule as reversi } from "./games/reversi";
import { gameModule as connect4 } from "./games/connect4";
import { gameModule as gomoku } from "./games/gomoku";
import { gameModule as battleship } from "./games/battleship";
import { gameModule as daifugo } from "./games/daifugo";
import { gameModule as werewolf } from "./games/werewolf";

export const ONLINE_GAMES: Record<string, OnlineGameModule> = {
  reversi,
  connect4,
  gomoku,
  battleship,
  daifugo,
  werewolf,
};

export function getOnlineGame(id: string): OnlineGameModule | undefined {
  if (typeof id !== "string") return undefined;
  return ONLINE_GAMES[id];
}
