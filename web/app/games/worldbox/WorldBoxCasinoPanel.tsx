"use client";
// AGO WORLD BOX のカジノパネル（ロビー右翼のカジノルーム専用）。
// スロットマシンの前ではスロット、カジノテーブルの前ではルーレット。
// 位置の検証はサーバー側（プレゼンス）が行い、このパネルは今いる機器を
// 表示して遊ぶだけ。コインの正は AGO コイン本体: プレイは gamble オプ
// として Bot 本体が適用し、残高はその結果を読み直して表示する。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CASINO_BET_TIERS, SLOT_SYMBOLS,
  type CasinoMachine, type RouletteColor, type RoulettePick,
} from "@/lib/worldbox/casino";
import type { EconomyOp } from "@/lib/worldbox/economy-bridge";

type LoadState = "loading" | "ready" | "guest" | "unavailable";

interface CasinoState {
  balance: number;
  effectiveBalance: number;
  machine: CasinoMachine | null;
  ops: EconomyOp[];
}

type PlayResult =
  | { game: "slot"; reels: [number, number, number]; payout: number }
  | { game: "roulette"; number: number; color: RouletteColor; payout: number };

const ERROR_LABEL: Record<string, string> = {
  not_enough_coins: "コインが足りません",
  not_at_casino: "カジノの機器の前にいません",
  wrong_machine: "その機器では遊べません",
  invalid_bet: "ベット額が不正です",
  unauthorized: "ログインが必要です",
  discord_required: "Discord ログインが必要です",
  economy_unavailable: "いまカジノを使えません",
  economy_failed: "受け付けられませんでした",
};

const OP_STATUS_LABEL: Record<EconomyOp["status"], string> = {
  pending: "処理中",
  done: "精算済み",
  failed: "失敗",
};

const root: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(400px, calc(100% - 24px))", maxHeight: "calc(100% - 24px)", overflowY: "auto",
  padding: 14, borderRadius: 12, zIndex: 6, textAlign: "left",
  border: "1px solid rgba(255,210,62,0.45)", background: "rgba(12,10,18,0.94)", color: "#fff",
  boxShadow: "0 10px 32px rgba(0,0,0,0.55)",
};
const btn: React.CSSProperties = {
  minHeight: 38, padding: "4px 14px", borderRadius: 10, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.07)", color: "inherit",
  touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
};
const chipOn: React.CSSProperties = {
  background: "rgba(255,210,62,0.22)", borderColor: "rgba(255,210,62,0.8)",
};
const reelBox: React.CSSProperties = {
  width: 72, height: 84, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 44, fontWeight: 700, background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.22)",
};

export default function WorldBoxCasinoPanel({ onClose }: { onClose: () => void }) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [state, setState] = useState<CasinoState | null>(null);
  const [bet, setBet] = useState<number>(CASINO_BET_TIERS[0]);
  const [pick, setPick] = useState<RoulettePick>("red");
  const [result, setResult] = useState<PlayResult | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [spinReels, setSpinReels] = useState<[number, number, number]>([1, 2, 3]);
  const [msg, setMsg] = useState("");
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/casino", { headers: { Accept: "application/json" } });
      if (res.status === 401 || res.status === 403) {
        if (aliveRef.current) setLoadState("guest");
        return;
      }
      if (!res.ok) {
        if (aliveRef.current) setLoadState((prev) => (prev === "ready" ? prev : "unavailable"));
        return;
      }
      const data = (await res.json()) as CasinoState;
      if (aliveRef.current) {
        setState(data);
        setLoadState("ready");
      }
    } catch {
      if (aliveRef.current) setLoadState((prev) => (prev === "ready" ? prev : "unavailable"));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  // スロットの回転演出（結果が返るまで絵柄を回し続ける）
  useEffect(() => {
    if (!spinning) return;
    const timer = window.setInterval(() => {
      setSpinReels([
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
        Math.floor(Math.random() * SLOT_SYMBOLS.length),
      ]);
    }, 90);
    return () => window.clearInterval(timer);
  }, [spinning]);

  const play = async () => {
    if (!state?.machine || spinning) return;
    const game = state.machine;
    setMsg("");
    setResult(null);
    setSpinning(true);
    try {
      const res = await fetch("/api/worldbox/casino", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(game === "slot" ? { game, bet } : { game, bet, pick }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; payout?: number;
        result?: { reels?: [number, number, number]; number?: number; color?: RouletteColor };
      };
      if (!res.ok) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "遊べませんでした");
        return;
      }
      // 演出を少し見せてから結果で止める
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      if (!aliveRef.current) return;
      if (game === "slot" && data.result?.reels) {
        setResult({ game, reels: data.result.reels, payout: data.payout ?? 0 });
      } else if (game === "roulette" && typeof data.result?.number === "number" && data.result.color) {
        setResult({ game, number: data.result.number, color: data.result.color, payout: data.payout ?? 0 });
      }
      void refresh();
    } catch {
      if (aliveRef.current) setMsg("遊べませんでした");
    } finally {
      if (aliveRef.current) setSpinning(false);
    }
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <strong>カジノ</strong>
      {state && <span>残高 <strong>{state.effectiveBalance}</strong></span>}
      <span style={{ flex: 1 }} />
      <button type="button" style={{ ...btn, minHeight: 32, padding: "2px 10px" }} onClick={onClose}>
        閉じる
      </button>
    </div>
  );

  if (loadState === "loading") return <div style={root}>{header}<p style={{ margin: "10px 0 0" }}>読み込み中…</p></div>;
  if (loadState === "guest") return <div style={root}>{header}<p style={{ margin: "10px 0 0" }}>ログインが必要です</p></div>;
  if (loadState === "unavailable" || !state) {
    return <div style={root}>{header}<p style={{ margin: "10px 0 0" }}>いまカジノを使えません</p></div>;
  }

  const machine = state.machine;
  const shownReels: [number, number, number] =
    result?.game === "slot" ? result.reels : spinReels;
  const pending = state.ops.filter((op) => op.status === "pending");
  const recent = state.ops.slice(0, 3);

  return (
    <div style={root} role="dialog" aria-label="カジノ">
      {header}

      {machine === null && (
        <p style={{ margin: "12px 0 0" }}>スロットマシンかカジノテーブルの前へ</p>
      )}

      {machine === "slot" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            {shownReels.map((idx, i) => (
              <div key={i} style={{ ...reelBox, color: SLOT_SYMBOLS[idx].color }}>
                {SLOT_SYMBOLS[idx].glyph}
              </div>
            ))}
          </div>
        </div>
      )}

      {machine === "roulette" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
            <div
              style={{
                width: 84, height: 84, borderRadius: "50%", display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 34, fontWeight: 700,
                border: "2px solid rgba(255,255,255,0.35)",
                background:
                  result?.game === "roulette"
                    ? result.color === "red" ? "#b03030" : result.color === "green" ? "#2e7d46" : "#26262e"
                    : "#26262e",
              }}
            >
              {result?.game === "roulette" ? result.number : "―"}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <button type="button" style={{ ...btn, ...(pick === "red" ? { background: "#b03030", borderColor: "#ff8a8a" } : {}) }}
                onClick={() => setPick("red")} aria-pressed={pick === "red"}>
                赤
              </button>
              <button type="button" style={{ ...btn, ...(pick === "black" ? { background: "#26262e", borderColor: "#9a9aad" } : {}) }}
                onClick={() => setPick("black")} aria-pressed={pick === "black"}>
                黒
              </button>
            </div>
          </div>
        </div>
      )}

      {machine !== null && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
            <span>ベット</span>
            {CASINO_BET_TIERS.map((tier) => (
              <button key={tier} type="button" style={{ ...btn, ...(bet === tier ? chipOn : {}) }}
                onClick={() => setBet(tier)} aria-pressed={bet === tier}>
                {tier}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button type="button" disabled={spinning || bet > state.effectiveBalance}
              style={{ ...btn, background: "rgba(255,210,62,0.25)", borderColor: "rgba(255,210,62,0.7)", fontWeight: 700 }}
              onClick={() => void play()}>
              {machine === "slot" ? "回す" : "賭ける"}
            </button>
          </div>
          {result && !spinning && (
            <p role="status" style={{ margin: "10px 0 0", fontWeight: 700 }}>
              {result.payout > 0 ? `当たり 配当 ${result.payout}` : "はずれ"}
            </p>
          )}
          {pending.length > 0 && (
            <p style={{ margin: "8px 0 0", fontSize: 12, opacity: 0.8 }}>
              処理中 {pending.reduce((sum, op) => sum + op.amount, 0)} コイン
            </p>
          )}
        </>
      )}

      {recent.length > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 8 }}>
          {recent.map((op) => (
            <div key={op.id} style={{ display: "flex", gap: 8, fontSize: 12, padding: "3px 0" }}>
              <span>{op.reason === "casino_slot" ? "スロット" : "ルーレット"}</span>
              <span style={{ opacity: 0.75 }}>ベット {op.amount}</span>
              <span style={{ flex: 1 }} />
              {op.status === "done" && <span>配当 {op.appliedAmount ?? 0}</span>}
              <span style={{ opacity: 0.75 }}>{OP_STATUS_LABEL[op.status]}</span>
            </div>
          ))}
        </div>
      )}

      {msg && <p role="status" style={{ margin: "10px 0 0" }}>{msg}</p>}
    </div>
  );
}
