"use client";
// モンテカルロ（ソリティア）。ロジックは lib/montecarlo.ts。
// 縦・横・斜めに隣接する同じランクのペアを取り除く。除去後は空きが残り、
// 「詰める」で前へ寄せて山札から補充する方式。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const MonteCarloScene3D = dynamic(() => import("./MonteCarloScene3D"), { ssr: false });
import {
  MC_COLS,
  createMonteCarlo,
  montecarloConsolidate,
  montecarloPairs,
  montecarloRemovePair,
  type McCard,
  type McState,
} from "@/lib/montecarlo";
import { useGamesNav } from "../GamesShell";
import { useGesture } from "@/lib/gesture";
import { sfxFlip, sfxPop, sfxTap } from "@/lib/sfx";

const RANK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];

function CardFace({ card }: { card: McCard }) {
  const red = card.suit === 1 || card.suit === 2;
  return (
    <span
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        lineHeight: 1.05,
        color: red ? "#dc2626" : "#0f172a",
        fontWeight: 700,
      }}
    >
      <span style={{ fontSize: 17 }}>{RANK_LABELS[card.rank - 1]}</span>
      <span style={{ fontSize: 14 }}>{SUITS[card.suit]}</span>
    </span>
  );
}

export default function MonteCarloClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<McState>(() =>
    createMonteCarlo(Date.now() % 2147483647),
  );
  const [selected, setSelected] = useState<number | null>(null);

  const pairs = montecarloPairs(state);
  const pairSet = new Set(pairs.flatMap(([a, b]) => [a, b]));
  const remaining = state.board.filter((c) => c !== null).length + state.stock.length;

  const restart = () => {
    setState(createMonteCarlo(Date.now() % 2147483647));
    setSelected(null);
  };

  const onCell = (index: number) => {
    if (state.status !== "playing") return;
    const card = state.board[index];
    if (!card) return;
    if (selected === null) {
      sfxTap();
      setSelected(index);
      return;
    }
    if (selected === index) {
      sfxTap();
      setSelected(null);
      return;
    }
    const isPair = pairs.some(
      ([a, b]) => (a === selected && b === index) || (a === index && b === selected),
    );
    if (isPair) {
      sfxPop();
      setState((s) => montecarloRemovePair(s, selected, index));
      setSelected(null);
    } else {
      sfxTap();
      setSelected(index);
    }
  };

  // 盤面の下スワイプで「詰める」（前へ寄せて山札から補充）。札のタップは各マスが受ける。
  const consolidate = () => {
    if (state.status !== "playing") return;
    sfxFlip();
    setState((s) => montecarloConsolidate(s));
    setSelected(null);
  };
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down") consolidate();
    },
  });

  const statusText =
    state.status === "won"
      ? "全部取り除けました！クリアです。"
      : state.status === "stuck"
        ? "手詰まりです。ペアが作れなくなりました。"
        : `取り除けるペアは ${pairs.length} 組あります。`;

  // 2D 盤面（WebGL が使えない場合のフォールバック）。
  const board2d = (
      <div
        {...boardGesture}
        role="grid"
        aria-label="モンテカルロの盤面（下スワイプで詰める）"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${MC_COLS}, minmax(0, 1fr))`,
          gap: 6,
          maxWidth: 430,
          margin: "0 auto",
          touchAction: "none",
        }}
      >
        {state.board.map((card, i) => {
          const isSel = selected === i;
          const inPair = card !== null && pairSet.has(i);
          return (
            <div
              key={i}
              role="gridcell"
              tabIndex={card ? 0 : -1}
              aria-disabled={!card}
              aria-pressed={isSel}
              aria-label={
                card
                  ? `${SUITS[card.suit]}の${RANK_LABELS[card.rank - 1]}`
                  : "空きマス"
              }
              onClick={() => onCell(i)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onCell(i);
              }}
              style={{
                aspectRatio: "0.78",
                border: isSel
                  ? "3px solid #f59e0b"
                  : inPair
                    ? "2px solid #22c55e"
                    : "1px solid #cbd5e1",
                borderRadius: 8,
                background: card ? "#ffffff" : "#f1f5f9",
                boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                cursor: card ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              {card ? <CardFace card={card} /> : ""}
            </div>
          );
        })}
      </div>
  );

  return (
    <div>
      <p className="classic-status" role="status">
        残り {remaining} 枚（山札 {state.stock.length} 枚）・ 取り除いた {state.removed} 枚 ・{" "}
        {statusText}
      </p>

      {webglFailed ? board2d : (
        <MonteCarloScene3D
          board={state.board}
          selected={selected}
          pairCells={[...pairSet]}
          stockCount={state.stock.length}
          playing={state.status === "playing"}
          onCellTap={onCell}
          onConsolidate={consolidate}
          onFail={() => setWebglFailed(true)}
          fallback={board2d}
        />
      )}

      <div className="classic-controls" role="group" aria-label="操作" style={{ marginTop: 12 }}>
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <Link className="classic-btn" href={`${prefix}/games`}>
          ゲーム一覧へ
        </Link>
        <span className="muted" style={{ fontSize: 13 }}>
          盤面を下にスワイプで詰める（山札から補充）
        </span>
      </div>
      <p style={{ fontSize: 13, color: "#475569", marginTop: 10 }}>
        ルール: 縦・横・斜めに隣り合う同じ数字の2枚がペアで取り除けます（緑の枠）。
        除去したあとは空きマスが残るので、盤面を下にスワイプして前へ寄せ、山札から補充してください。
        山札が尽きてペアも作れなくなったら手詰まりです。
      </p>
    </div>
  );
}
