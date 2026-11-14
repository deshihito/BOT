"use client";
// しりとり（オンライン）クライアント。ルーム管理は OnlineShell が担い、
// このコンポーネントは view.state（ゲーム別ビュー）の描画と単語提出だけを持つ。
// 有効な単語はサーバー側の単語バンクにあるものだけ。入力が本体のためチャットは無効。
import { useEffect, useRef, useState } from "react";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";
import { playSe } from "@/lib/balku-sound";

type ShiritoriEvent =
  | { kind: "word"; seat: number; word: string }
  | { kind: "n-foul"; seat: number; word: string }
  | { kind: "timeout"; seat: number }
  | { kind: "left"; seat: number };

type ShiritoriPlayer = { seat: number; name: string; alive: boolean; left: boolean; isTurn: boolean };

type ShiritoriView = {
  phase: "playing" | "finished";
  turn: number;
  turnEndsAt: number | null;
  requiredStart: string | null;
  history: { seat: number; word: string; foul: boolean }[];
  you: { seat: number; alive: boolean; left: boolean; isTurn: boolean };
  players: ShiritoriPlayer[];
  finished: boolean;
  winner: number | null;
  lastEvent: ShiritoriEvent | null;
};

export default function ShiritoriClient() {
  return (
    <OnlineShell gameId="shiritori" title="しりとり" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <ShiritoriTable view={view} api={api} />}
    </OnlineShell>
  );
}

function ShiritoriTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as ShiritoriView | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.turn ?? ""}`, state?.finished ?? false);
  const mySeat = view.player.seat;
  const [word, setWord] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const historyRef = useRef<HTMLDivElement | null>(null);

  // 残り時間の表示用に現在時刻を更新する。
  useEffect(() => {
    if (!state || state.finished || state.turnEndsAt === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state?.history.length]);

  const prevTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state) return;
    const prev = prevTurnRef.current;
    prevTurnRef.current = state.turn;
    if (prev !== null && prev !== state.turn && state.turn === mySeat && !state.finished && state.you.alive) playSe("turn");
  }, [state, mySeat]);

  const finishRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    if (state.finished) {
      if (finishRef.current === view.code) return;
      finishRef.current = view.code;
      playSe(state.winner === mySeat ? "win" : "lose");
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

  const remainSec =
    state.turnEndsAt !== null ? Math.max(0, Math.ceil((state.turnEndsAt - nowMs) / 1000)) : null;
  const myTurn = !state.finished && state.you.alive && state.turn === mySeat;

  const submit = async () => {
    const value = word.trim();
    if (!value) return;
    playSe("play");
    const ok = await api.move({ type: "submit", word: value });
    if (ok) setWord("");
  };

  const eventText = (ev: ShiritoriEvent | null): string | null => {
    if (!ev) return null;
    switch (ev.kind) {
      case "word":
        return `${nameOf(ev.seat)}: ${ev.word}`;
      case "n-foul":
        return `「${ev.word}」は「ン」で終わり！ ${nameOf(ev.seat)} は脱落しました`;
      case "timeout":
        return `${nameOf(ev.seat)} は時間切れで脱落しました`;
      case "left":
        return `${nameOf(ev.seat)} が退出しました（脱落）`;
    }
  };

  const lastEventText = eventText(state.lastEvent);

  return (
    <div>
      <p role="status" className={state.finished ? "juice-slide" : myTurn ? "juice-pulse" : undefined} style={{ fontWeight: 700, margin: "4px 0 6px" }}>
        {state.finished
          ? state.winner !== null
            ? `${nameOf(state.winner)} の勝ちです！`
            : "勝者なし"
          : state.turn === mySeat
            ? "あなたの番です"
            : `${nameOf(state.turn)} の番です`}
        {!state.finished && remainSec !== null && (
          <span style={{ marginLeft: 10, color: remainSec <= 5 ? "#dc2626" : "#475569" }}>残り {remainSec} 秒</span>
        )}
      </p>
      <p style={{ margin: "0 0 10px", fontSize: 15 }}>
        次の単語の最初は{" "}
        {state.requiredStart !== null ? (
          <strong style={{ fontSize: 20, color: "#db2777" }}>「{state.requiredStart}」</strong>
        ) : (
          <strong>自由</strong>
        )}
      </p>
      {lastEventText && (
        <p
          key={lastEventText}
          aria-live="polite"
          className={state.lastEvent?.kind === "n-foul" && state.lastEvent.seat === mySeat ? "juice-shake" : "juice-pop"}
          style={{ margin: "0 0 12px", color: "#475569", fontSize: 14 }}
        >
          {lastEventText}
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {state.players.map((p) => (
          <span
            key={p.seat}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              border: p.isTurn && !state.finished ? "2px solid #db2777" : "1px solid #e2e8f0",
              background: p.alive ? "#fff" : "#f1f5f9",
              opacity: p.alive ? 1 : 0.55,
              fontSize: 13,
              fontWeight: p.seat === mySeat ? 700 : 400,
            }}
          >
            {p.alive ? "○" : "✕"} {nameOf(p.seat)}
            {p.left && "（退出）"}
          </span>
        ))}
      </div>

      <div
        ref={historyRef}
        style={{
          maxHeight: 220,
          overflowY: "auto",
          border: "1px solid #e2e8f0",
          borderRadius: 10,
          padding: "8px 12px",
          marginBottom: 14,
          background: "#f8fafc",
        }}
        role="log"
        aria-label="しりとりの履歴"
      >
        {state.history.length === 0 ? (
          <p style={{ margin: 0, color: "#94a3b8", fontSize: 14 }}>まだ単語がありません。最初の単語は自由です。</p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {state.history.map((h, i) => (
              <li key={i} className={i === state.history.length - 1 ? "juice-pop" : undefined} style={{ fontSize: 15, color: h.foul ? "#dc2626" : "#1f2937" }}>
                <span style={{ color: "#64748b", fontSize: 13 }}>{nameOf(h.seat)}: </span>
                {h.word}
                {h.foul && " （反則）"}
              </li>
            ))}
          </ol>
        )}
      </div>

      {!state.finished && state.you.alive && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: "flex", gap: 8 }}
        >
          <input
            type="text"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            disabled={!myTurn}
            placeholder={state.requiredStart !== null ? `「${state.requiredStart}」から始まる単語` : "単語を入力（カタカナ）"}
            aria-label="しりとりの単語"
            autoComplete="off"
            style={{
              flex: 1,
              minHeight: 44,
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid #8a90a3",
              fontSize: 16,
            }}
          />
          <button
            type="submit"
            disabled={!myTurn || word.trim().length === 0}
            style={{
              padding: "10px 20px",
              borderRadius: 999,
              border: "1px solid #8a90a3",
              background: "#22304f",
              color: "#fff",
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
              minHeight: 44,
              opacity: !myTurn || word.trim().length === 0 ? 0.4 : 1,
            }}
          >
            出す
          </button>
        </form>
      )}
      {!state.finished && !state.you.alive && (
        <p className="og-notice">あなたは脱落しました。最後まで見届けましょう。</p>
      )}
      <p style={{ color: "#64748b", fontSize: 13, marginTop: 14 }}>
        ルール: 使えるのは単語バンクにある言葉だけ。末尾の「ー」は除いた文字でつなぎ、小さい文字は大きい文字として扱います。
        「ン」で終わる言葉を出すと脱落、1ターンは30秒です。
      </p>
    </div>
  );
}
