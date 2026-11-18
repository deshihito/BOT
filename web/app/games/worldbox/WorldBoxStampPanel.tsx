"use client";
import { useState } from "react";
import {
  LOBBY_DISTRICTS,
  LOBBY_H,
  LOBBY_SECRET_ROOMS,
  LOBBY_W,
  lobbyDistrictAt,
  lobbySecretRoomAt,
} from "@/lib/worldbox/lobby";
import { discoveryRank, type LobbyDiscoveryState } from "@/lib/worldbox/lobby-discovery";

const wrap: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(640px, calc(100% - 16px))",
  maxHeight: "calc(100% - 20px)",
  overflowY: "auto",
  padding: 14,
  borderRadius: 14,
  background: "rgba(10,12,20,0.96)",
  border: "1px solid rgba(255,215,110,0.35)",
  color: "#f4f5fa",
  zIndex: 6,
  boxShadow: "0 16px 44px rgba(0,0,0,0.65)",
  boxSizing: "border-box",
};

const btn: React.CSSProperties = {
  minHeight: 34,
  padding: "4px 12px",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)",
  color: "#fff",
  fontSize: 12,
  cursor: "pointer",
};

export default function WorldBoxStampPanel({
  discovery,
  playerPos,
  onClose,
}: {
  discovery: LobbyDiscoveryState;
  playerPos: { x: number; y: number };
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"map" | "stamps" | "secrets">("map");
  const rank = discoveryRank(discovery);
  const currentDistrict = lobbyDistrictAt(playerPos.x, playerPos.y);
  const currentSecret = lobbySecretRoomAt(playerPos.x, playerPos.y);

  return (
    <div style={wrap} className="wb-panel">
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}
      >
        <strong style={{ fontSize: 15 }}>🧭 デパート総合案内・館内マップ＆スタンプ帳</strong>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 99,
            background: "rgba(255,215,100,0.16)",
            border: "1px solid rgba(255,215,100,0.38)",
            color: "#ffe084",
            fontWeight: 700,
          }}
        >
          {rank.badge} {rank.title} ({rank.progressPct}%)
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>
          閉じる
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          fontSize: 12,
          color: "#cbd4e8",
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <span>
          📍 現在地：
          <strong style={{ color: "#fff" }}>
            {currentSecret ? `${currentSecret.name}（秘密）` : currentDistrict}
          </strong>{" "}
          (X {Math.floor(playerPos.x)} / Y {Math.floor(playerPos.y)})
        </span>
        <span>
          🗺 地区{" "}
          <strong>
            {discovery.districts.length}/{LOBBY_DISTRICTS.length}
          </strong>
        </span>
        <span>
          🗝 秘密部屋{" "}
          <strong>
            {discovery.secretRooms.length}/{LOBBY_SECRET_ROOMS.length}
          </strong>
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {[
          { id: "map" as const, label: "🗺 館内フロアマップ" },
          {
            id: "stamps" as const,
            label: `🏅 探索スタンプ (${discovery.districts.length}/${LOBBY_DISTRICTS.length})`,
          },
          {
            id: "secrets" as const,
            label: `🗝 秘密部屋の手がかり (${discovery.secretRooms.length}/${LOBBY_SECRET_ROOMS.length})`,
          },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              ...btn,
              background: tab === t.id ? "rgba(255,200,80,0.28)" : "rgba(255,255,255,0.07)",
              borderColor: tab === t.id ? "#ffd86b" : "rgba(255,255,255,0.18)",
              fontWeight: tab === t.id ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "map" && (
        <div>
          <svg
            viewBox={`0 0 ${LOBBY_W} ${LOBBY_H}`}
            style={{
              width: "100%",
              height: "auto",
              borderRadius: 10,
              background: "#0b0d14",
              border: "1px solid rgba(255,255,255,0.18)",
              display: "block",
            }}
          >
            {/* 主要エリア概略 */}
            <rect
              x="2"
              y="4"
              width="57"
              height="44"
              rx="3"
              fill="#252c44"
              stroke="#475580"
              strokeWidth="0.6"
            />
            <rect
              x="60"
              y="4"
              width="66"
              height="44"
              rx="3"
              fill="#2a3529"
              stroke="#536e4f"
              strokeWidth="0.6"
            />
            <ellipse
              cx="93"
              cy="26"
              rx="28"
              ry="17"
              fill="none"
              stroke="#c8b470"
              strokeWidth="1.5"
              opacity="0.6"
            />
            <rect
              x="127"
              y="6"
              width="27"
              height="41"
              rx="2"
              fill="#2d293e"
              stroke="#625a82"
              strokeWidth="0.6"
            />
            <rect
              x="2"
              y="48"
              width="17"
              height="15"
              rx="2"
              fill="#3a2f4d"
              stroke="#8b71b8"
              strokeWidth="0.8"
            />
            <rect
              x="22"
              y="48"
              width="37"
              height="42"
              rx="3"
              fill="#223632"
              stroke="#48756a"
              strokeWidth="0.6"
            />
            <rect
              x="2"
              y="70"
              width="21"
              height="20"
              rx="2"
              fill="#203144"
              stroke="#4c749e"
              strokeWidth="0.6"
            />
            <rect
              x="59"
              y="49"
              width="95"
              height="41"
              rx="3"
              fill="#2b2b42"
              stroke="#5c5e8a"
              strokeWidth="0.6"
            />
            {/* 新ウィング群 */}
            <rect
              x="156"
              y="4"
              width="65"
              height="43"
              rx="3"
              fill="#3e2636"
              stroke="#8a4f74"
              strokeWidth="0.7"
            />
            <rect
              x="156"
              y="48"
              width="35"
              height="43"
              rx="3"
              fill="#383024"
              stroke="#8c7550"
              strokeWidth="0.7"
            />
            <rect
              x="192"
              y="48"
              width="29"
              height="53"
              rx="3"
              fill="#1e3848"
              stroke="#4c8ca8"
              strokeWidth="0.7"
            />
            <rect
              x="4"
              y="93"
              width="96"
              height="40"
              rx="3"
              fill="#262838"
              stroke="#565b7d"
              strokeWidth="0.7"
            />
            <rect
              x="101"
              y="93"
              width="90"
              height="40"
              rx="3"
              fill="#24223c"
              stroke="#625ca0"
              strokeWidth="0.7"
            />

            {/* 地区マーカー */}
            {LOBBY_DISTRICTS.map((d) => {
              const found = discovery.districts.includes(d.id);
              return (
                <g key={d.id}>
                  <circle
                    cx={d.cx}
                    cy={d.cy}
                    r={2.2}
                    fill={found ? "#78e8a8" : "#66708a"}
                    stroke="#0d111a"
                    strokeWidth="0.6"
                  />
                  <text
                    x={d.cx}
                    y={d.cy - 3.2}
                    textAnchor="middle"
                    fontSize="3.4"
                    fill={found ? "#e8fff0" : "#9aa5be"}
                  >
                    {d.name.slice(0, 6)}
                  </text>
                </g>
              );
            })}

            {/* 発見済みの秘密部屋 */}
            {LOBBY_SECRET_ROOMS.map((room) => {
              const found = discovery.secretRooms.includes(room.id);
              const [x0, y0, x1, y1] = room.bounds;
              if (!found) return null;
              return (
                <g key={room.id}>
                  <rect
                    x={x0}
                    y={y0}
                    width={x1 - x0 + 1}
                    height={y1 - y0 + 1}
                    rx="1.5"
                    fill="rgba(255,210,70,0.22)"
                    stroke="#ffd84d"
                    strokeWidth="0.9"
                  />
                  <text
                    x={room.cx}
                    y={room.cy + 1.5}
                    textAnchor="middle"
                    fontSize="3.2"
                    fill="#ffe89e"
                  >
                    ★{room.name.slice(0, 5)}
                  </text>
                </g>
              );
            })}

            {/* プレイヤー現在地 */}
            <circle cx={playerPos.x} cy={playerPos.y} r="3.4" fill="rgba(255,95,95,0.35)" />
            <circle
              cx={playerPos.x}
              cy={playerPos.y}
              r="1.9"
              fill="#ff5e6c"
              stroke="#fff"
              strokeWidth="0.7"
            />
          </svg>
          <div
            style={{
              display: "flex",
              gap: 14,
              fontSize: 11,
              color: "#b8c2d8",
              marginTop: 6,
              flexWrap: "wrap",
            }}
          >
            <span>🔴 現在地</span>
            <span>🟢 踏破済み地区</span>
            <span>★ 発見済み秘密部屋（未発見は非表示）</span>
            <span style={{ flex: 1 }} />
            <span>
              🎯射的最高 {discovery.bestShootingScore}点 / 🔐暗号解錠 {discovery.vaultClears}回
            </span>
          </div>
        </div>
      )}

      {tab === "stamps" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(185px, 1fr))",
            gap: 6,
          }}
        >
          {LOBBY_DISTRICTS.map((d) => {
            const ok = discovery.districts.includes(d.id);
            return (
              <div
                key={d.id}
                style={{
                  padding: "7px 9px",
                  borderRadius: 9,
                  background: ok ? "rgba(110,220,150,0.14)" : "rgba(255,255,255,0.04)",
                  border: ok
                    ? "1px solid rgba(110,220,150,0.45)"
                    : "1px solid rgba(255,255,255,0.12)",
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 700, color: ok ? "#9cf5be" : "#9aa4bc" }}>
                  {ok ? "✅ " : "⬜ "}
                  {d.name}
                </div>
                <div style={{ fontSize: 10, color: "#aab4ca", marginTop: 2 }}>{d.areaHint}</div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "secrets" && (
        <div style={{ display: "grid", gap: 8 }}>
          {LOBBY_SECRET_ROOMS.map((room, idx) => {
            const ok = discovery.secretRooms.includes(room.id);
            return (
              <div
                key={room.id}
                style={{
                  padding: "9px 11px",
                  borderRadius: 10,
                  background: ok ? "rgba(255,210,80,0.12)" : "rgba(255,255,255,0.05)",
                  border: ok
                    ? "1px solid rgba(255,210,80,0.45)"
                    : "1px dashed rgba(255,255,255,0.2)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <strong style={{ fontSize: 13, color: ok ? "#ffe07d" : "#c7cde0" }}>
                    {ok ? `🗝️ ${room.name}` : `❓ 秘密部屋 #${idx + 1}（未発見）`}
                  </strong>
                  {ok && <span style={{ fontSize: 11, color: "#a5f0be" }}>発見済み</span>}
                </div>
                <div style={{ fontSize: 12, color: "#dce2f2", lineHeight: 1.5 }}>
                  {ok ? room.hint : room.riddle}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
