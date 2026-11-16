"use client";
// AGO WORLD BOX の闘技場パネル（ロビー北の半円アリーナ専用）。
// 位置の検証はサーバー側（プレゼンス）。参加費と賞金は経済ブリッジ経由で、
// 試合の状態はサーバー側セッションが持つ。ここは表示と入力だけ。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaTier } from "@/lib/worldbox/arena";
import { onEconomyApplied } from "@/lib/worldbox/economy-push";
import { createPollGuard, type PollGuard } from "@/lib/poll-guard";

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

interface PvpDuelView {
  state: "paying" | "fighting";
  yourHp: number;
  yourHpMax: number;
  opponentHp: number;
  opponentHpMax: number;
  yourTurn: boolean;
  turnNo: number;
  fee: number;
  prize: number;
  log: string[];
}

interface PvpState {
  queued: boolean;
  queuePosition: number | null;
  duel: PvpDuelView | null;
}

interface TournamentView {
  status: "none" | "entry" | "running" | "done";
  fee: number;
  maxEntrants: number;
  entrantCount: number;
  entryEndsAt: number | null;
  prizePool: number;
  entered: boolean;
  champion: "you" | "decided" | null;
  myMatch: { round: number; state: "pending" | "dueling" | "done"; won: boolean | null } | null;
  decidedMatches: number;
  totalMatches: number;
}

interface TournamentState {
  tournament: TournamentView;
}

const ERROR_LABEL: Record<string, string> = {
  not_at_arena: "闘技場にいません",
  session_active: "進行中の試合があります",
  no_session: "試合が始まっていません",
  insufficient_balance: "コインが足りません",
  not_your_turn: "相手の番です",
  payment_pending: "参加費を処理中です。少し待ってください",
  payment_failed: "参加費の支払いに失敗しました",
  tournament_closed: "大会は締め切られました",
  tournament_full: "大会は満員です",
  bad_tier: "相手が不正です",
  bad_move: "手が不正です",
  unauthorized: "ログインが必要です",
  economy_unavailable: "いま闘技場を使えません",
};

/** 階級の大きさの気配（敵HPの数値は出さない）。未知の id には何も付けない。 */
const TIER_SIZE_LABEL: Record<string, string> = {
  slime: "小さい",
  golem: "大きい",
  dragon: "巨大",
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

function tournamentRoundLabel(round: number, totalMatches: number): string {
  const lastRound = totalMatches <= 1 ? 0 : totalMatches <= 3 ? 1 : 2;
  if (round >= lastRound) return "決勝";
  if (round === 1) return "準決勝";
  return `${round + 1}回戦`;
}

export default function WorldBoxArenaPanel({ onClose }: { onClose: () => void }) {
  const [load, setLoad] = useState<LoadState>("loading");
  const [state, setState] = useState<ArenaState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [outcome, setOutcome] = useState<"win" | "lose" | null>(null);
  const [pvp, setPvp] = useState<PvpState | null>(null);
  const [pvpMsg, setPvpMsg] = useState("");
  const [pvpOutcome, setPvpOutcome] = useState<"win" | "lose" | null>(null);
  const [tournament, setTournament] = useState<TournamentView | null>(null);
  const [tournamentMsg, setTournamentMsg] = useState("");
  const aliveRef = useRef(true);
  // ポーリングガード（S6）: 3本の取得を重ねて走らせず、古いレスポンスで
  // 対戦・大会の状態を巻き戻さない（カジノパネルと同じ規則）。
  const arenaGuardRef = useRef<PollGuard>(createPollGuard());
  const pvpGuardRef = useRef<PollGuard>(createPollGuard());
  const tournamentGuardRef = useRef<PollGuard>(createPollGuard());

  const refresh = useCallback(async () => {
    const ticket = arenaGuardRef.current.begin();
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/arena", { headers: { Accept: "application/json" } });
      if (res.status === 401 || res.status === 403) { if (aliveRef.current) setLoad("guest"); return; }
      if (!res.ok) { if (aliveRef.current) setLoad("unavailable"); return; }
      const data = (await res.json()) as ArenaState;
      if (!aliveRef.current || !arenaGuardRef.current.isCurrent(ticket)) return;
      setState(data);
      setLoad("ready");
    } catch {
      if (aliveRef.current) setLoad("unavailable");
    } finally {
      arenaGuardRef.current.end(ticket);
    }
  }, []);

  const refreshPvp = useCallback(async () => {
    const ticket = pvpGuardRef.current.begin();
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/pvp", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as PvpState;
      if (!aliveRef.current || !pvpGuardRef.current.isCurrent(ticket)) return;
      setPvp(data);
    } catch {
      // 対人戦の取得失敗は PvE の表示を壊さない（次の更新で取り直す）
    } finally {
      pvpGuardRef.current.end(ticket);
    }
  }, []);

  const refreshTournament = useCallback(async () => {
    const ticket = tournamentGuardRef.current.begin();
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/tournament", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as TournamentState;
      if (!aliveRef.current || !tournamentGuardRef.current.isCurrent(ticket)) return;
      setTournament(data.tournament);
    } catch {
      // 大会の取得失敗は闘技場の表示を壊さない（次の更新で取り直す）
    } finally {
      tournamentGuardRef.current.end(ticket);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    void refreshPvp();
    void refreshTournament();
    const timer = window.setInterval(() => { void refresh(); void refreshPvp(); void refreshTournament(); }, 3000);
    // 経済オプ確定の push でも即時更新する（3秒ポーリングは fallback）
    const off = onEconomyApplied(() => { void refresh(); void refreshPvp(); void refreshTournament(); });
    return () => { aliveRef.current = false; window.clearInterval(timer); off(); };
  }, [refresh, refreshPvp, refreshTournament]);

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

  const postPvp = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/worldbox/pvp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as PvpState & { error?: string; outcome?: "win" | "lose" };
      if (!res.ok) {
        setPvpMsg(ERROR_LABEL[data.error ?? ""] ?? "受け付けられませんでした");
        if (data.error === "payment_pending") void refreshPvp();
        return;
      }
      setPvpMsg("");
      setPvp(data);
      if (data.outcome) setPvpOutcome(data.outcome);
    } catch {
      setPvpMsg("受け付けられませんでした");
    } finally {
      setBusy(false);
    }
  };

  const postTournament = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch("/api/worldbox/tournament", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as TournamentState & { error?: string };
      if (!res.ok) {
        setTournamentMsg(ERROR_LABEL[data.error ?? ""] ?? "受け付けられませんでした");
        return;
      }
      setTournamentMsg("");
      setTournament(data.tournament);
    } catch {
      setTournamentMsg("受け付けられませんでした");
    } finally {
      setBusy(false);
    }
  };

  const session = state?.session ?? null;

  return (
    <div style={wrap} role="dialog" aria-label="闘技場" className="wb-panel">
      <div
        style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          position: "sticky", top: -16, zIndex: 3,
          margin: "-16px -16px 10px", padding: "16px 16px 8px",
          background: "rgba(12,14,22,0.98)",
        }}
      >
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

          {!outcome && !session && !pvp?.duel && (
            <div style={{ display: "grid", gap: 8 }}>
              {state.tiers.map((t) => {
                const sizeLabel = TIER_SIZE_LABEL[t.id];
                return (
                  <button
                    key={t.id} type="button" disabled={busy}
                    style={{ ...btn, display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left" }}
                    onClick={() => void post({ action: "start", tier: t.id })}
                  >
                    <span>{sizeLabel ? `${t.name}（${sizeLabel}）` : t.name}</span>
                    <span>参加費 {t.fee} ・ 勝てば賞金</span>
                  </button>
                );
              })}
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

          {!outcome && !session && pvp && (
            <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12 }}>
              <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700 }}>対人戦</p>
              {pvpOutcome && (
                <div style={{ marginBottom: 12, textAlign: "center" }}>
                  <p style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700 }}>
                    {pvpOutcome === "win" ? "勝利" : "敗北"}
                  </p>
                  <button
                    type="button" style={btn} disabled={busy}
                    onClick={() => { setPvpOutcome(null); void refreshPvp(); }}
                  >
                    次へ
                  </button>
                </div>
              )}
              {!pvpOutcome && !pvp.duel && !pvp.queued && (
                <button
                  type="button" disabled={busy}
                  style={{ ...btn, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left" }}
                  onClick={() => void postPvp({ action: "queue" })}
                >
                  <span>対戦相手を探す</span>
                  <span>参加費 100 → 賞金 240</span>
                </button>
              )}
              {!pvpOutcome && !pvp.duel && pvp.queued && (
                <div>
                  <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                    相手を待っています{pvp.queuePosition ? `（${pvp.queuePosition} 番目）` : ""}
                  </p>
                  <button type="button" style={{ ...btn, minHeight: 32, padding: "2px 10px" }} disabled={busy} onClick={() => void postPvp({ action: "leave" })}>やめる</button>
                </div>
              )}
              {!pvpOutcome && pvp.duel && (
                <div>
                  <p style={{ margin: "0 0 4px", fontSize: 13 }}>あいて HP {pvp.duel.opponentHp}</p>
                  <HpBar value={pvp.duel.opponentHp} max={pvp.duel.opponentHpMax} color="#e5534b" />
                  <p style={{ margin: "8px 0 4px", fontSize: 13 }}>自分 HP {pvp.duel.yourHp}</p>
                  <HpBar value={pvp.duel.yourHp} max={pvp.duel.yourHpMax} color="#3fb950" />
                  {pvp.duel.state === "paying" ? (
                    <p style={{ margin: "10px 0 0", fontSize: 13 }}>参加費を処理中…</p>
                  ) : (
                    <>
                      <p style={{ margin: "10px 0 0", fontSize: 13 }}>
                        {pvp.duel.yourTurn ? "あなたの番です" : "相手の番です"}（{pvp.duel.turnNo} 手目）
                      </p>
                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <button type="button" style={{ ...btn, flex: 1 }} disabled={busy || !pvp.duel.yourTurn} onClick={() => void postPvp({ action: "act", move: "attack" })}>たたかう</button>
                        <button type="button" style={{ ...btn, flex: 1 }} disabled={busy || !pvp.duel.yourTurn} onClick={() => void postPvp({ action: "act", move: "heavy" })}>強攻撃</button>
                        <button type="button" style={{ ...btn, flex: 1 }} disabled={busy || !pvp.duel.yourTurn} onClick={() => void postPvp({ action: "act", move: "guard" })}>まもる</button>
                      </div>
                    </>
                  )}
                  <div style={{ display: "grid", gap: 2, marginTop: 12, fontSize: 12, opacity: 0.85 }}>
                    {pvp.duel.log.map((line, i) => <span key={i}>{line}</span>)}
                  </div>
                  <button
                    type="button" disabled={busy}
                    style={{ ...btn, minHeight: 32, padding: "2px 10px", marginTop: 12 }}
                    onClick={() => void postPvp({ action: "forfeit" })}
                  >
                    降参する
                  </button>
                </div>
              )}
              {pvpMsg && <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{pvpMsg}</p>}
            </div>
          )}

          {!outcome && !session && tournament && (
            <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.15)", paddingTop: 12 }}>
              <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 700 }}>大会</p>
              {tournament.status === "none" && (
                <button
                  type="button" disabled={busy}
                  style={{ ...btn, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left" }}
                  onClick={() => void postTournament({ action: "enter" })}
                >
                  <span>大会に参加する</span>
                  <span>参加費 {tournament.fee} → 優勝賞金は参加費の総額</span>
                </button>
              )}
              {tournament.status === "entry" && (
                <div>
                  <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                    募集中（{tournament.entrantCount}/{tournament.maxEntrants}人）・賞金総額 {tournament.prizePool}
                  </p>
                  {tournament.entered ? (
                    <p style={{ margin: 0, fontSize: 13 }}>参加済みです</p>
                  ) : (
                    <button
                      type="button" disabled={busy}
                      style={{ ...btn, display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left" }}
                      onClick={() => void postTournament({ action: "enter" })}
                    >
                      <span>参加する</span>
                      <span>参加費 {tournament.fee}</span>
                    </button>
                  )}
                </div>
              )}
              {tournament.status === "running" && (
                <div>
                  <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                    開催中（{tournament.decidedMatches}/{tournament.totalMatches}試合決着）・賞金総額 {tournament.prizePool}
                  </p>
                  {tournament.entered && tournament.myMatch && (
                    <p style={{ margin: 0, fontSize: 13 }}>
                      {tournamentRoundLabel(tournament.myMatch.round, tournament.totalMatches)}
                      {tournament.myMatch.state === "pending" && " — 対戦相手を待っています"}
                      {tournament.myMatch.state === "dueling" && " — 決闘中です。対人戦で戦ってください"}
                      {tournament.myMatch.state === "done" && (tournament.myMatch.won ? " — 勝利" : " — 敗退")}
                    </p>
                  )}
                </div>
              )}
              {tournament.status === "done" && (
                <p style={{ margin: 0, fontSize: 13 }}>
                  {tournament.champion === "you"
                    ? `優勝 — 賞金 ${tournament.prizePool}`
                    : tournament.champion === "decided"
                      ? "優勝者が決まりました"
                      : "不成立 — 参加費を返金します"}
                </p>
              )}
              {tournamentMsg && <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{tournamentMsg}</p>}
            </div>
          )}

          {msg && <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{msg}</p>}
        </>
      )}
    </div>
  );
}
