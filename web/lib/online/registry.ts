// オンライン対戦ゲームのモジュール登録。
// 各ゲームは web/lib/online/games/<id>.ts で `export const gameModule` を提供する。
import type { OnlineGameModule } from "./types";
import { gameModule as reversi } from "./games/reversi";
import { gameModule as connect4 } from "./games/connect4";
import { gameModule as battleship } from "./games/battleship";
import { gameModule as daifugo } from "./games/daifugo";
import { gameModule as werewolf } from "./games/werewolf";
import { gameModule as babanuki } from "./games/babanuki";
import { gameModule as territory } from "./games/territory";
import { gameModule as speed } from "./games/speed";
import { gameModule as quizbattle } from "./games/quizbattle";
import { gameModule as wordwolf } from "./games/wordwolf";
import { gameModule as drawguess } from "./games/drawguess";
import { gameModule as bombpass } from "./games/bombpass";
import { gameModule as shiritori } from "./games/shiritori";
import { gameModule as majority } from "./games/majority";
import { gameModule as texas } from "./games/texas";
import { gameModule as nanja } from "./games/nanja";
import { gameModule as liarsdice } from "./games/liarsdice";
import { gameModule as countdown } from "./games/countdown";
import { gameModule as cheat } from "./games/cheat";
import { gameModule as hagetaka } from "./games/hagetaka";
import { gameModule as burst } from "./games/burst";
import { gameModule as stopbattle } from "./games/stopbattle";
import { gameModule as calcrace } from "./games/calcrace";
import { gameModule as musicalchairs } from "./games/musicalchairs";
import { gameModule as wordbasket } from "./games/wordbasket";
import { gameModule as typerace } from "./games/typerace";

export const ONLINE_GAMES: Record<string, OnlineGameModule> = {
  reversi,
  connect4,
  battleship,
  daifugo,
  werewolf,
  babanuki,
  territory,
  speed,
  quizbattle,
  wordwolf,
  drawguess,
  bombpass,
  shiritori,
  majority,
  texas,
  nanja,
  liarsdice,
  countdown,
  cheat,
  hagetaka,
  burst,
  stopbattle,
  calcrace,
  musicalchairs,
  wordbasket,
  typerace,
};

export function getOnlineGame(id: string): OnlineGameModule | undefined {
  if (typeof id !== "string") return undefined;
  return ONLINE_GAMES[id];
}
