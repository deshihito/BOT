"use client";
// PK戦。ロジックは lib/penalty.ts（シード決定的）。
// キッカーのときは狙うゾーン、キーパーのときは飛ぶゾーンを選ぶ読み合い。
// ベストの設計: localStorage の ago-penalty-best に「勝利回数」を保存する。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  PEN_ZONES,
  createPenaltyGame,
  penaltyLastKick,
  playerDive,
  playerShoot,
  type PenKick,
  type PenaltyState,
} from "@/lib/penalty";
import { sfxCorrect, sfxLose, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const BEST_KEY = "ago-penalty-best";

function kickMark(kick: PenKick | undefined): string {
  if (!kick) return "・";
  return kick.outcome === "goal" ? "○" : "×";
}

function kickDetail(kick: PenKick): string {
  const zone = PEN_ZONES[kick.zone]?.label ?? "";
  const keeper = PEN_ZONES[kick.keeperZone]?.label ?? "";
  if (kick.outcome === "goal") return `${zone}へ決めた！`;
  if (kick.outcome === "saved") return `${zone}を狙ったが、キーパーが${keeper}へ飛んでセーブ`;
  return `${zone}を狙ったが枠外…`;
}

/** サッカーボールを SVG で描く（絵文字は使わない）。 */
function BallIcon() {
  return (
    <svg viewBox="0 0 48 48" width="38" height="38" aria-hidden style={{ display: "inline-block", verticalAlign: "middle" }}>
      <circle cx="24" cy="24" r="21" fill="#ffffff" stroke="#374151" strokeWidth="2" />
      <polygon points="24,15 31.5,20.5 28.7,29.5 19.3,29.5 16.5,20.5" fill="#1f2937" />
      <path d="M24 15V5.5M31.5 20.5l9-3M28.7 29.5l5.3 8M19.3 29.5l-5.3 8M16.5 20.5l-9-3" stroke="#374151" strokeWidth="1.6" />
    </svg>
  );
}

/** キーパーのグローブを SVG で描く（絵文字は使わない）。 */
function GloveIcon() {
  return (
    <svg viewBox="0 0 48 48" width="38" height="38" aria-hidden style={{ display: "inline-block", verticalAlign: "middle" }}>
      <path
        d="M27 3c-6.6 0-11 4.8-11 11.2V17l-4.3-3.4c-2-1.6-5-.9-6.3 1.4-1.1 2-.6 4.4 1 6l7.5 7.6C15.6 33.4 20 36 27 36s10-2.6 12.3-6.4C41.4 26.2 42 20 41.4 12.9 40.9 7.2 35.4 3 27 3Z"
        fill="#f59e0b"
        stroke="#92400e"
        strokeWidth="2"
        transform="translate(0 5)"
      />
    </svg>
  );
}

export default function PenaltyClient() {
  const { prefix } = useGamesNav();
  const [state, setState] = useState<PenaltyState>(() => createPenaltyGame(Date.now() % 2147483647));
  const [wins, setWins] = useState(0);
  const countedRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(BEST_KEY));
      setWins(Number.isFinite(saved) && saved > 0 ? Math.floor(saved) : 0);
    } catch {
      setWins(0);
    }
  }, []);

  useEffect(() => {
    if (state.status !== "finished" || state.winner !== "player") return;
    if (countedRef.current === state.seed) return;
    countedRef.current = state.seed;
    setWins((w) => {
      const next = w + 1;
      try {
        window.localStorage.setItem(BEST_KEY, String(next));
      } catch {
        // 保存失敗はプレイに影響しない。
      }
      return next;
    });
  }, [state]);

  const restart = () => {
    sfxTap();
    countedRef.current = null;
    setState(createPenaltyGame(Date.now() % 2147483647));
  };

  const choose = (zoneId: number) => {
    const next = state.turn === "player" ? playerShoot(state, zoneId) : playerDive(state, zoneId);
    const kick = penaltyLastKick(next);
    if (next.status === "finished") {
      if (next.winner === "player") sfxWin();
      else sfxLose();
    } else if (kick) {
      // 自分のキックが決まった／CPUのキックを止めたら正解音、それ以外は誤り音
      const good = kick.by === "player" ? kick.outcome === "goal" : kick.outcome !== "goal";
      if (good) sfxCorrect();
      else sfxWrong();
    }
    setState(next);
  };

  const last = penaltyLastKick(state);
  const isPlayerKick = state.turn === "player";
  const finished = state.status === "finished";

  const statusText = finished
    ? state.winner === "player"
      ? "PK戦に勝利！"
      : "CPUの勝ち…"
    : state.suddenDeath
      ? "サドンデス！差が付いた時点で決着"
      : isPlayerKick
        ? "あなたのキック。狙うゾーンを選んでください"
        : "CPUのキック。飛ぶゾーンを選んでください";

  // ラウンドごとの結果表（プレイヤー行・CPU行）
  const rounds = Math.max(5, Math.ceil(state.kicks.length / 2));
  const playerKicks = state.kicks.filter((k) => k.by === "player");
  const cpuKicks = state.kicks.filter((k) => k.by === "cpu");

  const btn: React.CSSProperties = {
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--line, rgba(255,255,255,0.18))",
    background: "rgba(127,127,127,0.12)",
    color: "inherit",
    cursor: "pointer",
    fontWeight: 700,
    minHeight: 44,
    touchAction: "manipulation",
  };

  const zoneBtn = (zoneId: number): React.CSSProperties => {
    const isLastZone = last && (isPlayerKick ? last.keeperZone : last.zone) === zoneId;
    return {
      minHeight: 64,
      borderRadius: 10,
      border: "2px solid rgba(255,255,255,0.55)",
      background: "rgba(255,255,255,0.10)",
      color: "#fff",
      cursor: finished ? "default" : "pointer",
      fontWeight: 700,
      fontSize: 15,
      outline: isLastZone ? "3px solid #ffd34d" : undefined,
      touchAction: "manipulation",
    };
  };

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>PK戦</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>PK戦</h1>
        <p className="muted">キッカーのときは狙うゾーン、キーパーのときは飛ぶゾーンを選びます。</p>
      </div>

      <p className="classic-status" role="status">
        あなた {state.playerGoals} - {state.cpuGoals} CPU ・ {statusText}
        {wins > 0 ? ` ・ 通算勝利 ${wins} 回` : ""}
      </p>

      <div
        style={{
          maxWidth: 520,
          margin: "0 auto",
          background: "linear-gradient(180deg, #14532d, #166534)",
          borderRadius: 14,
          padding: 16,
        }}
        role="group"
        aria-label={isPlayerKick ? "狙うゾーン" : "飛ぶゾーン"}
      >
        <div key={`${state.turn}-${state.kicks.length}`} className="juice-flip" style={{ textAlign: "center", fontSize: 30 }} aria-hidden>
          {isPlayerKick ? <GloveIcon /> : <BallIcon />}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8 }}>
          {PEN_ZONES.map((zone) => (
            <button
              key={zone.id}
              type="button"
              style={zoneBtn(zone.id)}
              disabled={finished}
              onClick={() => choose(zone.id)}
              aria-label={`${zone.label}（枠外 ${Math.round(zone.missRate * 100)}%）`}
            >
              {zone.label}
              <span style={{ display: "block", fontSize: 11, fontWeight: 400, opacity: 0.85 }}>
                枠外 {Math.round(zone.missRate * 100)}%
              </span>
            </button>
          ))}
        </div>
        <p key={state.kicks.length} className="juice-pop" style={{ color: "#e7f6ec", textAlign: "center", margin: "12px 0 0", minHeight: 22 }} role="status">
          {last
            ? `${last.by === "player" ? "あなた" : "CPU"}のキック: ${kickDetail(last)}${last.outcome === "goal" ? "（ゴール）" : last.outcome === "saved" ? "（セーブ）" : "（ミス）"}`
            : isPlayerKick
              ? "キーパーは隅を多めに読む傾向があります。中央は枠外率も読まれる確率も低めです。"
              : "CPUは下の隅を好みます。読み切って止めましょう。"}
        </p>
      </div>

      <div style={{ maxWidth: 520, margin: "14px auto 0", overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", margin: "0 auto", textAlign: "center" }} aria-label="キック結果">
          <thead>
            <tr>
              <th style={{ padding: "4px 8px" }}></th>
              {Array.from({ length: rounds }, (_, i) => (
                <th key={i} style={{ padding: "4px 8px" }}>
                  {i + 1}
                </th>
              ))}
              <th style={{ padding: "4px 8px" }}>計</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th style={{ padding: "4px 8px" }}>あなた</th>
              {Array.from({ length: rounds }, (_, i) => (
                <td key={i} style={{ padding: "4px 8px" }}>
                  {kickMark(playerKicks[i])}
                </td>
              ))}
              <td style={{ padding: "4px 8px", fontWeight: 700 }}>{state.playerGoals}</td>
            </tr>
            <tr>
              <th style={{ padding: "4px 8px" }}>CPU</th>
              {Array.from({ length: rounds }, (_, i) => (
                <td key={i} style={{ padding: "4px 8px" }}>
                  {kickMark(cpuKicks[i])}
                </td>
              ))}
              <td style={{ padding: "4px 8px", fontWeight: 700 }}>{state.cpuGoals}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {finished && (
        <div style={{ maxWidth: 520, margin: "14px auto 0" }}>
          <EndScreen
            outcome={state.winner === "player" ? "win" : "lose"}
            title={state.winner === "player" ? "あなたの勝ち！" : "CPUの勝ち…"}
            onRetry={restart}
          >
            <p className="muted" style={{ margin: 0 }}>
              最終スコア {state.playerGoals} - {state.cpuGoals}
              {wins > 0 ? ` ・ 通算勝利 ${wins} 回` : ""}
            </p>
          </EndScreen>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 14 }}>
        <button type="button" style={btn} onClick={restart}>
          もう一度
        </button>
      </div>
    </>
  );
}
