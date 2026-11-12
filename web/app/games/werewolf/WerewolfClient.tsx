"use client";
// 人狼（オンライン）クライアント。ルーム管理は共通基盤 OnlineShell が担い、
// このコンポーネントは view.state（ゲーム別ビュー）の描画と、夜の行動・
// 議論終了・投票の送信だけを持つ。チャットは無効（chatEnabled=false）。
// 秘匿情報は view に含まれるものだけを表示し、含まれない情報は推測しない
// （誰が投票済みか等は件数表示のみ）。
//
// === OnlineShell 連携（統合時に確定した実仕様） ===
// - チャット無効はサーバー側のゲーム定義（chatEnabled: false）で決まり、
//   shell が view.chatEnabled を見てチャットを出さない。クライアント側に
//   渡す prop は無い。
// - createOptions: 作成フォーム内に置かれる ReactNode。その中の部品は
//   useOnlineCreateOptions() で { options, setOptions } を読み書きし、
//   shell が作成時に options として createRoom へ渡す（サーバー側は
//   options.discussionSec を 60/120/180 に正規化する）。既定値は 120 秒。
// - 夜の対象提出はモジュール契約どおり { type: "nightAction", target }。
//   対象は自分を選べない（サーバーの assertValidTarget が全役職共通で
//   自分を拒否する）。狩人の護衛も自分は対象外。
import { useEffect, useRef, useState } from "react";
import OnlineShell, { useOnlineCreateOptions } from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { playSe } from "@/lib/balku-sound";

/* --- 人狼のゲーム別ビュー（モジュール担当との契約） --- */
type Role = "wolf" | "seer" | "hunter" | "villager";
type WerewolfPlayer = { seat: number; name: string; alive: boolean; role?: Role };
type WerewolfState = {
  phase: "night" | "day" | "vote" | "finished";
  dayCount: number;
  you: { role: Role; alive: boolean };
  players: WerewolfPlayer[];
  wolves?: number[];
  night: { submitted: boolean; seerResults?: { day: number; target: number; isWolf: boolean }[] };
  day: { endsAt: number; readySeats: number[]; readyCount: number; aliveCount: number };
  vote: { submitted: boolean; votedCount: number; aliveCount: number; revote: boolean };
  lastNightResult: { deadSeat: number | null } | null;
  lastExecution: { deadSeat: number | null; tied: boolean } | null;
  winner: "village" | "wolf" | null;
  discussionSec: number;
};

const ROLE_META: Record<Role, { label: string; className: string; description: string }> = {
  wolf: { label: "人狼", className: "og-role-wolf", description: "毎夜、村人1人を襲撃します。昼は村人のふりをして生き残ってください。" },
  seer: { label: "占い師", className: "og-role-seer", description: "毎夜、1人が人狼かどうかを占えます。結果はあなただけが見られます。" },
  hunter: { label: "狩人", className: "og-role-hunter", description: "毎夜、1人を人狼の襲撃から護衛します。" },
  villager: { label: "村人", className: "og-role-villager", description: "特殊な力はありません。議論と投票で人狼を見つけ出してください。" },
};

const DISCUSSION_OPTIONS = [60, 120, 180] as const;
const DEFAULT_DISCUSSION_SEC = 120;
const NIGHT_MOVE_TYPE = "nightAction";

type WerewolfCreateOptionsValue = { discussionSec?: number };

/** ルーム作成フォームへ差し込む議論時間セレクト（createOptions）。 */
function WerewolfCreateOptions() {
  const { options, setOptions } = useOnlineCreateOptions();
  const current = (options as WerewolfCreateOptionsValue | undefined)?.discussionSec;
  const value =
    typeof current === "number" && (DISCUSSION_OPTIONS as readonly number[]).includes(current)
      ? current
      : DEFAULT_DISCUSSION_SEC;
  // 未操作でも既定値（120秒）が options として作成時に渡るようにする
  useEffect(() => {
    if (current === undefined) setOptions({ discussionSec: DEFAULT_DISCUSSION_SEC });
  }, [current, setOptions]);
  return (
    <label className="og-field">
      <span>議論時間</span>
      <select
        name="discussionSec"
        className="og-input"
        value={value}
        onChange={(e) => setOptions({ discussionSec: Number(e.target.value) })}
      >
        {DISCUSSION_OPTIONS.map((sec) => (
          <option key={sec} value={sec}>
            {sec}秒
          </option>
        ))}
      </select>
    </label>
  );
}

export default function WerewolfClient() {
  return (
    <OnlineShell gameId="werewolf" title="人狼" playerRange={{ min: 4, max: 8 }} createOptions={<WerewolfCreateOptions />}>
      {(view, api) => <WerewolfTable view={view} api={api} />}
    </OnlineShell>
  );
}

function formatClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function WerewolfTable({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as WerewolfState | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());

  // 議論タイマー用の1秒刻み
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // --- SE: フェーズ遷移と終局 ---
  const prevPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = state.phase;
    if (prev !== null && prev !== state.phase && state.phase !== "finished") playSe("turn");
  }, [state]);
  const finishSeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishSeRef.current === view.code) return;
    finishSeRef.current = view.code;
    const iAmWolf = state.you.role === "wolf";
    const won = (state.winner === "wolf") === iAmWolf;
    playSe(won ? "win" : "lose");
  }, [state, view.code]);

  if (!state) {
    return <p className="og-notice">対戦の開始を待っています…</p>;
  }

  const nameOf = (seat: number) => state.players.find((p) => p.seat === seat)?.name ?? `プレイヤー${seat + 1}`;
  const roleMeta = ROLE_META[state.you.role];
  const wolfAllies = (state.wolves ?? []).filter((seat) => seat !== mySeat);
  const alivePlayers = state.players.filter((p) => p.alive);
  const iAmAlive = state.you.alive;

  const phaseLabel =
    state.phase === "night"
      ? `${state.dayCount}日目 夜`
      : state.phase === "day"
        ? `${state.dayCount}日目 昼`
        : state.phase === "vote"
          ? `${state.dayCount}日目 投票${state.vote.revote ? "（再投票）" : ""}`
          : "対戦終了";

  const remainingSec =
    state.phase === "day" && state.day?.endsAt ? Math.max(0, Math.ceil((state.day.endsAt - now) / 1000)) : null;
  const alreadyReady = (state.day?.readySeats ?? []).includes(mySeat);

  /* --- 夜の対象候補（役職で出し分ける） --- */
  const nightTargets: WerewolfPlayer[] = (() => {
    if (state.phase !== "night" || !iAmAlive) return [];
    if (state.you.role === "wolf") {
      // 自分と人狼仲間は襲撃対象にしない
      return alivePlayers.filter((p) => p.seat !== mySeat && !(state.wolves ?? []).includes(p.seat));
    }
    if (state.you.role === "seer") {
      return alivePlayers.filter((p) => p.seat !== mySeat);
    }
    if (state.you.role === "hunter") {
      // 護衛も自分は選べない（サーバー共通の対象検証に合わせる）
      return alivePlayers.filter((p) => p.seat !== mySeat);
    }
    return [];
  })();
  const nightActionLabel =
    state.you.role === "wolf" ? "襲撃する相手" : state.you.role === "seer" ? "占う相手" : state.you.role === "hunter" ? "護衛する相手" : "";

  const submitNight = (target: number) => {
    playSe("play");
    void api.move({ type: NIGHT_MOVE_TYPE, target });
  };
  const submitReady = () => {
    playSe("play");
    void api.move({ type: "ready" });
  };
  const submitVote = (target: number) => {
    playSe("play");
    void api.move({ type: "vote", target });
  };

  return (
    <div className="og-game og-werewolf">
      <div key={`${state.phase}-${state.dayCount}`} className={`og-phase-banner og-phase-${state.phase} juice-slide`} role="status" aria-live="polite">
        <span className="og-phase-title">{phaseLabel}</span>
        {remainingSec !== null && <span className="og-timer">残り {formatClock(remainingSec)}</span>}
      </div>

      {/* 前夜・前回の結果 */}
      {state.lastNightResult && state.phase !== "finished" && (
        <p className="og-notice juice-slide">
          {state.lastNightResult.deadSeat === null
            ? "昨夜は誰も襲撃されませんでした。"
            : `昨夜、${nameOf(state.lastNightResult.deadSeat)} が襲撃されました。`}
        </p>
      )}
      {state.lastExecution && state.phase !== "finished" && (
        <p className="og-notice juice-slide">
          {state.lastExecution.tied
            ? "前回の投票は同票で、処刑はありませんでした。"
            : state.lastExecution.deadSeat === null
              ? "前回の投票で処刑はありませんでした。"
              : `前回の投票で ${nameOf(state.lastExecution.deadSeat)} が処刑されました。`}
        </p>
      )}

      {/* 自分の役職カード */}
      <section className={`og-role-card ${roleMeta.className} juice-pop`} aria-label="あなたの役職">
        <span className="og-role-label">あなたの役職</span>
        <span className="og-role-name">{roleMeta.label}</span>
        <span className="og-role-desc">{roleMeta.description}</span>
        {!iAmAlive && <span className="og-role-desc">あなたは死亡しています。対戦の行方を見守ってください。</span>}
        {state.you.role === "wolf" && (
          <span className="og-role-desc">
            {wolfAllies.length > 0 ? `人狼の仲間: ${wolfAllies.map((seat) => nameOf(seat)).join("、")}` : "人狼の仲間はいません（単独）。"}
          </span>
        )}
      </section>

      {/* プレイヤー一覧 */}
      <div className="og-player-grid" aria-label="プレイヤー一覧">
        {state.players.map((p) => (
          <div key={p.seat} className={`og-member${p.alive ? "" : " og-member-dead"}${p.seat === mySeat ? " og-member-mine" : ""}`}>
            <span className="og-member-name">
              {p.name}
              {p.seat === mySeat ? "（あなた）" : ""}
            </span>
            <span className="og-member-meta">
              {p.alive ? "生存" : "死亡"}
              {!p.alive && p.role ? ` / ${ROLE_META[p.role].label}` : ""}
              {p.alive && state.phase === "finished" && p.role ? ` / ${ROLE_META[p.role].label}` : ""}
            </span>
          </div>
        ))}
      </div>

      {/* ===== 夜 ===== */}
      {state.phase === "night" && (
        <section className="og-phase-panel juice-slide" aria-label="夜の行動">
          {!iAmAlive || state.you.role === "villager" ? (
            <p className="og-status-line">夜が明けるのを待っています…</p>
          ) : state.night.submitted ? (
            <p className="og-status-line">提出済みです。夜が明けるのを待っています…</p>
          ) : (
            <>
              <h2>{nightActionLabel}を選んでください</h2>
              <div className="og-target-grid">
                {nightTargets.map((p) => (
                  <button key={p.seat} type="button" className="og-button" onClick={() => submitNight(p.seat)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
          {state.you.role === "seer" && state.night.seerResults && state.night.seerResults.length > 0 && (
            <div className="og-seer-history">
              <h2>占い履歴</h2>
              <ul className="og-log-list">
                {state.night.seerResults.map((r) => (
                  <li key={`${r.day}-${r.target}`}>
                    {r.day}日目: {nameOf(r.target)} は {r.isWolf ? "人狼" : "人狼ではない"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ===== 昼（議論） ===== */}
      {state.phase === "day" && (
        <section className="og-phase-panel juice-slide" aria-label="昼の議論">
          <p className="og-status-line">
            話し合い中です。終了に同意: {state.day.readyCount} / {state.day.aliveCount} 人
          </p>
          {remainingSec !== null && (
            <p className="og-timer" aria-live="off">
              議論終了まで {formatClock(remainingSec)}
            </p>
          )}
          {iAmAlive && (
            <div className="og-actions">
              <button type="button" className="og-button og-button-primary" disabled={alreadyReady} onClick={submitReady}>
                {alreadyReady ? "終了に同意済み" : "話し合いを終える"}
              </button>
            </div>
          )}
          {!iAmAlive && <p className="og-status-line">死亡しているため、議論の終了には参加できません。</p>}
        </section>
      )}

      {/* ===== 投票 ===== */}
      {state.phase === "vote" && (
        <section className="og-phase-panel juice-slide" aria-label="投票">
          {state.vote.revote && <p className="og-notice">同票のため再投票です。</p>}
          <p className="og-status-line">
            投票済み: {state.vote.votedCount} / {state.vote.aliveCount} 人
          </p>
          {!iAmAlive ? (
            <p className="og-status-line">死亡しているため投票できません。結果を待っています…</p>
          ) : state.vote.submitted ? (
            <p className="og-status-line">投票済みです。結果を待っています…</p>
          ) : (
            <>
              <h2>処刑する相手に投票してください</h2>
              <div className="og-target-grid">
                {alivePlayers
                  .filter((p) => p.seat !== mySeat)
                  .map((p) => (
                    <button key={p.seat} type="button" className="og-button" onClick={() => submitVote(p.seat)}>
                      {p.name}
                    </button>
                  ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* ===== 終了 ===== */}
      {state.phase === "finished" && (
        <section className="og-result juice-slide" aria-label="対戦結果">
          <h2 className="juice-pulse">{state.winner === "wolf" ? "人狼陣営の勝利" : state.winner === "village" ? "村人陣営の勝利" : "対戦終了"}</h2>
          <p className="og-status-line">
            {state.winner === "wolf"
              ? "人狼が村を支配しました。"
              : state.winner === "village"
                ? "人狼を全て追放しました。"
                : ""}
          </p>
          <div className="og-player-grid">
            {state.players.map((p) => (
              <div key={p.seat} className={`og-member${p.seat === mySeat ? " og-member-mine" : ""}`}>
                <span className="og-member-name">
                  {p.name}
                  {p.seat === mySeat ? "（あなた）" : ""}
                </span>
                <span className="og-member-meta">
                  {p.role ? ROLE_META[p.role].label : "役職不明"} / {p.alive ? "生存" : "死亡"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
