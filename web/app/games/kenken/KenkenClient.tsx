"use client";
// ケンケン。ロジックは lib/kenken.ts（解先行生成・ルール検証で完成判定）。
// マスを選んで下の数字パッドから入力する。端末内で完結し、サーバーへ送信しない。
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkKenken,
  createKenkenGame,
  setKenkenValue,
  type KenkenSize,
  type KenkenState,
  type KenkenViolation,
} from "@/lib/kenken";
import { sfxCorrect, sfxPlace, sfxTap, sfxWin, sfxWrong } from "@/lib/sfx";
import { tappableProps, useGesture } from "@/lib/gesture";
import { EndScreen } from "../GameJuice";
import { useGamesNav } from "../GamesShell";

const SIZES: { key: KenkenSize; label: string }[] = [
  { key: 4, label: "4×4" },
  { key: 5, label: "5×5" },
];

function newGame(size: KenkenSize): KenkenState {
  return createKenkenGame(size, Date.now() % 2147483647);
}

export default function KenkenClient() {
  const { prefix } = useGamesNav();
  const [size, setSize] = useState<KenkenSize>(4);
  const [state, setState] = useState<KenkenState>(() => newGame(4));
  const [selected, setSelected] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [checked, setChecked] = useState<KenkenViolation[] | null>(null);

  useEffect(() => {
    if (state.status !== "playing" || state.moves === 0) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state.status, state.moves]);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(`ago-kenken-best-${size}`));
      setBest(Number.isFinite(saved) && saved > 0 ? saved : null);
    } catch {
      setBest(null);
    }
  }, [size]);

  useEffect(() => {
    if (state.status !== "won" || seconds <= 0) return;
    if (best !== null && seconds >= best) return;
    setBest(seconds);
    try {
      window.localStorage.setItem(`ago-kenken-best-${size}`, String(seconds));
    } catch {
      // 保存失敗はプレイに影響しない。
    }
  }, [state.status, seconds, best, size]);

  // 勝利への遷移で1回だけジングルを鳴らし、その時点のベストと比較した結果を保持する。
  const prevStatusRef = useRef(state.status);
  const [winResult, setWinResult] = useState<{ newBest: boolean; prevBest: number | null } | null>(null);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = state.status;
    if (state.status === "won" && prev !== "won") {
      sfxWin();
      setWinResult({ newBest: best === null || seconds < best, prevBest: best });
    }
  }, [state.status, seconds, best]);

  const restart = (nextSize: KenkenSize) => {
    setSize(nextSize);
    setState(newGame(nextSize));
    setSelected(0);
    setSeconds(0);
    setChecked(null);
    setWinResult(null);
  };

  const input = (value: number) => {
    if (state.status === "playing") {
      if (value === 0) {
        sfxTap();
      } else {
        sfxPlace();
      }
    }
    setChecked(null);
    setState((s) => setKenkenValue(s, selected, value));
  };

  const onCheck = () => {
    const result = checkKenken(state);
    if (result.violations.length === 0) {
      sfxCorrect();
    } else {
      sfxWrong();
    }
    setChecked(result.violations);
  };

  // 盤面の下スワイプ = チェック。子のマスの onClick との二重発火は
  // useGesture の suppressClickAfterSwipe が抑止する。
  const boardGesture = useGesture({
    onSwipe: (dir) => {
      if (dir === "down") onCheck();
    },
  });

  // 物理キーボードでも数字を入れられる（画面パッドの代替）。
  // パッドの div は Enter/Space のみ受けるため数字キーとの二重発火はない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= size) input(Number(e.key));
      else if (e.key === "Backspace" || e.key === "Delete") input(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input, size]);

  const badCells = useMemo(() => {
    const set = new Set<number>();
    if (checked) for (const v of checked) for (const c of v.cells) set.add(c);
    return set;
  }, [checked]);

  // ケージのラベルは、そのケージで最も小さい index のマスに表示する。
  const labelCell = useMemo(() => {
    const map = new Map<number, number>();
    for (const cage of state.cages) {
      map.set(Math.min(...cage.cells), cage.id);
    }
    return map;
  }, [state.cages]);

  const statusText =
    state.status === "won"
      ? "完成！クリアです。"
      : checked !== null
        ? checked.length === 0
          ? "いまのところルール違反はありません。"
          : checked[0].message
        : "マスを選んで数字を入れよう。各行・各列に同じ数字は1つだけ。ケージの計算も合わせよう。";

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>ケンケン</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>ケンケン</h1>
        <p className="muted">
          マスをタップして選び、下の数字パッドで入力します。太線で囲まれたまとまりがケージで、左上の数字が目標値です。盤面を下にスワイプするとチェックします。
        </p>
      </div>

      <div className="classic-controls" role="group" aria-label="サイズ">
        {SIZES.map((s) => (
          <div
            key={s.key}
            {...tappableProps(() => restart(s.key))}
            aria-pressed={size === s.key}
            className={size === s.key ? "classic-btn classic-btn-active" : "classic-btn"}
          >
            {s.label}
          </div>
        ))}
        <button type="button" className="classic-btn" onClick={() => restart(size)}>
          もう一度
        </button>
      </div>

      <p className="classic-status" role="status">
        {seconds} 秒{best !== null ? ` ・ ベスト ${best} 秒` : ""} ・ {statusText}
      </p>

      <div
        {...boardGesture}
        role="grid"
        aria-label="ケンケンの盤（下にスワイプでチェック）"
        tabIndex={0}
        onKeyDown={(e) => {
          // 盤面そのものにフォーカスがあるときだけ Enter でチェックする。
          // ガードがないとマスにフォーカスして Enter を押したときに選択と
          // チェックが両方走る（anagram / mastermind と同じ構図）。
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCheck();
          }
        }}
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          maxWidth: size === 4 ? 400 : 460,
          margin: "0 auto",
          border: "3px solid var(--text)",
          touchAction: "none",
        }}
      >
        {state.values.map((value, i) => {
          const cageId = state.cageOf[i];
          const r = Math.floor(i / size);
          const c = i % size;
          const thick = "3px solid var(--text)";
          const thin = "1px solid var(--line)";
          const borderTop = r === 0 || state.cageOf[i - size] !== cageId ? thick : thin;
          const borderLeft = c === 0 || state.cageOf[i - 1] !== cageId ? thick : thin;
          const borderRight = c === size - 1 || state.cageOf[i + 1] !== cageId ? thick : thin;
          const borderBottom = r === size - 1 || state.cageOf[i + size] !== cageId ? thick : thin;
          const labelId = labelCell.get(i);
          const cage = labelId !== undefined ? state.cages[labelId] : null;
          return (
            <div
              key={i}
              role="gridcell"
              tabIndex={0}
              aria-label={`${r + 1}行${c + 1}列${value ? ` ${value}` : ""}`}
              aria-pressed={selected === i}
              className={
                badCells.has(i)
                  ? "juice-shake"
                  : selected === i
                    ? "juice-pulse"
                    : value !== 0
                      ? "juice-pop"
                      : undefined
              }
              onClick={() => {
                sfxTap();
                setSelected(i);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                sfxTap();
                setSelected(i);
              }}
              style={{
                position: "relative",
                aspectRatio: "1",
                minWidth: 0,
                padding: 0,
                cursor: "pointer",
                fontSize: size === 4 ? 26 : 22,
                fontWeight: 700,
                color: "var(--text)",
                background: badCells.has(i)
                  ? "#f7e3e0"
                  : selected === i
                    ? "var(--accent-soft)"
                    : "#fff",
                borderTop,
                borderLeft,
                borderRight,
                borderBottom,
              }}
            >
              {cage ? (
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    left: 4,
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--muted)",
                  }}
                >
                  {cage.target}
                  {cage.op}
                </span>
              ) : null}
              {value !== 0 ? value : ""}
            </div>
          );
        })}
      </div>

      <div
        className="classic-controls"
        role="group"
        aria-label="数字入力"
        style={{ justifyContent: "center", marginTop: 14 }}
      >
        {Array.from({ length: size }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            {...tappableProps(() => input(n))}
            className="classic-btn"
            style={{ minWidth: 44, minHeight: 44, fontSize: 18, fontWeight: 700 }}
          >
            {n}
          </div>
        ))}
        <div
          {...tappableProps(() => input(0))}
          className="classic-btn"
          style={{ minWidth: 44, minHeight: 44 }}
        >
          消す
        </div>
      </div>

      {state.status === "won" ? (
        <EndScreen
          outcome="win"
          score={seconds}
          scoreLabel="クリアタイム（秒）"
          newBest={winResult?.newBest}
          previousBest={winResult && !winResult.newBest ? winResult.prevBest : undefined}
          onRetry={() => restart(size)}
        >
          <p className="muted">
            {size}×{size} ・ {state.moves} 手でクリア
          </p>
        </EndScreen>
      ) : null}
    </>
  );
}
