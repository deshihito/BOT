"use client";
// ワードバスケット オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/wordbasket.ts の viewFor）:
//   phase prompt: お題（カテゴリ＋頭文字）と players[].answered のみ公開、採用単語は秘匿
//   phase reveal: players[].word/gained/first が開示される
//   phase finished: standings が付く
// 検証は形式ルールのみで、意味の正しさは判定しない。送信は { type: "submit", word }。
// 形式違いはそのラウンドだけ少し待つ必要があり、理由は you.notice に届く。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";

/** サーバー側モジュール（lib/online/games/wordbasket.ts）と一致させること。 */
const WB_TIME_LIMIT_MS = 20000;

type WbViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  answered: boolean;
  word?: string | null;
  gained?: number;
  first?: boolean;
};

type WbView = {
  phase: "prompt" | "reveal" | "finished";
  index: number;
  totalRounds: number;
  promptEndsAt: number | null;
  revealEndsAt: number | null;
  prompt: { category: string; initial: string } | null;
  you: {
    seat: number;
    answered: boolean;
    yourWord: string | null;
    lockedUntil: number | null;
    left: boolean;
    notice: string | null;
  };
  players: WbViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

function Bar({ ratio }: { ratio: number }) {
  return (
    <div
      aria-hidden
      style={{ height: 8, borderRadius: 4, background: "var(--soft)", overflow: "hidden", marginTop: 8 }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
          background: "var(--accent)",
          transition: "width 0.2s linear",
        }}
      />
    </div>
  );
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as WbView | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.phase ?? ""}`, state?.phase === "finished");
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [input, setInput] = useState("");
  const finishRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  // SE: 新しいラウンドのお題フェーズが来た遷移で1回だけ鳴らす。
  const prevPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const key = `${view.code}:${state.index}:${state.phase}`;
    const prev = prevPromptRef.current;
    prevPromptRef.current = key;
    if (prev !== null && prev !== key && state.phase === "prompt" && !state.you.left) playSe("turn");
  }, [state, view.code]);

  // ラウンドが変わったら入力をリセットする。
  const roundKey = state ? `${view.code}:${state.index}:${state.phase}` : "";
  const lastRoundKey = useRef(roundKey);
  useEffect(() => {
    if (lastRoundKey.current !== roundKey) {
      lastRoundKey.current = roundKey;
      setInput("");
    }
  }, [roundKey]);

  if (!state) return <p className="og-muted">お題を待っています…</p>;

  const locked = state.you.lockedUntil !== null && state.you.lockedUntil > now;
  const lockRemainingSec = locked ? Math.ceil(((state.you.lockedUntil as number) - now) / 1000) : 0;
  const canSubmit = state.phase === "prompt" && !state.you.answered && !state.you.left && !locked;
  const promptRemaining =
    state.promptEndsAt !== null ? Math.max(0, state.promptEndsAt - now) : null;

  const submit = () => {
    const word = input.trim();
    if (word.length === 0) {
      api.setError("単語を入力してください");
      return;
    }
    playSe("play");
    void api.move({ type: "submit", word });
    setInput("");
  };

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
            {state.phase === "prompt" ? (p.answered ? " ・ 出した！" : " ・ 考え中") : ""}
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        ラウンド {state.index + 1} / {state.totalRounds}
      </p>

      {state.phase !== "finished" && state.prompt && (
        <div key={`${state.index}-${state.phase}`} className="juice-pop" style={{ textAlign: "center", padding: "10px 0 2px" }}>
          <div aria-live="polite" style={{ fontSize: 18 }}>
            お題: <strong style={{ fontSize: 24 }}>{state.prompt.category}</strong>
            <span style={{ margin: "0 8px" }}>×</span>
            頭文字: <strong style={{ fontSize: 40, color: "var(--accent)" }}>{state.prompt.initial}</strong>
          </div>
          <p className="og-muted">
            「{state.prompt.initial}」で始まる{state.prompt.category}の単語を、最初に出した人が得点。
            形式（頭文字・2文字以上・かなだけ）だけを判定し、意味の正しさは判定しません。
          </p>
        </div>
      )}

      {state.phase === "prompt" && (
        <div style={{ padding: "8px 0 4px" }}>
          {promptRemaining !== null && <Bar ratio={promptRemaining / WB_TIME_LIMIT_MS} />}
          {state.you.left ? (
            <p className="og-muted" style={{ textAlign: "center", marginTop: 12 }}>
              退出したため、このゲームには参加していません。
            </p>
          ) : state.you.answered ? (
            <p className="og-muted" style={{ textAlign: "center", marginTop: 12 }}>
              あなたの単語: <strong>{state.you.yourWord}</strong>（他の人の単語は締切まで見えません）
            </p>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "center",
                  marginTop: 14,
                  flexWrap: "wrap",
                }}
              >
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                  placeholder="単語を入力（かな）"
                  aria-label="単語"
                  maxLength={30}
                  disabled={locked}
                  style={{
                    fontSize: 20,
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--line)",
                    width: 220,
                    minHeight: 48,
                  }}
                />
                <button
                  type="button"
                  className="classic-btn"
                  style={{ minHeight: 48, fontSize: 16, fontWeight: 700 }}
                  onClick={submit}
                  disabled={locked}
                >
                  {locked ? `あと${lockRemainingSec}秒` : "出す"}
                </button>
              </div>
              {state.you.notice && (
                <p role="alert" className="juice-shake" style={{ textAlign: "center", color: "#c0392b", marginTop: 10 }}>
                  {state.you.notice}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {state.phase === "reveal" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <p style={{ textAlign: "center", fontWeight: 700 }}>このラウンドの単語</p>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {state.players.map((p) => (
              <li
                key={p.seat}
                className="juice-pop"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: p.first ? "var(--accent-soft)" : undefined,
                  fontWeight: p.first ? 700 : 400,
                }}
              >
                <span>
                  {p.first ? "" : ""}
                  {p.name}
                  {p.seat === mySeat ? "（あなた）" : ""}
                  {p.left ? "（退出）" : ""}
                </span>
                <span>
                  {p.word === null || p.word === undefined ? "出せなかった" : p.word}
                  {p.gained ? ` ・ +${p.gained}点` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.phase === "finished" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <h2 className={state.standings?.find((s) => s.seat === mySeat)?.rank === 1 ? "juice-pulse" : undefined} style={{ textAlign: "center" }}>結果</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {(state.standings ?? []).map((s) => {
              const p = state.players.find((x) => x.seat === s.seat);
              if (!p) return null;
              return (
                <li
                  key={s.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "6px 10px",
                    fontWeight: s.rank === 1 ? 700 : 400,
                  }}
                >
                  <span>
                    {s.rank}位 {p.name}
                    {s.seat === mySeat ? "（あなた）" : ""}
                    {p.left ? "（退出）" : ""}
                  </span>
                  <strong>{s.score}点</strong>
                </li>
              );
            })}
          </ul>
          <p className="og-muted">全{state.totalRounds}ラウンドが終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      )}
    </div>
  );
}

export default function WordBasketClient() {
  return (
    <OnlineShell gameId="wordbasket" title="ワードバスケット" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
