"use client";
// ババ抜き（オンライン）クライアント。ルーム管理は OnlineShell が担い、
// このコンポーネントは view.state（ゲーム別ビュー）の描画と
// 「隣の手札から1枚引く」操作だけを持つ。
// 契約: view.state.yourHand は自分の手札（カード id 配列）、他人の手札は
// others[].count（枚数）だけが見える。引く操作は { type: "draw", index }
// で、index は引く相手の手札の位置（中身は見えない）。
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const BabanukiScene3D = dynamic(() => import("./BabanukiScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";
import { playSe } from "@/lib/balku-sound";

type BabanukiOther = { seat: number; name: string; count: number; rank: number | null; left: boolean };
type BabanukiLogEntry = { seat: number; kind: "draw" | "pair" | "finish" | "lose" | "left"; from?: number };
type BabanukiState = {
  yourHand: number[];
  others: BabanukiOther[];
  turn: number;
  drawFrom: number | null;
  finishOrder: number[];
  yourRank: number | null;
  loser: number | null;
  finished: boolean;
  lastDraw: { seat: number; from: number; paired: boolean } | null;
  log: BabanukiLogEntry[];
  players: { seat: number; name: string }[];
};

const SUIT_GLYPHS = ["♠", "♥", "♦", "♣"] as const;
function isRedCard(id: number): boolean {
  if (id === 52) return false;
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
  if (id === 52) return "ジョーカー";
  const suitName = ["スペード", "ハート", "ダイヤ", "クラブ"][Math.floor(id / 13)];
  return `${suitName}の${rankLabel(id)}`;
}

function CardFace({ id }: { id: number }) {
  if (id === 52) {
    return (
      <span className="og-card-face">
        <span className="og-card-suit">★</span>
        <span className="og-card-rank">JOKER</span>
      </span>
    );
  }
  return (
    <span className="og-card-face">
      <span className="og-card-suit">{SUIT_GLYPHS[Math.floor(id / 13)]}</span>
      <span className="og-card-rank">{rankLabel(id)}</span>
    </span>
  );
}

export default function BabanukiClient() {
  return (
    <OnlineShell gameId="babanuki" title="ババ抜き" playerRange={{ min: 2, max: 4 }}>
      {(view, api) => <BabanukiTable view={view} api={api} />}
    </OnlineShell>
  );
}

function BabanukiTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const [webglFailed, setWebglFailed] = useState(false);
  const state = view.state as BabanukiState | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.turn ?? ""}`, state?.finished ?? false);
  const mySeat = view.player.seat;

  const prevTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state || state.finished) return;
    const prev = prevTurnRef.current;
    prevTurnRef.current = state.turn;
    if (prev !== null && prev !== state.turn && state.turn === mySeat) playSe("turn");
  }, [state, mySeat]);

  const finishRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    if (state.finished) {
      if (finishRef.current === view.code) return;
      finishRef.current = view.code;
      playSe(state.loser === mySeat ? "lose" : "win");
    }
  }, [state, mySeat, view.code]);

  if (!state) {
    return <p className="og-notice">対戦の開始を待っています…</p>;
  }

  const nameOf = (seat: number): string => {
    if (seat === mySeat) return "あなた";
    const p = state.players.find((pl) => pl.seat === seat);
    return p ? p.name : `プレイヤー${seat + 1}`;
  };

  const isMyTurn = !state.finished && state.yourRank === null && state.turn === mySeat;
  const drawTarget = state.others.find((o) => o.seat === state.drawFrom) ?? null;
  const recentLog = [...(state.log ?? [])].slice(-6).reverse();

  const logText = (entry: BabanukiLogEntry): string => {
    switch (entry.kind) {
      case "draw":
        return `${nameOf(entry.seat)} が ${entry.from !== undefined ? nameOf(entry.from) : "隣"} から1枚引きました`;
      case "pair":
        return `${nameOf(entry.seat)} がペアを捨てました`;
      case "finish":
        return `${nameOf(entry.seat)} が上がりました`;
      case "lose":
        return `${nameOf(entry.seat)} がジョーカーを持って負けました`;
      case "left":
        return `${nameOf(entry.seat)} が退出しました`;
      default:
        return "";
    }
  };

  // 3D シーンからの操作（既存の「引く」ボタンと同じ move を送る。意味は変えない）。
  const doDraw = (index: number) => {
    if (api.busy) return;
    playSe("play");
    void api.move({ type: "draw", index });
  };

  // 2D テーブル（引く操作＋自分の手札。WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const table2d = (
    <>
      {/* 引く操作: 相手の手札は裏向きで枚数だけ見える */}
      {!state.finished && isMyTurn && drawTarget && (
        <section aria-label="カードを引く" style={{ marginTop: 12 }}>
          <p className="og-status-line">{drawTarget.name} の手札（裏向き）から1枚選んでください。</p>
          <div
            role="group"
            aria-label={`${drawTarget.name}の手札`}
            style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
          >
            {Array.from({ length: drawTarget.count }, (_, index) => (
              <button
                key={index}
                type="button"
                disabled={api.busy}
                aria-label={`${drawTarget.name}の手札 ${index + 1}枚目を引く`}
                onClick={() => {
                  playSe("play");
                  void api.move({ type: "draw", index });
                }}
                style={{
                  width: 52,
                  height: 72,
                  minHeight: 48,
                  borderRadius: 8,
                  border: "2px solid #7a4a21",
                  background:
                    "repeating-linear-gradient(45deg, #a33b32 0 8px, #93332b 8px 16px)",
                  color: "#fff",
                  fontSize: 20,
                  cursor: api.busy ? "default" : "pointer",
                  touchAction: "manipulation",
                }}
              >
                🂠
              </button>
            ))}
          </div>
        </section>
      )}
      {/* 自分の手札 */}
      {!state.finished && (
        <section aria-label="あなたの手札" style={{ marginTop: 16 }}>
          <p className="og-status-line">あなたの手札（{state.yourHand.length}枚）</p>
          <div className="og-hand" role="group" aria-label="あなたの手札">
            {state.yourHand.map((id) => (
              <span
                key={id}
                className={`og-card juice-pop${isRedCard(id) ? " og-card-red" : ""}`}
                role="img"
                aria-label={cardAriaLabel(id)}
                style={id === 52 ? { borderColor: "#7a4a21", background: "#fff7e0" } : undefined}
              >
                <CardFace id={id} />
              </span>
            ))}
            {state.yourHand.length === 0 && <span className="og-status-line">手札はありません（上がり）。</span>}
          </div>
          <p className="og-muted">
            同じ数字が2枚そろうと自動で捨てられます。最後までジョーカーを持っていた人が負けです。
          </p>
        </section>
      )}
    </>
  );

  return (
    <div className="og-game og-babanuki">
      <div className={`og-turn-banner${isMyTurn ? " og-turn-mine juice-pulse" : ""}`} role="status" aria-live="polite">
        {state.finished ? (
          <span>
            対戦終了{state.loser !== null ? `: ${nameOf(state.loser)} の負け` : ""}
            {state.loser === mySeat ? "（ジョーカー）" : ""}
          </span>
        ) : state.yourRank !== null ? (
          <span>{state.yourRank}位で上がりました。残りの対戦を見守っています。</span>
        ) : isMyTurn ? (
          <span>
            あなたの手番です。{drawTarget ? drawTarget.name : "隣"} の手札から1枚引いてください。
          </span>
        ) : (
          <span>{nameOf(state.turn)} の手番です（待機中）</span>
        )}
      </div>

      {/* 他プレイヤー */}
      <div className="og-members" aria-label="他のプレイヤー">
        {state.others.map((other) => (
          <div
            key={other.seat}
            className={`og-member${state.turn === other.seat && !state.finished ? " og-member-turn" : ""}`}
            style={
              state.drawFrom === other.seat && !state.finished
                ? { outline: "2px solid #d9a41c", outlineOffset: 2 }
                : undefined
            }
          >
            <span className="og-member-name">
              {other.name}
              {state.turn === other.seat && !state.finished ? "（手番）" : ""}
              {state.drawFrom === other.seat && isMyTurn ? "（引く相手）" : ""}
            </span>
            <span className="og-member-meta">
              {other.left ? "退出" : other.rank !== null ? `${other.rank}位` : `手札 ${other.count} 枚`}
            </span>
          </div>
        ))}
      </div>

      {/* 終了時の結果 */}
      {state.finished && (
        <section className="og-result juice-slide" aria-label="最終結果">
          <h2 className={state.loser !== mySeat ? "juice-pulse" : undefined}>結果</h2>
          <ol className="og-result-list">
            {state.finishOrder.map((seat, index) => (
              <li key={seat} className={seat === mySeat ? "og-result-mine" : ""}>
                <span className="og-result-rank">{index + 1}位</span>
                <span>{nameOf(seat)}</span>
                {seat === mySeat && <span className="og-badge">あなた</span>}
              </li>
            ))}
            {state.loser !== null && (
              <li className={state.loser === mySeat ? "og-result-mine" : ""}>
                <span className="og-result-rank">負け</span>
                <span>{nameOf(state.loser)}（ジョーカー）</span>
                {state.loser === mySeat && <span className="og-badge">あなた</span>}
              </li>
            )}
          </ol>
          <p className="og-status-line">
            {state.loser === mySeat
              ? "ジョーカーを持ってしまいました…"
              : state.yourRank !== null
                ? `あなたは ${state.yourRank} 位でした。`
                : "対戦が終了しました。"}
          </p>
        </section>
      )}

      {/* 手札まわり: 3D シーン（WebGL が使えない場合は 2D テーブルへ） */}
      {!state.finished &&
        (webglFailed ? (
          table2d
        ) : (
          <BabanukiScene3D
            mySeat={mySeat}
            yourHand={state.yourHand}
            others={state.others.map((o) => ({ seat: o.seat, count: o.count }))}
            drawFromSeat={state.drawFrom}
            isMyTurn={isMyTurn}
            lastDraw={state.lastDraw}
            onDrawTap={doDraw}
            onFail={() => setWebglFailed(true)}
            fallback={table2d}
          />
        ))}

      {/* ログ */}
      {recentLog.length > 0 && (
        <section className="og-log" aria-label="対戦ログ">
          <h2>ログ</h2>
          <ul className="og-log-list">
            {recentLog.map((entry, i) => (
              <li key={`${view.revision}-${i}`} className={i === 0 ? "juice-pop" : undefined}>{logText(entry)}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
