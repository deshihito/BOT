"use client";
// 計算レース オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/calcrace.ts の viewFor）:
//   phase question: questionText と players[].solved のみ公開（提出値は一切渡らない）
//   phase reveal: correctAnswer と players[].gained/winner が開示される
//   phase finished: standings が付く
// 回答は { type: "answer", value }。得点は各問題の最初の正解者だけが
// 100 + 残り秒数×5 点を得る。不正解はその問題だけ 3 秒ロック。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

/** サーバー側モジュール（lib/online/games/calcrace.ts）と一致させること。 */
const CR_TIME_LIMIT_MS = 20000;
const CR_LOCK_MS = 3000;

type CrViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  solved: boolean;
  gained?: number;
  winner?: boolean;
};

type CrView = {
  phase: "question" | "reveal" | "finished";
  index: number;
  totalQuestions: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  questionText: string | null;
  correctAnswer: number | null;
  you: { seat: number; solved: boolean; lockedUntil: number | null; left: boolean };
  players: CrViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

function Bar({ ratio }: { ratio: number }) {
  return (
    <div aria-hidden style={{ height: 8, borderRadius: 4, background: "var(--soft)", overflow: "hidden", marginTop: 8 }}>
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
  const state = view.state as CrView | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [input, setInput] = useState("");
  const finishRef = useRef<string | null>(null);
  const prevPhaseRef = useRef<string>("");
  const turnRef = useRef<string | null>(null);
  const lockRef = useRef<number | null>(null);

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

  // 新しい問題が出たら合図を1回だけ鳴らす。
  useEffect(() => {
    if (!state || state.phase !== "question") return;
    const key = `${view.code}:${state.index}`;
    if (turnRef.current === key) return;
    turnRef.current = key;
    playSe("turn");
  }, [state, view.code]);

  // 自分の不正解でロックされたらエラー音を1回だけ鳴らす。
  useEffect(() => {
    if (!state || state.you.lockedUntil === null) return;
    if (lockRef.current === state.you.lockedUntil) return;
    lockRef.current = state.you.lockedUntil;
    playSe("error");
  }, [state]);

  // 問題が変わったら入力をリセットする。
  const roundKey = state ? `${view.code}:${state.index}:${state.phase}` : "";
  const lastRoundKey = useRef(roundKey);
  useEffect(() => {
    if (lastRoundKey.current !== roundKey) {
      lastRoundKey.current = roundKey;
      setInput("");
    }
    if (state && state.phase === "reveal" && prevPhaseRef.current !== "reveal") {
      const winner = state.players.find((p) => p.winner);
      if (winner) playSe(winner.seat === mySeat ? "win" : "click");
    }
    if (state) prevPhaseRef.current = state.phase;
  }, [roundKey, state, mySeat]);

  if (!state) return <p className="og-muted">出題を待っています…</p>;

  const lockedMs = state.you.lockedUntil !== null ? Math.max(0, state.you.lockedUntil - now) : 0;
  const locked = lockedMs > 0;
  const canAnswer = state.phase === "question" && !state.you.solved && !state.you.left && !locked;
  const remaining = state.questionEndsAt !== null ? Math.max(0, state.questionEndsAt - now) : null;

  const submit = () => {
    const value = Number(input);
    if (!Number.isInteger(value) || Math.abs(value) > 999999 || input.trim() === "") {
      api.setError("答えは整数で入力してください");
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
            {state.phase === "question" ? (p.solved ? " ・ 正解済み" : "") : ""}
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        第 {state.index + 1} 問 / 全{state.totalQuestions}問 ・ 最初の正解者が得点（速いほど高得点）
      </p>

      {state.phase === "question" && (
        <div style={{ padding: "12px 0 4px" }}>
          <div key={state.index} className="juice-slide" aria-live="polite" style={{ textAlign: "center", fontSize: 44, fontWeight: 800, lineHeight: 1.2, minHeight: 56 }}>
            {state.questionText ?? "…"}
          </div>
          {remaining !== null && <Bar ratio={remaining / CR_TIME_LIMIT_MS} />}
          {state.you.left ? (
            <p className="og-muted" style={{ textAlign: "center" }}>
              退出したため、このゲームには参加していません。
            </p>
          ) : state.you.solved ? (
            <p className="og-muted juice-pop" style={{ textAlign: "center" }}>
              正解済みです。他の人の正解を待っています。
            </p>
          ) : locked ? (
            <p className="og-muted juice-shake" style={{ textAlign: "center" }} role="status">
              不正解でした。あと {(lockedMs / 1000).toFixed(1)} 秒で再挑戦できます。
              <Bar ratio={lockedMs / CR_LOCK_MS} />
            </p>
          ) : (
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
              <input
                type="number"
                inputMode="numeric"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                placeholder="答えを入力"
                aria-label="答え"
                style={{ fontSize: 20, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--line)", width: 180, minHeight: 48 }}
              />
              <button type="button" className="classic-btn" style={{ minHeight: 48, fontSize: 16, fontWeight: 700 }} onClick={submit} disabled={!canAnswer}>
                回答する
              </button>
            </div>
          )}
        </div>
      )}

      {state.phase === "reveal" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <p style={{ textAlign: "center", fontSize: 20 }}>
            {state.questionText} = <strong key={state.index} className="juice-pop" style={{ fontSize: 28 }}>{state.correctAnswer}</strong>
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
                  {p.solved ? "正解" : "不正解・未回答"}
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
                <li key={s.seat} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 10px", fontWeight: s.rank === 1 ? 700 : 400 }}>
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
          <p className="og-muted">全{state.totalQuestions}問が終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      )}
    </div>
  );
}

export default function CalcRaceClient() {
  return (
    <OnlineShell gameId="calcrace" title="計算レース" playerRange={{ min: 2, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
