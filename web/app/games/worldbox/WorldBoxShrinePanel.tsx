"use client";
import { useState } from "react";
import { LOBBY_SECRET_ROOMS } from "@/lib/worldbox/lobby";
import { playWbSe } from "@/lib/worldbox/sound";
import type { FortuneRecord, LobbyDiscoveryState } from "@/lib/worldbox/lobby-discovery";

const FORTUNE_TIERS: readonly {
  rank: string;
  color: string;
  weight: number;
  messages: readonly string[];
}[] = [
  {
    rank: "超大吉",
    color: "#ffd84d",
    weight: 6,
    messages: [
      "隠されし扉が次々と開く奇跡の日。デパートの迷宮があなたを歓迎している。",
      "星々と精霊の祝福が揃い、秘宝の金庫さえも自ら口を開く兆し。",
    ],
  },
  {
    rank: "大吉",
    color: "#ff8c5a",
    weight: 18,
    messages: [
      "思いがけない裏通路から素晴らしい発見あり。隅のタペストリーに注意。",
      "縁日の射的もカジノの風も追い風。迷ったら東の棟へ足を伸ばそう。",
    ],
  },
  {
    rank: "中吉",
    color: "#7be495",
    weight: 26,
    messages: [
      "地図に描かれていない壁の向こうに近道が眠る。焦らず散策すると吉。",
      "古い本棚や生垣の切れ目を見つめれば、新たな景色が広がる。",
    ],
  },
  {
    rank: "小吉",
    color: "#78c8ff",
    weight: 22,
    messages: [
      "スタンプを集めて歩くほど運気が上向く。まずは館内の案内デスクを巡ろう。",
      "音楽に耳を澄ませれば心も軽やか。地下モールの音響が福を呼ぶ。",
    ],
  },
  {
    rank: "吉",
    color: "#d6d9e6",
    weight: 16,
    messages: [
      "平穏で心地よい冒険日和。噴水に小銭を投げて一息つくのがおすすめ。",
      "仲間と語らいながら歩けば、見落としていた名所が見つかるはず。",
    ],
  },
  {
    rank: "末吉",
    color: "#b7b4c9",
    weight: 8,
    messages: [
      "今は準備と観察のとき。博物館で知識を蓄えてから謎解きに挑むと良い。",
      "急がば回れ。迷路の突き当たりこそ、よく確かめてみよう。",
    ],
  },
  {
    rank: "凶",
    color: "#f26b7a",
    weight: 4,
    messages: [
      "射的の爆弾的と壁の角に注意。おみくじを結んで厄を払えば一転して吉！",
      "迷いやすい相。総合案内のフロアマップで現在地を確かめよう。",
    ],
  },
];

const LUCKY_ITEMS = [
  "古い真鍮の鍵",
  "星屑のランタン",
  "紅白の縁日お面",
  "アクアマリン片",
  "地下モールの切符",
  "アンティーク羅針盤",
  "金のコルク栓",
];

const LUCKY_DIRS = ["北東の迷路", "東回廊の中庭", "南東の展望幕", "地下の裏通り", "大水槽の北"];

function pickWeightedFortune(discoveredSecretIds: readonly string[]): FortuneRecord {
  const total = FORTUNE_TIERS.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  let chosen = FORTUNE_TIERS[0];
  for (const tier of FORTUNE_TIERS) {
    r -= tier.weight;
    if (r <= 0) {
      chosen = tier;
      break;
    }
  }
  const undiscovered = LOBBY_SECRET_ROOMS.filter((room) => !discoveredSecretIds.includes(room.id));
  const pool = undiscovered.length > 0 ? undiscovered : LOBBY_SECRET_ROOMS;
  const whisperRoom = pool[Math.floor(Math.random() * pool.length)];
  return {
    rank: chosen.rank,
    message: chosen.messages[Math.floor(Math.random() * chosen.messages.length)],
    luckyItem: LUCKY_ITEMS[Math.floor(Math.random() * LUCKY_ITEMS.length)],
    luckyDir: LUCKY_DIRS[Math.floor(Math.random() * LUCKY_DIRS.length)],
    secretWhisper: whisperRoom.riddle,
  };
}

const wrap: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(480px, calc(100% - 20px))",
  maxHeight: "calc(100% - 24px)",
  overflowY: "auto",
  padding: 14,
  borderRadius: 14,
  background: "rgba(12,14,22,0.95)",
  border: "1px solid rgba(255,210,120,0.3)",
  color: "#f5f4f8",
  zIndex: 6,
  boxShadow: "0 14px 40px rgba(0,0,0,0.6)",
  boxSizing: "border-box",
};

const btn: React.CSSProperties = {
  minHeight: 36,
  padding: "6px 14px",
  borderRadius: 9,
  border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.1)",
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
};

export default function WorldBoxShrinePanel({
  discovery,
  onDrawFortune,
  onTieFortune,
  onClose,
}: {
  discovery: LobbyDiscoveryState;
  onDrawFortune: (fortune: FortuneRecord) => void;
  onTieFortune: () => void;
  onClose: () => void;
}) {
  const [shaking, setShaking] = useState(false);

  const handleDraw = () => {
    if (shaking) return;
    setShaking(true);
    playWbSe("click");
    window.setTimeout(() => {
      const f = pickWeightedFortune(discovery.secretRooms);
      onDrawFortune(f);
      playWbSe(f.rank === "超大吉" || f.rank === "大吉" ? "success" : "coin");
      setShaking(false);
    }, 380);
  };

  const fortune = discovery.lastFortune;
  const tierColor = FORTUNE_TIERS.find((t) => t.rank === fortune?.rank)?.color ?? "#ffd84d";

  return (
    <div style={wrap} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>⛩️ おみくじ神社・占いの祠</strong>
        <span style={{ fontSize: 12, color: "#c9c4b0" }}>累計 {discovery.fortuneCount} 回</span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>
          閉じる
        </button>
      </div>

      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#cfcfe0", lineHeight: 1.55 }}>
        祠の御神籤を引くと今日の運勢とともに、まだ見ぬ<strong>秘密の部屋</strong>
        に関する神託が授けられます。
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={handleDraw}
          disabled={shaking}
          style={{
            ...btn,
            flex: 1,
            background: shaking
              ? "rgba(255,210,90,0.22)"
              : "linear-gradient(135deg, rgba(220,90,70,0.85), rgba(185,55,55,0.9))",
            borderColor: "rgba(255,200,150,0.45)",
            fontWeight: 700,
          }}
        >
          {shaking ? "御神籤を振っています…" : "🎍 おみくじを引く"}
        </button>
        {fortune && !fortune.tied && (
          <button
            type="button"
            onClick={() => {
              playWbSe("open");
              onTieFortune();
            }}
            style={btn}
          >
            🎀 おみくじを結ぶ
          </button>
        )}
      </div>

      {fortune && (
        <div
          style={{
            padding: 12,
            borderRadius: 10,
            background: "rgba(255,255,255,0.06)",
            border: `1px solid ${tierColor}55`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span
              style={{
                fontSize: 20,
                fontWeight: 800,
                color: tierColor,
                letterSpacing: "0.08em",
              }}
            >
              {fortune.rank}
            </span>
            {fortune.tied && (
              <span
                style={{
                  fontSize: 11,
                  padding: "2px 8px",
                  borderRadius: 99,
                  background: "rgba(120,220,160,0.18)",
                  color: "#8ef0b2",
                }}
              >
                奉納結び済み
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 8 }}>{fortune.message}</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              fontSize: 12,
              color: "#d4d8e8",
              marginBottom: 8,
            }}
          >
            <div>🔮 幸運の品：{fortune.luckyItem}</div>
            <div>🧭 吉方位：{fortune.luckyDir}</div>
          </div>
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(255,215,120,0.08)",
              border: "1px dashed rgba(255,215,120,0.3)",
              fontSize: 12,
              color: "#ffe49e",
              lineHeight: 1.5,
            }}
          >
            <strong>神託の囁き：</strong>
            {fortune.secretWhisper}
          </div>
        </div>
      )}
    </div>
  );
}
