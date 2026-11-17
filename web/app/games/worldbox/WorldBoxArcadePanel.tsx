"use client";
// AGO WORLD BOX のアーケード筐体パネル（ロビー 2F/3F の筐体専用、L4/L4b）。
// カジノのスロット台と同じく、ゲームページへは飛ばず WORLD BOX の中（ステージ
// 上の筐体画面）でそのまま遊ぶ。見た目は「ダークな筐体の枠＋明色の画面」で、
// 画面の中はゲーム本体の本来の配色（明色テーマ）のままにする（白文字化の防止）。
// ゲーム本体は各ゲームのクライアント部品
// （OnlineShell の枠組み、ルーム作成/参加・待機ロビー・対戦・チャットまで一式）を
// arcade-clients.tsx から遅延読み込みしてこの画面に埋め込む。プレイヤーは
// 筐体の前に立ったまま（プレゼンスも継続する）で、閉じればすぐワールドに戻る。
import { getWebGame } from "@/lib/games-catalog";
import { playWbSe } from "@/lib/worldbox/sound";
import { arcadeClientFor } from "./arcade-clients";

const wrap: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(920px, calc(100% - 16px))", height: "calc(100% - 16px)",
  display: "flex", flexDirection: "column",
  boxSizing: "border-box", borderRadius: 14, overflow: "hidden",
  background: "rgba(12,14,22,0.97)", color: "#fff", zIndex: 6,
  boxShadow: "0 10px 32px rgba(0,0,0,0.5)",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
  borderBottom: "1px solid rgba(255,255,255,0.14)", flex: "0 0 auto",
};
// ゲーム本体は明色テーマ前提の部品（文字色を継承に頼る箇所が多い）なので、
// 筐体のダークな枠（color:#fff）をそのまま継がせると白いカード類の上で
// 白文字になって読めない。そこで本体は「筐体の画面」として明色の面に
// サイト標準の文字色で描く（枠だけ WORLD BOX のダーク基調にする）。
const body: React.CSSProperties = {
  flex: "1 1 auto", minHeight: 0, overflowY: "auto",
  margin: "10px 12px 12px", padding: "12px 14px 14px", borderRadius: 12,
  background: "var(--bg)", color: "var(--text)",
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 2px 10px rgba(0,0,0,0.45)",
};
const btn: React.CSSProperties = {
  minHeight: 36, padding: "4px 14px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)", color: "#fff", fontSize: 14, cursor: "pointer",
};

export default function WorldBoxArcadePanel({
  gameId,
  onClose,
}: {
  gameId: string;
  onClose: () => void;
}) {
  const game = getWebGame(gameId);
  const title = game?.title ?? gameId;
  const Client = arcadeClientFor(gameId);
  return (
    <div style={wrap} role="dialog" aria-label={`${title} の筐体`} className="wb-panel" data-wb-se="self">
      <div style={header}>
        <h3 style={{ margin: 0, fontSize: 17 }}>{title}</h3>
        {game?.players && <span style={{ fontSize: 12, opacity: 0.75 }}>{game.players}</span>}
        <button type="button" style={{ ...btn, marginLeft: "auto" }} onClick={() => { playWbSe("click"); onClose(); }}>
          閉じる
        </button>
      </div>
      <div style={body}>
        {Client ? <Client /> : <p style={{ margin: 0, fontSize: 14, opacity: 0.75 }}>この筐体は準備中です。</p>}
      </div>
    </div>
  );
}
