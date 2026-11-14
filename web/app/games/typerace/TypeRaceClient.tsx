"use client";
// タイピングレース オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/typerace.ts の viewFor）:
//   phase racing: text が課題文、players[].progress は正しく打てた文字数（公開情報）
//   phase reveal: lastResults に前ラウンドの順位と得点が入る
//   phase finished: standings が付く
// 進行は申告制: 正しい接頭辞の長さを { type: "progress", count } で送る。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";
import { useRoomJuice } from "../GameJuice";

/** サーバー側モジュール（lib/online/games/typerace.ts）と一致させること。 */
const TR_TIME_LIMIT_MS = 60000;

type TrViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  progress: number;
  ratio: number;
  completed: boolean;
};

type TrRoundResult = {
  seat: number;
  progress: number;
  completed: boolean;
  rank: number | null;
  gained: number;
};

type TrView = {
  phase: "racing" | "reveal" | "finished";
  round: number;
  totalRounds: number;
  text: string;
  textLength: number;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  you: { seat: number; progress: number; completed: boolean; left: boolean };
  players: TrViewPlayer[];
  lastResults: TrRoundResult[] | null;
  standings: { seat: number; score: number; rank: number }[] | null;
};

/** typed が text の接頭辞と一致している長さ（最初に間違えた位置で止まる）。 */
function correctPrefix(text: string, typed: string): number {
  let n = 0;
  while (n < text.length && n < typed.length && typed[n] === text[n]) n++;
  return n;
}

function Bar({ ratio, color }: { ratio: number; color?: string }) {
  return (
    <div
      aria-hidden
      style={{ height: 8, borderRadius: 4, background: "var(--soft)", overflow: "hidden", flex: 1 }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
          background: color ?? "var(--accent)",
          transition: "width 0.15s linear",
        }}
      />
    </div>
  );
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as TrView | null;
  // 櫻井流バッチ2: 着手の反映に小ヒットストップ、決着に大ヒット＋フラッシュ（音は既存の playSe 系に任せる）。
  useRoomJuice(`${state?.phase ?? ""}:${state?.round ?? ""}`, state?.phase === "finished");
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [typed, setTyped] = useState("");
  const sentRef = useRef(0);
  const sendingRef = useRef(false);
  const lastAttemptRef = useRef(0);
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<string | null>(null);
  const completeRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  // ラウンドが変わったら入力をリセットする。
  const roundKey = state ? `${view.code}:${state.round}:${state.phase === "racing"}` : "";
  const lastRoundKey = useRef(roundKey);
  useEffect(() => {
    if (lastRoundKey.current !== roundKey) {
      lastRoundKey.current = roundKey;
      setTyped("");
      sentRef.current = 0;
      sendingRef.current = false;
      lastAttemptRef.current = 0;
    }
  }, [roundKey]);

  const text = state?.text ?? "";
  const prefix = state ? correctPrefix(text, typed) : 0;

  // 正しい接頭辞が伸びたらサーバーへ申告する。sentRef は送信が成功した
  // ときだけ進める。失敗（基盤の busy や 409 で捨てられた等）した場合は
  // 同じ prefix を送り直す。now（100ms 時計）を依存に入れて定期的に
  // 再評価するため、完走時の最終進捗も次の打鍵が無くても再試行される。
  useEffect(() => {
    if (!state || state.phase !== "racing") return;
    // サーバーが記録済みの進捗までは送信済みとして扱う。
    if (state.you.progress > sentRef.current) sentRef.current = state.you.progress;
    if (prefix <= sentRef.current || sendingRef.current) return;
    const nowMs = Date.now();
    if (nowMs - lastAttemptRef.current < 300) return;
    lastAttemptRef.current = nowMs;
    sendingRef.current = true;
    const target = prefix;
    void api.move({ type: "progress", count: target }).then((ok) => {
      sendingRef.current = false;
      if (ok && target > sentRef.current) sentRef.current = target;
    });
  }, [prefix, state, api, now]);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  // 新しいラウンドの開始を1回だけ知らせる（打鍵ごとには鳴らさない）。
  useEffect(() => {
    if (!state || state.phase !== "racing") return;
    const key = `${view.code}:${state.round}`;
    if (turnRef.current === key) return;
    turnRef.current = key;
    playSe("turn");
  }, [state, view.code]);

  // 自分の完走がサーバーに確定した節目だけ1回鳴らす。
  useEffect(() => {
    if (!state || !state.you.completed) return;
    const key = `${view.code}:${state.round}:completed`;
    if (completeRef.current === key) return;
    completeRef.current = key;
    playSe("submit");
  }, [state, view.code]);

  if (!state) return <p className="og-muted">出題を待っています…</p>;

  const canType =
    state.phase === "racing" && !state.you.completed && !state.you.left;
  const remaining =
    state.roundEndsAt !== null ? Math.max(0, state.roundEndsAt - now) : null;

  const nameOf = (seat: number) => state.players.find((p) => p.seat === seat)?.name ?? "?";

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        ラウンド {state.round + 1} / {state.totalRounds}
        {state.phase === "racing" && remaining !== null
          ? ` ・ 残り ${Math.ceil(remaining / 1000)} 秒`
          : ""}
      </p>
      {state.phase === "racing" && remaining !== null && (
        <div style={{ display: "flex", marginTop: 4 }}>
          <Bar ratio={remaining / TR_TIME_LIMIT_MS} />
        </div>
      )}

      {(state.phase === "racing" || state.phase === "reveal") && (
        <div key={state.round} className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <p
            aria-label={`課題文: ${text}`}
            style={{
              fontSize: 22,
              lineHeight: 1.7,
              letterSpacing: 1,
              fontFamily: "ui-monospace, monospace",
              wordBreak: "break-all",
            }}
          >
            {text.split("").map((ch, i) => {
              const mine = state.players.find((p) => p.seat === mySeat);
              const myProgress = i < (mine?.progress ?? 0);
              const typedWrong = i < typed.length && typed[i] !== ch;
              return (
                <span
                  key={i}
                  style={{
                    color: typedWrong
                      ? "#d32f2f"
                      : myProgress || i < prefix
                        ? "#2e7d32"
                        : "inherit",
                    background:
                      i === prefix && canType ? "var(--accent-soft)" : undefined,
                    fontWeight: myProgress || i < prefix ? 700 : 400,
                  }}
                >
                  {typedWrong ? typed[i] : ch === " " ? "␣" : ch}
                </span>
              );
            })}
          </p>

          {state.phase === "racing" &&
            (canType ? (
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="ここに課題文を入力"
                aria-label="タイピング入力"
                autoFocus
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={{
                  width: "100%",
                  fontSize: 18,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--line)",
                  minHeight: 48,
                  marginTop: 10,
                  fontFamily: "ui-monospace, monospace",
                  boxSizing: "border-box",
                }}
              />
            ) : (
              <p className="og-muted juice-pop" style={{ textAlign: "center", marginTop: 10 }}>
                {state.you.left
                  ? "退出したため、このゲームには参加していません。"
                  : "完走しました！他の人の結果を待っています。"}
              </p>
            ))}

          <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
            {state.players.map((p) => (
              <div key={p.seat} className={p.completed && p.seat === mySeat ? "juice-pop" : undefined} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 110, fontSize: 13 }}>
                  {p.name}
                  {p.seat === mySeat ? "（あなた）" : ""}
                  {p.completed ? " （完走）" : ""}
                </span>
                <Bar ratio={p.ratio} />
                <span style={{ fontSize: 13, minWidth: 64, textAlign: "right" }}>
                  {p.progress} / {state.textLength} 字
                </span>
              </div>
            ))}
          </div>

          <p className="og-muted" style={{ marginTop: 10, fontSize: 13 }}>
            進捗は「正しく打てた文字数」の申告制です。入力した文字そのものは送信されません。
          </p>
        </div>
      )}

      {state.phase === "reveal" && state.lastResults && (
        <div className="juice-slide" style={{ padding: "4px 0" }}>
          <h2 style={{ textAlign: "center", fontSize: 18 }}>ラウンド結果</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
            {[...state.lastResults]
              .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
              .map((r) => (
                <li
                  key={r.seat}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "6px 10px",
                    borderRadius: 8,
                    background: r.rank === 1 ? "var(--accent-soft)" : undefined,
                    fontWeight: r.rank === 1 ? 700 : 400,
                  }}
                >
                  <span>
                    {r.rank !== null ? `${r.rank}位 ` : ""}
                    {nameOf(r.seat)}
                    {r.seat === mySeat ? "（あなた）" : ""}
                  </span>
                  <span>
                    {r.completed ? `完走 ・ +${r.gained}点` : `${r.progress} 字で時間切れ`}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {state.phase === "finished" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <h2 className="juice-pulse" style={{ textAlign: "center" }}>結果</h2>
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

export default function TypeRaceClient() {
  return (
    <OnlineShell gameId="typerace" title="タイピングレース" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
