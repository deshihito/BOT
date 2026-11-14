"use client";
// バカラ。ロジックは lib/baccarat.ts（第3カードのルール表は正式ルール）。
// チップは端末内だけの遊び用ポイントで、localStorage に保存する。
// チップが動くのは「配る」＝結果確定の遷移だけなので、読み込み完了後に
// チップ残高が変わったタイミングで保存すれば確定時のみ保存になる。
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// 3D シーンは three を含むため遅延読み込み（このページ専用チャンクに閉じる）。
const BaccaratScene3D = dynamic(() => import("./BaccaratScene3D"), { ssr: false });
import {
  BACCARAT_MIN_BET,
  BACCARAT_START_CHIPS,
  baccaratCardLabel,
  baccaratHandValue,
  createBaccarat,
  nextBaccaratRound,
  placeBaccaratBet,
  refillBaccarat,
  type BaccaratBetKind,
  type BaccaratCard,
  type BaccaratState,
} from "@/lib/baccarat";
import { useGamesNav } from "../GamesShell";
import { tappableProps, useGesture } from "@/lib/gesture";
import { sfxCorrect, sfxDeal, sfxPop, sfxTap, sfxWrong } from "@/lib/sfx";
import { ScorePop } from "../GameJuice";

const CHIPS_KEY = "ago-baccarat-chips";
const AMOUNTS = [10, 50, 100, 500] as const;

const BET_OPTIONS: { kind: BaccaratBetKind; label: string; note: string }[] = [
  { kind: "player", label: "プレイヤー", note: "配当 1:1" },
  { kind: "banker", label: "バンカー", note: "配当 0.95:1（手数料5%）" },
  { kind: "tie", label: "タイ（引き分け）", note: "配当 8:1" },
];

function CardChip({ card }: { card: BaccaratCard }) {
  const red = card.suit === 1 || card.suit === 2;
  return (
    <span
      className="juice-flip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 52,
        height: 64,
        padding: "0 6px",
        borderRadius: 8,
        border: "1px solid #cbd5e1",
        background: "#fff",
        color: red ? "#dc2626" : "#111827",
        fontSize: 19,
        fontWeight: 800,
      }}
    >
      {baccaratCardLabel(card)}
    </span>
  );
}

function HandRow({ title, cards, color }: { title: string; cards: BaccaratCard[]; color: string }) {
  return (
    <div style={{ flex: "1 1 240px", border: `2px solid ${color}`, borderRadius: 12, padding: 12, background: "#fffdf6" }}>
      <p style={{ margin: "0 0 8px", fontWeight: 800 }}>
        {title}
        {cards.length > 0 ? ` ・ 合計 ${baccaratHandValue(cards)}` : ""}
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", minHeight: 64 }}>
        {cards.length === 0 ? <span className="muted">まだ配られていません</span> : cards.map((c, i) => <CardChip key={`${i}-${c.rank}-${c.suit}`} card={c} />)}
      </div>
    </div>
  );
}

export default function BaccaratClient() {
  const { prefix } = useGamesNav();
  const [webglFailed, setWebglFailed] = useState(false);
  const [state, setState] = useState<BaccaratState>(() => createBaccarat(Date.now() % 2147483647));
  const [betKind, setBetKind] = useState<BaccaratBetKind>("player");
  const [amount, setAmount] = useState<number>(50);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // 保存チップの読み込み（初回のみ）。
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(CHIPS_KEY));
      if (Number.isFinite(saved) && saved > 0) {
        setState((s) => ({ ...s, chips: Math.floor(saved) }));
      }
    } catch {
      /* 保存できない環境では初期チップで開始 */
    }
    setHydrated(true);
  }, []);

  // 読み込みが終わるまでは保存しない（初期値で上書きしない）。
  // state.chips が変わるのは結果確定の遷移だけなので、保存も確定時のみになる。
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(CHIPS_KEY, String(state.chips));
    } catch {
      /* プレイに影響しない */
    }
  }, [hydrated, state.chips]);

  const broke = state.chips < BACCARAT_MIN_BET;

  // 結果確定時に収支へ効果音を連動させる。
  const resultSoundRef = useRef(-1);
  useEffect(() => {
    if (state.phase !== "result") return;
    if (resultSoundRef.current === state.round) return;
    resultSoundRef.current = state.round;
    if (state.lastDelta > 0) sfxCorrect();
    else if (state.lastDelta < 0) sfxWrong();
    else sfxTap();
  }, [state.phase, state.round, state.lastDelta]);

  const deal = () => {
    setError(null);
    try {
      sfxDeal();
      setState((s) => placeBaccaratBet(s, betKind, amount));
    } catch (e) {
      sfxWrong();
      setError(e instanceof Error ? e.message : "賭けられませんでした");
    }
  };

  const resultText =
    state.phase !== "result" || !state.winner
      ? null
      : state.winner === "tie"
        ? "タイ（引き分け）！"
        : state.winner === "player"
          ? "プレイヤーの勝ち！"
          : "バンカーの勝ち！";

  // テーブルのタップ/フリック: 賭け中は配る、チップ切れは再支給、結果中は次のラウンドへ。
  const tableAction = () => {
    if (state.phase === "result") {
      sfxTap();
      setState((s) => nextBaccaratRound(s));
      return;
    }
    if (state.phase !== "betting") return;
    if (broke) {
      sfxPop();
      setState((s) => refillBaccarat(s));
      return;
    }
    deal();
  };
  const tableGesture = useGesture({ onTap: tableAction, onSwipe: tableAction });
  const tableKeyDown = (e: { key: string; preventDefault: () => void }) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    tableAction();
  };

  // 2D テーブル（WebGL が使えない場合のフォールバックとしてそのまま使う）。
  const table2d = (
    <div
      {...tableGesture}
      role="button"
      tabIndex={0}
      onKeyDown={tableKeyDown}
      aria-label={
        state.phase === "result"
          ? "テーブル（タップで次のラウンドへ）"
          : broke
            ? "テーブル（タップでチップを再支給）"
            : "テーブル（タップで配る）"
      }
      style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14, touchAction: "none", cursor: "pointer" }}
    >
      <HandRow title="プレイヤー" cards={state.playerCards} color="#2563eb" />
      <HandRow title="バンカー" cards={state.bankerCards} color="#dc2626" />
    </div>
  );

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>バカラ</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>バカラ</h1>
        <p className="muted">
          賭け先と金額を選んでテーブルをタップすると、カードが配られて結果が決まります。第3カードは正式ルールで自動的に引かれます。
        </p>
      </div>

      <p className="classic-status" role="status">
        チップ {state.chips} ・ ラウンド {state.round + (state.phase === "betting" ? 1 : 0)}
        {state.phase === "result" && resultText
          ? ` ・ ${resultText} （${state.lastDelta > 0 ? `+${state.lastDelta}` : state.lastDelta}）`
          : ""}
        {state.phase === "result" && state.lastDelta !== 0 ? (
          <ScorePop key={state.round} amount={state.lastDelta} />
        ) : null}
      </p>

      {webglFailed ? table2d : (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontWeight: 800, color: "#2563eb" }}>
              プレイヤー（手前）
              {state.playerCards.length > 0 ? `・合計 ${baccaratHandValue(state.playerCards)}` : ""}
            </span>
            <span style={{ fontWeight: 800, color: "#dc2626" }}>
              バンカー（奥）
              {state.bankerCards.length > 0 ? `・合計 ${baccaratHandValue(state.bankerCards)}` : ""}
            </span>
          </div>
          <BaccaratScene3D
            playerCards={state.playerCards}
            bankerCards={state.bankerCards}
            phase={state.phase}
            chipAmount={state.phase === "betting" ? amount : state.lastBet?.amount ?? 0}
            chipKind={state.phase === "betting" ? betKind : state.lastBet?.kind ?? betKind}
            onTapAction={tableAction}
            onFail={() => setWebglFailed(true)}
            fallback={table2d}
          />
        </div>
      )}

      {state.phase === "betting" ? (
        <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <div className="classic-controls" role="group" aria-label="賭け先" style={{ margin: 0 }}>
            {BET_OPTIONS.map((opt) => (
              <div
                key={opt.kind}
                {...tappableProps(() => { sfxTap(); setBetKind(opt.kind); })}
                aria-pressed={betKind === opt.kind}
                className={betKind === opt.kind ? "classic-btn classic-btn-active" : "classic-btn"}
                title={opt.note}
              >
                {opt.label}
              </div>
            ))}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {BET_OPTIONS.find((o) => o.kind === betKind)?.note} ・ タイのときはプレイヤー／バンカーへの賭けは返金されます。
          </p>
          <div className="classic-controls" role="group" aria-label="賭け金" style={{ margin: 0 }}>
            {AMOUNTS.map((a) => (
              <div
                key={a}
                {...tappableProps(() => { sfxTap(); setAmount(a); })}
                aria-pressed={amount === a}
                className={amount === a ? "classic-btn classic-btn-active" : "classic-btn"}
              >
                {a}
              </div>
            ))}
          </div>
          {error ? (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontWeight: 700 }}>
              {error}
            </p>
          ) : null}
          <p className="muted" style={{ margin: 0 }}>
            {broke
              ? `チップが足りません。テーブルをタップで再支給（${BACCARAT_START_CHIPS}）`
              : `テーブルをタップで配る（${amount} チップ賭ける）`}
          </p>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          テーブルをタップで次のラウンドへ
        </p>
      )}

      {state.history.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontWeight: 800, margin: "0 0 6px" }}>直近の結果</p>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} aria-label="勝敗履歴">
            {state.history.map((w, i) => (
              <span
                key={i}
                title={w === "player" ? "プレイヤー勝ち" : w === "banker" ? "バンカー勝ち" : "タイ"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: w === "player" ? "#2563eb" : w === "banker" ? "#dc2626" : "#16a34a",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 800,
                }}
              >
                {w === "player" ? "P" : w === "banker" ? "B" : "T"}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
