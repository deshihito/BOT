"use client";
// 爆弾パス（オンライン）クライアント。ルーム管理は OnlineShell が担い、
// このコンポーネントは view.state（ゲーム別ビュー）の描画とパス操作だけを持つ。
// 爆発までの残り時間はサーバー側でも伏せられ、ビューには含まれない（全員非表示）。
import { useEffect, useRef } from "react";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { playSe } from "@/lib/balku-sound";

type BombEvent =
  | { kind: "pass"; from: number; to: number }
  | { kind: "explode"; seat: number }
  | { kind: "eliminate"; seat: number }
  | { kind: "left"; seat: number };

type BombPlayer = {
  seat: number;
  name: string;
  losses: number;
  alive: boolean;
  left: boolean;
  isHolder: boolean;
};

type BombView = {
  phase: "playing" | "finished";
  holder: number;
  round: number;
  you: { seat: number; alive: boolean; left: boolean; isHolder: boolean };
  players: BombPlayer[];
  finished: boolean;
  winner: number | null;
  lastEvent: BombEvent | null;
};

export default function BombPassClient() {
  return (
    <OnlineShell gameId="bombpass" title="爆弾パス" playerRange={{ min: 2, max: 8 }}>
      {(view, api) => <BombTable view={view} api={api} />}
    </OnlineShell>
  );
}

function BombTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as BombView | null;
  const mySeat = view.player.seat;

  const finishRef = useRef(false);
  useEffect(() => {
    if (!state || finishRef.current) return;
    if (state.finished) {
      finishRef.current = true;
      playSe(state.winner === mySeat ? "win" : "lose");
    }
  }, [state, mySeat]);

  const boomRef = useRef<BombEvent | null>(null);
  useEffect(() => {
    if (!state?.lastEvent) return;
    if (boomRef.current === state.lastEvent) return;
    boomRef.current = state.lastEvent;
    if (state.lastEvent.kind === "explode" || state.lastEvent.kind === "eliminate") playSe("lose");
  }, [state]);

  if (!state) {
    return <p className="og-notice">対戦の開始を待っています…</p>;
  }

  const nameOf = (seat: number): string => {
    if (seat === mySeat) return "あなた";
    const p = state.players.find((pl) => pl.seat === seat);
    return p ? p.name : `プレイヤー${seat + 1}`;
  };

  const isHolder = !state.finished && state.you.alive && state.holder === mySeat;
  const targets = state.players.filter((p) => p.alive && p.seat !== mySeat);

  const eventText = (ev: BombEvent | null): string => {
    if (!ev) return "爆弾は誰かの手にあります…いつ爆発するかは誰にも分かりません。";
    switch (ev.kind) {
      case "pass":
        return `${nameOf(ev.from)} が ${nameOf(ev.to)} に爆弾をパスしました`;
      case "explode":
        return `💥 爆発！ ${nameOf(ev.seat)} に1失点`;
      case "eliminate":
        return `💥 爆発！ ${nameOf(ev.seat)} は3失点で脱落しました`;
      case "left":
        return `${nameOf(ev.seat)} が退出しました（脱落）`;
    }
  };

  const btnStyle: React.CSSProperties = {
    padding: "10px 16px",
    borderRadius: 999,
    border: "1px solid #8a90a3",
    background: "#22304f",
    color: "#fff",
    fontSize: 15,
    fontWeight: 700,
    cursor: "pointer",
    minHeight: 44,
  };

  return (
    <div>
      <p role="status" style={{ fontWeight: 700, margin: "4px 0 10px" }}>
        {state.finished
          ? state.winner !== null
            ? `🏆 ${nameOf(state.winner)} の勝ちです！`
            : "引き分け（全員脱落）"
          : `ラウンド ${state.round} ／ 爆弾は ${nameOf(state.holder)} が持っています`}
      </p>
      <p aria-live="polite" style={{ margin: "0 0 14px", color: "#475569", fontSize: 14 }}>
        {eventText(state.lastEvent)}
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {state.players.map((p) => (
          <li
            key={p.seat}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              borderRadius: 10,
              border: p.isHolder && !state.finished ? "2px solid #dc2626" : "1px solid #e2e8f0",
              background: p.alive ? "#fff" : "#f1f5f9",
              opacity: p.alive ? 1 : 0.6,
              fontSize: 15,
            }}
          >
            <span style={{ fontSize: 20 }}>{p.isHolder && !state.finished ? "💣" : p.alive ? "🙂" : "💀"}</span>
            <span style={{ fontWeight: p.seat === mySeat ? 700 : 400 }}>
              {nameOf(p.seat)}
              {p.left && "（退出）"}
            </span>
            <span style={{ marginLeft: "auto" }} aria-label={`失点 ${p.losses}`}>
              失点: {"✖".repeat(p.losses) || "0"}
              {p.losses > 0 && `（${p.losses}）`}
            </span>
          </li>
        ))}
      </ul>

      {!state.finished && !state.you.alive && (
        <p className="og-notice">あなたは脱落しました。最後まで見届けましょう。</p>
      )}

      {isHolder && (
        <div>
          <p style={{ fontWeight: 700, margin: "0 0 8px" }}>💣 あなたが爆弾を持っています！ 誰かにパス：</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {targets.map((p) => (
              <button key={p.seat} type="button" style={btnStyle} onClick={() => void api.move({ type: "pass", target: p.seat })}>
                {nameOf(p.seat)} にパス
              </button>
            ))}
          </div>
        </div>
      )}
      {!state.finished && state.you.alive && !isHolder && (
        <p style={{ color: "#64748b", fontSize: 14 }}>爆弾が回ってくるのを待っています…</p>
      )}
      <p style={{ color: "#64748b", fontSize: 13, marginTop: 16 }}>
        ルール: 爆発した瞬間に持っていた人が1失点。3失点で脱落し、最後の1人が勝ちです。爆発までの時間は誰にも分かりません。
      </p>
    </div>
  );
}
