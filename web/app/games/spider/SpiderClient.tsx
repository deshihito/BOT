"use client";
// スパイダー・ソリティア（1スート簡易版）。ロジックは lib/spider.ts。
// タップ選択式：動かしたい束の先頭カード→置き先の列の順にタップする。
// 端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  SPIDER_COLUMNS,
  canMoveSpiderRun,
  createSpider,
  dealSpider,
  movableRunLength,
  moveSpider,
  spiderRankLabel,
  spiderStockDeals,
  type SpiderState,
} from "@/lib/spider";
import { useGamesNav } from "../GamesShell";
import { sfxDeal, sfxLose, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";

type Selection = { col: number; index: number } | null;

function newGame(): SpiderState {
  return createSpider(Date.now() % 2147483647);
}

export default function SpiderClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<SpiderState>(() => newGame());
  const [selection, setSelection] = useState<Selection>(null);
  const [message, setMessage] = useState<string | null>(null);

  const restart = () => {
    setState(newGame());
    setSelection(null);
    setMessage(null);
  };

  const endSoundRef = useRef<SpiderState | null>(null);
  useEffect(() => {
    if (state.status === "playing") return;
    if (endSoundRef.current === state) return;
    endSoundRef.current = state;
    if (state.status === "won") sfxWin();
    else sfxLose();
  }, [state]);

  const onCardClick = (col: number, index: number) => {
    if (state.status !== "playing") return;
    const pile = state.columns[col];
    const card = pile[index];
    if (selection) {
      // 置き先としてこの列が選ばれた
      if (selection.col !== col) {
        if (canMoveSpiderRun(state, selection.col, selection.index, col)) {
          sfxPlace();
          setState((s) => moveSpider(s, selection.col, selection.index, col));
          setMessage(null);
        } else {
          sfxWrong();
          setMessage("そこには置けません。下降順の束と、置き先の数字を確認してください。");
        }
        setSelection(null);
        return;
      }
      // 同じ列をもう一度押したら選択し直し／解除
      if (selection.index === index) {
        setSelection(null);
        return;
      }
    }
    if (!card || !card.faceUp) {
      setSelection(null);
      return;
    }
    // 動かせる束の範囲内なら、その位置から選択する
    const runStart = pile.length - movableRunLength(state, col);
    if (index >= runStart) {
      sfxTap();
      setSelection({ col, index });
      setMessage(null);
    } else {
      sfxWrong();
      setSelection(null);
      setMessage("まとめて動かせるのは、下降順に続いた部分だけです。");
    }
  };

  const onEmptyColumnClick = (col: number) => {
    if (!selection || state.status !== "playing") return;
    if (canMoveSpiderRun(state, selection.col, selection.index, col)) {
      sfxPlace();
      setState((s) => moveSpider(s, selection.col, selection.index, col));
      setMessage(null);
    } else {
      sfxWrong();
      setMessage("そこには置けません。");
    }
    setSelection(null);
  };

  const onDeal = () => {
    if (state.columns.some((p) => p.length === 0)) {
      sfxWrong();
      setMessage("空の列があるときは配れません。先にカードを置いてください。");
      return;
    }
    sfxDeal();
    setState((s) => dealSpider(s));
    setSelection(null);
    setMessage(null);
  };

  const deals = spiderStockDeals(state);

  // 山札から配る（旧ボタンの代替: 配る対象物のタップ / 盤面の下スワイプ / D キー）。
  // 旧ボタンの disabled 条件（残り0回・プレイ中でない）と同等に、無効なときは無音の no-op。
  const tryDeal = () => {
    if (deals === 0 || state.status !== "playing") return;
    onDeal();
  };
  const dealDisabled = deals === 0 || state.status !== "playing";

  // 盤面の下スワイプ = 山札から配る。子の札の onClick との二重発火は
  // useGesture の suppressClickAfterSwipe が抑止する（solitaire / freecell と同じ）。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down") tryDeal();
    },
  });

  // D キーでも山札から配れる（札の div は Enter/Space のみのため二重発火なし）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "d" || e.key === "D") tryDeal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>スパイダー</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>スパイダーソリティア</h1>
        <p className="muted">
          動かしたい束の先頭カードをタップし、続けて置き先の列をタップします。全カードがスペードの1スート制です。盤面を下にスワイプ（または D キー）で山札から配ります。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="操作">
        <button type="button" className="classic-btn" onClick={restart}>
          もう一度
        </button>
        <div
          {...(dealDisabled ? {} : tappableProps(tryDeal))}
          aria-disabled={dealDisabled}
          className="classic-btn"
          style={dealDisabled ? { opacity: 0.5, cursor: "default" } : undefined}
        >
          山札から配る（残り{deals}回）
        </div>
      </div>

      <p className="classic-status" role="status">
        手数 {state.moves} ・ 完成 {state.completed} / 8組
        {state.status === "won"
          ? " ・ 全8組そろった！クリアです。"
          : state.status === "stuck"
            ? " ・ 詰みです。動かせる手がもうありません。「もう一度」で新しい配布に挑戦してください。"
            : message
              ? ` ・ ${message}`
              : selection
                ? " ・ 置き先の列を選んでください。"
                : " ・ 動かしたいカードを選んでください。"}
      </p>

      <div
        {...boardGesture}
        role="group"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${SPIDER_COLUMNS}, minmax(0, 1fr))`,
          gap: 4,
          maxWidth: 860,
          margin: "0 auto",
          touchAction: "none",
        }}
        aria-label="スパイダーの場札（下にスワイプで山札から配る）"
      >
        {state.columns.map((pile, col) => (
          <div key={col} style={{ display: "flex", flexDirection: "column" }}>
            {pile.length === 0 ? (
              <div
                {...tappableProps(() => onEmptyColumnClick(col))}
                aria-label={`${col + 1}列目（空）`}
                style={{
                  height: 62,
                  borderRadius: 7,
                  border: "1px dashed #94a3b8",
                  background: "#f1f5f9",
                  color: "#64748b",
                  fontSize: 11,
                  cursor: selection ? "pointer" : "default",
                }}
              >
                空
              </div>
            ) : (
              pile.map((card, index) => {
                const isSelected =
                  selection !== null && selection.col === col && index >= selection.index;
                return (
                  <div
                    key={card.id}
                    {...(card.faceUp
                      ? tappableProps(() => onCardClick(col, index))
                      : {})}
                    aria-label={
                      card.faceUp
                        ? `スペードの${spiderRankLabel(card.rank)}`
                        : "裏向きのカード"
                    }
                    aria-pressed={card.faceUp ? isSelected : undefined}
                    aria-disabled={!card.faceUp}
                    className={card.faceUp ? "juice-flip" : undefined}
                    style={{
                      height: 62,
                      marginTop: index === 0 ? 0 : -38,
                      borderRadius: 7,
                      border: isSelected ? "2px solid #2563eb" : "1px solid #cbd5e1",
                      background: card.faceUp
                        ? isSelected
                          ? "#dbeafe"
                          : "#ffffff"
                        : "#334155",
                      color: card.faceUp ? "#111827" : "#e2e8f0",
                      fontWeight: 700,
                      fontSize: 14,
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "flex-start",
                      padding: "3px 5px",
                      cursor: card.faceUp ? "pointer" : "default",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.10)",
                      zIndex: index,
                      position: "relative",
                    }}
                  >
                    {card.faceUp ? `♠${spiderRankLabel(card.rank)}` : "🂠"}
                  </div>
                );
              })
            )}
          </div>
        ))}
      </div>

      {state.status === "won" ? (
        <div style={{ maxWidth: 640, margin: "16px auto 0" }}>
          <EndScreen outcome="win" title="クリア！" onRetry={restart}>
            <p className="muted" style={{ margin: 0 }}>
              全8組そろいました。手数 {state.moves} 手でクリアです。
            </p>
          </EndScreen>
        </div>
      ) : state.status === "stuck" ? (
        <div style={{ maxWidth: 640, margin: "16px auto 0" }}>
          <EndScreen outcome="lose" title="詰みです" onRetry={restart}>
            <p className="muted" style={{ margin: 0 }}>
              動かせる手がもうありません。完成 {state.completed} / 8組、手数 {state.moves} 手でした。
            </p>
          </EndScreen>
        </div>
      ) : null}
    </>
  );
}
