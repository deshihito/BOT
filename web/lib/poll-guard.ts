// クライアント側ポーリングの in-flight 重複と古いレスポンスの上書きを防ぐ共有ガード（S6）。
//
// 問題: setInterval で回る取得（カジノ 3s / チャット 3s / パーティ 4s /
// プレゼンス 1s / モブ・タイル・プロフィール 15s など）は従来、進行中の
// 取得と重ねて走り、遅れて届いた古いレスポンスが新しい状態をそのまま
// 上書きしていた。実害: カジノの残高表示がプレイ前の値に戻る、倒した
// モブが生き返って見える、掘ったブロックが元に戻って見える、他者の
// ゴースト表示、パーティ招待の古い状態への巻き戻り、プロフィールの
// 行為前への巻き戻り。
//
// 使い方: 取得ごとに guard.begin() でチケットを取り、await の後で
// guard.isCurrent(ticket) を確認してから適用し、最後に guard.end(ticket)
// で進行中を解く。begin() は進行中なら null を返して今回をスキップする
// （次の tick が最新を取り直す）。明示的な再取得（プレイ後・行為後の
// 更新など）は begin({ force: true }) で、進行中の古い取得を無効化して
// 必ず走らせる。
export type PollTicket = number;

export function createPollGuard() {
  let seq = 0;
  let inFlight = false;
  return {
    /** 取得開始。進行中なら null（今回はスキップ）。force なら必ず開始し、古い取得を無効化する。 */
    begin(opts?: { force?: boolean }): PollTicket | null {
      if (inFlight && !opts?.force) return null;
      inFlight = true;
      seq += 1;
      return seq;
    },
    /** このチケットが最新か（古いレスポンスは適用しない）。 */
    isCurrent(ticket: PollTicket): boolean {
      return ticket === seq;
    },
    /** 取得完了。最新チケットのときだけ進行中を解く。 */
    end(ticket: PollTicket): void {
      if (ticket === seq) inFlight = false;
    },
  };
}

export type PollGuard = ReturnType<typeof createPollGuard>;
