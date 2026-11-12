"use client";
// 麻雀ソリティア。ロジックは lib/mahjong.ts（解ける割り当てを生成で保証）。
// フリーな牌（上に牌が無く、左右どちらかが空いている）を選んで、
// 同じ種類のペアを取り除いていく。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MJ_BOARD_H,
  MJ_BOARD_W,
  MJ_KINDS,
  availablePairs,
  createMahjongGame,
  freeTileIds,
  hintPair,
  remainingCount,
  removePair,
  type MjState,
} from "@/lib/mahjong";
import { sfxLose, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

function newGame(): MjState {
  return createMahjongGame(Date.now() % 2147483647);
}

export default function MahjongClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<MjState>(() => newGame());
  const [selected, setSelected] = useState<number | null>(null);
  const [hint, setHint] = useState<[number, number] | null>(null);

  const free = useMemo(() => new Set(freeTileIds(state)), [state]);
  const pairs = useMemo(() => availablePairs(state), [state]);
  const remaining = remainingCount(state);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status || state.status === "playing") return;
    if (state.status === "won") sfxWin();
    else if (state.status === "stuck") sfxLose();
  }, [state.status]);

  const restart = () => {
    setState(newGame());
    setSelected(null);
    setHint(null);
  };

  const onTile = (id: number) => {
    if (state.status !== "playing") return;
    const tile = state.tiles[id];
    if (!tile || tile.removed) return;
    if (selected === id) {
      sfxTap();
      setSelected(null);
      return;
    }
    if (!free.has(id)) return;
    if (selected === null) {
      sfxTap();
      setSelected(id);
      return;
    }
    const first = state.tiles[selected];
    if (first && first.kind === tile.kind) {
      const next = removePair(state, selected, id);
      // 終局（won）は終局ジングル側が担当するので、ここでは置き音だけ。
      if (next.status === "playing") sfxPlace();
      setState(next);
      setSelected(null);
      setHint(null);
    } else {
      sfxTap();
      setSelected(id);
    }
  };

  const onHint = () => {
    sfxTap();
    const pair = hintPair(state);
    setHint(pair);
    setSelected(null);
  };

  const statusText =
    state.status === "won"
      ? "全部の牌を取れた！クリアです。"
      : state.status === "stuck"
        ? "取れるペアがありません。「もう一度」で別の配置にできます。"
        : selected !== null
          ? "同じ種類のフリーな牌を選んでペアにしよう。"
          : "光っている牌がフリーな牌。同じ種類を2枚選ぶと取り除けます。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>麻雀ソリティア</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>麻雀ソリティア</h1>
        <p className="muted">
          牌をタップして選び、同じ種類のフリーな牌をもう1枚選ぶと取り除けます。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <button type="button" className="classic-btn" onClick={onHint} disabled={state.status !== "playing"}>
          ヒント
        </button>
      </div>

      <p className="classic-status" role="status">
        残り {remaining} 枚 ・ {state.moves} 手 ・ 取れるペア {pairs.length} 組 ・ {statusText}
      </p>

      <div
        role="group"
        aria-label="麻雀ソリティアの盤"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 680,
          margin: "0 auto",
          aspectRatio: `${MJ_BOARD_W} / ${MJ_BOARD_H}`,
          background: "#2e6b46",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {state.tiles.map((tile) => {
          if (tile.removed) return null;
          const isFree = free.has(tile.id);
          const isSelected = selected === tile.id;
          const isHint = hint !== null && (hint[0] === tile.id || hint[1] === tile.id);
          return (
            <button
              key={tile.id}
              type="button"
              aria-label={`${MJ_KINDS[tile.kind]}${isFree ? "（フリー）" : ""}`}
              aria-pressed={isSelected}
              onClick={() => onTile(tile.id)}
              style={{
                position: "absolute",
                left: `${(tile.x / MJ_BOARD_W) * 100}%`,
                top: `${(tile.y / MJ_BOARD_H) * 100}%`,
                width: `${(2 / MJ_BOARD_W) * 100}%`,
                height: `${(2 / MJ_BOARD_H) * 100}%`,
                transform: `translate(${tile.layer * 3}px, ${tile.layer * -3}px)`,
                zIndex: tile.layer * 100 + tile.y,
                padding: 1,
                background: "transparent",
                border: "none",
                cursor: isFree ? "pointer" : "default",
              }}
            >
              <span
                className={isSelected || isHint ? "juice-pulse" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: "100%",
                  borderRadius: 5,
                  background: isFree ? "#fffdf4" : "#d8d2c2",
                  border: isSelected
                    ? "2px solid #e2534a"
                    : isHint
                      ? "2px solid #f2b01e"
                      : "1px solid #9a927c",
                  boxShadow: "1px 2px 0 rgba(0,0,0,0.35)",
                  fontSize: "clamp(13px, 3.4vw, 26px)",
                  lineHeight: 1,
                  opacity: isFree ? 1 : 0.72,
                }}
              >
                {MJ_KINDS[tile.kind]}
              </span>
            </button>
          );
        })}
      </div>
      {state.status !== "playing" && (
        <EndScreen
          outcome={state.status === "won" ? "win" : "lose"}
          title={state.status === "won" ? "クリア！" : "取れるペアがありません"}
          onRetry={restart}
        >
          <p className="muted" style={{ margin: 0 }}>
            残り {remaining} 枚 ・ {state.moves} 手 ・ 取れるペア {pairs.length} 組
          </p>
        </EndScreen>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        層が高い牌ほど手前にずれて表示されます。暗い牌は今は取れません。
      </p>
    </>
  );
}
