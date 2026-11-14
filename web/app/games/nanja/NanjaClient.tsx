"use client";
// ナンジャモンジャ風オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約: 山札は deckCount のみ（中身は秘匿）。名前は覚えることが
// 勝負なので対局中は配られず（named で命名済みかどうかだけ分かる）、
// 終了時に names へ開示される。場の山・獲得枚数は公開。
// アクションは { type: "flip" } / { type: "name", name } / { type: "shout", name }。
// めくった人が初めての生き物に名前を付け（30秒制限）、名前のある生き物が
// 再び出たら全員が名前を叫んで早い者勝ちで山をもらう。
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { playSe } from "@/lib/balku-sound";

const NanjaScene3D = dynamic(() => import("./NanjaScene3D"), { ssr: false });
import OnlineShell from "../online/OnlineShell";
import type { OnlineRoomApi, OnlineRoomView } from "../online/useOnlineRoom";

type NanjaEvent =
  | { type: "flip"; seat: number; creature: number }
  | { type: "named"; seat: number; creature: number; name: string; auto: boolean }
  | { type: "won"; seat: number; creature: number; name: string; count: number }
  | { type: "wrong"; seat: number }
  | { type: "dead" }
  | { type: "left"; seat: number };

type NanjaStanding = {
  seat: number;
  name: string;
  captured: number;
  rank: number;
  left: boolean;
};

type NanjaState = {
  players: { seat: number; name: string }[];
  deckCount: number;
  pile: number[];
  pileCount: number;
  top: number | null;
  /** 対局中は全て null（秘匿）。終了時にだけ名前が開示される。 */
  names: (string | null)[];
  /** 命名済みかどうか（対局中も分かる）。 */
  named: boolean[];
  namedBy: (number | null)[];
  current: number;
  lastFlipper: number | null;
  phase: "flip" | "naming" | "shout" | "finished";
  namingSeat: number | null;
  namingCreature: number | null;
  namingEndsAt: number | null;
  /** flip / shout フェーズの締切。それ以外のフェーズは null。 */
  phaseEndsAt: number | null;
  shoutLocked: boolean[];
  captured: number[];
  leftSeats: number[];
  lastEvent: NanjaEvent | null;
  winners: number[] | null;
  standings: NanjaStanding[] | null;
  finished: boolean;
};

/** lib/online/games/nanja.ts の NANJA_CREATURES と同じ並び（表示専用に複製）。 */
const CREATURES: { color: string; colorName: string; shape: string; shapeName: string; kana: string; label: string }[] = [
  { color: "#d93a3a", colorName: "あか", shape: "circle", shapeName: "丸", kana: "ア", label: "あか丸のア" },
  { color: "#d93a3a", colorName: "あか", shape: "triangle", shapeName: "三角", kana: "イ", label: "あか三角のイ" },
  { color: "#d93a3a", colorName: "あか", shape: "square", shapeName: "四角", kana: "ウ", label: "あか四角のウ" },
  { color: "#d93a3a", colorName: "あか", shape: "star", shapeName: "星", kana: "エ", label: "あか星のエ" },
  { color: "#d93a3a", colorName: "あか", shape: "diamond", shapeName: "菱形", kana: "オ", label: "あか菱形のオ" },
  { color: "#2f6fd0", colorName: "あお", shape: "circle", shapeName: "丸", kana: "カ", label: "あお丸のカ" },
  { color: "#2f6fd0", colorName: "あお", shape: "triangle", shapeName: "三角", kana: "キ", label: "あお三角のキ" },
  { color: "#2f6fd0", colorName: "あお", shape: "square", shapeName: "四角", kana: "ク", label: "あお四角のク" },
  { color: "#2f6fd0", colorName: "あお", shape: "star", shapeName: "星", kana: "ケ", label: "あお星のケ" },
  { color: "#2f6fd0", colorName: "あお", shape: "diamond", shapeName: "菱形", kana: "コ", label: "あお菱形のコ" },
  { color: "#2f9e5f", colorName: "みどり", shape: "circle", shapeName: "丸", kana: "サ", label: "みどり丸のサ" },
  { color: "#2f9e5f", colorName: "みどり", shape: "triangle", shapeName: "三角", kana: "シ", label: "みどり三角のシ" },
  { color: "#2f9e5f", colorName: "みどり", shape: "square", shapeName: "四角", kana: "ス", label: "みどり四角のス" },
  { color: "#2f9e5f", colorName: "みどり", shape: "star", shapeName: "星", kana: "セ", label: "みどり星のセ" },
  { color: "#2f9e5f", colorName: "みどり", shape: "diamond", shapeName: "菱形", kana: "ソ", label: "みどり菱形のソ" },
  { color: "#e0aa00", colorName: "きいろ", shape: "circle", shapeName: "丸", kana: "タ", label: "きいろ丸のタ" },
  { color: "#e0aa00", colorName: "きいろ", shape: "triangle", shapeName: "三角", kana: "チ", label: "きいろ三角のチ" },
  { color: "#e0aa00", colorName: "きいろ", shape: "square", shapeName: "四角", kana: "ツ", label: "きいろ四角のツ" },
  { color: "#e0aa00", colorName: "きいろ", shape: "star", shapeName: "星", kana: "テ", label: "きいろ星のテ" },
  { color: "#e0aa00", colorName: "きいろ", shape: "diamond", shapeName: "菱形", kana: "ト", label: "きいろ菱形のト" },
  { color: "#ef7d1a", colorName: "オレンジ", shape: "circle", shapeName: "丸", kana: "ナ", label: "オレンジ丸のナ" },
  { color: "#ef7d1a", colorName: "オレンジ", shape: "triangle", shapeName: "三角", kana: "ニ", label: "オレンジ三角のニ" },
  { color: "#ef7d1a", colorName: "オレンジ", shape: "square", shapeName: "四角", kana: "ヌ", label: "オレンジ四角のヌ" },
  { color: "#ef7d1a", colorName: "オレンジ", shape: "star", shapeName: "星", kana: "ネ", label: "オレンジ星のネ" },
  { color: "#ef7d1a", colorName: "オレンジ", shape: "diamond", shapeName: "菱形", kana: "ノ", label: "オレンジ菱形のノ" },
  { color: "#8b4fc0", colorName: "むらさき", shape: "circle", shapeName: "丸", kana: "ハ", label: "むらさき丸のハ" },
  { color: "#8b4fc0", colorName: "むらさき", shape: "triangle", shapeName: "三角", kana: "ヒ", label: "むらさき三角のヒ" },
  { color: "#8b4fc0", colorName: "むらさき", shape: "square", shapeName: "四角", kana: "フ", label: "むらさき四角のフ" },
  { color: "#8b4fc0", colorName: "むらさき", shape: "star", shapeName: "星", kana: "ヘ", label: "むらさき星のヘ" },
  { color: "#8b4fc0", colorName: "むらさき", shape: "diamond", shapeName: "菱形", kana: "ホ", label: "むらさき菱形のホ" },
];

function creatureLabel(id: number): string {
  return CREATURES[id]?.label ?? "ふめいの生き物";
}

/** 色の明るさから、中央に重ねるカナの文字色を決める。 */
function kanaColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? "#333333" : "#ffffff";
}

const STAR_POINTS = Array.from({ length: 10 }, (_, i) => {
  const angle = ((i * 36 - 90) * Math.PI) / 180;
  const r = i % 2 === 0 ? 42 : 17;
  return `${(50 + r * Math.cos(angle)).toFixed(1)},${(50 + r * Math.sin(angle)).toFixed(1)}`;
}).join(" ");

/** 生き物の図形バッジ（色×形の図形＋中央に頭文字カナ）。 */
function CreatureBadge({ id, size }: { id: number; size: number }) {
  const c = CREATURES[id];
  if (!c) return null;
  const shape =
    c.shape === "circle" ? (
      <circle cx="50" cy="50" r="40" fill={c.color} />
    ) : c.shape === "triangle" ? (
      <polygon points="50,12 88,80 12,80" fill={c.color} />
    ) : c.shape === "square" ? (
      <rect x="14" y="14" width="72" height="72" rx="8" fill={c.color} />
    ) : c.shape === "star" ? (
      <polygon points={STAR_POINTS} fill={c.color} />
    ) : (
      <polygon points="50,8 90,50 50,92 10,50" fill={c.color} />
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={c.label}
      style={{ display: "block" }}
    >
      {shape}
      <text
        x="50"
        y="51"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="32"
        fontWeight="800"
        fill={kanaColor(c.color)}
      >
        {c.kana}
      </text>
    </svg>
  );
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as NanjaState | null;
  const mySeat = view.player.seat;
  const [nameInput, setNameInput] = useState("");
  const [shoutInput, setShoutInput] = useState("");
  const [webglFailed, setWebglFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // フェーズ締切のカウントダウン表示用（命名・めくる番・叫ぶ）。
  useEffect(() => {
    if (state?.phase !== "naming" && state?.phase !== "flip" && state?.phase !== "shout") return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [state?.phase, state?.namingEndsAt, state?.phaseEndsAt]);

  useEffect(() => {
    setShoutInput("");
  }, [state?.pileCount, state?.phase]);

  const turnRef = useRef<boolean>(false);
  useEffect(() => {
    if (!state || state.finished) return;
    const isMine =
      (state.phase === "flip" && state.current === mySeat) ||
      (state.phase === "naming" && state.namingSeat === mySeat);
    const was = turnRef.current;
    turnRef.current = isMine;
    if (!was && isMine) playSe("turn");
  }, [state, mySeat]);

  const finishRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state || !state.finished) return;
    if (finishRef.current === view.code) return;
    finishRef.current = view.code;
    playSe(state.winners?.includes(mySeat) ? "win" : "click");
  }, [state, mySeat, view.code]);

  if (!state) return <p className="og-muted">盤面を待っています…</p>;

  const nameOf = (seat: number | null) =>
    seat === null
      ? "—"
      : state.players.find((p) => p.seat === seat)?.name ?? `プレイヤー${seat + 1}`;
  const top = state.top;
  const myLocked = state.shoutLocked[mySeat] ?? false;
  const namingLeftSec =
    state.namingEndsAt !== null
      ? Math.max(0, Math.ceil((state.namingEndsAt - nowMs) / 1000))
      : null;
  const phaseLeftSec =
    state.phaseEndsAt !== null
      ? Math.max(0, Math.ceil((state.phaseEndsAt - nowMs) / 1000))
      : null;

  const eventText = (ev: NanjaEvent | null): string => {
    if (!ev) return "";
    switch (ev.type) {
      case "flip":
        return `${nameOf(ev.seat)} がカードをめくりました。`;
      case "named":
        return `${nameOf(ev.seat)} が ${creatureLabel(ev.creature)} に「${ev.name}」と名付けました${ev.auto ? "（時間切れの自動名）" : ""}。`;
      case "won":
        return `${nameOf(ev.seat)} が「${ev.name}」と叫んで正解！ 山の ${ev.count} 枚をゲット。`;
      case "wrong":
        return `${nameOf(ev.seat)} の叫びはハズレ。この山ではもう叫べません。`;
      case "dead":
        return "全員ハズレで、この山は流れました。";
      case "left":
        return `${nameOf(ev.seat)} が退出しました。`;
      default:
        return "";
    }
  };

  const banner = state.finished
    ? `結果: ${(state.winners ?? []).map((s) => nameOf(s)).join("・") || "—"} の勝ち`
    : state.phase === "flip"
      ? state.current === mySeat
        ? "あなたの番です。カードをめくってください。"
        : `${nameOf(state.current)} の番です。`
      : state.phase === "naming"
        ? state.namingSeat === mySeat
          ? "初めての生き物！ 名前を付けてください。"
          : `${nameOf(state.namingSeat)} が名前を考え中…`
        : "名前のある生き物が出た！ 名前を叫んだ人が山をもらえます。";

  const isMyActionTurn =
    !state.finished &&
    ((state.phase === "flip" && state.current === mySeat) || (state.phase === "naming" && state.namingSeat === mySeat));

  const canFlip = !state.finished && state.phase === "flip" && state.current === mySeat;
  const doFlip = () => {
    playSe("play");
    void api.move({ type: "flip" });
  };

  const board2d = (
      <div
        style={{
          display: "flex",
          gap: 24,
          justifyContent: "center",
          alignItems: "center",
          margin: "10px 0",
          flexWrap: "wrap",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div
            key={`${state.pileCount}-${top ?? "empty"}`}
            className={top !== null ? "juice-flip" : undefined}
            role="img"
            aria-label={top !== null ? `場の山の一番上 ${creatureLabel(top)}` : "場の山は空です"}
            style={{
              display: "grid",
              placeItems: "center",
              width: 120,
              height: 120,
              borderRadius: 16,
              border: "3px solid #c9b489",
              background: "#fffdf6",
              fontSize: 56,
              lineHeight: 1,
            }}
          >
            {top !== null ? <CreatureBadge id={top} size={104} /> : "・"}
          </div>
          <p className="og-muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
            場の山 {state.pileCount} 枚
          </p>
        </div>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              display: "grid",
              placeItems: "center",
              width: 84,
              height: 120,
              borderRadius: 12,
              border: "2px solid #8a7a55",
              background: "repeating-linear-gradient(45deg,#f3ead8,#f3ead8 6px,#e9dcbf 6px,#e9dcbf 12px)",
              fontSize: 30,
            }}
            role="img"
            aria-label={`山札 残り ${state.deckCount} 枚`}
          >
            <svg width="36" height="36" viewBox="0 0 100 100" aria-hidden="true">
              <polygon points={STAR_POINTS} fill="#8a7a55" />
            </svg>
          </div>
          <p className="og-muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
            山札 残り {state.deckCount} 枚
          </p>
        </div>
      </div>
  );

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${state.finished ? " juice-slide" : " og-turn-mine"}${isMyActionTurn ? " juice-pulse" : ""}`} role="status">
        {banner}
      </div>

      <div className="og-score-row">
        {state.players.map((p) => (
          <span key={p.seat} className="og-score">
            {p.name}
            {p.seat === mySeat ? "（あなた）" : ""}
            {state.leftSeats.includes(p.seat) ? "（退出）" : ""} ・ {state.captured[p.seat] ?? 0} 枚
            {!state.finished && state.phase === "flip" && state.current === p.seat ? " ・ 手番" : ""}
          </span>
        ))}
      </div>

      {webglFailed ? board2d : (
        <div style={{ margin: "10px 0" }}>
          <NanjaScene3D
            top={top}
            pile={state.pile}
            pileCount={state.pileCount}
            deckCount={state.deckCount}
            canFlip={canFlip}
            onFlip={doFlip}
            onFail={() => setWebglFailed(true)}
            fallback={board2d}
          />
        </div>
      )}

      {state.pileCount > 1 && (
        <div
          style={{ display: "flex", justifyContent: "center", gap: 4, margin: "2px 0", flexWrap: "wrap" }}
          role="img"
          aria-label="場の山の履歴"
        >
          {state.pile.slice(-8).map((c, i) => (
            <CreatureBadge key={i} id={c} size={26} />
          ))}
        </div>
      )}

      {state.lastEvent && (
        <p key={`${state.pileCount}-${state.phase}-${eventText(state.lastEvent)}`} className="og-muted juice-pop" style={{ textAlign: "center" }} role="status">
          {eventText(state.lastEvent)}
        </p>
      )}

      {!state.finished && state.phase === "flip" && phaseLeftSec !== null && (
        <p className="og-muted" style={{ textAlign: "center", fontSize: 13 }}>
          あと {phaseLeftSec} 秒で、自動的にカードがめくられます。
        </p>
      )}
      {!state.finished && state.phase === "shout" && phaseLeftSec !== null && (
        <p className="og-muted" style={{ textAlign: "center", fontSize: 13 }}>
          あと {phaseLeftSec} 秒で、この山は流れます。
        </p>
      )}

      {!state.finished && state.phase === "flip" && state.current === mySeat && (
        <div style={{ display: "flex", justifyContent: "center", margin: "10px 0" }}>
          <button
            type="button"
            className="classic-btn"
            style={{ minWidth: 200, fontWeight: 700 }}
            onClick={doFlip}
          >
            カードをめくる
          </button>
        </div>
      )}

      {!state.finished && state.phase === "naming" && state.namingSeat === mySeat && (
        <form
          style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", margin: "10px 0" }}
          onSubmit={(e) => {
            e.preventDefault();
            const name = nameInput.trim();
            if (!name) return;
            playSe("click");
            setNameInput("");
            void api.move({ type: "name", name });
          }}
        >
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="名前（12文字まで）"
            maxLength={24}
            aria-label="生き物の名前"
            style={{
              minHeight: 44,
              padding: "0 12px",
              borderRadius: 8,
              border: "1px solid var(--line)",
              fontSize: 16,
              minWidth: 220,
            }}
          />
          <button type="submit" className="classic-btn" style={{ fontWeight: 700 }}>
            名前をつける{namingLeftSec !== null ? `（あと ${namingLeftSec} 秒）` : ""}
          </button>
        </form>
      )}
      {!state.finished && state.phase === "naming" && state.namingSeat !== mySeat && (
        <p className="og-muted" style={{ textAlign: "center" }}>
          命名の制限時間: あと {namingLeftSec ?? "—"} 秒（過ぎると自動で名前が付きます）
        </p>
      )}

      {!state.finished && state.phase === "shout" && (
        <form
          style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap", margin: "10px 0" }}
          onSubmit={(e) => {
            e.preventDefault();
            const name = shoutInput.trim();
            if (!name) return;
            playSe("play");
            setShoutInput("");
            void api.move({ type: "shout", name });
          }}
        >
          <input
            type="text"
            value={shoutInput}
            onChange={(e) => setShoutInput(e.target.value)}
            placeholder="名前を入力して叫ぶ！"
            aria-label="叫ぶ名前"
            disabled={myLocked}
            style={{
              minHeight: 44,
              padding: "0 12px",
              borderRadius: 8,
              border: "1px solid var(--line)",
              fontSize: 16,
              minWidth: 220,
            }}
          />
          <button type="submit" className="classic-btn" style={{ fontWeight: 700 }} disabled={myLocked}>
            叫ぶ！
          </button>
          {myLocked && (
            <p className="og-muted" style={{ width: "100%", textAlign: "center", margin: 0 }}>
              あなたはこの山ではハズレ済みです。次の山をお待ちください。
            </p>
          )}
        </form>
      )}

      {state.finished && state.standings && (
        <div className="juice-slide" style={{ maxWidth: 420, margin: "10px auto" }}>
          {state.standings.map((s) => (
            <div
              key={s.seat}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "6px 10px",
                borderTop: "1px solid var(--line)",
                fontWeight: s.rank === 1 ? 800 : 400,
              }}
            >
              <span>
                {s.rank} 位 ・ {s.name}
                {s.seat === mySeat ? "（あなた）" : ""}
                {s.left ? "（退出）" : ""}
              </span>
              <span>{s.captured} 枚</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ maxWidth: 560, margin: "12px auto 0" }}>
        <p className="og-muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
          生き物の一覧（名前は覚えるのが勝負なので、対局中は伏せられます）
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 6,
          }}
        >
          {CREATURES.map((c, id) => {
            const isNamed = state.named[id] ?? false;
            const revealed = state.finished ? state.names[id] : null;
            return (
              <div
                key={id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  background: isNamed ? "#fffdf6" : "transparent",
                  opacity: isNamed ? 1 : 0.55,
                }}
              >
                <CreatureBadge id={id} size={38} />
                <span style={{ fontSize: 13 }}>
                  {revealed ? (
                    <>
                      <strong>{revealed}</strong>
                      <br />
                      <span className="og-muted" style={{ fontSize: 11 }}>
                        名付け: {nameOf(state.namedBy[id])}
                      </span>
                    </>
                  ) : isNamed ? (
                    <>
                      命名済み
                      <br />
                      <span className="og-muted" style={{ fontSize: 11 }}>
                        名付け: {nameOf(state.namedBy[id])}
                      </span>
                    </>
                  ) : (
                    c.label
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="og-muted" style={{ textAlign: "center", fontSize: 13 }}>
        初めて出た生き物には、めくった人が名前を付けます。名前のある生き物が再び出たら、
        名前を最初に正しく叫んだ人が場の山を全部もらえます。ハズレたらその山では叫べません。
        名前は対局中は一覧に表示されません。終了時に全ての名前が公開されます。
      </p>
    </div>
  );
}

export default function NanjaClient() {
  return (
    <OnlineShell gameId="nanja" title="ナンジャモンジャ風" playerRange={{ min: 2, max: 6 }}>
      {(view, api) => <Board view={view} api={api} />}
    </OnlineShell>
  );
}
