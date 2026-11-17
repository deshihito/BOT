"use client";
// AGO WORLD BOX の競馬パネル（ロビー競馬場の馬券カウンター/掲示板）。
// 出走表・オッズ・結果はサーバーが決定的ロジックから返す。ここは表示と
// 購入の入力だけ。購入はカウンター前でのみサーバーが受け付ける。
import { useCallback, useEffect, useRef, useState } from "react";
import { createPollGuard, type PollGuard } from "@/lib/poll-guard";
import { onEconomyApplied } from "@/lib/worldbox/economy-push";
import { BET_PRESETS, COAT_COLORS } from "@/lib/worldbox/racing";

type LoadState = "loading" | "ready" | "guest" | "unavailable";

interface EntryView {
  gate: number;
  horseId: number;
  name: string;
  sex: string;
  age: number;
  coat: string;
  style: string;
  form: [number, number][];
  popularity: { win: number; place: number };
  odds: { win: number; place: number };
}

interface MyBetView {
  betId: string;
  postMs: number;
  horseId: number;
  horseName: string;
  type: "win" | "place";
  amount: number;
  odds: number;
  settle: "open" | "settled" | "void";
  payout: number | null;
}

interface RacingState {
  balance: number;
  serverNow: number;
  next: {
    postMs: number;
    closesAtMs: number;
    bettingOpen: boolean;
    track: string;
    surface: string;
    distanceM: number;
    going: string;
    entries: EntryView[];
  };
  running: { postMs: number; endsAtMs: number; track: string } | null;
  last: {
    postMs: number;
    track: string;
    surface: string;
    distanceM: number;
    going: string;
    placings: { place: number; horseId: number; name: string; margin: string }[];
  };
  myBets: MyBetView[];
}

const ERROR_LABEL: Record<string, string> = {
  not_at_racecourse: "馬券カウンターの前にいません",
  betting_closed: "締め切りました",
  bet_failed: "コインが足りません",
  invalid_bet: "その馬券は買えません",
  economy_unavailable: "いま競馬場を使えません",
  unauthorized: "ログインが必要です",
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
const chip: React.CSSProperties = {
  minHeight: 36, padding: "4px 12px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 13, cursor: "pointer",
};

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export default function WorldBoxRacingPanel({ onClose }: { onClose: () => void }) {
  const [load, setLoad] = useState<LoadState>("loading");
  const [state, setState] = useState<RacingState | null>(null);
  const [selHorse, setSelHorse] = useState<number | null>(null);
  const [selType, setSelType] = useState<"win" | "place">("win");
  const [selAmount, setSelAmount] = useState<number>(500);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [nowTick, setNowTick] = useState(() => Date.now());
  /** 最後に受け取ったサーバー時刻と、その時点の端末時刻（カウントダウン補正用）。 */
  const serverClockRef = useRef<{ serverNow: number; clientNow: number } | null>(null);
  const aliveRef = useRef(true);
  const guardRef = useRef<PollGuard>(createPollGuard());

  const refresh = useCallback(async () => {
    const ticket = guardRef.current.begin();
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/racing", { headers: { Accept: "application/json" } });
      if (res.status === 401 || res.status === 403) { if (aliveRef.current) setLoad("guest"); return; }
      if (!res.ok) { if (aliveRef.current) setLoad("unavailable"); return; }
      const data = (await res.json()) as RacingState;
      if (!aliveRef.current || !guardRef.current.isCurrent(ticket)) return;
      serverClockRef.current = { serverNow: data.serverNow, clientNow: Date.now() };
      setState(data);
      setLoad("ready");
    } catch {
      if (aliveRef.current) setLoad("unavailable");
    } finally {
      guardRef.current.end(ticket);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    const clock = window.setInterval(() => setNowTick(Date.now()), 1000);
    const off = onEconomyApplied(() => { void refresh(); });
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      window.clearInterval(clock);
      off();
    };
  }, [refresh]);

  const buy = async () => {
    if (!state || selHorse === null || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/worldbox/racing", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          action: "bet",
          postMs: state.next.postMs,
          horseId: selHorse,
          type: selType,
          amount: selAmount,
          clientBetId: crypto.randomUUID(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "受け付けられませんでした");
        return;
      }
      setMsg("購入しました");
      void refresh();
    } catch {
      setMsg("受け付けられませんでした");
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <div style={{ fontSize: 17, fontWeight: 700 }}>競馬場</div>
      {state && <div style={{ marginLeft: "auto", fontSize: 13, opacity: 0.9 }}>{state.balance.toLocaleString()} コイン</div>}
      <button type="button" style={{ ...btn, minHeight: 36, padding: "4px 12px" }} onClick={onClose}>閉じる</button>
    </div>
  );

  if (load !== "ready" || !state) {
    return (
      <div style={wrap}>
        {header}
        <div style={{ fontSize: 14, opacity: 0.85, padding: "12px 0" }}>
          {load === "guest" ? "Discord ログインが必要です" : load === "unavailable" ? "いま競馬場を使えません" : "読み込み中…"}
        </div>
      </div>
    );
  }

  const { next, last } = state;
  // サーバー時刻ベースでカウントダウンを引く（端末時計のズレ対策）。
  const clock = serverClockRef.current;
  const estServerNow = clock ? clock.serverNow + (nowTick - clock.clientNow) : nowTick;
  const countdownMs = next.closesAtMs - estServerNow;
  const selected = next.entries.find((e) => e.horseId === selHorse) ?? null;
  const selOdds = selected ? (selType === "win" ? selected.odds.win : selected.odds.place) : 0;

  return (
    <div style={wrap}>
      {header}

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{next.track}競馬場</div>
        <div style={{ fontSize: 12, opacity: 0.85 }}>{next.surface} {next.distanceM}m ・ {next.going}</div>
        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.85 }}>{fmtClock(next.postMs)} 発走</div>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.15)", overflow: "hidden", margin: "8px 0 4px" }}>
        <div
          style={{
            height: "100%",
            width: `${Math.max(0, Math.min(100, (countdownMs / (25 * 60 * 1000)) * 100))}%`,
            background: next.bettingOpen ? "#e8b93e" : "#888",
            transition: "width 1s linear",
          }}
        />
      </div>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10 }}>
        {state.running ? "前のレースが発走中" : next.bettingOpen ? `締切まで ${fmtCountdown(countdownMs)}` : "締め切りました"}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {next.entries.map((e) => {
          const active = selHorse === e.horseId;
          return (
            <button
              key={e.horseId}
              type="button"
              onClick={() => setSelHorse(e.horseId)}
              style={{
                display: "flex", alignItems: "center", gap: 8, textAlign: "left",
                padding: "7px 9px", borderRadius: 10, cursor: "pointer", color: "#fff",
                border: active ? "2px solid #e8b93e" : "1px solid rgba(255,255,255,0.18)",
                background: active ? "rgba(232,185,62,0.14)" : "rgba(255,255,255,0.05)",
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: COAT_COLORS[e.coat] ?? "#666", fontSize: 12, fontWeight: 700,
                color: e.coat === "芦毛" || e.coat === "白毛" ? "#222" : "#fff",
              }}>{e.gate}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
                <span style={{ display: "block", fontSize: 11, opacity: 0.75 }}>
                  {e.sex}{e.age} ・ {e.style} ・ {e.form.length > 0 ? e.form.map(([p, n]) => `${p}/${n}`).join(" ") : "初出走"}
                </span>
              </span>
              <span style={{ fontSize: 11, opacity: 0.8, textAlign: "right" }}>
                {e.popularity.win + e.popularity.place > 0 ? `${e.popularity.win + e.popularity.place}票` : ""}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, minWidth: 44, textAlign: "right" }}>{e.odds.win.toFixed(1)}</span>
              <span style={{ fontSize: 12, opacity: 0.85, minWidth: 40, textAlign: "right" }}>{e.odds.place.toFixed(1)}</span>
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 11, opacity: 0.7, marginTop: 4, justifyContent: "flex-end" }}>
        <span>右: 単勝 / 複勝</span>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" style={{ ...chip, ...(selType === "win" ? { borderColor: "#e8b93e", background: "rgba(232,185,62,0.2)" } : {}) }} onClick={() => setSelType("win")}>単勝</button>
        <button type="button" style={{ ...chip, ...(selType === "place" ? { borderColor: "#e8b93e", background: "rgba(232,185,62,0.2)" } : {}) }} onClick={() => setSelType("place")}>複勝</button>
        <span style={{ width: 6 }} />
        {BET_PRESETS.map((amt) => (
          <button
            key={amt}
            type="button"
            style={{ ...chip, ...(selAmount === amt ? { borderColor: "#e8b93e", background: "rgba(232,185,62,0.2)" } : {}) }}
            onClick={() => setSelAmount(amt)}
          >
            {amt.toLocaleString()}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={selected === null || !next.bettingOpen || busy}
        onClick={() => void buy()}
        style={{
          ...btn, width: "100%", marginTop: 10, fontWeight: 700,
          background: selected !== null && next.bettingOpen ? "#e8b93e" : "rgba(255,255,255,0.1)",
          color: selected !== null && next.bettingOpen ? "#221a05" : "#fff",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {selected === null
          ? "馬を選んでください"
          : `${selected.name} の${selType === "win" ? "単勝" : "複勝"} ${selAmount.toLocaleString()} ・ ${selOdds.toFixed(1)}倍`}
      </button>
      {msg && <div style={{ fontSize: 13, marginTop: 8 }}>{msg}</div>}

      {state.myBets.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>自分の馬券</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {state.myBets.slice(0, 8).map((b) => (
              <div key={b.betId} style={{ display: "flex", gap: 8, fontSize: 12, padding: "5px 8px", borderRadius: 8, background: "rgba(255,255,255,0.05)" }}>
                <span style={{ opacity: 0.75 }}>{fmtClock(b.postMs)}</span>
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.horseName}</span>
                <span>{b.type === "win" ? "単勝" : "複勝"} {b.amount.toLocaleString()} ・ {b.odds.toFixed(1)}倍</span>
                <span style={{ fontWeight: 700, minWidth: 64, textAlign: "right" }}>
                  {b.settle === "open" ? "受付中" : b.settle === "void" ? "無効" : b.payout !== null && b.payout > 0 ? `+${b.payout.toLocaleString()}` : "ハズレ"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
          前のレース ・ {last.track}競馬場 {last.surface} {last.distanceM}m
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {last.placings.slice(0, 5).map((p) => (
            <div key={p.horseId} style={{ display: "flex", gap: 8, fontSize: 12, padding: "5px 8px", borderRadius: 8, background: p.place <= 3 ? "rgba(232,185,62,0.1)" : "rgba(255,255,255,0.04)" }}>
              <span style={{ fontWeight: 700, width: 18 }}>{p.place}</span>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span style={{ opacity: 0.75 }}>{p.margin}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
