"use client";
// 椅子取り オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/musicalchairs.ts の viewFor）:
//   phase playing: 音楽が流れている（止まる時刻は渡らない）
//   phase racing: 止まった。全員が「座る」を競い、座れたかどうかだけ公開される
//   phase intermission: lastResult で座れた順と脱落者が開示される
//   phase finished: standings が付く
// アクションは { type: "sit" }。進行はサーバー側の tick で進む。
// 反応順はサーバー受信順で決まる（モジュール側のコメント参照）。
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { playSe } from "@/lib/balku-sound";

const MusicalChairsScene3D = dynamic(() => import("./MusicalChairsScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type McResult = {
  round: number;
  sits: { seat: number; order: number }[];
  notSat: number[];
  eliminatedSeat: number;
  reason: "slowest" | "nosit";
} | null;

type McView = {
  phase: "playing" | "racing" | "intermission" | "finished";
  round: number;
  aliveCount: number;
  chairs: number;
  reactEndsAt: number | null;
  intermissionEndsAt: number | null;
  lastResult: McResult;
  winnerSeat: number | null;
  you: { seat: number; alive: boolean; left: boolean; sat: boolean };
  players: { seat: number; name: string; alive: boolean; left: boolean; sat: boolean }[];
  standings: { seat: number; rank: number }[] | null;
};

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as McView | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [webglFailed, setWebglFailed] = useState(false);
  const prevPhaseRef = useRef<string>("");
  const finishRef = useRef<string | null>(null);
  const turnRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);

  // 音楽が止まったら合図の音、終了時は勝敗の音を1回だけ鳴らす。
  useEffect(() => {
    if (!state) return;
    if (state.phase === "racing" && prevPhaseRef.current === "playing") {
      playSe("error");
    }
    prevPhaseRef.current = state.phase;
  }, [state]);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winnerSeat === mySeat ? "win" : "click");
  }, [state, mySeat, view.code]);

  // 新しいラウンド（音楽の開始）を1回だけ知らせる。
  useEffect(() => {
    if (!state || state.phase !== "playing") return;
    const key = `${view.code}:${state.round}`;
    if (turnRef.current === key) return;
    turnRef.current = key;
    playSe("turn");
  }, [state, view.code]);

  if (!state) return <p className="og-muted">対戦の開始を待っています…</p>;

  const nameOf = (seat: number) => state.players.find((p) => p.seat === seat)?.name ?? `プレイヤー${seat + 1}`;
  const canSit = state.phase === "racing" && state.you.alive && !state.you.sat;
  const reactRatio =
    state.phase === "racing" && state.reactEndsAt !== null
      ? Math.max(0, state.reactEndsAt - now) / 5000
      : null;

  const result = state.lastResult;

  const doSit = () => {
    playSe("play");
    void api.move({ type: "sit" });
  };

  const board2d = (
    <div
      style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 10, padding: "16px 10px", flexWrap: "wrap" }}
      role="img"
      aria-label={`椅子 ${state.chairs} 個とプレイヤー ${state.players.length} 人（2D表示）`}
    >
      {Array.from({ length: state.chairs }, (_, i) => (
        <span
          key={i}
          style={{
            width: 34, height: 44, display: "inline-block",
            border: "3px solid #9a6b3f", borderBottomWidth: 10, borderRadius: 4,
            background: "#c0392b",
          }}
        />
      ))}
      {state.players.map((pl) => (
        <span
          key={pl.seat}
          style={{
            width: 22, height: 22, borderRadius: 999, display: "inline-block",
            background: pl.alive && !pl.left ? "#3f7fe0" : "#8a8f96",
            border: pl.seat === mySeat ? "3px solid #ffffff" : "3px solid transparent",
          }}
        />
      ))}
    </div>
  );

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : !p.alive ? "（脱落）" : ""}
            {(state.phase === "racing" || state.phase === "intermission") && p.alive && p.sat ? " ・ 座れた" : ""}
          </span>
        ))}
      </div>

      <p className="og-muted" style={{ marginTop: 8 }}>
        ラウンド {state.round + 1} ・ 残り {state.aliveCount} 人 ・ 椅子は {state.chairs} 個
      </p>

      {webglFailed ? board2d : (
        <div style={{ margin: "10px 0 2px" }}>
          <MusicalChairsScene3D
            players={state.players}
            chairs={state.chairs}
            phase={state.phase}
            round={state.round}
            mySeat={mySeat}
            canSit={canSit}
            onSit={doSit}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.phase === "playing" && (
        <div className="juice-slide" style={{ textAlign: "center", padding: "18px 0 6px" }}>
          <div className="juice-pulse" aria-hidden style={{ fontSize: 56, lineHeight: 1.2 }}>
            ♪♫♪
          </div>
          <p role="status" style={{ fontWeight: 700, fontSize: 18 }}>
            音楽が流れています…
          </p>
          <p className="og-muted">止まったら、すぐに「座る！」を押そう。</p>
          {state.you.alive ? (
            <button
              type="button"
              className="classic-btn"
              disabled
              style={{ minWidth: 200, minHeight: 64, fontSize: 20, fontWeight: 800, opacity: 0.55 }}
            >
              まだ止まっていない…
            </button>
          ) : (
            <p className="og-muted">あなたは脱落しました。対戦の様子は見られます。</p>
          )}
        </div>
      )}

      {state.phase === "racing" && (
        <div className="juice-slide" style={{ textAlign: "center", padding: "18px 0 6px" }}>
          <p className="juice-pulse" role="alert" style={{ fontWeight: 800, fontSize: 22 }}>
            音楽が止まった！
          </p>
          {reactRatio !== null && (
            <div
              aria-hidden
              style={{ height: 8, borderRadius: 4, background: "var(--soft)", overflow: "hidden", marginTop: 8 }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${reactRatio * 100}%`,
                  background: "var(--accent)",
                  transition: "width 0.1s linear",
                }}
              />
            </div>
          )}
          {canSit ? (
            <button
              type="button"
              className="classic-btn classic-btn-active"
              style={{ minWidth: 220, minHeight: 72, fontSize: 24, fontWeight: 800, marginTop: 14 }}
              onClick={doSit}
            >
              座る！
            </button>
          ) : state.you.alive ? (
            <p className="juice-pop" role="status" style={{ fontWeight: 700, marginTop: 14 }}>
              座れました！ 結果を待っています…
            </p>
          ) : (
            <p className="og-muted" style={{ marginTop: 14 }}>
              あなたは脱落しました。対戦の様子は見られます。
            </p>
          )}
          <p className="og-muted" style={{ marginTop: 8 }}>
            一番遅かった人が脱落します。
          </p>
        </div>
      )}

      {state.phase === "intermission" && result && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <p className={result.eliminatedSeat === mySeat ? "juice-shake" : "juice-pop"} role="status" style={{ textAlign: "center", fontWeight: 700, fontSize: 18 }}>
            {nameOf(result.eliminatedSeat)} さんが脱落しました
            {result.reason === "nosit" ? "（時間内に座れませんでした）" : "（一番遅かった）"}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {result.sits.map((s) => (
              <li key={s.seat} style={{ display: "flex", justifyContent: "space-between", padding: "4px 10px" }}>
                <span>
                  {s.order + 1} 番目 {nameOf(s.seat)}
                  {s.seat === mySeat ? "（あなた）" : ""}
                </span>
                <span>座れた</span>
              </li>
            ))}
            {result.notSat.map((seat) => (
              <li key={seat} style={{ display: "flex", justifyContent: "space-between", padding: "4px 10px", opacity: 0.75 }}>
                <span>
                  {nameOf(seat)}
                  {seat === mySeat ? "（あなた）" : ""}
                </span>
                <span>座れず</span>
              </li>
            ))}
          </ul>
          <p className="og-muted" style={{ textAlign: "center" }}>
            まもなく次のラウンドが始まります。
          </p>
        </div>
      )}

      {state.phase === "finished" && (
        <div className="juice-slide" style={{ padding: "12px 0 4px" }}>
          <h2 className="juice-pulse" style={{ textAlign: "center" }}>結果</h2>
          <p className={state.winnerSeat === mySeat ? "juice-pulse" : undefined} style={{ textAlign: "center", fontSize: 18 }}>
            {state.winnerSeat === null
              ? "勝者はいませんでした。"
              : state.winnerSeat === mySeat
                ? "あなたの勝ちです！"
                : `${nameOf(state.winnerSeat)} さんの勝ちです。`}
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
            {(state.standings ?? []).map((s) => (
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
                  {s.rank}位 {nameOf(s.seat)}
                  {s.seat === mySeat ? "（あなた）" : ""}
                </span>
                <span>{state.players.find((p) => p.seat === s.seat)?.left ? "退出" : ""}</span>
              </li>
            ))}
          </ul>
          <p className="og-muted" style={{ textAlign: "center" }}>
            再戦は下のボタンからどうぞ。
          </p>
        </div>
      )}
    </div>
  );
}

export default function MusicalChairsClient() {
  return (
    <OnlineShell gameId="musicalchairs" title="椅子取り" playerRange={{ min: 3, max: 8 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
