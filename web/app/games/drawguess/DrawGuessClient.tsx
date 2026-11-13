"use client";
// お絵かき当て オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/drawguess.ts の viewFor）:
//   choosing: 描き手にだけ wordOptions が渡る（3択）
//   drawing: 描き手にだけ word、回答側には wordLength だけ。strokes / feed は全員共通
//   reveal: word が全員に開示される
//   finished: standings が付く
// 座標は 0〜1000 に正規化して送る（canvas 内部解像度 1000x750、表示は 4:3）。
// 描画は { type: "stroke", color, width, points }、回答は { type: "guess", text }。
import { useEffect, useRef, useState } from "react";
import { playSe } from "@/lib/balku-sound";
import { tappableProps } from "@/lib/gesture";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

/** サーバー側モジュール（lib/online/games/drawguess.ts の DG_COLORS / DG_WIDTHS）と一致させること。 */
const DG_COLORS = ["#111827", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"];
const DG_WIDTHS = [6, 14, 28];
const DG_MAX_POINTS = 200;
/** サーバー側モジュール（lib/online/games/drawguess.ts の DG_MAX_STROKES / DG_MAX_TOTAL_POINTS）と一致させること。 */
const DG_MAX_STROKES = 300;
const DG_MAX_TOTAL_POINTS = 20000;
const CANVAS_H_RATIO = 0.75; // 内部解像度 1000x750

type DgStroke = { color: string; width: number; points: [number, number][] };
type DgFeedEntry = { seat: number; text: string | null; correct: boolean };

type DgView = {
  phase: "choosing" | "drawing" | "reveal" | "finished";
  roundIndex: number;
  totalRounds: number;
  drawerSeat: number | null;
  phaseEndsAt: number | null;
  strokes: DgStroke[];
  feed: DgFeedEntry[];
  players: { seat: number; name: string; score: number; left: boolean; isDrawer: boolean; correct: boolean }[];
  you: { seat: number; isDrawer: boolean; left: boolean; correct: boolean };
  wordOptions: string[] | null;
  word: string | null;
  wordLength: number | null;
  correctSeats: number[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

function drawStrokes(canvas: HTMLCanvasElement, strokes: DgStroke[], extra: DgStroke | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const all = extra ? [...strokes, extra] : strokes;
  for (const stroke of all) {
    if (stroke.points.length === 0) continue;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    if (stroke.points.length === 1) {
      const [x, y] = stroke.points[0];
      ctx.beginPath();
      ctx.arc(x, y * CANVAS_H_RATIO, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    stroke.points.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y * CANVAS_H_RATIO);
      else ctx.lineTo(x, y * CANVAS_H_RATIO);
    });
    ctx.stroke();
  }
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as DgView | null;
  const mySeat = view.player.seat;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<[number, number][] | null>(null);
  const [liveStroke, setLiveStroke] = useState<DgStroke | null>(null);
  const [color, setColor] = useState(DG_COLORS[0]);
  const [width, setWidth] = useState(DG_WIDTHS[1]);
  const [guessText, setGuessText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const finishRef = useRef<string | null>(null);

  const strokes = state?.strokes ?? [];
  const strokesJson = JSON.stringify(strokes);
  const liveJson = JSON.stringify(liveStroke);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawStrokes(canvas, JSON.parse(strokesJson) as DgStroke[], liveStroke);
    // liveStroke は liveJson で追跡する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokesJson, liveJson]);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  // SE: 自分が描き手になるフェーズ遷移で1回だけ鳴らす。
  const prevPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state) return;
    const key = `${view.code}:${state.roundIndex}:${state.phase}:${state.drawerSeat ?? ""}`;
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = key;
    if (prev !== null && prev !== key && state.you.isDrawer && (state.phase === "choosing" || state.phase === "drawing")) playSe("turn");
  }, [state, view.code]);

  // SE: 自分が正解した遷移で1回だけ鳴らす。
  const prevCorrectRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!state) return;
    const prev = prevCorrectRef.current;
    prevCorrectRef.current = state.you.correct;
    if (prev === false && state.you.correct) playSe("coin");
  }, [state]);

  if (!state) return <p className="og-muted">部屋の準備を待っています…</p>;

  const atStrokeLimit = strokes.length >= DG_MAX_STROKES;
  const canDraw = state.phase === "drawing" && state.you.isDrawer && !state.you.left;
  const canGuess = state.phase === "drawing" && !state.you.isDrawer && !state.you.left && !state.you.correct;
  const drawer = state.players.find((p) => p.seat === state.drawerSeat);
  const remainingSec = state.phaseEndsAt !== null ? Math.max(0, Math.ceil((state.phaseEndsAt - now) / 1000)) : null;

  const toNorm = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1000, Math.round(((e.clientX - rect.left) / rect.width) * 1000)));
    const y = Math.max(0, Math.min(1000, Math.round(((e.clientY - rect.top) / rect.height) * 1000)));
    return [x, y];
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw || atStrokeLimit) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toNorm(e);
    drawingRef.current = [pt];
    setLiveStroke({ color, width, points: [pt] });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canDraw || !drawingRef.current) return;
    const pt = toNorm(e);
    const pts = drawingRef.current;
    const last = pts[pts.length - 1];
    const dist = Math.hypot(pt[0] - last[0], pt[1] - last[1]);
    if (dist < 6) return;
    if (pts.length >= DG_MAX_POINTS) return;
    pts.push(pt);
    setLiveStroke({ color, width, points: [...pts] });
  };

  const onPointerUp = () => {
    if (!drawingRef.current) return;
    const points = drawingRef.current;
    drawingRef.current = null;
    setLiveStroke(null);
    if (points.length < 1) return;
    // サーバー側の総点数上限を超えるストロークは送らない（送っても弾かれて黙って消えるため）
    const totalPoints = strokes.reduce((sum, s) => sum + s.points.length, 0);
    if (totalPoints + points.length > DG_MAX_TOTAL_POINTS) return;
    void api.move({ type: "stroke", color, width, points });
  };

  const submitGuess = () => {
    const text = guessText.trim();
    if (!text || !canGuess) return;
    playSe("play");
    void api.move({ type: "guess", text });
    setGuessText("");
  };

  const nameOf = (seat: number) => state.players.find((p) => p.seat === seat)?.name ?? "?";

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.isDrawer ? "（描き手）" : ""}
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
            {state.phase === "drawing" && p.correct ? " ・ 正解済み" : ""}
          </span>
        ))}
      </div>

      {state.phase !== "finished" ? (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          <p style={{ margin: 0, fontWeight: 800 }}>
            {state.roundIndex + 1} 人目の描き手 / {state.totalRounds} 人
            {drawer ? ` ・ ${drawer.name}${drawer.seat === mySeat ? "（あなた）" : ""} が描きます` : ""}
          </p>
          {remainingSec !== null ? (
            <span style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>残り {remainingSec} 秒</span>
          ) : null}
        </div>
      ) : null}

      {state.phase === "choosing" ? (
        state.you.isDrawer && state.wordOptions ? (
          <div className="juice-pop" style={{ marginTop: 16 }}>
            <p style={{ fontWeight: 800, margin: "0 0 10px" }}>描くお題を選んでください</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {state.wordOptions.map((word, i) => (
                <div
                  key={i}
                  {...tappableProps(() => {
                    playSe("play");
                    void api.move({ type: "choose", index: i });
                  })}
                  style={{
                    minHeight: 52,
                    padding: "12px 22px",
                    fontSize: 18,
                    fontWeight: 800,
                    borderRadius: 12,
                    border: "2px solid #d8c9a3",
                    background: "#fffdf6",
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  {word}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="og-turn-banner" role="status" style={{ marginTop: 16 }}>
            {drawer ? `${drawer.name} さんがお題を選んでいます…` : "お題の選択を待っています…"}
          </p>
        )
      ) : null}

      {state.phase === "drawing" || state.phase === "reveal" ? (
        <>
          {state.phase === "drawing" && state.you.isDrawer && state.word ? (
            <p role="status" style={{ margin: "14px 0 8px", fontWeight: 800, fontSize: 18 }}>
              お題: <span style={{ color: "#b3543f" }}>{state.word}</span>
              <span className="og-muted" style={{ fontWeight: 400, fontSize: 14 }}> （あなただけに見えています）</span>
            </p>
          ) : null}
          {state.phase === "drawing" && !state.you.isDrawer ? (
            <p role="status" style={{ margin: "14px 0 8px", fontWeight: 800, fontSize: 18 }}>
              お題は {state.wordLength ?? "？"} 文字
              {state.you.correct ? " ・ あなたは正解済みです" : ""}
            </p>
          ) : null}

          <canvas
            ref={canvasRef}
            width={1000}
            height={750}
            aria-label="お絵かきキャンバス"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            style={{
              width: "100%",
              aspectRatio: "4 / 3",
              background: "#ffffff",
              border: "2px solid #d8c9a3",
              borderRadius: 12,
              touchAction: canDraw ? "none" : "auto",
              cursor: canDraw ? "crosshair" : "default",
              display: "block",
            }}
          />

          {canDraw && atStrokeLimit ? (
            <p className="og-muted" style={{ margin: "10px 0 0" }}>
              ストローク数が上限（{DG_MAX_STROKES}本）に達しました。「全部消す」で描き直せます。
            </p>
          ) : null}

          {canDraw ? (
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
              <div role="group" aria-label="色" style={{ display: "flex", gap: 6 }}>
                {DG_COLORS.map((c) => (
                  <div
                    key={c}
                    {...tappableProps(() => setColor(c))}
                    aria-label={`色 ${c}`}
                    aria-pressed={color === c}
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "50%",
                      background: c,
                      border: color === c ? "3px solid #111827" : "2px solid #d1d5db",
                      cursor: "pointer",
                      touchAction: "manipulation",
                    }}
                  />
                ))}
              </div>
              <div role="group" aria-label="太さ" style={{ display: "flex", gap: 6 }}>
                {DG_WIDTHS.map((w) => (
                  <div
                    key={w}
                    {...tappableProps(() => setWidth(w))}
                    aria-pressed={width === w}
                    style={{
                      minWidth: 44,
                      height: 40,
                      padding: "0 10px",
                      borderRadius: 999,
                      border: width === w ? "2px solid #111827" : "2px solid #d1d5db",
                      background: "#fffdf6",
                      fontWeight: 700,
                      cursor: "pointer",
                      touchAction: "manipulation",
                    }}
                  >
                    {w === DG_WIDTHS[0] ? "細" : w === DG_WIDTHS[1] ? "中" : "太"}
                  </div>
                ))}
              </div>
              <div
                {...tappableProps(() => void api.move({ type: "clear" }))}
                className="classic-btn"
              >
                全部消す
              </div>
            </div>
          ) : null}

          {state.phase === "drawing" && !state.you.isDrawer ? (
            state.you.left ? (
              <p className="og-muted" style={{ textAlign: "center" }}>退出したため、この対戦では回答できません。</p>
            ) : state.you.correct ? (
              <p className="og-muted" style={{ textAlign: "center" }}>正解済みです。全員の正解か制限時間でラウンドが終わります。</p>
            ) : (
              <form
                style={{ display: "flex", gap: 8, marginTop: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitGuess();
                }}
              >
                <input
                  type="text"
                  value={guessText}
                  onChange={(e) => setGuessText(e.target.value)}
                  placeholder="お題はなに？"
                  aria-label="お題の回答"
                  maxLength={50}
                  style={{
                    flex: 1,
                    minHeight: 48,
                    padding: "10px 14px",
                    fontSize: 16,
                    borderRadius: 10,
                    border: "2px solid #d8c9a3",
                    background: "#fffdf6",
                  }}
                />
                <div
                  {...tappableProps(submitGuess)}
                  className="classic-btn"
                  style={{ minHeight: 48, padding: "10px 22px", fontSize: 16 }}
                >
                  回答
                </div>
              </form>
            )
          ) : null}

          {state.feed.length > 0 ? (
            <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {state.feed.slice(-8).map((entry, i, arr) => (
                <li
                  key={`${i}-${entry.seat}`}
                  className={i === arr.length - 1 ? "juice-pop" : undefined}
                  style={{
                    padding: "7px 12px",
                    borderRadius: 10,
                    border: "1px solid #e5e7eb",
                    background: entry.correct ? "#f0fdf4" : "#fffdf6",
                  }}
                >
                  <strong>{nameOf(entry.seat)}</strong>: {entry.correct ? "正解！" : entry.text}
                </li>
              ))}
            </ul>
          ) : null}

          {state.phase === "reveal" ? (
            <p className="og-turn-banner juice-slide" role="status" style={{ marginTop: 14 }}>
              お題は「{state.word ?? "—"}」でした
              {state.correctSeats.length > 0
                ? ` ・ 正解: ${state.correctSeats.map((s) => nameOf(s)).join("、")}`
                : " ・ 正解者はいませんでした"}
            </p>
          ) : null}
        </>
      ) : null}

      {state.phase === "finished" ? (
        <div className="juice-slide" style={{ textAlign: "center" }}>
          <h2 className={state.standings?.find((s) => s.seat === mySeat)?.rank === 1 ? "juice-pulse" : undefined} style={{ fontSize: 24, margin: "10px 0" }}>結果発表</h2>
          {state.word ? <p className="muted">最後のお題は「{state.word}」でした。</p> : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {(state.standings ?? [...state.players].map((p) => ({ seat: p.seat, score: p.score, rank: 0 })))
              .slice()
              .sort((a, b) => a.rank - b.rank || b.score - a.score)
              .map((s) => {
                const p = state.players.find((x) => x.seat === s.seat);
                if (!p) return null;
                return (
                  <li
                    key={s.seat}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "12px 16px",
                      borderRadius: 12,
                      border: s.rank === 1 ? "2px solid #d9a41c" : "1px solid #e5e7eb",
                      background: s.rank === 1 ? "#fff3c4" : "#fffdf6",
                      fontWeight: s.seat === mySeat ? 800 : 400,
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
          <p className="og-muted">全員が1回ずつ描き終わりました。再戦は下のボタンからどうぞ。</p>
        </div>
      ) : null}
    </div>
  );
}

export default function DrawGuessClient() {
  return (
    <OnlineShell gameId="drawguess" title="お絵かき当て" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
