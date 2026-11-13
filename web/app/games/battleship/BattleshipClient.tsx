"use client";
// 海戦ゲーム（バトルシップ）オンライン対戦クライアント。
// view.state の契約:
//   phase: "placing" | "battle" | "finished"
//   you: 自分の艦隊（確定済み）と被弾履歴、opponent: 自分が撃った記録と
//   沈めた相手艦の cells、残り隻数 afloatCount。
// 配置はローカルで組み立てて { type: "placeShips", ships: number[][] }、
// 射撃は { type: "fire", index } を送る。
import { useEffect, useMemo, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import { tappableProps, useGesture } from "@/lib/gesture";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type ShotResult = string; // "hit" | "miss" | "sunk" など（文字列は緩く受ける）
type Shot = { index: number; result: ShotResult };
type BattleshipState = {
  phase: "placing" | "battle" | "finished";
  turn: number;
  winner: number | "draw" | null;
  lastShot: (Shot & { by?: number; seat?: number }) | null;
  you: { ships: { cells: number[]; sunk: boolean }[]; incoming: Shot[] };
  opponent: { shots: Shot[]; sunkShips: number[][]; afloatCount: number };
  players: { seat: number; name: string }[];
};

const FLEET_SIZES = [5, 4, 3, 3, 2];
const SIZE_NAMES: Record<number, string> = { 5: "戦艦", 4: "空母", 3: "巡洋艦・潜水艦", 2: "駆逐艦" };

type PlacedShip = { cells: number[]; size: number };

function cellsFor(anchor: number, size: number, horizontal: boolean): number[] | null {
  const row = Math.floor(anchor / 10);
  const col = anchor % 10;
  const cells: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    if (r > 9 || c > 9) return null;
    cells.push(r * 10 + c);
  }
  return cells;
}

function isHitResult(result: ShotResult): boolean {
  return result === "hit" || result === "sunk";
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as BattleshipState | null;
  const mySeat = view.player.seat;
  const [placed, setPlaced] = useState<PlacedShip[]>([]);
  const [horizontal, setHorizontal] = useState(true);
  const [selectedSize, setSelectedSize] = useState<number>(FLEET_SIZES[0]);
  const [localError, setLocalError] = useState("");
  const finishRef = useRef<string | null>(null);
  const lastShotRef = useRef<string | null>(null);
  const turnRef = useRef<number | null>(null);

  const remainingSizes = useMemo(() => {
    const rest = [...FLEET_SIZES];
    for (const ship of placed) {
      const i = rest.indexOf(ship.size);
      if (i >= 0) rest.splice(i, 1);
    }
    return rest;
  }, [placed]);

  // 選択中のサイズが配置済みになったら、次の未配置サイズへ寄せる
  useEffect(() => {
    if (!remainingSizes.includes(selectedSize)) {
      setSelectedSize(remainingSizes[0] ?? 0);
    }
  }, [remainingSizes, selectedSize]);

  // 自分の手番が来たら知らせる（戦闘フェーズのみ）
  useEffect(() => {
    if (!state || state.phase !== "battle") return;
    const prev = turnRef.current;
    turnRef.current = state.turn;
    if (prev !== null && prev !== state.turn && state.turn === mySeat) playSe("turn");
  }, [state, mySeat]);

  // 直近の射撃結果で SE（命中/撃沈は高め、はずれは着水）
  useEffect(() => {
    if (!state?.lastShot) return;
    const key = `${state.lastShot.seat ?? ""}:${state.lastShot.index}:${state.lastShot.result}:${state.turn}`;
    if (lastShotRef.current === key) return;
    lastShotRef.current = key;
    if (state.lastShot.result === "sunk") playSe("bulkSuccess");
    else if (isHitResult(state.lastShot.result)) playSe("coin");
    else playSe("draw");
  }, [state?.lastShot, state?.turn]);

  // 終局の勝敗 SE（対局ごとに一度だけ）
  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winner === "draw" ? "click" : state.winner === mySeat ? "win" : "lose");
  }, [state, mySeat, view.code]);

  /* ---------- 配置フェーズの操作（トップレベルに置く。配置盤の useGesture は
     フェーズが変わってもフック数が変わらないよう無条件で呼ぶ必要があるため） ---------- */
  const confirmed = state !== null && state.you.ships.length > 0;
  const occupied = new Set(placed.flatMap((s) => s.cells));

  const tryPlace = (anchor: number) => {
    if (!state || state.phase !== "placing" || confirmed || selectedSize === 0) return;
    // 配置済みの艦をタップしたらその艦を取り消す（1隻取り消しボタンの代替）。
    const hitIndex = placed.findIndex((s) => s.cells.includes(anchor));
    if (hitIndex >= 0) {
      setLocalError("");
      playSe("click");
      setPlaced((prev) => prev.filter((_, i) => i !== hitIndex));
      return;
    }
    const cells = cellsFor(anchor, selectedSize, horizontal);
    if (!cells) {
      setLocalError("盤の外にはみ出します。");
      playSe("error");
      return;
    }
    if (cells.some((c) => occupied.has(c))) {
      setLocalError("他の艦と重なります。");
      playSe("error");
      return;
    }
    setLocalError("");
    playSe("play");
    setPlaced((prev) => [...prev, { cells, size: selectedSize }]);
  };

  const randomPlace = () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const used = new Set<number>();
      const ships: PlacedShip[] = [];
      let ok = true;
      for (const size of FLEET_SIZES) {
        let shipCells: number[] | null = null;
        for (let t = 0; t < 100 && !shipCells; t += 1) {
          const anchor = Math.floor(Math.random() * 100);
          const cells = cellsFor(anchor, size, Math.random() < 0.5);
          if (cells && !cells.some((c) => used.has(c))) shipCells = cells;
        }
        if (!shipCells) {
          ok = false;
          break;
        }
        shipCells.forEach((c) => used.add(c));
        ships.push({ cells: shipCells, size });
      }
      if (ok) {
        setPlaced(ships);
        setLocalError("");
        playSe("select");
        return;
      }
    }
    setLocalError("ランダム配置に失敗しました。もう一度お試しください。");
  };

  const confirmPlacement = () => {
    if (remainingSizes.length > 0) {
      setLocalError("まだ配置が終わっていません。");
      playSe("error");
      return;
    }
    playSe("submit");
    void api.move({ type: "placeShips", ships: placed.map((s) => s.cells) });
  };

  // 配置盤のスワイプ: 左=全消し、右=ランダム配置、上=配置を確定。
  // 艦のタップは各マスが受ける（配置済み艦のタップは取り消し）。
  const placementGesture = useGesture({
    onSwipe: (dir) => {
      if (!state || state.phase !== "placing" || confirmed) return;
      if (dir === "left") {
        setPlaced([]);
        setLocalError("");
        playSe("click");
      } else if (dir === "right") {
        randomPlace();
      } else if (dir === "up") {
        confirmPlacement();
      }
    },
  });

  if (!state) return <p className="og-muted">海域を準備中…</p>;

  const opponentPlayer = state.players.find((p) => p.seat !== mySeat);
  const turnName = state.players.find((p) => p.seat === state.turn)?.name ?? `プレイヤー${state.turn + 1}`;
  const winnerName =
    state.winner === "draw" ? null : state.players.find((p) => p.seat === state.winner)?.name ?? (typeof state.winner === "number" ? `プレイヤー${state.winner + 1}` : null);
  const myTurn = state.phase === "battle" && state.turn === mySeat;

  /* ---------- 配置フェーズ ---------- */
  if (state.phase === "placing") {
    return (
      <div className="og-board-wrap">
        <div className="og-turn-banner" role="status">
          {confirmed ? "配置を確定しました。相手の配置を待っています…" : "艦隊を配置してください"}
        </div>
        <p className="og-muted">
          相手: {opponentPlayer?.name ?? "—"}
          {confirmed ? "（あなたの配置は確定済み）" : ""}
        </p>
        {!confirmed && (
          <>
            <div className="og-bs-fleet" role="group" aria-label="配置する艦">
              {FLEET_SIZES.map((size, i) => {
                const usedCount = placed.filter((s) => s.size === size).length;
                const totalCount = FLEET_SIZES.filter((s) => s === size).length;
                const done = usedCount >= totalCount;
                const isSelected = selectedSize === size && !done;
                return (
                  <div
                    key={`${size}-${i}`}
                    {...(done
                      ? { "aria-disabled": true as const }
                      : tappableProps(() => setSelectedSize(size)))}
                    className={`og-bs-ship-btn${isSelected ? " og-bs-ship-selected" : ""}`}
                    aria-pressed={isSelected}
                  >
                    {SIZE_NAMES[size]}（{size}マス）{done ? " 配置済み" : usedCount > 0 ? ` ${usedCount}/${totalCount}` : ""}
                  </div>
                );
              })}
              <div
                {...tappableProps(() => setHorizontal((h) => !h))}
                className="og-btn"
                aria-pressed={!horizontal}
              >
                向き: {horizontal ? "横 →" : "縦 ↓"}
              </div>
            </div>
            <p className="og-muted">
              配置 {placed.length}/5隻。配置済みの艦をタップで取り消し。盤を左スワイプで全消し、右スワイプでランダム配置、上スワイプで確定。
            </p>
            {localError && (
              <p className="og-error juice-shake" role="alert">
                {localError}
              </p>
            )}
          </>
        )}
        <div {...placementGesture} className="og-bs-board" role="grid" aria-label="自分の海（配置。左スワイプで全消し、右スワイプでランダム配置、上スワイプで確定）" style={{ touchAction: "none" }}>
          {Array.from({ length: 100 }, (_, index) => {
            const shipIndex = confirmed
              ? state.you.ships.findIndex((s) => s.cells.includes(index))
              : placed.findIndex((s) => s.cells.includes(index));
            return (
              <div
                key={index}
                role="gridcell"
                tabIndex={confirmed ? -1 : 0}
                className={`og-cell og-bs-cell${shipIndex >= 0 ? " og-bs-cell-ship juice-pop" : ""}`}
                aria-disabled={confirmed}
                aria-label={`${Math.floor(index / 10) + 1}行${(index % 10) + 1}列${shipIndex >= 0 ? " 艦あり" : ""}`}
                onClick={() => tryPlace(index)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  tryPlace(index);
                }}
                style={{ cursor: confirmed ? "default" : "pointer" }}
              />
            );
          })}
        </div>
      </div>
    );
  }

  /* ---------- 戦闘 / 終了フェーズ ---------- */
  const myShipCells = new Map<number, { sunk: boolean }>();
  for (const ship of state.you.ships) for (const c of ship.cells) myShipCells.set(c, { sunk: ship.sunk });
  const incoming = new Map(state.you.incoming.map((s) => [s.index, s.result]));
  const myShots = new Map(state.opponent.shots.map((s) => [s.index, s.result]));
  const sunkEnemyCells = new Set(state.opponent.sunkShips.flat());

  const fire = (index: number) => {
    if (!myTurn || myShots.has(index)) return;
    playSe("play");
    void api.move({ type: "fire", index });
  };

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${myTurn ? " og-turn-mine" : ""}${state.phase === "finished" ? " juice-slide" : myTurn ? " juice-pulse" : ""}`} role="status">
        {state.phase === "finished"
          ? state.winner === "draw"
            ? "引き分け"
            : `勝者: ${winnerName ?? "—"}${state.winner === mySeat ? "" : ""}`
          : myTurn
            ? "あなたの手番です。相手の海をタップして攻撃"
            : `${turnName} の手番です（待機中）`}
      </div>
      <div className="og-bs-seas">
        <section className="og-bs-sea">
          <h3 className="og-bs-sea-title">自分の海</h3>
          <div className="og-bs-board" role="grid" aria-label="自分の海">
            {Array.from({ length: 100 }, (_, index) => {
              const ship = myShipCells.get(index);
              const hit = incoming.get(index);
              return (
                <div
                  key={index}
                  role="gridcell"
                  className={`og-cell og-bs-cell${ship ? " og-bs-cell-ship" : ""}${ship?.sunk ? " og-bs-cell-sunk" : ""}${hit ? (isHitResult(hit) ? " og-bs-cell-hit" : " og-bs-cell-miss") : ""}${state.lastShot?.index === index && state.lastShot.seat !== undefined && state.lastShot.seat !== mySeat ? " juice-pop" : ""}`}
                  aria-label={`${Math.floor(index / 10) + 1}行${(index % 10) + 1}列${ship ? " 艦あり" : ""}${hit ? (isHitResult(hit) ? " 被弾" : " 着水") : ""}`}
                >
                  {hit ? (isHitResult(hit) ? "✕" : "・") : null}
                </div>
              );
            })}
          </div>
          <p className="og-muted">残り艦隊: {state.you.ships.filter((s) => !s.sunk).length}隻</p>
        </section>
        <section className="og-bs-sea">
          <h3 className="og-bs-sea-title">攻撃用の海（相手: {opponentPlayer?.name ?? "—"}、残り{state.opponent.afloatCount}隻）</h3>
          <div className="og-bs-board" role="grid" aria-label="攻撃用の海">
            {Array.from({ length: 100 }, (_, index) => {
              const result = myShots.get(index);
              const sunkCell = sunkEnemyCells.has(index);
              const canFire = myTurn && result === undefined;
              return (
                <div
                  key={index}
                  role="gridcell"
                  tabIndex={canFire ? 0 : -1}
                  className={`og-cell og-bs-cell${sunkCell ? " og-bs-cell-sunk" : ""}${result ? (isHitResult(result) ? " og-bs-cell-hit" : " og-bs-cell-miss") : ""}${state.lastShot?.index === index ? " og-cell-last juice-pop" : ""}`}
                  aria-disabled={!canFire}
                  aria-label={`${Math.floor(index / 10) + 1}行${(index % 10) + 1}列${result ? (isHitResult(result) ? " 命中" : " はずれ") : ""}`}
                  onClick={() => fire(index)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    fire(index);
                  }}
                  style={{ cursor: canFire ? "pointer" : "default" }}
                >
                  {result ? (isHitResult(result) ? "✕" : "・") : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function BattleshipClient() {
  return (
    <OnlineShell gameId="battleship" title="海戦ゲーム" playerRange={{ min: 2, max: 2 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
