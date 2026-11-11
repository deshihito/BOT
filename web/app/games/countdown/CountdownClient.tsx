"use client";
// 数字カウントダウン オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約（lib/online/games/countdown.ts の viewFor）:
//   phase playing: 目標と数字は全員共通で公開。他人の式は秘匿（submitted フラグのみ）
//   phase reveal: players[].value / distance / points / steps が開示される
//   phase finished: standings が付く
// 式は数字タイルと演算子をタップして組み立て、最後の計算結果が答えになる。
// ローカルの検証はサーバーと同じ evaluateCountdown を使う。
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { playSe } from "@/lib/balku-sound";
import {
  evaluateCountdown,
  CD_TIME_LIMIT_MS,
  type CdOp,
  type CdRef,
  type CdStep,
} from "@/lib/online/games/countdown";
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

const OP_LABEL: Record<CdOp, string> = { "+": "＋", "-": "－", "*": "×", "/": "÷" };
const OPS: CdOp[] = ["+", "-", "*", "/"];

type CdViewPlayer = {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  submitted: boolean;
  value?: number | null;
  distance?: number | null;
  points?: number;
  steps?: CdStep[] | null;
  pick?: number | null;
};

type CdView = {
  phase: "playing" | "reveal" | "finished";
  round: number;
  totalRounds: number;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  target: number;
  numbers: number[];
  you: {
    seat: number;
    left: boolean;
    submitted: boolean;
    yourSteps: CdStep[] | null;
    yourPick: number | null;
    yourValue: number | null;
  };
  players: CdViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
};

interface Builder {
  steps: CdStep[];
  stepValues: number[];
  usedNums: boolean[];
  usedSteps: boolean[];
  sel: CdRef | null;
  op: CdOp | null;
  error: string | null;
}

function freshBuilder(numbers: number[]): Builder {
  return {
    steps: [],
    stepValues: [],
    usedNums: numbers.map(() => false),
    usedSteps: [],
    sel: null,
    op: null,
    error: null,
  };
}

function refEquals(a: CdRef | null, b: CdRef): boolean {
  return a !== null && a.kind === b.kind && a.index === b.index;
}

/** 2つの値の演算を検証つきで計算する（サーバーの evaluateCountdown と同じ規則）。 */
function combine(a: number, op: CdOp, b: number): { ok: true; value: number } | { ok: false; reason: string } {
  switch (op) {
    case "+":
      return { ok: true, value: a + b };
    case "-":
      return a - b > 0
        ? { ok: true, value: a - b }
        : { ok: false, reason: "引き算の結果は正の数でなければなりません" };
    case "*":
      return { ok: true, value: a * b };
    case "/":
      return b !== 0 && a % b === 0
        ? { ok: true, value: a / b }
        : { ok: false, reason: "割り算は割り切れる場合だけ使えます" };
  }
}

function formatSteps(numbers: number[], steps: CdStep[] | null, pick: number | null): string[] {
  if (!steps) return [];
  if (steps.length === 0) {
    return pick !== null && numbers[pick] !== undefined ? [`${numbers[pick]}（そのまま）`] : [];
  }
  const evaluated = evaluateCountdown(numbers, { steps, pick });
  const values = evaluated.ok ? evaluated.stepValues : [];
  const refText = (ref: CdRef): string =>
    ref.kind === "num" ? String(numbers[ref.index]) : String(values[ref.index] ?? "?");
  return steps.map(
    (s, i) => `${refText(s.a)} ${OP_LABEL[s.op]} ${refText(s.b)} = ${values[i] ?? "?"}`,
  );
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as CdView | null;
  const mySeat = view.player.seat;
  const [now, setNow] = useState(() => Date.now());
  const [builder, setBuilder] = useState<Builder | null>(null);
  const finishRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  // ラウンドが変わったら式ビルダーを作り直す。
  const playingRound = state && state.phase === "playing" ? state.round : -1;
  useEffect(() => {
    if (playingRound >= 0 && state) setBuilder(freshBuilder(state.numbers));
    // state.numbers は playingRound と同時に切り替わる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingRound]);

  useEffect(() => {
    if (!state || state.phase !== "finished") return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    const myRank = state.standings?.find((s) => s.seat === mySeat)?.rank;
    playSe(myRank === 1 ? "win" : "click");
  }, [state, mySeat, view.code]);

  if (!state) return <p className="og-muted">対戦の開始を待っています…</p>;

  const numbers = state.numbers;
  const submitted = state.you.submitted || state.you.left;
  const canPlay = state.phase === "playing" && !submitted && builder !== null;
  const b: Builder = builder ?? freshBuilder(numbers);

  const tileValue = (ref: CdRef): number =>
    ref.kind === "num" ? numbers[ref.index] : b.stepValues[ref.index];

  const tileUsed = (ref: CdRef): boolean =>
    ref.kind === "num" ? b.usedNums[ref.index] : b.usedSteps[ref.index];

  const tapTile = (ref: CdRef) => {
    if (!canPlay || tileUsed(ref)) return;
    playSe("click");
    setBuilder((prev) => {
      if (!prev) return prev;
      if (prev.sel === null || prev.op === null) {
        // 1つ目（または選び直し）。
        return { ...prev, sel: ref, error: null };
      }
      if (refEquals(prev.sel, ref)) return prev;
      const result = combine(tileValue(prev.sel), prev.op, tileValue(ref));
      if (!result.ok) return { ...prev, error: result.reason };
      const usedNums = [...prev.usedNums];
      const usedSteps = [...prev.usedSteps];
      for (const r of [prev.sel, ref]) {
        if (r.kind === "num") usedNums[r.index] = true;
        else usedSteps[r.index] = true;
      }
      return {
        steps: [...prev.steps, { a: prev.sel, op: prev.op, b: ref }],
        stepValues: [...prev.stepValues, result.value],
        usedNums,
        usedSteps: [...usedSteps, false],
        sel: null,
        op: null,
        error: null,
      };
    });
  };

  const undo = () => {
    setBuilder((prev) => {
      if (!prev || prev.steps.length === 0) return prev;
      const last = prev.steps[prev.steps.length - 1];
      const usedNums = [...prev.usedNums];
      const usedSteps = [...prev.usedSteps];
      for (const r of [last.a, last.b]) {
        if (r.kind === "num") usedNums[r.index] = false;
        else usedSteps[r.index] = false;
      }
      return {
        steps: prev.steps.slice(0, -1),
        stepValues: prev.stepValues.slice(0, -1),
        usedNums,
        usedSteps: usedSteps.slice(0, -1),
        sel: null,
        op: null,
        error: null,
      };
    });
  };

  const answer: number | null =
    b.steps.length > 0
      ? b.stepValues[b.stepValues.length - 1]
      : b.sel !== null && b.sel.kind === "num"
        ? numbers[b.sel.index]
        : null;

  const onSubmit = () => {
    if (!canPlay || answer === null) return;
    const sub =
      b.steps.length > 0
        ? { steps: b.steps, pick: null as number | null }
        : { steps: [] as CdStep[], pick: b.sel !== null && b.sel.kind === "num" ? b.sel.index : null };
    const check = evaluateCountdown(numbers, sub);
    if (!check.ok) {
      setBuilder((prev) => (prev ? { ...prev, error: check.reason } : prev));
      return;
    }
    playSe("play");
    void api.move({ type: "submit", steps: sub.steps, pick: sub.pick });
  };

  const remainingMs = state.roundEndsAt !== null ? Math.max(0, state.roundEndsAt - now) : null;
  const remainingRatio = remainingMs !== null ? remainingMs / CD_TIME_LIMIT_MS : 0;
  const winner = state.phase === "reveal" ? state.players.find((p) => (p.points ?? 0) > 0) : undefined;

  const tileStyle = (active: boolean, used: boolean): CSSProperties => ({
    minWidth: 56,
    minHeight: 56,
    padding: "8px 10px",
    borderRadius: 12,
    border: `2px solid ${active ? "#4a6fa5" : "#d8c9a3"}`,
    background: used ? "#e5e7eb" : active ? "#e0eaff" : "#fffdf6",
    color: used ? "#9ca3af" : "inherit",
    fontSize: 20,
    fontWeight: 800,
    cursor: canPlay && !used ? "pointer" : "default",
    touchAction: "manipulation",
  });

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="og-score-row" role="status">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {p.left ? "（退出）" : ""} ・ {p.score}点
            {state.phase === "playing" ? (p.submitted ? " ・ 提出済み" : " ・ 考え中") : ""}
          </span>
        ))}
      </div>

      {state.phase !== "finished" ? (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 12,
              flexWrap: "wrap",
              marginTop: 8,
            }}
          >
            <p style={{ margin: 0, fontWeight: 800 }}>
              第{state.round + 1}ラウンド / {state.totalRounds}
            </p>
            {state.phase === "playing" && remainingMs !== null ? (
              <span style={{ fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                残り {(remainingMs / 1000).toFixed(1)} 秒
              </span>
            ) : null}
          </div>
          {state.phase === "playing" ? (
            <div
              aria-hidden="true"
              style={{ height: 8, borderRadius: 999, background: "#e5e7eb", margin: "8px 0 14px", overflow: "hidden" }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${remainingRatio * 100}%`,
                  background: remainingRatio < 0.25 ? "#ef4444" : "#4a6fa5",
                  transition: "width 0.2s linear",
                }}
              />
            </div>
          ) : null}

          <div style={{ textAlign: "center", margin: "6px 0 12px" }}>
            <span className="og-muted">目標</span>
            <div style={{ fontSize: 44, fontWeight: 900, lineHeight: 1.1 }}>{state.target}</div>
          </div>

          {state.phase === "playing" ? (
            state.you.left ? (
              <p className="og-muted" style={{ textAlign: "center" }}>
                退出したため、この対戦では提出できません。
              </p>
            ) : state.you.submitted ? (
              <div style={{ textAlign: "center" }}>
                <p className="og-turn-banner" role="status">
                  「{state.you.yourValue}」で提出済み。全員の提出か制限時間で締め切られます。
                </p>
                <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, color: "#4b4237" }}>
                  {formatSteps(numbers, state.you.yourSteps, state.you.yourPick).map((line, i) => (
                    <li key={i} style={{ fontVariantNumeric: "tabular-nums" }}>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                <p className="muted" style={{ textAlign: "center", margin: "0 0 8px" }}>
                  数字タイル→演算子→数字タイルの順にタップして計算を組み立てます。各数字は1回まで、中間結果は正の整数だけ。最後の計算結果が答えになります。
                </p>

                {/* 使える数（元の数字＋計算結果） */}
                <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }} role="group" aria-label="使える数字">
                  {numbers.map((n, i) => {
                    const ref: CdRef = { kind: "num", index: i };
                    return (
                      <button
                        key={`num-${i}`}
                        type="button"
                        disabled={!canPlay || b.usedNums[i]}
                        onClick={() => tapTile(ref)}
                        style={tileStyle(refEquals(b.sel, ref), b.usedNums[i])}
                      >
                        {n}
                      </button>
                    );
                  })}
                  {b.stepValues.map((v, i) => {
                    const ref: CdRef = { kind: "step", index: i };
                    return (
                      <button
                        key={`step-${i}`}
                        type="button"
                        disabled={!canPlay || b.usedSteps[i]}
                        onClick={() => tapTile(ref)}
                        style={{ ...tileStyle(refEquals(b.sel, ref), b.usedSteps[i]), borderStyle: "dashed" }}
                      >
                        {v}
                      </button>
                    );
                  })}
                </div>

                {/* 演算子 */}
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }} role="group" aria-label="演算子">
                  {OPS.map((op) => (
                    <button
                      key={op}
                      type="button"
                      disabled={!canPlay || b.sel === null}
                      aria-pressed={b.op === op}
                      onClick={() => setBuilder((prev) => (prev ? { ...prev, op, error: null } : prev))}
                      style={{
                        width: 56,
                        height: 48,
                        borderRadius: 12,
                        border: `2px solid ${b.op === op ? "#4a6fa5" : "#d8c9a3"}`,
                        background: b.op === op ? "#e0eaff" : "#fffdf6",
                        fontSize: 22,
                        fontWeight: 800,
                        cursor: canPlay && b.sel !== null ? "pointer" : "default",
                        touchAction: "manipulation",
                      }}
                    >
                      {OP_LABEL[op]}
                    </button>
                  ))}
                </div>

                {/* 組み立てた式 */}
                {b.steps.length > 0 ? (
                  <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, textAlign: "center", color: "#4b4237" }}>
                    {formatSteps(numbers, b.steps, null).map((line, i) => (
                      <li key={i} style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p style={{ textAlign: "center", margin: "10px 0 0", fontWeight: 800 }}>
                  {b.sel !== null
                    ? `選択中: ${tileValue(b.sel)}${b.op ? ` ${OP_LABEL[b.op]} …` : "（演算子を選んでください）"}`
                    : answer !== null
                      ? `答え: ${answer}（目標まで ${Math.abs(answer - state.target)}）`
                      : "数字タイルを選んでください。そのまま提出もできます。"}
                </p>
                {b.error ? (
                  <p role="alert" style={{ textAlign: "center", color: "#dc2626", fontWeight: 700 }}>
                    {b.error}
                  </p>
                ) : null}

                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10, flexWrap: "wrap" }}>
                  <button type="button" className="classic-btn" disabled={!canPlay || b.steps.length === 0} onClick={undo}>
                    1つ戻す
                  </button>
                  <button
                    type="button"
                    className="classic-btn"
                    disabled={!canPlay}
                    onClick={() => setBuilder(freshBuilder(numbers))}
                  >
                    やり直す
                  </button>
                  <button
                    type="button"
                    className="classic-btn classic-btn-active"
                    disabled={!canPlay || answer === null}
                    onClick={onSubmit}
                    style={{ minWidth: 140 }}
                  >
                    {answer !== null ? `${answer} で提出` : "提出"}
                  </button>
                </div>
              </>
            )
          ) : null}

          {state.phase === "reveal" ? (
            <div style={{ marginTop: 6 }}>
              <p className="og-turn-banner" role="status">
                {winner
                  ? `${winner.name} が ${winner.value}（目標まで ${winner.distance}）で +${winner.points}点！`
                  : "誰も提出しませんでした。"}
              </p>
              <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 8 }}>
                {state.players.map((p) => (
                  <li
                    key={p.seat}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      border: (p.points ?? 0) > 0 ? "2px solid #22c55e" : "1px solid #e5e7eb",
                      background: (p.points ?? 0) > 0 ? "#dcfce7" : "#fffdf6",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <span style={{ fontWeight: 700 }}>
                        {p.name}
                        {p.seat === mySeat ? "（あなた）" : ""}
                      </span>
                      <strong>
                        {p.value !== null && p.value !== undefined
                          ? `${p.value}（あと ${p.distance}）${(p.points ?? 0) > 0 ? ` +${p.points}点` : ""}`
                          : p.left
                            ? "退出"
                            : "出さなかった"}
                      </strong>
                    </div>
                    {p.steps ? (
                      <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, color: "#4b4237", fontVariantNumeric: "tabular-nums" }}>
                        {formatSteps(numbers, p.steps, p.pick ?? null).map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <div style={{ textAlign: "center" }}>
          <h2 style={{ fontSize: 24, margin: "10px 0" }}>結果発表</h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {(state.standings ?? [...state.players].map((p) => ({ seat: p.seat, score: p.score, rank: 0 })))
              .slice()
              .sort((a, c) => a.rank - c.rank || c.score - a.score)
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
                      {s.seat === mySeat ? "（あなた）🎉" : ""}
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

export default function CountdownClient() {
  return (
    <OnlineShell gameId="countdown" title="数字カウントダウン" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
