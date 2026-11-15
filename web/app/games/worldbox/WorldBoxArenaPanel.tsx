"use client";
// AGO WORLD BOX の闘技場パネル（ロビー北の半円アリーナ専用）。
// 位置の検証はサーバー側（プレゼンス）。参加費と賞金は経済ブリッジ経由で、
// 試合の状態はサーバー側セッションが持つ。ここは表示と入力だけ。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaTier } from "@/lib/worldbox/arena";

type LoadState = "loading" | "ready" | "guest" | "unavailable";

interface ArenaSessionView {
  state: "paying" | "fighting";
  tierId: string;
  tierName: string;
  fee: number;
  prize: number;
  playerHp: number;
  playerHpMax: number;
  enemyHp: number;
  enemyHpMax: number;
  turn: number;
  log: string[];
}

interface ArenaState {
  balance: number | null;
  effectiveBalance: number | null;
  attack: number;
  tiers: ArenaTier[];
  session: ArenaSessionView | null;
}

const ERROR_LABEL: Record<string, string> = {
  not_at_arena: "闘技場にいません",
  session_active: "進行中の試合があります",
  no_session: "試合が始まっていません",
  insufficient_balance: "コインが足りません",
  payment_pending: "参加費を処理中です。少し待ってください",
  payment_failed: "参加費の支払いに失敗しました",
  bad_tier: "相手が不正です",
  bad_move: "手が不正です",
  unauthorized: "ログインが必要です",
  economy_unavailable: "いま闘技場を使えません",
};

const wrap: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(430px, calc(100% - 20px))", maxHeight: "calc(100% - 24px)", overflowY: "auto",
  boxSizing: "border-box", padding: 16, borderRadius: 14,
  background: "rgba(12,14,22,0.94)", color: "#fff", zIndex: 6,
  boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
};
const btn: React.CSSProperties = {
  minHeight: 40, padding: "6px 14px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)", color: "#fff", fontSize: 14, cursor: "pointer",
};
const barOuter: React.CSSProperties = {
  height: 12, borderRadius: 6, background: "rgba(255,255,255,0.15)", overflow: "hidden",
};

function HpBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div style={barOuter}>
      <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, background: color, transition: "width 0.25s" }} />
    </div>
  );
}

export default function WorldBoxArenaPanel({ onClose }: { onClose: () => void }) {
  const [load, setLoad] = useState<LoadState>("loading");
  const [state, setState] = useState<ArenaState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [outcome, setOutcome] = useState<"win" | "lose" | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/arena", { headers: { Accept: "application/json" } });
      if (res.status === 401 || res.status === 403) { if (aliveRef.current) setLoad("guest"); return; }
      if (!res.ok) { if (aliveRef.current) setLoad("unavailable"); return; }
      const data = (await res.json()) as ArenaState;
      if (!aliveRef.current) return;
      setState(data);
      setLoad("ready");
    } catch {
      if (aliveRef.current) setLoad("unavailable");
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { aliveRef.current = false; window.clearInterval(timer); };
  }, [refresh]);

  const post = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/worldbox/arena", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as ArenaState & { error?: string; outcome?: "win" | "lose" };
      if (!res.ok) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "受け付けられませんでした");
        if (data.error === "payment_pending") void refresh();
        return;
      }
      setMsg("");
      setState(data);
      if (data.outcome) setOutcome(data.outcome);
    } catch {
      setMsg("受け付けられませんでした");
    } finally {
      setBusy(false);
    }
  };

  const session = state?.session ?? null;

  return (
    <div style={wrap} role="dialog" aria-label="闘技場">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <strong style={{ fontSize: 16 }}>闘技場</strong>
        <button type="button" style={{ ...btn, minHeight: 32, padding: "2px 10px" }} onClick={onClose}>閉じる</button>
      </div>

      {load === "loading" && <p style={{ margin: 0, fontSize: 13 }}>読み込み中…</p>}
      {load === "guest" && <p style={{ margin: 0, fontSize: 13 }}>Discord ログインが必要です</p>}
      {load === "unavailable" && <p style={{ margin: 0, fontSize: 13 }}>いま闘技場を使えません</p>}

      {load === "ready" && state && (
        <>
          <p style={{ margin: "0 0 10px", fontSize: 13 }}>
            残高 {state.effectiveBalance ?? "―"} ／ 攻撃力 {state.attack}
          </p>

          {outcome && (
            <div style={{ marginBottom: 12, textAlign: "center" }}>
              <p style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700 }}>
                {outcome === "win" ? "勝利" : "敗北"}
              </p>
              <button
                type="button" style={btn} disabled={busy}
                onClick={() => { setOutcome(null); void refresh(); }}
              >
                次へ
              </button>
            </div>
          )}

          {!outcome && !session && (
            <div style={{ display: "grid", gap: 8 }}>
              {state.tiers.map((t) => (
                <button
                  key={t.id} type="button" disabled={busy}
                  style={{ ...btn, display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left" }}
                  onClick={() => void post({ action: "start", tier: t.id })}
                >
                  <span>{t.name}（HP {t.enemyHp}）</span>
                  <span>参加費 {t.fee} → 賞金 {t.prize}</span>
                </button>
              ))}
            </div>
          )}

          {!outcome && session && (
            <div>
              <p style={{ margin: "0 0 4px", fontSize: 13 }}>{session.tierName}（{session.turn} 手目）</p>
              <HpBar value={session.enemyHp} max={session.enemyHpMax} color="#e5534b" />
              <p style={{ margin: "8px 0 4px", fontSize: 13 }}>自分 HP {session.playerHp}</p>
              <HpBar value={session.playerHp} max={session.playerHpMax} color="#3fb950" />
              {session.state === "paying" ? (
                <p style={{ margin: "10px 0 0", fontSize: 13 }}>参加費を処理中…</p>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button type="button" style={{ ...btn, flex: 1 }} disabled={busy} onClick={() => void post({ action: "act", move: "attack" })}>たたかう</button>
                  <button type="button" style={{ ...btn, flex: 1 }} disabled={busy} onClick={() => void post({ action: "act", move: "heavy" })}>強攻撃</button>
                  <button type="button" style={{ ...btn, flex: 1 }} disabled={busy} onClick={() => void post({ action: "act", move: "guard" })}>まもる</button>
                </div>
              )}
              <div style={{ display: "grid", gap: 2, marginTop: 12, fontSize: 12, opacity: 0.85 }}>
                {session.log.map((line, i) => <span key={i}>{line}</span>)}
              </div>
              <button
                type="button" disabled={busy}
                style={{ ...btn, minHeight: 32, padding: "2px 10px", marginTop: 12 }}
                onClick={() => void post({ action: "forfeit" })}
              >
                棄権する
              </button>
            </div>
          )}

          {msg && <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{msg}</p>}
        </>
      )}
    </div>
  );
}
