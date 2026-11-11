// オンライン対戦ゲーム共通基盤の型定義。
// ゲームモジュールは web/lib/online/games/<id>.ts に置かれ、
// `export const gameModule` としてこのインターフェースを実装する。
// 状態・アクション・ビューはすべて JSON 化可能な値だけを使うこと
// （Map / Set / クラスインスタンスは禁止）。

export type Rng = () => number;

export type SeatInfo = { seat: number; name: string };

export interface OnlineGameModule<S = any, A = any, V = any> {
  id: string; // URLスラッグと一致（reversi 等）
  title: string;
  minPlayers: number;
  maxPlayers: number;
  cpuSupported: boolean;
  chatEnabled: boolean;
  createState(players: SeatInfo[], rng: Rng, options: Record<string, unknown>): S;
  /** 不正な手は Error（日本語メッセージ）を throw する。 */
  applyAction(state: S, seat: number, action: A, rng: Rng): S;
  /** 秘匿フィルタ済みビューを返す。 */
  viewFor(state: S, seat: number): V;
  /** 形式不正は null を返す。 */
  parseAction(raw: unknown): A | null;
  /** 不正は Error を throw する。 */
  parseOptions?(raw: Record<string, unknown>): Record<string, unknown>;
  phaseOf(state: S): string;
  isFinished(state: S): boolean;
  /** 対戦中の退出をゲーム側で処理する。 */
  onPlayerLeft?(state: S, seat: number): S;
  /** その seat が CPU で今打つべき手。無ければ null。 */
  cpuAction?(state: S, seat: number, rng: Rng): A | null;
  /** 時間進行（人狼の議論タイマー等）。変化なければ同一参照を返す。 */
  tick?(state: S, now: number): S;
}
