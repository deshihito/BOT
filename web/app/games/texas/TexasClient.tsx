"use client";
// テキサスポーカー簡易版（オンライン）クライアント。ルーム管理は OnlineShell が担い、
// このコンポーネントは view.state（ゲーム別ビュー）の描画と
// 「参加／フォールド」「次のハンドへ」の操作だけを持つ。
// 契約: 自分の手札は yourCards、他人の手札は枚数（cardCount）だけが見える。
// 共通カードは board に現在のストリートで公開された分だけ入る。
// ルールはレイズなしの簡易版: アンティ10点＋各ストリート固定10点、全5ハンド。
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const TexasScene3D = dynamic(() => import("./TexasScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";
import { playSe } from "@/lib/balku-sound";

type TexasPlayerView = {
  seat: number;
  name: string;
  chips: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  left: boolean;
  committed: number;
  cardCount: number;
  isTurn: boolean;
};
type TexasLogEntry = {
  kind: "hand" | "call" | "fold" | "win" | "left";
  seat?: number;
  amount?: number;
  hand?: number;
  handName?: string;
  showdown?: boolean;
};
type TexasLastResult = {
  hand: number;
  winners: number[];
  amount: number;
  showdown: boolean;
  hands: Record<number, { cards: number[]; name: string }> | null;
};
type TexasView = {
  phase: "betting" | "handEnd" | "finished";
  street: "preflop" | "flop" | "turn" | "river";
  handNumber: number;
  totalHands: number;
  pot: number;
  board: number[];
  yourCards: number[];
  turn: number | null;
  yourTurn: boolean;
  callAmount: number;
  players: TexasPlayerView[];
  lastResult: TexasLastResult | null;
  standings: { seat: number; chips: number; rank: number }[] | null;
  nextHandAt: number | null;
  log: TexasLogEntry[];
  finished: boolean;
};

const SUIT_GLYPHS = ["♠", "♥", "♦", "♣"] as const;
const STREET_LABELS: Record<TexasView["street"], string> = {
  preflop: "プリフロップ",
  flop: "フロップ",
  turn: "ターン",
  river: "リバー",
};

function isRedCard(id: number): boolean {
  const suit = Math.floor(id / 13);
  return suit === 1 || suit === 2;
}
function rankLabel(id: number): string {
  const rank = (id % 13) + 1;
  if (rank === 1) return "A";
  if (rank <= 10) return String(rank);
  return { 11: "J", 12: "Q", 13: "K" }[rank as 11 | 12 | 13];
}
function cardAriaLabel(id: number): string {
  const suitName = ["スペード", "ハート", "ダイヤ", "クラブ"][Math.floor(id / 13)];
  return `${suitName}の${rankLabel(id)}`;
}

function CardFace({ id }: { id: number }) {
  return (
    <span className="og-card-face">
      <span className="og-card-suit">{SUIT_GLYPHS[Math.floor(id / 13)]}</span>
      <span className="og-card-rank">{rankLabel(id)}</span>
    </span>
  );
}

export default function TexasClient() {
  return (
    <OnlineShell gameId="texas" title="テキサスポーカー" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <TexasTable view={view} api={api} />}
    </OnlineShell>
  );
}

function TexasTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const [webglFailed, setWebglFailed] = useState(false);
  const state = view.state as TexasView | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.turn ?? ""}:${state?.phase ?? ""}`, (state?.finished ?? false) || state?.phase === "finished");
  const mySeat = view.player.seat;

  const prevTurnRef = useRef<boolean>(false);
  useEffect(() => {
    if (!state) return;
    const was = prevTurnRef.current;
    prevTurnRef.current = state.yourTurn;
    if (!was && state.yourTurn) playSe("turn");
  }, [state]);

  const finishRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state || !state.finished) return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const mine = state.standings?.find((s) => s.seat === mySeat);
    playSe(mine && mine.rank === 1 ? "win" : "lose");
  }, [state, mySeat, view.code]);

  if (!state) {
    return <p className="og-notice">対戦の開始を待っています…</p>;
  }

  const nameOf = (seat: number): string => {
    if (seat === mySeat) return "あなた";
    const p = state.players.find((pl) => pl.seat === seat);
    return p ? p.name : `プレイヤー${seat + 1}`;
  };
  // 3D シーンからの操作（既存ボタンと同じ move を送る。意味は変えない）。
  const doCall = () => {
    playSe("play");
    void api.move({ type: "act", move: "call" });
  };
  const doFold = () => {
    playSe("play");
    void api.move({ type: "act", move: "fold" });
  };
  const doNext = () => void api.move({ type: "next" });
  const me = state.players.find((p) => p.seat === mySeat);
  const recentLog = [...(state.log ?? [])].slice(-8).reverse();

  const logText = (entry: TexasLogEntry): string => {
    switch (entry.kind) {
      case "hand":
        return `―― ハンド ${entry.hand} 開始（アンティ10点） ――`;
      case "call":
        return `${entry.seat !== undefined ? nameOf(entry.seat) : "?"} が ${entry.amount} 点で参加`;
      case "fold":
        return `${entry.seat !== undefined ? nameOf(entry.seat) : "?"} がフォールド`;
      case "win":
        return entry.showdown
          ? `${entry.seat !== undefined ? nameOf(entry.seat) : "?"} が ${entry.handName ?? ""} で ${entry.amount} 点を獲得`
          : `${entry.seat !== undefined ? nameOf(entry.seat) : "?"} が ${entry.amount} 点を獲得（他全員フォールド）`;
      case "left":
        return `${entry.seat !== undefined ? nameOf(entry.seat) : "?"} が退出しました`;
      default:
        return "";
    }
  };

  const banner = state.finished
    ? "対戦終了"
    : state.phase === "handEnd"
      ? `ハンド ${state.lastResult?.hand ?? state.handNumber} 終了`
      : state.yourTurn
        ? "あなたの手番です。参加するかフォールドを選んでください。"
        : state.turn !== null
          ? `${nameOf(state.turn)} の手番です（待機中）`
          : "進行中です";

  // 2D テーブル（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const table2d = (
    <>
      {/* 共通カード */}
      <section aria-label="共通カード" style={{ marginTop: 14 }}>
        <p className="og-status-line">共通カード</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {Array.from({ length: 5 }, (_, i) => {
            const card = state.board[i];
            if (card === undefined) {
              return (
                <span
                  key={i}
                  aria-hidden
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 52,
                    height: 72,
                    borderRadius: 8,
                    border: "2px dashed var(--line)",
                    color: "var(--muted)",
                    fontSize: 12,
                  }}
                >
                  ?
                </span>
              );
            }
            return (
              <span
                key={`${state.handNumber}-${i}-${card}`}
                className={`og-card juice-flip${isRedCard(card) ? " og-card-red" : ""}`}
                role="img"
                aria-label={cardAriaLabel(card)}
              >
                <CardFace id={card} />
              </span>
            );
          })}
        </div>
      </section>

      {/* 自分の手札 */}
      <section aria-label="あなたの手札" style={{ marginTop: 14 }}>
        <p className="og-status-line">あなたの手札</p>
        <div className="og-hand" role="group" aria-label="あなたの手札">
          {state.yourCards.map((id) => (
            <span
              key={`${state.handNumber}-${id}`}
              className={`og-card juice-flip${isRedCard(id) ? " og-card-red" : ""}`}
              role="img"
              aria-label={cardAriaLabel(id)}
            >
              <CardFace id={id} />
            </span>
          ))}
          {state.yourCards.length === 0 && (
            <span className="og-status-line">
              {me && !me.inHand ? "このハンドは不参加です。" : "配られていません。"}
            </span>
          )}
        </div>
      </section>
    </>
  );

  return (
    <div className="og-game og-texas">
      <div className={`og-turn-banner${state.yourTurn ? " og-turn-mine juice-pulse" : ""}`} role="status" aria-live="polite">
        <span>{banner}</span>
      </div>

      <p className="og-status-line">
        ハンド {state.handNumber} / {state.totalHands} ・ {STREET_LABELS[state.street]} ・ ポット{" "}
        {state.pot} 点{me ? ` ・ あなたのチップ ${me.chips} 点` : ""}
      </p>

      {/* プレイヤー一覧 */}
      <div className="og-members" aria-label="プレイヤー">
        {state.players.map((p) => (
          <div key={p.seat} className={`og-member${p.isTurn ? " og-member-turn" : ""}`}>
            <span className="og-member-name">
              {p.name}
              {p.seat === mySeat ? "（あなた）" : ""}
              {p.isTurn ? "（手番）" : ""}
            </span>
            <span className="og-member-meta">
              {p.left
                ? "退出"
                : !p.inHand
                  ? state.phase === "finished"
                    ? `${p.chips} 点`
                    : p.chips <= 0
                      ? "脱落"
                      : "不参加"
                  : p.folded
                    ? `フォールド ・ ${p.chips} 点`
                    : `${p.chips} 点 ・ 出した合計 ${p.committed} 点${p.allIn ? " ・ オールイン" : ""}`}
            </span>
            {p.inHand && !p.folded && p.seat !== mySeat && (
              <span style={{ display: "inline-flex", gap: 4, marginTop: 4 }}>
                {Array.from({ length: p.cardCount }, (_, i) => (
                  <span
                    key={i}
                    aria-hidden
                    style={{
                      display: "inline-block",
                      width: 16,
                      height: 22,
                      borderRadius: 3,
                      border: "1px solid #7a4a21",
                      background: "repeating-linear-gradient(45deg, #a33b32 0 4px, #93332b 4px 8px)",
                    }}
                  />
                ))}
              </span>
            )}
          </div>
        ))}
      </div>

      {webglFailed ? table2d : (
        <TexasScene3D
          board={state.board}
          yourCards={state.yourCards}
          pot={state.pot}
          players={state.players}
          mySeat={mySeat}
          handNumber={state.handNumber}
          phase={state.phase}
          yourTurn={state.yourTurn}
          onCall={doCall}
          onFold={doFold}
          onNext={doNext}
          onFail={() => setWebglFailed(true)}
          fallback={table2d}
        />
      )}

      {/* アクション */}
      {state.phase === "betting" && state.yourTurn && (
        <section aria-label="アクション" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="og-btn og-btn-primary"
              disabled={api.busy}
              style={{ minHeight: 48, padding: "10px 18px" }}
              onClick={() => {
                playSe("play");
                void api.move({ type: "act", move: "call" });
              }}
            >
              {me && me.chips <= state.callAmount && state.callAmount < 10
                ? `オールイン（残り ${state.callAmount} 点）`
                : `参加する（${state.callAmount} 点）`}
            </button>
            <button
              type="button"
              className="og-btn"
              disabled={api.busy}
              style={{ minHeight: 48, padding: "10px 18px" }}
              onClick={() => {
                playSe("play");
                void api.move({ type: "act", move: "fold" });
              }}
            >
              フォールド
            </button>
          </div>
          <p className="og-muted">簡易版のためレイズはありません。</p>
        </section>
      )}

      {/* ハンド結果 */}
      {state.phase === "handEnd" && state.lastResult && (
        <section className="og-result juice-slide" aria-label="ハンド結果" style={{ marginTop: 14 }}>
          <h2>ハンド {state.lastResult.hand} の結果</h2>
          <p className="og-status-line">
            {state.lastResult.winners.length > 0
              ? `勝者: ${state.lastResult.winners.map((s) => nameOf(s)).join("、")}（ポット ${state.lastResult.amount} 点）`
              : "勝者はいませんでした。"}
          </p>
          {state.lastResult.showdown && state.lastResult.hands && (
            <ul className="og-result-list">
              {Object.entries(state.lastResult.hands).map(([seatStr, info]) => {
                const seat = Number(seatStr);
                return (
                  <li key={seat} className={seat === mySeat ? "og-result-mine" : ""}>
                    <span>
                      {nameOf(seat)}: {info.name}
                    </span>
                    <span style={{ display: "inline-flex", gap: 4, marginLeft: 8 }}>
                      {info.cards.map((id) => (
                        <span
                          key={id}
                          className={`og-card juice-flip${isRedCard(id) ? " og-card-red" : ""}`}
                          role="img"
                          aria-label={cardAriaLabel(id)}
                          style={{ transform: "scale(0.8)", transformOrigin: "center" }}
                        >
                          <CardFace id={id} />
                        </span>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            className="og-btn og-btn-primary"
            disabled={api.busy}
            style={{ minHeight: 48, marginTop: 8 }}
            onClick={() => void api.move({ type: "next" })}
          >
            次のハンドへ
          </button>
          <p className="og-muted">しばらくすると自動で次のハンドが始まります。</p>
        </section>
      )}

      {/* 最終結果 */}
      {state.finished && state.standings && (
        <section className="og-result juice-slide" aria-label="最終結果" style={{ marginTop: 14 }}>
          <h2 className="juice-pulse">最終結果</h2>
          <ol className="og-result-list">
            {[...state.standings]
              .sort((a, b) => a.rank - b.rank || a.seat - b.seat)
              .map((s) => (
                <li key={s.seat} className={s.seat === mySeat ? "og-result-mine" : ""}>
                  <span className="og-result-rank">{s.rank}位</span>
                  <span>
                    {nameOf(s.seat)} ・ {s.chips} 点
                  </span>
                  {s.seat === mySeat && <span className="og-badge">あなた</span>}
                </li>
              ))}
          </ol>
        </section>
      )}

      {/* ログ */}
      {recentLog.length > 0 && (
        <section className="og-log" aria-label="対戦ログ" style={{ marginTop: 14 }}>
          <h2>ログ</h2>
          <ul className="og-log-list">
            {recentLog.map((entry, i) => (
              <li key={`${view.revision}-${i}`}>{logText(entry)}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="og-muted" style={{ marginTop: 12 }}>
        簡易版ルール: 全5ハンド、各ハンドのアンティ10点＋ストリートごとに固定10点（レイズなし）。チップ0で脱落し、5ハンド終了時点のチップで順位が決まります。
      </p>
    </div>
  );
}
