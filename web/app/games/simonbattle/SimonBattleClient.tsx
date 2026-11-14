"use client";
// サイモン対戦 オンラインクライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/simonbattle.ts の viewFor）:
//   phase showing: flash が1色ずつ光る（並びはこの間だけ公開される）
//   phase input: 手番の人が並びを再現する。並び自体は渡らない（inputProgress のみ）
//   phase add: 手番の人が末尾に1色追加する
//   phase finished: winnerSeat と sequence（全体）が開示される
// 操作は { type: "press", color }。進行はサーバー側の tick で進む。
import { useEffect, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { playSe } from "@/lib/balku-sound";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const SimonBattleScene3D = dynamic(() => import("./SimonBattleScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

const PADS = [
  { name: "みどり", color: "#2fbf71", dark: "#1e7f4c", freq: 329.63 },
  { name: "あか", color: "#ef476f", dark: "#a12c49", freq: 261.63 },
  { name: "きいろ", color: "#f2c531", dark: "#a8861a", freq: 392.0 },
  { name: "あお", color: "#4361ee", dark: "#2b3f9e", freq: 440.0 },
] as const;

type SbViewPlayer = {
  seat: number;
  name: string;
  out: boolean;
  left: boolean;
  isTurn: boolean;
};

type SbEvent = {
  seat: number;
  kind: "clear" | "out";
  addedColor: number | null;
  reason: "wrong" | "timeout" | "left" | null;
};

type SbView = {
  phase: "showing" | "input" | "add" | "finished";
  sequenceLength: number;
  flash: number | null;
  flashIndex: number;
  turnSeat: number;
  inputProgress: number;
  showEndsAt: number | null;
  inputEndsAt: number | null;
  addEndsAt: number | null;
  lastEvent: SbEvent | null;
  winnerSeat: number | null;
  sequence: number[] | null;
  you: { seat: number; out: boolean; left: boolean; isTurn: boolean };
  players: SbViewPlayer[];
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
  const state = view.state as SbView | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [pressed, setPressed] = useState<number | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const finishRef = useRef<string | null>(null);
  const flashRef = useRef<string>("");
  const turnRef = useRef<string | null>(null);
  const outRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  const playTone = (pad: number, durationMs = 300) => {
    try {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      if (!audioRef.current) audioRef.current = new AC();
      const ctx = audioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = PADS[pad]?.freq ?? 330;
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durationMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + durationMs / 1000 + 0.05);
    } catch {
      // 音が出せなくても点滅だけで成立させる
    }
  };

  // 再生フェーズで色が切り替わるたびに音を鳴らす。
  const flashKey = state && state.phase === "showing" ? `${state.flashIndex}:${state.flash}` : "";
  useEffect(() => {
    if (!state || state.phase !== "showing" || state.flash === null) return;
    if (flashRef.current === flashKey) return;
    flashRef.current = flashKey;
    playTone(state.flash, 280);
    // playTone は毎レンダー再生成されるが、flashKey の変化時のみ鳴らせばよい
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashKey]);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winnerSeat === mySeat ? "win" : "click");
  }, [state, mySeat, view.code]);

  // 自分の入力／追加フェーズが来たら合図を1回だけ鳴らす。
  useEffect(() => {
    if (!state) return;
    if (state.phase !== "input" && state.phase !== "add") return;
    if (!state.you.isTurn || state.you.out) return;
    const key = `${view.code}:${state.sequenceLength}:${state.phase}:${state.turnSeat}`;
    if (turnRef.current === key) return;
    turnRef.current = key;
    playSe("turn");
  }, [state, view.code]);

  // 自分が脱落したときだけエラー音を1回鳴らす（他人の脱落では鳴らさない）。
  useEffect(() => {
    if (!state || !state.lastEvent) return;
    if (state.lastEvent.kind !== "out" || state.lastEvent.seat !== mySeat) return;
    const key = `${view.code}:out:${mySeat}`;
    if (outRef.current === key) return;
    outRef.current = key;
    playSe("error");
  }, [state, mySeat, view.code]);

  if (!state) return <p className="og-muted">対戦の開始を待っています…</p>;

  const turnPlayer = state.players.find((p) => p.seat === state.turnSeat);
  const canPress =
    (state.phase === "input" || state.phase === "add") && state.you.isTurn && !state.you.out;
  const litPad =
    state.phase === "showing" ? state.flash : pressed;

  const press = (color: number) => {
    if (!canPress) return;
    playTone(color, 220);
    setPressed(color);
    setTimeout(() => setPressed((cur) => (cur === color ? null : cur)), 200);
    void api.move({ type: "press", color });
  };

  const deadline =
    state.phase === "input" ? state.inputEndsAt : state.phase === "add" ? state.addEndsAt : null;
  const limitMs =
    state.phase === "input"
      ? 8000 + state.sequenceLength * 1500
      : state.phase === "add"
        ? 10000
        : null;
  const remainingRatio =
    deadline !== null && limitMs !== null ? Math.max(0, deadline - now) / limitMs : null;

  const eventText = (() => {
    const ev = state.lastEvent;
    if (!ev) return null;
    const p = state.players.find((x) => x.seat === ev.seat);
    const name = p ? p.name : "?";
    if (ev.kind === "clear") {
      return `${name} さんが並びを再現し、「${PADS[ev.addedColor ?? 0]?.name ?? ""}」を追加しました。`;
    }
    const reason =
      ev.reason === "wrong"
        ? "間違えて"
        : ev.reason === "timeout"
          ? "時間切れで"
          : "退出して";
    return `${name} さんが${reason}脱落しました。`;
  })();

  const phaseText =
    state.phase === "showing"
      ? `${turnPlayer?.name ?? ""} さんの番。光る順番を覚えよう（${state.flashIndex + 1} / ${state.sequenceLength}）。`
      : state.phase === "input"
        ? state.you.isTurn
          ? `あなたの番です。並びを最初から押してください（${state.inputProgress} / ${state.sequenceLength}）。`
          : `${turnPlayer?.name ?? ""} さんが並びを再現中（${state.inputProgress} / ${state.sequenceLength}）。`
        : state.phase === "add"
          ? state.you.isTurn
            ? "並びを再現できました！末尾に追加する色を1つ押してください。"
            : `${turnPlayer?.name ?? ""} さんが追加する色を選んでいます。`
          : "";

  const padStyle = (index: number): CSSProperties => {
    const pad = PADS[index];
    const isLit = litPad === index;
    return {
      aspectRatio: "1",
      width: "100%",
      border: "none",
      borderRadius:
        index === 0
          ? "120px 18px 18px 18px"
          : index === 1
            ? "18px 120px 18px 18px"
            : index === 2
              ? "18px 18px 18px 120px"
              : "18px 18px 120px 18px",
      background: isLit ? pad.color : pad.dark,
      opacity: isLit ? 1 : 0.82,
      transform: isLit ? "scale(1.03)" : "scale(1)",
      transition: "background 80ms ease, opacity 80ms ease, transform 80ms ease",
      boxShadow: isLit ? `0 0 0 4px #fff, 0 0 28px ${pad.color}` : "inset 0 0 0 2px rgba(0,0,0,0.2)",
      cursor: canPress ? "pointer" : "default",
      touchAction: "manipulation",
      fontSize: 15,
      fontWeight: 800,
      color: "#fff",
      textShadow: "0 1px 3px rgba(0,0,0,0.5)",
    };
  };

  const board2d = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 12,
        width: "min(88vw, 380px)",
        margin: "14px auto 0",
        padding: 14,
        borderRadius: "50%",
        background: "#20242e",
        boxShadow: "0 8px 28px rgba(0,0,0,0.25)",
      }}
      role="group"
      aria-label="サイモンのボタン"
    >
      {PADS.map((pad, i) => (
        <button
          key={pad.name}
          type="button"
          className={litPad === i ? "juice-pop" : undefined}
          style={padStyle(i)}
          disabled={!canPress}
          aria-label={pad.name}
          onClick={() => press(i)}
        >
          {pad.name}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : p.out ? "（脱落）" : ""}
            {p.isTurn && !p.out ? " ・ 手番" : ""}
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        並びの長さ {state.sequenceLength} ・ 残り {state.players.filter((p) => !p.out).length} 人
      </p>

      {state.phase !== "finished" && (
        <>
          <p key={`${state.phase}-${state.turnSeat}-${state.sequenceLength}`} className="juice-slide" role="status" style={{ fontWeight: 700, textAlign: "center", minHeight: 24 }}>
            {phaseText}
          </p>
          {eventText && (
            <p
              className={`og-muted ${state.lastEvent?.kind === "out" && state.lastEvent.seat === mySeat ? "juice-shake" : "juice-pop"}`}
              style={{ textAlign: "center" }}
            >
              {eventText}
            </p>
          )}
          {remainingRatio !== null && <Bar ratio={remainingRatio} />}
          {webglFailed ? board2d : (
            <div style={{ maxWidth: 420, margin: "0 auto" }}>
              <SimonBattleScene3D
                lit={state.phase === "showing" ? state.flash : null}
                pressed={pressed}
                onPad={press}
                onFail={() => setWebglFailed(true)}
                fallback={board2d}
              />
            </div>
          )}
          {state.you.out && (
            <p className="og-muted" style={{ textAlign: "center" }}>
              あなたは脱落しました。対戦の様子は見られます。
            </p>
          )}
        </>
      )}

      {state.phase === "finished" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <h2 className="juice-pulse" style={{ textAlign: "center" }}>結果</h2>
          <p className={state.winnerSeat === mySeat ? "juice-pulse" : undefined} style={{ textAlign: "center", fontSize: 18 }}>
            {state.winnerSeat === null
              ? "勝者はいませんでした。"
              : state.winnerSeat === mySeat
                ? "あなたの勝ちです！"
                : `${state.players.find((p) => p.seat === state.winnerSeat)?.name ?? ""} さんの勝ちです。`}
          </p>
          {state.sequence && (
            <p className="og-muted" style={{ textAlign: "center" }}>
              最終的な並び（{state.sequence.length}）:{" "}
              {state.sequence.map((c) => PADS[c]?.name ?? "").join(" → ")}
            </p>
          )}
          <p className="og-muted" style={{ textAlign: "center" }}>
            再戦は下のボタンからどうぞ。
          </p>
        </div>
      )}
    </div>
  );
}

export default function SimonBattleClient() {
  return (
    <OnlineShell gameId="simonbattle" title="サイモン対戦" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
