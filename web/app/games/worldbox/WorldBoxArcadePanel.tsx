"use client";
// AGO WORLD BOX のアーケード筐体パネル（ロビー 2F/3F の筐体専用、L4/L4b）。
// カジノのスロット台と同じく、ゲームページへは飛ばず WORLD BOX の中（ステージ
// 上の筐体画面）でそのまま遊ぶ。ゲーム本体は各ゲームのクライアント部品
// （OnlineShell の枠組み、ルーム作成/参加・待機ロビー・対戦・チャットまで一式）を
// arcade-clients.tsx から遅延読み込みしてこの画面に埋め込む。プレイヤーは
// 筐体の前に立ったまま（プレゼンスも継続する）で、閉じればすぐワールドに戻る。
import { getWebGame } from "@/lib/games-catalog";
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
const body: React.CSSProperties = {
  flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "10px 12px 14px",
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
    <div style={wrap} role="dialog" aria-label={`${title} の筐体`}>
      <div style={header}>
        <h3 style={{ margin: 0, fontSize: 17 }}>{title}</h3>
        {game?.players && <span style={{ fontSize: 12, opacity: 0.75 }}>{game.players}</span>}
        <button type="button" style={{ ...btn, marginLeft: "auto" }} onClick={onClose}>
          閉じる
        </button>
      </div>
      <div style={body}>
        {Client ? <Client /> : <p style={{ margin: 0, fontSize: 14, opacity: 0.75 }}>この筐体は準備中です。</p>}
      </div>
    </div>
  );
}
