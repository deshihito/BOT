"use client";
// バカラ。ロジックは lib/baccarat.ts（第3カードのルール表は正式ルール）。
// チップは端末内だけの遊び用ポイントで、localStorage に保存する。
// チップが動くのは「配る」＝結果確定の遷移だけなので、読み込み完了後に
// チップ残高が変わったタイミングで保存すれば確定時のみ保存になる。
import Link from "next/link";
import { useEffect, useState } from "react";
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
        {cards.length === 0 ? <span className="muted">まだ配られていません</span> : cards.map((c, i) => <CardChip key={i} card={c} />)}
      </div>
    </div>
  );
}

export default function BaccaratClient() {
  const { prefix } = useGamesNav();
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
  const canBet = state.phase === "betting" && !broke;

  const deal = () => {
    setError(null);
    try {
      setState((s) => placeBaccaratBet(s, betKind, amount));
    } catch (e) {
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
          賭け先と金額を選んで「配る」を押すと、カードが配られて結果が決まります。第3カードは正式ルールで自動的に引かれます。
        </p>
      </div>

      <p className="classic-status" role="status">
        チップ {state.chips} ・ ラウンド {state.round + (state.phase === "betting" ? 1 : 0)}
        {state.phase === "result" && resultText
          ? ` ・ ${resultText} （${state.lastDelta > 0 ? `+${state.lastDelta}` : state.lastDelta}）`
          : ""}
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <HandRow title="プレイヤー" cards={state.playerCards} color="#2563eb" />
        <HandRow title="バンカー" cards={state.bankerCards} color="#dc2626" />
      </div>

      {state.phase === "betting" ? (
        <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <div className="classic-controls" role="group" aria-label="賭け先" style={{ margin: 0 }}>
            {BET_OPTIONS.map((opt) => (
              <button
                key={opt.kind}
                type="button"
                aria-pressed={betKind === opt.kind}
                className={betKind === opt.kind ? "classic-btn classic-btn-active" : "classic-btn"}
                onClick={() => setBetKind(opt.kind)}
                title={opt.note}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {BET_OPTIONS.find((o) => o.kind === betKind)?.note} ・ タイのときはプレイヤー／バンカーへの賭けは返金されます。
          </p>
          <div className="classic-controls" role="group" aria-label="賭け金" style={{ margin: 0 }}>
            {AMOUNTS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={amount === a}
                className={amount === a ? "classic-btn classic-btn-active" : "classic-btn"}
                onClick={() => setAmount(a)}
              >
                {a}
              </button>
            ))}
          </div>
          {error ? (
            <p role="alert" style={{ color: "#b91c1c", margin: 0, fontWeight: 700 }}>
              {error}
            </p>
          ) : null}
          {broke ? (
            <button
              type="button"
              className="classic-btn"
              onClick={() => setState((s) => refillBaccarat(s))}
            >
              チップを再支給する（{BACCARAT_START_CHIPS}）
            </button>
          ) : (
            <button
              type="button"
              disabled={!canBet}
              onClick={deal}
              style={{
                minHeight: 48,
                borderRadius: 10,
                border: "2px solid #166534",
                background: "#16a34a",
                color: "#fff",
                fontSize: 16,
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              配る（{amount} チップ賭ける）
            </button>
          )}
        </div>
      ) : (
        <button type="button" className="classic-btn" onClick={() => setState((s) => nextBaccaratRound(s))}>
          次のラウンドへ
        </button>
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
