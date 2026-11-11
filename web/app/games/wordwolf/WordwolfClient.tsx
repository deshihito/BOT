"use client";
// ワードウルフ オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/wordwolf.ts の viewFor）:
//   - you.word に自分のお題だけが入る（自分がウルフかどうかは分からない）
//   - phase discuss: discussionEndsAt まで議論、全員 ready で早期に投票へ
//   - phase vote/revote: vote アクション。revote では tiedCandidates のみ投票可
//   - phase finished: result にウルフ・お題ペア・集計が開示される
import { useEffect, useState } from "react";
import OnlineShell, { useOnlineCreateOptions } from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type WwViewPlayer = { seat: number; name: string; left: boolean; voted: boolean; ready: boolean };

type WwView = {
  phase: "discuss" | "vote" | "revote" | "finished";
  discussionSec: number;
  discussionEndsAt: number | null;
  you: { word: string; left: boolean; voted: boolean; ready: boolean };
  players: WwViewPlayer[];
  revote: boolean;
  tiedCandidates: number[];
  result: {
    winner: "majority" | "wolf";
    wolfSeat: number;
    majorityWord: string;
    minorityWord: string;
    caughtSeat: number | null;
    tally: Record<number, number>;
  } | null;
};

const DISCUSSION_OPTIONS = [120, 180, 240] as const;
const DEFAULT_DISCUSSION_SEC = 180;

/** ルーム作成フォームへ差し込む議論時間セレクト。 */
function WordwolfCreateOptions() {
  const { options, setOptions } = useOnlineCreateOptions();
  const current = (options as { discussionSec?: number } | undefined)?.discussionSec;
  const value =
    typeof current === "number" && (DISCUSSION_OPTIONS as readonly number[]).includes(current)
      ? current
      : DEFAULT_DISCUSSION_SEC;
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

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as WwView | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (!state) return <p className="og-muted">お題を配っています…</p>;

  const inVote = state.phase === "vote" || state.phase === "revote";
  const voteTargets = state.players.filter((p) => {
    if (p.left || p.seat === mySeat) return false;
    if (state.phase === "revote") return state.tiedCandidates.includes(p.seat);
    return true;
  });
  const canAct = !state.you.left && state.phase !== "finished";
  const remainingMs = state.discussionEndsAt !== null ? state.discussionEndsAt - now : null;

  const send = async (action: unknown) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.move(action);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div
        style={{
          textAlign: "center",
          padding: "18px 12px",
          borderRadius: 14,
          border: "2px solid #8b5cf6",
          background: "#f5f0ff",
          marginBottom: 12,
        }}
      >
        <p style={{ margin: 0, fontSize: 13, color: "#6b7280" }}>あなたのお題</p>
        <p style={{ margin: "4px 0 0", fontSize: 30, fontWeight: 800 }}>{state.you.word}</p>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>
          自分が少数派（ウルフ）かどうかは分かりません。お題そのものは口に出さず、関連する話で議論してください。
        </p>
      </div>

      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""}
            {state.phase === "discuss" && !p.left ? (p.ready ? " ・ 準備OK" : " ・ 議論中") : ""}
            {inVote && !p.left ? (p.voted ? " ・ 投票済み" : " ・ 未投票") : ""}
          </span>
        ))}
      </div>

      {state.phase === "discuss" ? (
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <p style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            議論タイム {remainingMs !== null ? formatClock(remainingMs) : ""}
          </p>
          <p className="og-muted">チャットで話し合い、違うお題を持っていそうな人を探してください。全員が「投票へ」を押すと早めに投票へ進みます。</p>
          {canAct && !state.you.ready ? (
            <button type="button" className="classic-btn" disabled={busy} onClick={() => send({ type: "ready" })}>
              投票へ進む
            </button>
          ) : state.you.ready ? (
            <p className="og-muted">他の人の準備を待っています…</p>
          ) : null}
        </div>
      ) : null}

      {inVote ? (
        <div style={{ marginTop: 14 }}>
          <h2 style={{ fontSize: 20, margin: "6px 0" }}>
            {state.phase === "revote" ? "決選投票：ウルフだと思う人を選んでください" : "投票：ウルフだと思う人を選んでください"}
          </h2>
          {state.you.voted ? (
            <p className="og-muted">投票済みです。全員の投票を待っています…</p>
          ) : canAct ? (
            <div style={{ display: "grid", gap: 8 }}>
              {voteTargets.map((p) => (
                <button
                  key={p.seat}
                  type="button"
                  className="classic-btn"
                  disabled={busy}
                  onClick={() => send({ type: "vote", target: p.seat })}
                  style={{ minHeight: 48, fontSize: 16 }}
                >
                  {p.name} に投票
                </button>
              ))}
            </div>
          ) : (
            <p className="og-muted">退出したため投票できません。</p>
          )}
        </div>
      ) : null}

      {state.phase === "finished" && state.result ? (
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <h2 style={{ fontSize: 24, margin: "8px 0" }}>
            {state.result.winner === "majority" ? "多数派の勝ち！ウルフを当てました" : "ウルフの逃げ切り勝ち！"}
          </h2>
          <p style={{ fontSize: 16 }}>
            ウルフは{" "}
            <strong>{state.players.find((p) => p.seat === state.result!.wolfSeat)?.name ?? "?"}</strong> さんでした。
          </p>
          <p>
            多数派のお題「{state.result.majorityWord}」／少数派のお題「{state.result.minorityWord}」
          </p>
          {state.result.caughtSeat !== null ? (
            <p>
              投票で指名されたのは{" "}
              <strong>{state.players.find((p) => p.seat === state.result!.caughtSeat)?.name ?? "?"}</strong> さんです。
            </p>
          ) : (
            <p>同票などで指名は決まりませんでした。</p>
          )}
          <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 6 }}>
            {state.players.map((p) => {
              const count = state.result!.tally[p.seat] ?? 0;
              return (
                <li
                  key={p.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "8px 14px",
                    borderRadius: 10,
                    border: p.seat === state.result!.wolfSeat ? "2px solid #8b5cf6" : "1px solid #e5e7eb",
                    background: "#fffdf6",
                  }}
                >
                  <span>
                    {p.name}
                    {p.seat === state.result!.wolfSeat ? "（ウルフ）" : ""}
                    {p.left ? "（退出）" : ""}
                  </span>
                  <strong>{count}票</strong>
                </li>
              );
            })}
          </ul>
          <p className="og-muted">再戦は下のボタンからどうぞ。</p>
        </div>
      ) : null}
    </div>
  );
}

export default function WordwolfClient() {
  return (
    <OnlineShell gameId="wordwolf" title="ワードウルフ" playerRange={{ min: 3, max: 6 }} createOptions={<WordwolfCreateOptions />}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
