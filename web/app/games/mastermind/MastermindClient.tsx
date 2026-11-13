"use client";
// マスターマインド。ロジックは lib/mastermind.ts（ヒット＆ブローの集計・勝敗）。
// 色を4つ並べて判定し、10回までに正解の並びを当てる。端末内で完結。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createMastermindGame,
  isValidGuess,
  mmPalette,
  remainingGuesses,
  submitGuess,
  MM_CODE_LENGTH,
  type MmColor,
  type MmDifficulty,
  type MmState,
} from "@/lib/mastermind";
import { sfxFlip, sfxLose, sfxPlace, sfxTap, sfxWin } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const DIFFS: { key: MmDifficulty; label: string }[] = [
  { key: "easy", label: "かんたん（5色）" },
  { key: "normal", label: "ふつう（6色）" },
];

function newGame(diff: MmDifficulty): MmState {
  return createMastermindGame(Date.now() % 2147483647, diff);
}

function Peg({ color, size = 30 }: { color: MmColor | undefined; size?: number }) {
  return (
    <span
      aria-label={color ? color.label : "未選択"}
      className={color ? "juice-pop" : undefined}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color ? color.value : "transparent",
        border: color ? "2px solid rgba(0,0,0,0.25)" : "2px dashed var(--line)",
        verticalAlign: "middle",
      }}
    />
  );
}

export default function MastermindClient() {
  const { prefix } = useGamesNav();
  const [difficulty, setDifficulty] = useState<MmDifficulty>("normal");
  const [state, setState] = useState<MmState>(() => newGame("normal"));
  const [current, setCurrent] = useState<(string | null)[]>(() => Array(MM_CODE_LENGTH).fill(null));
  const [slot, setSlot] = useState(0);

  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (prev === state.status) return;
    if (state.status === "won") sfxWin();
    else if (state.status === "lost") sfxLose();
  }, [state.status]);

  const palette = mmPalette(state.difficulty);
  const colorOf = (id: string | null) => palette.find((c) => c.id === id) ?? undefined;
  const full = current.every((c) => c !== null);
  const canSubmit = state.status === "playing" && full && isValidGuess(state, current as string[]);

  const restart = (diff: MmDifficulty) => {
    setDifficulty(diff);
    setState(newGame(diff));
    setCurrent(Array(MM_CODE_LENGTH).fill(null));
    setSlot(0);
  };

  const pickColor = (id: string) => {
    if (state.status !== "playing") return;
    sfxPlace();
    const next = [...current];
    next[slot] = id;
    setCurrent(next);
    const emptyAfter = next.findIndex((c, i) => i > slot && c === null);
    const emptyAny = next.findIndex((c) => c === null);
    setSlot(emptyAfter >= 0 ? emptyAfter : emptyAny >= 0 ? emptyAny : slot);
  };

  const onSubmit = () => {
    if (!canSubmit) return;
    const next = submitGuess(state, current as string[]);
    if (next === state) return;
    // 終局時は終局ジングルに任せ、二重に鳴らさない。
    if (next.status === "playing") sfxFlip();
    setState(next);
    setCurrent(Array(MM_CODE_LENGTH).fill(null));
    setSlot(0);
  };

  const clearGuess = () => {
    if (state.status !== "playing") return;
    sfxTap();
    setCurrent(Array(MM_CODE_LENGTH).fill(null));
    setSlot(0);
  };

  // 予想欄のジェスチャ: 上スワイプ = 判定する、左スワイプ = クリア。
  // キーボードは予想欄フォーカス時の Enter / Space・Backspace / Delete。
  // window リスナーはないため二重発火の余地はない。子のスロット onClick との
  // 二重発火は useGesture の suppressClickAfterSwipe が抑止する。
  const guessGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "up") onSubmit();
      else if (dir === "left") clearGuess();
    },
  });

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>マスターマインド</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>マスターマインド</h1>
        <p className="muted">
          隠された4つの色の並びを当てる推理ゲーム。ヒットは色も位置も一致、ブローは色だけ一致（位置違い）です。色は重複します。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="難易度">
        {DIFFS.map((d) => (
          <div
            key={d.key}
            {...tappableProps(() => restart(d.key))}
            aria-pressed={difficulty === d.key}
            className={difficulty === d.key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {d.label}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(difficulty)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        残り {remainingGuesses(state)} 回
        {state.status === "won"
          ? ` ・ 正解！ ${state.guesses.length} 回で当てました。`
          : state.status === "lost"
            ? " ・ 終了… 正解は下の通りでした。"
            : ""}
      </p>

      {state.status === "lost" && (
        <p style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0" }}>
          <strong>正解:</strong>
          {state.secret.map((id, i) => (
            <Peg key={i} color={colorOf(id) ?? { id, label: id, value: "#999" }} />
          ))}
          <span className="muted">{state.secret.map((id) => colorOf(id)?.label ?? id).join("・")}</span>
        </p>
      )}

      {state.status !== "playing" && (
        <div style={{ margin: "14px 0" }}>
          <EndScreen
            outcome={state.status === "won" ? "win" : "lose"}
            title={state.status === "won" ? "正解！" : undefined}
            onRetry={() => restart(difficulty)}
          >
            <p>
              {state.guesses.length} 回判定 ・ {DIFFS.find((d) => d.key === difficulty)?.label ?? difficulty}
              {state.status === "won" ? ` ・ ${state.guesses.length} 回で当てました` : ""}
            </p>
          </EndScreen>
        </div>
      )}

      <section aria-label="いまの予想" style={{ margin: "14px 0" }}>
        <div
          role="group"
          tabIndex={0}
          aria-label="いまの予想（上にスワイプで判定・左スワイプでクリア）"
          {...guessGesture}
          onKeyDown={(e) => {
            // 子の予想スロット（tappableProps）の Enter / Space はスロット自身が
            // 受けるため、予想欄そのものにフォーカスがあるときだけ判定する。
            // ガードがないと予想が揃った状態でスロットに Enter を押したときに
            // スロット選択と判定が両方走る（anagram と同じ構図）。
            if ((e.key === "Enter" || e.key === " ") && e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSubmit();
            } else if (e.key === "Backspace" || e.key === "Delete") {
              e.preventDefault();
              clearGuess();
            }
          }}
          style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", touchAction: "none" }}
        >
          {current.map((id, i) => (
            <div
              key={i}
              {...tappableProps(() => {
                sfxTap();
                setSlot(i);
              })}
              aria-label={`${i + 1} 番目のマス${id ? `（${colorOf(id)?.label ?? id}）` : "（未選択）"}`}
              aria-pressed={slot === i}
              style={{
                padding: 4,
                borderRadius: "50%",
                border: slot === i ? "3px solid var(--accent)" : "3px solid transparent",
                background: "transparent",
                cursor: "pointer",
              }}
            >
              <Peg color={colorOf(id)} size={36} />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }} role="group" aria-label="色の選択">
          {palette.map((c) => (
            <div
              key={c.id}
              {...tappableProps(() => pickColor(c.id))}
              aria-label={`${c.label}を選ぶ`}
              style={{ padding: 2, border: "none", background: "transparent", cursor: "pointer" }}
            >
              <Peg color={c} size={34} />
            </div>
          ))}
        </div>
      </section>

      <section aria-label="履歴">
        <h2 style={{ fontSize: 16, margin: "14px 0 8px" }}>履歴</h2>
        {state.guesses.length === 0 ? (
          <p className="muted">まだ判定していません。色を4つ選んで、予想欄を上にスワイプで判定してください。</p>
        ) : (
          <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {[...state.guesses].reverse().map((g, ri) => {
              const turn = state.guesses.length - ri;
              return (
                <li
                  key={turn}
                  className="juice-slide"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    padding: "8px 10px",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    background: "#fff",
                  }}
                >
                  <span style={{ fontWeight: 700, minWidth: 34 }}>{turn}.</span>
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    {g.pegs.map((id, i) => (
                      <Peg key={i} color={colorOf(id) ?? { id, label: id, value: "#999" }} size={24} />
                    ))}
                  </span>
                  <span>
                    ● ヒット {g.hits} ・ ○ ブロー {g.blows}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}
