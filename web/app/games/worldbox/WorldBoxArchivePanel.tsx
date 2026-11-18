"use client";
import { useState } from "react";
import { LOBBY_DISTRICTS, LOBBY_SECRET_ROOMS } from "@/lib/worldbox/lobby";
import { playWbSe } from "@/lib/worldbox/sound";
import type { LobbyDiscoveryState } from "@/lib/worldbox/lobby-discovery";

const EXHIBITS: readonly {
  id: string;
  title: string;
  era: string;
  body: string;
  note: string;
}[] = [
  {
    id: "grand_hall",
    title: "第一展示：中央噴水広場とデパート大拡張計画",
    era: "建築記・第一期〜第三期",
    body: "かつて中央広場とコロッセオ、鍛冶街だけだった小さな館は、東西南へ大きく枝分かれした迷宮型デパート＆テーマパークへと成長した。全20の個性豊かな地区がアーチ橋と吹抜アトリウムで立体的に結ばれている。",
    note: "建築メモ：壁一枚の向こう側に、図面に記されない保守通路が残されているという。",
  },
  {
    id: "secret_architecture",
    title: "第二展示：隠し通路の紋章と「透ける壁」の法則",
    era: "建築記・極秘設計図",
    body: "館内には6つの隠し部屋が存在する。偽装されたレンガ壁、抜けられる生垣、裏口のあるタペストリーや本棚は、近づくことでその輪郭が半透明に揺らぎ、内側へ歩み入ることができる。",
    note: "特別報告：最深部の『VIP秘密クラブ』だけは物理的に地上から孤立しており、地下モールの南東幕裏から階段ワープでのみ到達できる。",
  },
  {
    id: "aquarium_wonder",
    title: "第三展示：ワンダーランド遊園地＆クリスタル迷宮館",
    era: "東翼・新設テーマパーク棟",
    body: "東の競馬場を抜けた先に広がるのは、縁日射的場と生垣迷路が連なるワンダーランド遊園地、3階層吹抜の総合デパートアトリウム、そして青い水槽と結晶が輝くクリスタル迷宮館だ。",
    note: "噂話：迷路北東の行き止まりの生垣の奥では、時おり鈴の音が聴こえるという。",
  },
  {
    id: "basement_network",
    title: "第四展示：地下大迷宮モールと怪盗のバックヤード",
    era: "南翼・地下街記録",
    body: "南の桟橋・屋外劇場から地下連絡橋を降りると、雑貨店と飲食店が軒を連ねる地下大迷宮モールが広がる。その南壁の裏側には、怪盗団と支配人が暗号金庫を置いたバックヤード迷路が走っている。",
    note: "調査メモ：地下モールの南壁には3箇所もの偽装入口が確認されている。",
  },
];

const QUIZ_ITEMS: readonly {
  id: string;
  question: string;
  choices: readonly string[];
  answerIdx: number;
  explain: string;
}[] = [
  {
    id: "q_rooms",
    question: "広大なロビーの中に隠されている『秘密部屋』は全部でいくつある？",
    choices: ["3つ", "4つ", "6つ", "8つ"],
    answerIdx: 2,
    explain:
      "東回廊の秘宝金庫室・星読みプラネタリウム・妖精の祠・王家の秘密書庫・怪盗の隠し金庫室・地下VIP秘密クラブの計6つ！",
  },
  {
    id: "q_vip",
    question: "地上から完全に切り離された『地下VIP秘密クラブ』へ行く唯一の方法は？",
    choices: [
      "競馬場の柵を飛び越える",
      "スターライト展望モール南東のタペストリー裏の階段ワープ",
      "噴水に100回小銭を投げる",
      "コロッセオの中央から潜る",
    ],
    answerIdx: 1,
    explain:
      "スターライト展望モール南東隅（187,127）のタペストリー裏の隠し階段から空間ワープで移動できます。",
  },
  {
    id: "q_districts",
    question: "デパート＆テーマパークロビーには現在いくつの探索地区（スタンプ対象）がある？",
    choices: ["10地区", "15地区", "20地区", "25地区"],
    answerIdx: 2,
    explain: `現在は合計 ${LOBBY_DISTRICTS.length} 地区と ${LOBBY_SECRET_ROOMS.length} つの秘密部屋が存在します。`,
  },
  {
    id: "q_shooting",
    question: "縁日カーニバル射的場で、撃つと大きく減点されてコンボが途切れる的は？",
    choices: ["👑 王冠", "🏮 提灯", "💣 爆弾", "🦆 アヒル"],
    answerIdx: 2,
    explain: "💣 爆弾の的を撃つと -120点＆コンボリセット！ 👑 王冠は180点の高得点です。",
  },
  {
    id: "q_passage",
    question: "隠し扉（壁・生垣・本棚・タペストリー）を見分ける一番のヒントは？",
    choices: [
      "近くに歩み寄ると半透明に透けて奥へすり抜けられる",
      "叩くと爆発する",
      "ジャンプキーで乗り越える",
      "店員に1000G払う",
    ],
    answerIdx: 0,
    explain: "怪しい場所の壁や装飾に近づくと半透明に変化し、そのまま通り抜けられます！",
  },
];

const wrap: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(560px, calc(100% - 20px))",
  maxHeight: "calc(100% - 24px)",
  overflowY: "auto",
  padding: 14,
  borderRadius: 14,
  background: "rgba(12,14,22,0.95)",
  border: "1px solid rgba(110,215,200,0.35)",
  color: "#f2f6f9",
  zIndex: 6,
  boxShadow: "0 14px 40px rgba(0,0,0,0.6)",
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

export default function WorldBoxArchivePanel({
  discovery,
  onQuizClear,
  onClose,
}: {
  discovery: LobbyDiscoveryState;
  onQuizClear: (questionId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"exhibits" | "quiz">("exhibits");
  const [quizIdx, setQuizIdx] = useState(0);
  const [quizFeedback, setQuizFeedback] = useState<string | null>(null);

  const currentQuiz = QUIZ_ITEMS[quizIdx];

  const answerQuiz = (choiceIdx: number) => {
    if (choiceIdx === currentQuiz.answerIdx) {
      playWbSe("success");
      onQuizClear(currentQuiz.id);
      setQuizFeedback(`⭕ 正解！ ${currentQuiz.explain}`);
    } else {
      playWbSe("error");
      setQuizFeedback("❌ 惜しい！ 展示資料や館内のヒントを思い出してみよう。");
    }
  };

  return (
    <div style={wrap} className="wb-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>🏛️ WORLDBOX 博物館・歴史資料館</strong>
        <span style={{ fontSize: 12, color: "#8ee8d8" }}>
          クイズ {discovery.quizClearedIds.length}/{QUIZ_ITEMS.length}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={onClose}>
          閉じる
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setTab("exhibits")}
          style={{
            ...btn,
            background: tab === "exhibits" ? "rgba(85,205,185,0.3)" : "rgba(255,255,255,0.08)",
            borderColor: tab === "exhibits" ? "#6fe8d4" : "rgba(255,255,255,0.2)",
            fontWeight: tab === "exhibits" ? 700 : 400,
          }}
        >
          📜 展示資料を読む
        </button>
        <button
          type="button"
          onClick={() => setTab("quiz")}
          style={{
            ...btn,
            background: tab === "quiz" ? "rgba(85,205,185,0.3)" : "rgba(255,255,255,0.08)",
            borderColor: tab === "quiz" ? "#6fe8d4" : "rgba(255,255,255,0.2)",
            fontWeight: tab === "quiz" ? 700 : 400,
          }}
        >
          🎓 学芸員クイズ
        </button>
      </div>

      {tab === "exhibits" ? (
        <div style={{ display: "grid", gap: 10 }}>
          {EXHIBITS.map((ex) => (
            <div
              key={ex.id}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.12)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <strong style={{ fontSize: 13, color: "#9bf2e3" }}>{ex.title}</strong>
                <span style={{ fontSize: 11, color: "#b6c2cf" }}>{ex.era}</span>
              </div>
              <p style={{ margin: "0 0 6px", fontSize: 12, lineHeight: 1.55, color: "#e5eaf2" }}>
                {ex.body}
              </p>
              <div style={{ fontSize: 11, color: "#ffd88a" }}>{ex.note}</div>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {QUIZ_ITEMS.map((q, idx) => {
              const cleared = discovery.quizClearedIds.includes(q.id);
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => {
                    setQuizIdx(idx);
                    setQuizFeedback(null);
                    playWbSe("click");
                  }}
                  style={{
                    ...btn,
                    minHeight: 30,
                    padding: "2px 10px",
                    background:
                      quizIdx === idx
                        ? "rgba(85,205,185,0.35)"
                        : cleared
                          ? "rgba(120,220,140,0.2)"
                          : "rgba(255,255,255,0.08)",
                    borderColor: cleared ? "#7be495" : "rgba(255,255,255,0.2)",
                  }}
                >
                  Q{idx + 1} {cleared ? "✓" : ""}
                </button>
              );
            })}
          </div>
          <div
            style={{
              padding: 12,
              borderRadius: 10,
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.16)",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
              Q{quizIdx + 1}. {currentQuiz.question}
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {currentQuiz.choices.map((c, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => answerQuiz(idx)}
                  style={{
                    ...btn,
                    textAlign: "left",
                    padding: "7px 12px",
                    background: "rgba(255,255,255,0.08)",
                  }}
                >
                  {idx + 1}. {c}
                </button>
              ))}
            </div>
            {quizFeedback && (
              <div
                style={{
                  marginTop: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: "rgba(0,0,0,0.35)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: quizFeedback.startsWith("⭕") ? "#8ff0b4" : "#ff9fa8",
                }}
              >
                {quizFeedback}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
