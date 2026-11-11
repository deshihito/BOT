"use client";
// ナンジャモンジャ風オンライン対戦クライアント。盤面は OnlineShell の children で描く。
// view.state の契約: 山札は deckCount のみ（中身は秘匿）、場の山・名前・獲得枚数は公開。
// アクションは { type: "flip" } / { type: "name", name } / { type: "shout", name }。
// めくった人が初めての生き物に名前を付け（30秒制限）、名前のある生き物が
// 再び出たら全員が名前を叫んで早い者勝ちで山をもらう。
import { useEffect, useState } from "react";
import { playSe } from "@/lib/balku-sound";
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
  names: (string | null)[];
  namedBy: (number | null)[];
  current: number;
  lastFlipper: number | null;
  phase: "flip" | "naming" | "shout" | "finished";
  namingSeat: number | null;
  namingCreature: number | null;
  namingEndsAt: number | null;
  shoutLocked: boolean[];
  captured: number[];
  leftSeats: number[];
  lastEvent: NanjaEvent | null;
  winners: number[] | null;
  standings: NanjaStanding[] | null;
  finished: boolean;
};

/** lib/online/games/nanja.ts の NANJA_CREATURES と同じ並び（表示専用に複製）。 */
const CREATURES: { face: string; deco: string; label: string }[] = [
  { face: "🐶", deco: "🎩", label: "ぼうしのワンコ" },
  { face: "🐱", deco: "👑", label: "かんむりのネコ" },
  { face: "🐸", deco: "🎀", label: "リボンのカエル" },
  { face: "🐵", deco: "🕶️", label: "グラサンのサル" },
  { face: "🐷", deco: "🌸", label: "お花のブタ" },
  { face: "🐰", deco: "⭐", label: "星のウサギ" },
  { face: "🦊", deco: "🍀", label: "クローバーのキツネ" },
  { face: "🐻", deco: "🎈", label: "風船のクマ" },
  { face: "🐼", deco: "🍩", label: "ドーナツのパンダ" },
  { face: "🦁", deco: "🔔", label: "ベルのライオン" },
  { face: "🐨", deco: "🍎", label: "りんごのコアラ" },
  { face: "🦄", deco: "🌈", label: "虹のユニコーン" },
  { face: "🐙", deco: "🍓", label: "いちごのタコ" },
  { face: "🐥", deco: "🎧", label: "ヘッドホンのヒヨコ" },
  { face: "🐢", deco: "🌙", label: "お月さまのカメ" },
  { face: "🦉", deco: "🧣", label: "マフラーのフクロウ" },
  { face: "🐴", deco: "🍇", label: "ぶどうのウマ" },
  { face: "🐘", deco: "🍕", label: "ピザのゾウ" },
  { face: "🦒", deco: "❄️", label: "ゆきのキリン" },
  { face: "🐳", deco: "🧢", label: "キャップのクジラ" },
  { face: "🐭", deco: "🧀", label: "チーズのネズミ" },
  { face: "🐮", deco: "🍼", label: "ミルクのウシ" },
  { face: "🐯", deco: "🎸", label: "ギターのトラ" },
  { face: "🦩", deco: "💐", label: "花束のフラミンゴ" },
  { face: "🐧", deco: "🎿", label: "スキーのペンギン" },
  { face: "🦖", deco: "🍦", label: "アイスのキョウリュウ" },
  { face: "🐹", deco: "🌻", label: "ひまわりのハムスター" },
  { face: "🦓", deco: "🍉", label: "スイカのシマウマ" },
  { face: "🦢", deco: "💎", label: "宝石のハクチョウ" },
  { face: "🐌", deco: "🍃", label: "葉っぱのカタツムリ" },
];

function creatureFace(id: number): string {
  const c = CREATURES[id];
  return c ? `${c.face}${c.deco}` : "❓";
}

function Board({ view, api }: { view: OnlineRoomView; api: OnlineRoomApi }) {
  const state = view.state as NanjaState | null;
  const mySeat = view.player.seat;
  const [nameInput, setNameInput] = useState("");
  const [shoutInput, setShoutInput] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 命名カウントダウン表示用。
  useEffect(() => {
    if (state?.phase !== "naming") return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [state?.phase, state?.namingEndsAt]);

  useEffect(() => {
    setShoutInput("");
  }, [state?.pileCount, state?.phase]);

  if (!state) return <p className="og-muted">盤面を待っています…</p>;

  const nameOf = (seat: number | null) =>
    seat === null
      ? "—"
      : state.players.find((p) => p.seat === seat)?.name ?? `プレイヤー${seat + 1}`;
  const top = state.top;
  const topName = top !== null ? state.names[top] : null;
  const myLocked = state.shoutLocked[mySeat] ?? false;
  const namingLeftSec =
    state.namingEndsAt !== null
      ? Math.max(0, Math.ceil((state.namingEndsAt - nowMs) / 1000))
      : null;

  const eventText = (ev: NanjaEvent | null): string => {
    if (!ev) return "";
    switch (ev.type) {
      case "flip":
        return `${nameOf(ev.seat)} がカードをめくりました。`;
      case "named":
        return `${nameOf(ev.seat)} が ${creatureFace(ev.creature)} に「${ev.name}」と名付けました${ev.auto ? "（時間切れの自動名）" : ""}。`;
      case "won":
        return `🎉 ${nameOf(ev.seat)} が「${ev.name}」と叫んで正解！ 山の ${ev.count} 枚をゲット。`;
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
    ? `結果: ${(state.winners ?? []).map((s) => nameOf(s)).join("・") || "—"} の勝ち 🎉`
    : state.phase === "flip"
      ? state.current === mySeat
        ? "あなたの番です。カードをめくってください。"
        : `${nameOf(state.current)} の番です。`
      : state.phase === "naming"
        ? state.namingSeat === mySeat
          ? "初めての生き物！ 名前を付けてください。"
          : `${nameOf(state.namingSeat)} が名前を考え中…`
        : "名前のある生き物が出た！ 名前を叫んだ人が山をもらえます。";

  return (
    <div className="og-board-wrap">
      <div className={`og-turn-banner${state.finished ? "" : " og-turn-mine"}`} role="status">
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
            role="img"
            aria-label={top !== null ? `場の山の一番上 ${creatureFace(top)}` : "場の山は空です"}
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
            {top !== null ? creatureFace(top) : "・"}
          </div>
          <p className="og-muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
            場の山 {state.pileCount} 枚
            {top !== null && topName ? ` ・ 名前は「${topName}」` : ""}
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
            🂠
          </div>
          <p className="og-muted" style={{ margin: "4px 0 0", fontSize: 12 }}>
            山札 残り {state.deckCount} 枚
          </p>
        </div>
      </div>

      {state.pileCount > 1 && (
        <p style={{ textAlign: "center", fontSize: 22, margin: "2px 0" }} role="img" aria-label="場の山の履歴">
          {state.pile.slice(-8).map((c, i) => (
            <span key={i} style={{ marginRight: 4 }}>
              {creatureFace(c)}
            </span>
          ))}
        </p>
      )}

      {state.lastEvent && (
        <p className="og-muted" style={{ textAlign: "center" }} role="status">
          {eventText(state.lastEvent)}
        </p>
      )}

      {!state.finished && state.phase === "flip" && state.current === mySeat && (
        <div style={{ display: "flex", justifyContent: "center", margin: "10px 0" }}>
          <button
            type="button"
            className="classic-btn"
            style={{ minWidth: 200, fontWeight: 700 }}
            onClick={() => {
              playSe("play");
              void api.move({ type: "flip" });
            }}
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
        <div style={{ maxWidth: 420, margin: "10px auto" }}>
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
          生き物と名前の一覧
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 6,
          }}
        >
          {CREATURES.map((c, id) => (
            <div
              key={id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                border: "1px solid var(--line)",
                borderRadius: 8,
                background: state.names[id] ? "#fffdf6" : "transparent",
                opacity: state.names[id] ? 1 : 0.55,
              }}
            >
              <span style={{ fontSize: 24 }}>
                {c.face}
                {c.deco}
              </span>
              <span style={{ fontSize: 13 }}>
                {state.names[id] ? (
                  <>
                    <strong>{state.names[id]}</strong>
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
          ))}
        </div>
      </div>

      <p className="og-muted" style={{ textAlign: "center", fontSize: 13 }}>
        初めて出た生き物には、めくった人が名前を付けます。名前のある生き物が再び出たら、
        名前を最初に正しく叫んだ人が場の山を全部もらえます。ハズレたらその山では叫べません。
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
