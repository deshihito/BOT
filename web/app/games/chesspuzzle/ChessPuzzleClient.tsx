"use client";
// 詰めチェス。王手をかけ続けて指定手数で詰ませるパズル。ロジックとソルバーは lib/chesspuzzle.ts。
// 黒の応手は「最も粘る手」が自動で指される。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CHESS_PROBLEMS,
  createChessPuzzleGame,
  hintMove,
  moveNotation,
  playableMoves,
  playPuzzleMove,
  squareName,
  undoPuzzleMove,
  type CpGameState,
  type CpMove,
  type CpPieceType,
} from "@/lib/chesspuzzle";
import { sfxPlace, sfxSlide, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const GLYPHS: Record<string, string> = {
  wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
  bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
};

const SOLVED_KEY = "ago-chesspuzzle-solved";
const PROMOTIONS: CpPieceType[] = ["Q", "R", "B", "N"];

function loadSolved(): string[] {
  try {
    const raw = window.localStorage.getItem(SOLVED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export default function ChessPuzzleClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<CpGameState>(() => createChessPuzzleGame(CHESS_PROBLEMS[0].id));
  const [selected, setSelected] = useState<number | null>(null);
  const [promoOptions, setPromoOptions] = useState<CpMove[] | null>(null);
  const [hint, setHint] = useState<CpMove | null>(null);
  const [solvedIds, setSolvedIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string>("");
  const prevStatusRef = useRef(state.status);

  // 終局遷移の瞬間だけジングルを鳴らす。
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev !== state.status && state.status === "solved") sfxWin();
  }, [state.status]);

  const problem = CHESS_PROBLEMS.find((p) => p.id === state.problemId) ?? CHESS_PROBLEMS[0];
  const moves = useMemo(() => playableMoves(state), [state]);

  useEffect(() => {
    setSolvedIds(loadSolved());
  }, []);

  useEffect(() => {
    if (state.status !== "solved" || solvedIds.includes(state.problemId)) return;
    const next = [...solvedIds, state.problemId];
    setSolvedIds(next);
    try {
      window.localStorage.setItem(SOLVED_KEY, JSON.stringify(next));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, state.problemId, solvedIds]);

  const targets = useMemo(() => {
    if (selected === null) return new Map<number, CpMove[]>();
    const map = new Map<number, CpMove[]>();
    for (const m of moves) {
      if (m.from === selected) map.set(m.to, [...(map.get(m.to) ?? []), m]);
    }
    return map;
  }, [moves, selected]);

  const startProblem = (id: string) => {
    setState(createChessPuzzleGame(id));
    setSelected(null);
    setPromoOptions(null);
    setHint(null);
    setMessage("");
  };

  const doMove = (m: CpMove) => {
    const next = playPuzzleMove(state, m);
    if (next !== state && next.status !== "solved") sfxPlace();
    setState(next);
    setSelected(null);
    setPromoOptions(null);
    setHint(null);
    setMessage("");
  };

  const onSquare = (index: number) => {
    if (state.status !== "playing") return;
    if (selected !== null && targets.has(index)) {
      const options = targets.get(index) as CpMove[];
      if (options.length > 1) {
        sfxTap();
        setPromoOptions(options);
      } else {
        doMove(options[0]);
      }
      return;
    }
    const piece = state.position.board[index];
    if (piece && piece.color === "w") {
      const has = moves.some((m) => m.from === index);
      if (has) sfxTap();
      else sfxWrong();
      setSelected(index);
      setPromoOptions(null);
      setMessage(has ? "" : "その駒で王手をかける手はありません。");
    } else {
      setSelected(null);
      setPromoOptions(null);
      setMessage("");
    }
  };

  const showHint = () => {
    if (state.status !== "playing") return;
    const h = hintMove(state);
    if (!h) {
      sfxWrong();
      setMessage("ヒントが見つかりませんでした。「1手戻す」で戻って別の手を試してください。");
      return;
    }
    sfxTap();
    setHint(h);
    setMessage(`ヒント: ${moveNotation(state.position, h)}`);
  };

  const undoMove = () => {
    if (state.history.length === 0) return;
    sfxSlide();
    setState((s) => undoPuzzleMove(s));
    setSelected(null);
    setPromoOptions(null);
    setHint(null);
    setMessage("");
  };

  // 盤面の左スワイプ = 1手戻す、上スワイプ = ヒント。H / U キーでも同じ操作ができる。
  // 盤面の子のマス onClick との二重発火は useGesture の suppressClickAfterSwipe が抑止する。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "left") undoMove();
      else if (dir === "up") showHint();
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // タップ対象物は Enter / Space しか受けないため H / U との二重発火はない。
      if (e.key === "h" || e.key === "H") showHint();
      else if (e.key === "u" || e.key === "U") undoMove();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const remaining = problem.mateIn - state.history.length;
  const statusText =
    state.status === "solved"
      ? `詰ませました！（${state.history.length} 手でクリア）`
      : message ||
        (state.status === "playing" && moves.length === 0
          ? "王手になる手がもうありません。「1手戻す」か「もう一度」でやり直してください。"
          : state.lastReply
            ? remaining > 0
              ? `黒の応手: ${state.lastReply}。あなたの手番です（残り ${remaining} 手で詰み）。`
              : `黒の応手: ${state.lastReply}。指定手数を超えました。そのまま詰ませることもできます。`
            : `${problem.mateIn} 手で詰ませてください。王手になる手だけ指せます。`);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: 16 }}>
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        <Link href={`${prefix}/games`}>ゲーム</Link> / 詰めチェス
      </p>
      <h1 style={{ fontSize: 22, margin: "0 0 4px" }}>詰めチェス</h1>
      <p style={{ fontSize: 13, color: "#666", margin: "0 0 12px" }}>
        白の駒をタップして選び、移動先のマスをタップして指します。盤面を左にスワイプで1手戻す、上にスワイプでヒント（H / U キーでも可）。
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }} role="group" aria-label="問題を選ぶ">
        {CHESS_PROBLEMS.map((p, i) => (
          <div
            key={p.id}
            {...tappableProps(() => startProblem(p.id))}
            className="classic-btn"
            aria-pressed={p.id === state.problemId}
            style={{
              minHeight: 40,
              padding: "6px 10px",
              fontWeight: p.id === state.problemId ? 700 : 400,
              border: p.id === state.problemId ? "2px solid #3366cc" : undefined,
            }}
          >
            {i + 1}. {p.title}（{p.mateIn}手詰め）{solvedIds.includes(p.id) ? " ✓" : ""}
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 17, margin: "0 0 2px" }}>
        {problem.title}（{problem.mateIn}手詰め）
      </h2>
      <p style={{ fontSize: 13, color: "#666", margin: "0 0 8px" }}>{problem.comment}</p>
      <p role="status" style={{ fontSize: 14, margin: "0 0 10px", minHeight: 20 }}>
        {statusText}
      </p>

      <div
        role="grid"
        aria-label="チェス盤"
        {...boardGesture}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(8, 1fr)",
          border: "2px solid #5b4632",
          borderRadius: 6,
          overflow: "hidden",
          maxWidth: 440,
          touchAction: "none",
        }}
      >
        {Array.from({ length: 64 }, (_, viewIndex) => {
          const rank = 7 - Math.floor(viewIndex / 8);
          const file = viewIndex % 8;
          const index = rank * 8 + file;
          const piece = state.position.board[index];
          const dark = (rank + file) % 2 === 0;
          const isSelected = selected === index;
          const isTarget = targets.has(index);
          const isHintFrom = hint?.from === index;
          const isHintTo = hint?.to === index;
          return (
            <div
              key={index}
              role="gridcell"
              tabIndex={0}
              aria-label={`${squareName(index)}${piece ? ` ${piece.color === "w" ? "白" : "黒"}の${piece.type}` : ""}`}
              className={isSelected ? "juice-pulse" : undefined}
              onClick={() => onSquare(index)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onSquare(index);
              }}
              style={{
                aspectRatio: "1",
                minHeight: 44,
                border: "none",
                padding: 0,
                cursor: state.status === "playing" ? "pointer" : "default",
                background: isSelected
                  ? "#ffd94d"
                  : isHintFrom || isHintTo
                    ? "#b7e07a"
                    : dark
                      ? "#b58863"
                      : "#f0d9b5",
                boxShadow: isTarget ? "inset 0 0 0 3px #3366cc" : undefined,
                fontSize: 30,
                lineHeight: 1,
                color: piece?.color === "b" ? "#14100c" : "#ffffff",
                textShadow:
                  piece?.color === "w"
                    ? "0 0 2px #000, 0 0 3px #000"
                    : "0 0 2px #fff",
                position: "relative",
              }}
            >
              {piece ? GLYPHS[piece.color + piece.type] : ""}
              {isTarget && !piece ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#3366cc",
                    fontSize: 18,
                  }}
                >
                  ●
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {promoOptions && (
        <div className="juice-pop" style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }} role="group" aria-label="昇格する駒を選ぶ">
          <span style={{ fontSize: 13 }}>昇格:</span>
          {PROMOTIONS.map((p) => {
            const opt = promoOptions.find((m) => (m.promotion ?? "Q") === p);
            if (!opt) return null;
            return (
              <div
                key={p}
                {...tappableProps(() => doMove(opt))}
                className="classic-btn"
                style={{ minHeight: 40, minWidth: 44, fontSize: 20 }}
              >
                {GLYPHS["w" + p]} {p}
              </div>
            );
          })}
          <div
            {...tappableProps(() => setPromoOptions(null))}
            className="classic-btn"
            style={{ minHeight: 40 }}
          >
            やめる
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        <button type="button" className="classic-btn" style={{ minHeight: 40 }} onClick={() => startProblem(state.problemId)}>
          もう一度
        </button>
      </div>

      {state.plies.length > 0 && (
        <p style={{ fontSize: 13, color: "#444", marginTop: 12 }}>
          棋譜:{" "}
          {state.plies.map((ply, i) =>
            i % 2 === 0 ? `${i / 2 + 1}. ${ply}` : ply,
          ).join(" ")}
        </p>
      )}
      <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
        解けた問題: {solvedIds.length} / {CHESS_PROBLEMS.length}（端末に記録されます）
      </p>

      {state.status === "solved" && (
        <div style={{ marginTop: 16 }}>
          <EndScreen
            outcome="win"
            title="詰ませました！"
            score={state.history.length}
            scoreLabel="手数"
            onRetry={() => startProblem(state.problemId)}
          >
            <p className="muted">
              「{problem.title}」（{problem.mateIn}手詰め）を解きました。解けた問題は {solvedIds.length} / {CHESS_PROBLEMS.length} です。
            </p>
          </EndScreen>
        </div>
      )}
    </div>
  );
}
