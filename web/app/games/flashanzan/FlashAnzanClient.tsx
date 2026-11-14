"use client";
// フラッシュ暗算 オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/flashanzan.ts の viewFor）:
//   phase showing: currentNumber が全員に表示される（数字列そのものは渡らない）
//   phase answer: players[].answered のみ公開、回答は秘匿
//   phase reveal: correctAnswer と players[].value/diff/gained/winner が開示される
//   phase finished: standings が付く
// 回答は { type: "answer", value }。進行はサーバー側の tick で進む。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";

/** サーバー側モジュール（lib/online/games/flashanzan.ts）と一致させること。 */
const FA_SHOW_INTERVAL_MS = 1200;
const FA_ANSWER_LIMIT_MS = 15000;

type FaViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  answered: boolean;
  value?: number | null;
  diff?: number | null;
  gained?: number;
  winner?: boolean;
};

type FaView = {
  phase: "showing" | "answer" | "reveal" | "finished";
  round: number;
  totalRounds: number;
  currentNumber: number | null;
  shownCount: number;
  totalNumbers: number;
  showEndsAt: number | null;
  answerEndsAt: number | null;
  revealEndsAt: number | null;
  correctAnswer: number | null;
  you: { seat: number; answered: boolean; yourValue: number | null; left: boolean };
  players: FaViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

function Bar({ ratio }: { ratio: number }) {
  return (
    <div
      aria-hidden
      style={{ height: 8, borderRadius: 4, background: "var(--soft)", overflow: "hidden", marginTop: 8 }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
          background: "var(--accent)",
          transition: "width 0.2s linear",
        }}
      />
    </div>
  );
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as FaView | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.phase ?? ""}:${state?.round ?? ""}`, state?.phase === "finished");
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [input, setInput] = useState("");
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  // 新しいラウンドの出題が始まったら合図を1回だけ鳴らす。
  useEffect(() => {
    if (!state || state.phase !== "showing") return;
    const key = `${view.code}:${state.round}`;
    if (turnRef.current === key) return;
    turnRef.current = key;
    playSe("turn");
  }, [state, view.code]);

  // ラウンドが変わったら入力をリセットする。
  const roundKey = state ? `${view.code}:${state.round}:${state.phase}` : "";
  const lastRoundKey = useRef(roundKey);
  useEffect(() => {
    if (lastRoundKey.current !== roundKey) {
      lastRoundKey.current = roundKey;
      setInput("");
    }
  }, [roundKey]);

  if (!state) return <p className="og-muted">出題を待っています…</p>;

  const canAnswer = state.phase === "answer" && !state.you.answered && !state.you.left;
  const answerRemaining =
    state.answerEndsAt !== null ? Math.max(0, state.answerEndsAt - now) : null;
  const showRatio =
    state.showEndsAt !== null
      ? Math.max(0, state.showEndsAt - now) / FA_SHOW_INTERVAL_MS
      : 0;

  const submit = () => {
    if (input.trim() === "") {
      api.setError("合計を入力してください");
      return;
    }
    const value = Number(input);
    if (!Number.isInteger(value) || value < 0 || value > 99999) {
      api.setError("0〜99999 の整数で答えてください");
      return;
    }
    playSe("submit");
    void api.move({ type: "answer", value });
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
            {state.phase === "answer" ? (p.answered ? " ・ 回答済み" : " ・ 考え中") : ""}
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        ラウンド {state.round + 1} / {state.totalRounds}
      </p>

      {state.phase === "showing" && (
        <div style={{ textAlign: "center", padding: "12px 0 4px" }}>
          <div
            key={`${state.round}:${state.shownCount}:${state.currentNumber ?? ""}`}
            className="juice-flip"
            aria-live="polite"
            style={{ fontSize: 96, fontWeight: 800, lineHeight: 1.1, minHeight: 110 }}
          >
            {state.currentNumber ?? "…"}
          </div>
          <p className="og-muted">
            {state.shownCount} / {state.totalNumbers} 個目
          </p>
          <Bar ratio={showRatio} />
          <p className="og-muted">数字を全部足して覚えておこう。</p>
        </div>
      )}

      {state.phase === "answer" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <p className="juice-pulse" style={{ fontWeight: 700, textAlign: "center" }}>合計はいくつ？</p>
          {answerRemaining !== null && <Bar ratio={answerRemaining / FA_ANSWER_LIMIT_MS} />}
          {canAnswer ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "center",
                marginTop: 14,
                flexWrap: "wrap",
              }}
            >
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={99999}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                placeholder="合計を入力"
                aria-label="合計"
                style={{
                  fontSize: 20,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  width: 180,
                  minHeight: 48,
                }}
              />
              <button
                type="button"
                className="classic-btn"
                style={{ minHeight: 48, fontSize: 16, fontWeight: 700 }}
                onClick={submit}
              >
                回答する
              </button>
            </div>
          ) : (
            <p className="og-muted" style={{ textAlign: "center" }}>
              {state.you.left
                ? "退出したため、このゲームには参加していません。"
                : `あなたの回答: ${state.you.yourValue ?? "—"}（他の人の回答は締切まで見えません）`}
            </p>
          )}
        </div>
      )}

      {state.phase === "reveal" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <p style={{ textAlign: "center", fontSize: 20 }}>
            正解は <strong key={state.round} className="juice-pop" style={{ fontSize: 28 }}>{state.correctAnswer}</strong>
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {state.players.map((p) => (
              <li
                key={p.seat}
                className={p.winner ? "juice-pop" : undefined}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: p.winner ? "var(--accent-soft)" : undefined,
                  fontWeight: p.winner ? 700 : 400,
                }}
              >
                <span>
                  {p.winner ? "" : ""}
                  {p.name}
                  {p.seat === mySeat ? "（あなた）" : ""}
                  {p.left ? "（退出）" : ""}
                </span>
                <span>
                  {p.value === null || p.value === undefined
                    ? "未回答"
                    : `${p.value}（差 ${p.diff ?? "—"}）`}
                  {p.gained ? ` ・ +${p.gained}点` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.phase === "finished" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <h2 className="juice-pulse" style={{ textAlign: "center" }}>結果</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {(state.standings ?? []).map((s) => {
              const p = state.players.find((x) => x.seat === s.seat);
              if (!p) return null;
              return (
                <li
                  key={s.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "6px 10px",
                    fontWeight: s.rank === 1 ? 700 : 400,
                  }}
                >
                  <span>
                    {s.rank}位 {p.name}
                    {s.seat === mySeat ? "（あなた）" : ""}
                    {p.left ? "（退出）" : ""}
                  </span>
                  <strong>{s.score}点</strong>
                </li>
              );
            })}
          </ul>
          <p className="og-muted">全{state.totalRounds}ラウンドが終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      )}
    </div>
  );
}

export default function FlashAnzanClient() {
  return (
    <OnlineShell gameId="flashanzan" title="フラッシュ暗算" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
