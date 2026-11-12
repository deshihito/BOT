"use client";
// バックギャモン（対CPU）。ロジックは lib/backgammon.ts。
// 自分のコマ（白）をタップして選び、光った移動先をタップする。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { sfxDice, sfxLose, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import {
  bgApplyMove,
  bgChooseMove,
  bgCreateGame,
  bgLegalMoves,
  bgPassTurn,
  bgPipCount,
  bgRollDice,
  type BgFrom,
  type BgMove,
  type BgState,
} from "@/lib/backgammon";
import { useGamesNav } from "../GamesShell";

function newGame(): BgState {
  return bgCreateGame(Date.now() % 2147483647);
}

const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function CheckerStack({
  count,
  mine,
  cpu,
  selected,
  isTarget,
  onClick,
  label,
}: {
  count: number;
  mine: boolean;
  cpu: boolean;
  selected: boolean;
  isTarget: boolean;
  onClick?: () => void;
  label: string;
}) {
  const shown = Math.min(count, 5);
  return (
    <button
      type="button"
      className={selected ? "juice-pulse" : isTarget ? "juice-pop" : undefined}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      disabled={!onClick}
      style={{
        width: "100%",
        minHeight: 74,
        border: isTarget ? "2px solid #d97706" : "1px solid #d6c9a8",
        borderRadius: 6,
        background: isTarget ? "#fef3c7" : selected ? "#dbeafe" : "#f5ecd7",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        padding: "3px 1px",
        gap: 1,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 17,
            height: 17,
            borderRadius: "50%",
            background: mine ? "#f8fafc" : cpu ? "#1f2937" : "transparent",
            border: mine ? "2px solid #64748b" : "2px solid #000000",
            display: "block",
            flex: "0 0 auto",
          }}
        />
      ))}
      {count > 5 ? (
        <span style={{ fontSize: 10, fontWeight: 700, color: "#374151" }}>×{count}</span>
      ) : null}
      {count === 0 ? <span style={{ fontSize: 10, color: "#a8a29e" }}>・</span> : null}
    </button>
  );
}

export default function BackgammonClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<BgState>(() => newGame());
  const [selected, setSelected] = useState<BgFrom | null>(null);
  const endSfxRef = useRef<number | null>(null);

  const myTurn = state.turn === 0 && state.phase !== "finished";
  const legal = useMemo(
    () => (myTurn && state.phase === "move" ? bgLegalMoves(state) : []),
    [state, myTurn],
  );
  const targets = useMemo(
    () => (selected === null ? [] : legal.filter((m) => m.from === selected)),
    [legal, selected],
  );

  // 手が変わるたびに選択をリセット
  useEffect(() => {
    setSelected(null);
  }, [state]);

  useEffect(() => {
    if (state.phase !== "finished") return;
    if (endSfxRef.current === state.seed) return;
    endSfxRef.current = state.seed;
    if (state.winner === 0) sfxWin();
    else sfxLose();
  }, [state.phase, state.seed, state.winner]);

  // CPU の手番: ダイス→1手ずつ進める
  useEffect(() => {
    if (state.phase === "finished" || state.turn !== 1) return;
    const timer = setTimeout(() => {
      if (state.phase === "roll") sfxDice();
      else if (bgChooseMove(state)) sfxPlace();
      setState((s) => {
        if (s.phase === "finished" || s.turn !== 1) return s;
        if (s.phase === "roll") return bgRollDice(s);
        const move = bgChooseMove(s);
        if (!move) return bgPassTurn(s);
        return bgApplyMove(s, move);
      });
    }, 650);
    return () => clearTimeout(timer);
  }, [state]);

  const restart = () => {
    sfxTap();
    endSfxRef.current = null;
    setState(newGame());
    setSelected(null);
  };

  const applyMove = (move: BgMove) => {
    sfxPlace();
    setState((s) => bgApplyMove(s, move));
  };

  const onPointClick = (index: number) => {
    if (!myTurn || state.phase !== "move") return;
    // 移動先として選ばれた場合
    const dest = targets.find((m) => m.to === index);
    if (dest && selected !== null) {
      applyMove(dest);
      return;
    }
    sfxTap();
    // 自分のコマがあるマス／バーを選択
    if (state.bar[0] > 0) {
      if (legal.some((m) => m.from === "bar")) setSelected("bar");
      return;
    }
    if (state.points[index] > 0 && legal.some((m) => m.from === index)) {
      setSelected(index);
    } else {
      setSelected(null);
    }
  };

  const bearOffMove: BgMove | undefined = targets.find((m) => m.to === "off");

  const statusText =
    state.phase === "finished"
      ? state.winner === 0
        ? "あなたの勝ちです！"
        : "CPUの勝ちです。"
      : state.turn === 1
        ? "CPUが考え中です…"
        : state.phase === "roll"
          ? "ダイスを振ってください。"
          : legal.length === 0
            ? "動かせる手がありません。パスしてください。"
            : selected === null
              ? state.bar[0] > 0
                ? "バーにコマがあります。盤のマスをタップすると復帰先が光ります。"
                : "動かすコマを選んでください。"
              : "移動先を選んでください。";

  const topRow = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  const bottomRow = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

  const renderPoint = (index: number) => {
    const value = state.points[index];
    const count = Math.abs(value);
    const mine = value > 0;
    const cpu = value < 0;
    const isSelected = selected === index;
    const isTarget = targets.some((m) => m.to === index);
    const clickable =
      myTurn &&
      state.phase === "move" &&
      (isTarget || (state.bar[0] === 0 && value > 0 && legal.some((m) => m.from === index)));
    return (
      <div key={index}>
        <CheckerStack
          count={count}
          mine={mine}
          cpu={cpu}
          selected={isSelected}
          isTarget={isTarget}
          onClick={clickable || isTarget ? () => onPointClick(index) : undefined}
          label={`${index + 1}のマス${count > 0 ? ` ${mine ? "自分のコマ" : "CPUのコマ"}${count}個` : ""}`}
        />
        <div style={{ textAlign: "center", fontSize: 10, color: "#78716c" }}>{index + 1}</div>
      </div>
    );
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>バックギャモン</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>バックギャモン</h1>
        <p className="muted">
          白があなた、黒がCPUです（あなたは24→1の向きに進みます）。自分のコマをタップして選び、光った移動先をタップします。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        {myTurn && state.phase === "roll" ? (
          <button
            type="button"
            className="classic-btn classic-btn-active"
            onClick={() => {
              sfxDice();
              setState((s) => bgRollDice(s));
            }}
          >
            ダイスを振る
          </button>
        ) : null}
        {myTurn && state.phase === "move" && legal.length === 0 ? (
          <button
            type="button"
            className="classic-btn classic-btn-active"
            onClick={() => {
              sfxTap();
              setState((s) => bgPassTurn(s));
            }}
          >
            パスする
          </button>
        ) : null}
        {bearOffMove ? (
          <button
            type="button"
            className="classic-btn classic-btn-active"
            onClick={() => applyMove(bearOffMove)}
          >
            ⬆ 上がる（ベアオフ）
          </button>
        ) : null}
        {state.bar[0] > 0 && myTurn && state.phase === "move" ? (
          <button
            type="button"
            className={selected === "bar" ? "classic-btn classic-btn-active" : "classic-btn"}
            onClick={() => {
              sfxTap();
              setSelected("bar");
            }}
          >
            バーから復帰（{state.bar[0]}個）
          </button>
        ) : null}
      </div>

      <p className="classic-status" role="status">
        {state.lastRoll ? (
          <span key={`${state.lastRoll[0]}-${state.lastRoll[1]}-${state.dice.length}`} className="juice-pop">
            {`ダイス ${DICE_FACES[state.lastRoll[0]]}${DICE_FACES[state.lastRoll[1]]}`}
          </span>
        ) : (
          "ダイス未"
        )}
        {state.phase === "move" && state.dice.length > 0
          ? ` ・ 残りの目 ${state.dice.join("、")}`
          : ""}
        {" ・ "}上がり あなた {state.off[0]} / CPU {state.off[1]}
        {" ・ "}残り距離 あなた {bgPipCount(state, 0)} / CPU {bgPipCount(state, 1)}
        {state.bar[0] + state.bar[1] > 0
          ? ` ・ バー あなた ${state.bar[0]} / CPU ${state.bar[1]}`
          : ""}{" "}
        ・ {statusText}
      </p>

      {state.phase === "finished" && (
        <EndScreen
          outcome={state.winner === 0 ? "win" : "lose"}
          title={state.winner === 0 ? "あなたの勝ちです！" : "CPUの勝ちです。"}
          onRetry={restart}
        >
          <p className="muted" style={{ margin: 0 }}>
            上がり あなた {state.off[0]} / CPU {state.off[1]} ・ 残り距離 あなた {bgPipCount(state, 0)} / CPU{" "}
            {bgPipCount(state, 1)}
          </p>
        </EndScreen>
      )}

      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <div
          role="group"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
            gap: 3,
          }}
          aria-label="バックギャモンの盤（上段）"
        >
          {topRow.map(renderPoint)}
        </div>
        <div
          aria-hidden="true"
          style={{ height: 6, background: "#b45309", borderRadius: 3, margin: "6px 0" }}
        />
        <div
          role="group"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
            gap: 3,
          }}
          aria-label="バックギャモンの盤（下段）"
        >
          {bottomRow.map(renderPoint)}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          上段は13〜24、下段は12〜1のマス。あなたのホームは下段右側の1〜6です。
        </p>
      </div>
    </>
  );
}
