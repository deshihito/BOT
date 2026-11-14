"use client";
// ブラウザで完結するチェス CPU 対戦。着手生成・終局判定は lib/chess-game.ts、
// CPU の探索は Web Worker（lib/chess-cpu.worker.js）の中で lib/chess-engine.ts
// が実行する。Worker が使えない環境ではメインスレッド計算にフォールバックする。
// 対局は端末内で完結し、サーバーへ棋譜は送らない。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const ChessScene3D = dynamic(() => import("./ChessScene3D"), { ssr: false });
import {
  BLACK,
  WHITE,
  applyUciMove,
  createGame,
  gameFen,
  legalMovesFrom,
  resignGame,
  type ChessGameState,
  type LegalMove,
} from "@/lib/chess-game";
import { findBestMove } from "@/lib/chess-engine";
import { parseFen } from "@/lib/chess-perft";
import { sfxHit, sfxKo, sfxLose, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { juiceFlash, juiceHitstop, juiceShake, type JuiceIntensity } from "@/lib/juice";
import { JuiceHit } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const LEVELS = [
  { label: "よわい", depth: 2, jitterCp: 120 },
  { label: "ふつう", depth: 3, jitterCp: 30 },
  { label: "つよい", depth: 4, jitterCp: 0 },
] as const;

// 駒コード（白 1..6 / 黒 9..14、種別は code & 7）→ グリフ
const GLYPHS: Record<number, string> = {
  1: "♙", 2: "♘", 3: "♗", 4: "♖", 5: "♕", 6: "♔",
  9: "♟", 10: "♞", 11: "♝", 12: "♜", 13: "♛", 14: "♚",
};
const PIECE_NAMES: Record<number, string> = {
  1: "ポーン", 2: "ナイト", 3: "ビショップ", 4: "ルーク", 5: "クイーン", 6: "キング",
};

function uciSquares(uci: string): { from: number; to: number } {
  const fileOf = (ch: string) => ch.charCodeAt(0) - 97;
  const rankOf = (ch: string) => ch.charCodeAt(0) - 49;
  return {
    from: rankOf(uci[1]) * 16 + fileOf(uci[0]),
    to: rankOf(uci[3]) * 16 + fileOf(uci[2]),
  };
}

const DRAW_TEXT: Record<string, string> = {
  stalemate: "ステイルメイト",
  "insufficient-material": "駒不足",
  "threefold-repetition": "三度の同一局面",
  "fifty-move": "50手ルール",
};

export default function ChessClient() {
  const { prefix } = useGamesNav();
  const [game, setGame] = useState<ChessGameState>(() => createGame());
  const [playerColor, setPlayerColor] = useState<number>(WHITE);
  const [levelIndex, setLevelIndex] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [promoMoves, setPromoMoves] = useState<LegalMove[] | null>(null);
  const [thinking, setThinking] = useState(false);
  const [resignArmed, setResignArmed] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const workerFailedRef = useRef(false);
  const requestRef = useRef(0);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const [burst, setBurst] = useState<{ key: number; x: number; y: number; intensity: JuiceIntensity }>({ key: 0, x: 50, y: 50, intensity: 1 });

  const board = game.position.board;
  const isPlayerTurn = game.status === "playing" && game.position.side === playerColor;

  const targets = useMemo(
    () => (selected === null ? [] : legalMovesFrom(game, selected)),
    [game, selected],
  );
  const targetSquares = useMemo(
    () => new Set(targets.map(({ move }) => (move >> 7) & 0x7f)),
    [targets],
  );
  const lastMove = useMemo(() => {
    const uci = game.moves[game.moves.length - 1];
    return uci ? uciSquares(uci) : null;
  }, [game.moves]);
  const checkSquare = useMemo(() => {
    if (!game.inCheck || game.status !== "playing") return null;
    const king = game.position.side === WHITE ? 6 : 14;
    for (let sq = 0; sq < 128; sq++) {
      if (!(sq & 0x88) && board[sq] === king) return sq;
    }
    return null;
  }, [game.inCheck, game.status, game.position.side, board]);

  // 手応え層（櫻井流バッチ1）: 着手のたびに、取った手はヒット音＋
  // ヒットストップ、通常手は配置音＋小ヒットストップ、着手先に
  // ヒットマークを出す。終局時は止めの音とフラッシュ/振動を足す。
  const prevMovesRef = useRef(0);
  const prevBoardRef = useRef<number[] | null>(null);
  useEffect(() => {
    const prevBoard = prevBoardRef.current;
    prevBoardRef.current = [...board];
    const prevCount = prevMovesRef.current;
    prevMovesRef.current = game.moves.length;
    if (!prevBoard || game.moves.length <= prevCount || !lastMove) return;
    const movingPiece = prevBoard[lastMove.from] ?? 0;
    const isPawn = (movingPiece & 7) === 1;
    const captured =
      (prevBoard[lastMove.to] ?? 0) !== 0 ||
      (isPawn && (lastMove.from & 15) !== (lastMove.to & 15));
    if (captured) {
      sfxHit(2);
      juiceHitstop(boardWrapRef.current, 2);
    } else {
      sfxPlace();
      juiceHitstop(boardWrapRef.current, 1);
    }
    const file = lastMove.to & 15;
    const rank = lastMove.to >> 4;
    const xi = files.indexOf(file);
    const yi = ranks.indexOf(rank);
    if (xi >= 0 && yi >= 0) {
      setBurst({
        key: game.moves.length,
        x: ((xi + 0.5) / 8) * 100,
        y: ((yi + 0.5) / 8) * 100,
        intensity: captured ? 2 : 1,
      });
    }
    // files/ranks は表示向き（playerColor）で決まる値として扱う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.moves.length, board, lastMove]);

  const prevStatusRef = useRef(game.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = game.status;
    if (prev === game.status || game.status === "playing") return;
    if (game.status === "checkmate") {
      if (game.winner === playerColor) {
        sfxKo();
        juiceHitstop(boardWrapRef.current, 2);
      } else {
        sfxHit(3);
        juiceHitstop(boardWrapRef.current, 3);
      }
      juiceShake(boardWrapRef.current, game.winner === playerColor ? 2 : 3);
      juiceFlash(boardWrapRef.current);
    } else if (game.status === "resigned") {
      if (game.winner === playerColor) sfxWin();
      else sfxLose();
      juiceFlash(boardWrapRef.current);
    } else if (game.status === "draw") {
      juiceFlash(boardWrapRef.current);
    }
  }, [game.status, game.winner, playerColor]);

  const ensureWorker = (): Worker | null => {
    if (workerFailedRef.current) return null;
    if (workerRef.current) return workerRef.current;
    try {
      // /compute と同じ方式: URL を変数に切り出してから Worker に渡すと、
      // Next のビルドが lib の自己完結バンドルを静的アセットとして配信する
      // （Worker 用チャンク形式だと本番で読み込めない事故があったため）。
      const workerUrl = new URL("../../../lib/chess-cpu.worker.js", import.meta.url);
      const worker = new Worker(workerUrl, { type: "module" });
      worker.onerror = () => {
        workerFailedRef.current = true;
      };
      workerRef.current = worker;
      return worker;
    } catch {
      workerFailedRef.current = true;
      return null;
    }
  };

  // CPU の手番になったら Worker に探索させる
  useEffect(() => {
    if (game.status !== "playing" || game.position.side === playerColor) return;
    let cancelled = false;
    setThinking(true);
    const fen = gameFen(game);
    const level = LEVELS[levelIndex];
    const requestId = ++requestRef.current;
    const applyResult = (uci: string | null) => {
      if (cancelled) return;
      setThinking(false);
      if (!uci) return;
      setGame((current) => {
        if (current.status !== "playing" || gameFen(current) !== fen) return current;
        try {
          return applyUciMove(current, uci);
        } catch {
          return current;
        }
      });
    };
    const fallback = () => {
      window.setTimeout(() => {
        if (cancelled) return;
        try {
          const result = findBestMove(parseFen(fen), { depth: level.depth, jitterCp: level.jitterCp });
          applyResult(result ? result.uci : null);
        } catch {
          applyResult(null);
        }
      }, 30);
    };
    let detach: (() => void) | undefined;
    const worker = ensureWorker();
    if (worker) {
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; requestId?: number; uci?: string | null };
        if (!data || data.requestId !== requestId) return;
        detach?.();
        if (data.type === "bestmove" && typeof data.uci === "string") applyResult(data.uci);
        else fallback();
      };
      detach = () => worker.removeEventListener("message", onMessage);
      worker.addEventListener("message", onMessage);
      worker.postMessage({ type: "search", requestId, fen, depth: level.depth, jitterCp: level.jitterCp });
    } else {
      fallback();
    }
    return () => {
      cancelled = true;
      detach?.();
      setThinking(false);
    };
    // ensureWorker は ref 操作のみで再生成されない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, playerColor, levelIndex]);

  // アンマウント時に Worker を破棄する
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const startNewGame = (color: number, level: number) => {
    requestRef.current += 1;
    setPlayerColor(color);
    setLevelIndex(level);
    setGame(createGame());
    setSelected(null);
    setPromoMoves(null);
    setResignArmed(false);
    setThinking(false);
  };

  const playMove = (uci: string) => {
    setSelected(null);
    setPromoMoves(null);
    setResignArmed(false);
    setGame((current) => {
      try {
        return applyUciMove(current, uci);
      } catch {
        return current;
      }
    });
  };

  const onSquareClick = (sq: number) => {
    if (thinking || !isPlayerTurn || promoMoves) return;
    const piece = board[sq];
    if (selected !== null) {
      const candidates = targets.filter(({ move }) => ((move >> 7) & 0x7f) === sq);
      if (candidates.length === 1) {
        playMove(candidates[0].uci);
        return;
      }
      if (candidates.length > 1) {
        // 昇格は複数候補があるので選択させる
        setPromoMoves(candidates);
        return;
      }
    }
    const ownPiece = piece !== 0 && (playerColor === WHITE ? piece <= 6 : piece >= 9);
    // 駒を選んだ瞬間にタップ音で受け付けを見せる（#049 構えの瞬発）。
    if (ownPiece && selected !== sq) sfxTap();
    setSelected(ownPiece ? sq : null);
  };

  const statusText = (() => {
    if (game.status === "checkmate") {
      return game.winner === playerColor ? "チェックメイト。あなたの勝ちです。" : "チェックメイト。CPUの勝ちです。";
    }
    if (game.status === "resigned") {
      return game.winner === playerColor ? "CPUの投了。あなたの勝ちです。" : "投了しました。CPUの勝ちです。";
    }
    if (game.status === "draw") {
      return `${DRAW_TEXT[game.drawReason ?? ""] ?? "引き分け"}で引き分けです。`;
    }
    if (thinking) return "CPUが考え中…";
    if (isPlayerTurn) return game.inCheck ? "チェックされています。あなたの番です。" : "あなたの番です。";
    return "CPUの番です。";
  })();

  const ranks = playerColor === WHITE ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const files = playerColor === WHITE ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const movePairs: { no: number; white: string; black?: string }[] = [];
  for (let i = 0; i < game.sans.length; i += 2) {
    movePairs.push({ no: i / 2 + 1, white: game.sans[i], black: game.sans[i + 1] });
  }

  const board2d = (
          <div className="chess-board" role="grid" aria-label="チェス盤">
            {ranks.map((rank) =>
              files.map((file) => {
                const sq = rank * 16 + file;
                const piece = board[sq];
                const isDark = (rank + file) % 2 === 0;
                const classes = [
                  "chess-square",
                  "juice-pressable",
                  isDark ? "chess-square-dark" : "chess-square-light",
                  selected === sq ? "chess-square-selected" : "",
                  lastMove && (lastMove.from === sq || lastMove.to === sq) ? "chess-square-last" : "",
                  checkSquare === sq ? "chess-square-check" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <button
                    key={sq}
                    type="button"
                    role="gridcell"
                    className={classes}
                    onClick={() => onSquareClick(sq)}
                    disabled={!isPlayerTurn || thinking}
                    aria-label={`${"abcdefgh"[file]}${rank + 1}${piece ? ` ${piece <= 6 ? "白" : "黒"}の${PIECE_NAMES[piece & 7]}` : ""}`}
                  >
                    {file === files[0] && <span className="chess-coord chess-coord-rank">{rank + 1}</span>}
                    {rank === ranks[ranks.length - 1] && (
                      <span className="chess-coord chess-coord-file">{"abcdefgh"[file]}</span>
                    )}
                    {piece !== 0 && (
                      <span className={piece <= 6 ? "chess-piece chess-piece-white" : "chess-piece chess-piece-black"}>
                        {GLYPHS[piece]}
                      </span>
                    )}
                    {targetSquares.has(sq) && <span className="chess-target" aria-hidden="true" />}
                  </button>
                );
              }),
            )}
          </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>チェス</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>チェス</h1>
        <p className="muted">CPU対戦チェス。探索計算はあなたの端末のブラウザの中で実行されます。</p>
      </div>

      <div className="chess-layout">
        <div className="chess-board-area" ref={boardWrapRef} style={{ position: "relative" }}>
          {webglFailed ? (
            board2d
          ) : (
            <ChessScene3D
              board={board}
              playerColor={playerColor}
              selected={selected}
              targets={[...targetSquares]}
              lastMove={lastMove}
              checkSquare={checkSquare}
              onSquare={onSquareClick}
              onFail={() => setWebglFailed(true)}
              fallback={board2d}
            />
          )}
          <JuiceHit burstKey={burst.key} intensity={burst.intensity} xPct={burst.x} yPct={burst.y} continuous />
          {promoMoves && (
            <div className="chess-promo" role="group" aria-label="昇格する駒の選択">
              <span>昇格先を選んでください</span>
              <div className="chess-promo-buttons">
                {[5, 4, 3, 2].map((promoType) => {
                  const candidate = promoMoves.find(({ move }) => ((move >> 14) & 0x7) === promoType);
                  if (!candidate) return null;
                  const glyphCode = playerColor === WHITE ? promoType : promoType + 8;
                  return (
                    <button key={promoType} type="button" onClick={() => playMove(candidate.uci)}>
                      {GLYPHS[glyphCode]}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="chess-promo-cancel"
                  onClick={() => setPromoMoves(null)}
                  aria-label="キャンセル"
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="chess-side">
          <p className="chess-status" role="status" aria-live="polite">
            {statusText}
          </p>
          <div className="chess-controls">
            <div className="chess-control-group" role="group" aria-label="難易度">
              <span>難易度</span>
              <div className="chess-segmented">
                {LEVELS.map((level, index) => (
                  <button
                    key={level.label}
                    type="button"
                    aria-pressed={levelIndex === index}
                    className={levelIndex === index ? "chess-segmented-active" : ""}
                    onClick={() => startNewGame(playerColor, index)}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="chess-control-group" role="group" aria-label="手番">
              <span>手番</span>
              <div className="chess-segmented">
                <button
                  type="button"
                  aria-pressed={playerColor === WHITE}
                  className={playerColor === WHITE ? "chess-segmented-active" : ""}
                  onClick={() => startNewGame(WHITE, levelIndex)}
                >
                  白（先手）
                </button>
                <button
                  type="button"
                  aria-pressed={playerColor === BLACK}
                  className={playerColor === BLACK ? "chess-segmented-active" : ""}
                  onClick={() => startNewGame(BLACK, levelIndex)}
                >
                  黒（後手）
                </button>
              </div>
            </div>
            <div className="chess-actions">
              <button type="button" className="activity-button" onClick={() => startNewGame(playerColor, levelIndex)}>
                新規対局
              </button>
              {game.status === "playing" &&
                (resignArmed ? (
                  <button
                    type="button"
                    className="activity-button chess-resign-confirm"
                    onClick={() => {
                      setGame((current) => resignGame(current, playerColor));
                      setResignArmed(false);
                    }}
                  >
                    本当に投了する
                  </button>
                ) : (
                  <button
                    type="button"
                    className="activity-button activity-button-secondary"
                    onClick={() => setResignArmed(true)}
                  >
                    投了
                  </button>
                ))}
            </div>
          </div>
          <div className="chess-moves">
            <h2>棋譜</h2>
            {movePairs.length === 0 ? (
              <p className="muted">まだ着手がありません。駒をタップして選んでください。</p>
            ) : (
              <ol className="chess-move-list">
                {movePairs.map((pair) => (
                  <li key={pair.no}>
                    <span className="chess-move-no">{pair.no}.</span>
                    <span>{pair.white}</span>
                    <span>{pair.black ?? ""}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
