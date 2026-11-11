"use client";
// 大富豪（オンライン）クライアント。ルーム管理（ロビー/チャット/開始/再戦/
// 退出/サウンドバー）は共通基盤 OnlineShell が担い、このコンポーネントは
// view.state（ゲーム別ビュー）の描画と手札操作だけを持つ。
//
// OnlineShell / useOnlineRoom の実 API に合わせた接続（統合時に確定）:
// view.state は unknown で渡るため、ここで DaifugoState にキャストする。
import { useEffect, useMemo, useRef, useState } from "react";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { playSe } from "@/lib/balku-sound";

/* --- 大富豪のゲーム別ビュー（モジュール担当との契約） --- */
type DaifugoOther = { seat: number; name: string; count: number; finished: number | null };
type DaifugoLogEntry = { seat: number; kind: "play" | "pass"; cards?: number[] };
type DaifugoState = {
  yourHand: number[];
  others: DaifugoOther[];
  field: { cards: number[]; seat: number } | null;
  revolution: boolean;
  turn: number;
  finishOrder: number[];
  yourRank: number | null;
  finished: boolean;
  log: DaifugoLogEntry[];
  players: { seat: number; name: string }[];
};

/* --- カード表現（id: 0〜51 = 通常札、52 = ジョーカー） --- */
const SUIT_GLYPHS = ["♠", "♥", "♦", "♣"] as const;
function isRedCard(id: number): boolean {
  if (id === 52) return false;
  const suit = Math.floor(id / 13);
  return suit === 1 || suit === 2; // ♥ / ♦
}
function rankLabel(id: number): string {
  const rank = (id % 13) + 3; // 3..15
  if (rank <= 10) return String(rank);
  return { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" }[rank as 11 | 12 | 13 | 14 | 15];
}
function cardLabel(id: number): string {
  if (id === 52) return "JOKER";
  return `${SUIT_GLYPHS[Math.floor(id / 13)]}${rankLabel(id)}`;
}
function cardAriaLabel(id: number): string {
  if (id === 52) return "ジョーカー";
  const suitName = ["スペード", "ハート", "ダイヤ", "クラブ"][Math.floor(id / 13)];
  return `${suitName}の${rankLabel(id)}`;
}

function CardFace({ id, big = false }: { id: number; big?: boolean }) {
  if (id === 52) {
    return (
      <span className="og-card-face">
        <span className="og-card-suit">🃏</span>
        <span className="og-card-rank">JOKER</span>
      </span>
    );
  }
  return (
    <span className="og-card-face">
      <span className="og-card-suit">
        {SUIT_GLYPHS[Math.floor(id / 13)]}
        {big ? "" : ""}
      </span>
      <span className="og-card-rank">{rankLabel(id)}</span>
    </span>
  );
}

export default function DaifugoClient() {
  return (
    <OnlineShell gameId="daifugo" title="大富豪" playerRange={{ min: 2, max: 4 }}>
      {(view, api) => <DaifugoTable view={view} api={api} />}
    </OnlineShell>
  );
}

function DaifugoTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as DaifugoState | null;
  const mySeat = view.player.seat;
  const [selected, setSelected] = useState<number[]>([]);

  // 選択状態の同期: view 更新で自分の手札から消えたカードは選択から落とす。
  const handKey = state ? state.yourHand.join(",") : "";
  useEffect(() => {
    if (!state) return;
    setSelected((prev) => prev.filter((id) => state.yourHand.includes(id)));
    // handKey は yourHand の内容シグネチャ（revision 変化でも発火する）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handKey, view.revision]);

  const isMyTurn = !!state && !state.finished && state.yourRank === null && state.turn === mySeat;

  // --- SE: 自分の手番 / 上がり・終了 ---
  const prevTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    const prev = prevTurnRef.current;
    prevTurnRef.current = state.turn;
    if (prev !== null && prev !== state.turn && state.turn === mySeat && !state.finished) playSe("turn");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.turn, state?.finished]);
  const finishSeRef = useRef(false);
  useEffect(() => {
    if (!state || finishSeRef.current) return;
    if (state.yourRank !== null || state.finished) {
      finishSeRef.current = true;
      playSe(state.yourRank === 1 ? "win" : state.finished && state.yourRank === null ? "lose" : "win");
    }
    if (!state.finished && state.yourRank === null) finishSeRef.current = false;
  }, [state]);

  const nameOf = useMemo(() => {
    const map = new Map<number, string>();
    if (state) {
      for (const p of state.players ?? []) map.set(p.seat, p.name);
      for (const o of state.others ?? []) map.set(o.seat, o.name);
    }
    for (const p of view.players ?? []) {
      if (!map.has(p.seat)) map.set(p.seat, p.name ?? `プレイヤー${p.seat + 1}`);
    }
    map.set(mySeat, "あなた");
    return (seat: number) => map.get(seat) ?? `プレイヤー${seat + 1}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, view.players, mySeat]);

  if (!state) {
    return <p className="og-notice">対戦の開始を待っています…</p>;
  }

  const toggleCard = (id: number) => {
    if (!isMyTurn) return;
    playSe("select");
    setSelected((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  };

  const playSelected = () => {
    if (!isMyTurn || selected.length === 0) return;
    // 送信順は手札の並び順にそろえる
    const cards = state.yourHand.filter((id) => selected.includes(id));
    playSe("play");
    void api.move({ type: "play", cards });
    setSelected([]);
  };

  const pass = () => {
    if (!isMyTurn) return;
    playSe("play");
    void api.move({ type: "pass" });
    setSelected([]);
  };

  const turnName = nameOf(state.turn);
  // モジュール側の log は時系列（末尾が最新）なので、末尾6件を新しい順に並べる
  const recentLog = [...(state.log ?? [])].slice(-6).reverse();

  return (
    <div className="og-game og-daifugo">
      <div className={`og-turn-banner${isMyTurn ? " og-turn-mine" : ""}`} role="status" aria-live="polite">
        {state.finished ? (
          <span>対戦終了</span>
        ) : state.yourRank !== null ? (
          <span>
            {state.yourRank}位で上がりました。残りの対戦を見守っています。
          </span>
        ) : isMyTurn ? (
          <span>あなたの手番です</span>
        ) : (
          <span>{turnName} の手番です</span>
        )}
        {state.revolution && <span className="og-badge og-badge-revolution">革命中</span>}
      </div>

      {/* 他プレイヤー */}
      <div className="og-members" aria-label="他のプレイヤー">
        {state.others.map((other) => (
          <div
            key={other.seat}
            className={`og-member${state.turn === other.seat && !state.finished ? " og-member-turn" : ""}`}
          >
            <span className="og-member-name">
              {other.name}
              {state.turn === other.seat && !state.finished ? "（手番）" : ""}
            </span>
            <span className="og-member-meta">
              {other.finished !== null ? `${other.finished}位` : `残り ${other.count} 枚`}
            </span>
          </div>
        ))}
      </div>

      {/* 場 */}
      <section className="og-field-area" aria-label="場のカード">
        {state.field ? (
          <>
            <div className="og-field-cards">
              {state.field.cards.map((id, i) => (
                <span key={`${id}-${i}`} className={`og-card og-card-field${isRedCard(id) ? " og-card-red" : ""}`}>
                  <CardFace id={id} big />
                </span>
              ))}
            </div>
            <p className="og-status-line">{nameOf(state.field.seat)} が出しました</p>
          </>
        ) : (
          <p className="og-status-line">場は流れています。好きなカードを出せます。</p>
        )}
      </section>

      {/* 終了時の全順位 */}
      {state.finished && (
        <section className="og-result" aria-label="最終順位">
          <h2>最終順位</h2>
          <ol className="og-result-list">
            {state.finishOrder.map((seat, index) => (
              <li key={seat} className={seat === mySeat ? "og-result-mine" : ""}>
                <span className="og-result-rank">{index + 1}位</span>
                <span>{nameOf(seat)}</span>
                {seat === mySeat && <span className="og-badge">あなた</span>}
              </li>
            ))}
          </ol>
          {state.yourRank !== null && (
            <p className="og-status-line">
              あなたは {state.yourRank} 位でした。
            </p>
          )}
        </section>
      )}

      {/* 自分の手札と操作 */}
      {!state.finished && (
        <>
          <div className="og-hand" role="group" aria-label="あなたの手札">
            {state.yourHand.map((id) => {
              const isSelected = selected.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  className={`og-card${isRedCard(id) ? " og-card-red" : ""}${isSelected ? " og-card-selected" : ""}`}
                  aria-pressed={isSelected}
                  aria-label={cardAriaLabel(id)}
                  disabled={!isMyTurn}
                  onClick={() => toggleCard(id)}
                >
                  <CardFace id={id} />
                </button>
              );
            })}
          </div>
          <div className="og-actions">
            <button type="button" className="og-button og-button-primary" disabled={!isMyTurn || selected.length === 0} onClick={playSelected}>
              出す{selected.length > 0 ? `（${selected.length}枚）` : ""}
            </button>
            <button type="button" className="og-button" disabled={!isMyTurn} onClick={pass}>
              パス
            </button>
            {state.yourRank === null && !isMyTurn && <span className="og-status-line">相手の手を待っています…</span>}
          </div>
        </>
      )}

      {/* ログ（新しい順） */}
      {recentLog.length > 0 && (
        <section className="og-log" aria-label="対戦ログ">
          <h2>ログ</h2>
          <ul className="og-log-list">
            {recentLog.map((entry, i) => (
              <li key={`${view.revision}-${i}`}>
                {entry.kind === "play" ? (
                  <span>
                    {nameOf(entry.seat)} が {(entry.cards ?? []).map((id) => cardLabel(id)).join(" ")} を出しました
                  </span>
                ) : (
                  <span>{nameOf(entry.seat)} がパスしました</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
