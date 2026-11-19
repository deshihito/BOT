"use client";
// LLL 図鑑・規則・ミッション画面。
// 属性相性循環図（SVG）・属性反応一覧・編成共鳴・フィールド地脈・共鳴バースト・デイリー／実績を一画面に整理する。
import { useState } from "react";
import {
  ACHIEVEMENTS,
  BATTLE_FIELDS,
  DAILY_MISSIONS,
  ELEMENTAL_REACTIONS,
  PARTY_RESONANCE_CATALOG,
  RELICS,
  RESONANCE_BURST_INFO,
  evaluatePartyResonance,
  type LllElement,
} from "@/lib/lll/lll-game";
import { ELEMENT_LABEL } from "./LllCard";
import { ElementIcon, IconBolt, IconField, IconRelic, IconShard, IconLumen, IconTicket } from "./LllIcons";
import { checkAchievementDone, type CardT, type Profile } from "./LllTypes";

interface Props {
  profile: Profile;
  teamCards: CardT[];
  busy: boolean;
  onClaimMission: (kind: "daily" | "achievement", id: string) => void;
}

const STATUS_JP: Record<string, string> = {
  burn: "やけど",
  guard_break: "防御崩し",
  stun: "スタン",
};

const ALL_ELEMENTS: LllElement[] = ["fire", "water", "wind", "earth", "light", "dark"];

export default function LllCodexView({ profile, teamCards, busy, onClaimMission }: Props) {
  const [section, setSection] = useState<"rules" | "missions">("rules");
  const [missionKind, setMissionKind] = useState<"daily" | "achievement">("daily");

  const activeResonance = evaluatePartyResonance(teamCards);
  const dailyReady = DAILY_MISSIONS.filter((m) => {
    const cur = profile.dailyProgress?.[m.metric] ?? 0;
    return cur >= m.target && !(profile.dailyClaimed?.includes(m.id) ?? false);
  }).length;
  const achReady = ACHIEVEMENTS.filter(
    (a) => checkAchievementDone(profile, a.id) && !(profile.achievementsClaimed?.includes(a.id) ?? false),
  ).length;

  return (
    <section className="lll-codex">
      <div className="lll-codex-head">
        <div className="lll-seg" role="tablist" aria-label="図鑑カテゴリ">
          <button
            type="button"
            role="tab"
            aria-selected={section === "rules"}
            className={`lll-seg-btn${section === "rules" ? " lll-seg-active" : ""}`}
            onClick={() => setSection("rules")}
          >
            戦闘規則・ギミック図鑑
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === "missions"}
            className={`lll-seg-btn${section === "missions" ? " lll-seg-active" : ""}`}
            onClick={() => setSection("missions")}
          >
            ミッション・実績
            {dailyReady + achReady > 0 && <span className="lll-count-pill">{dailyReady + achReady}</span>}
          </button>
        </div>
        <span className="lll-chip">図鑑登録 {profile.cards.length}/60 ・ 遺物 {profile.unlockedRelics?.length ?? 0}/{RELICS.length}</span>
      </div>

      {section === "rules" ? (
        <div className="lll-codex-grid">
          {/* 属性循環図 & 相性倍率 */}
          <div className="lll-panel">
            <div className="lll-panel-head">
              <h2 className="lll-panel-title">属性相性サイクル</h2>
              <span className="lll-chip">有利 ×1.25 / 不利 ×0.80</span>
            </div>
            <div className="lll-cycle-wrap">
              <svg viewBox="0 0 380 200" className="lll-cycle-svg" role="img" aria-label="火→風→土→光→闇→水→火の6属性相性循環図">
                <defs>
                  <marker id="lll-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#d4a24c" />
                  </marker>
                </defs>
                {/* 6属性リング（火→風→土→光→闇→水→火） */}
                <path d="M 155 44 L 225 44" stroke="#d4a24c" strokeWidth="2" markerEnd="url(#lll-arr)" />
                <path d="M 262 56 L 296 86" stroke="#d4a24c" strokeWidth="2" markerEnd="url(#lll-arr)" />
                <path d="M 296 116 L 262 146" stroke="#d4a24c" strokeWidth="2" markerEnd="url(#lll-arr)" />
                <path d="M 225 158 L 155 158" stroke="#d4a24c" strokeWidth="2" markerEnd="url(#lll-arr)" />
                <path d="M 118 146 L 84 116" stroke="#d4a24c" strokeWidth="2" markerEnd="url(#lll-arr)" />
                <path d="M 84 86 L 118 56" stroke="#d4a24c" strokeWidth="2" markerEnd="url(#lll-arr)" />

                {[
                  { x: 132, y: 44, label: "火", fill: "#381f1b", stroke: "#f0886b", text: "#f0886b" },
                  { x: 248, y: 44, label: "風", fill: "#183024", stroke: "#7ed6a5", text: "#7ed6a5" },
                  { x: 312, y: 101, label: "土", fill: "#302616", stroke: "#dfc083", text: "#dfc083" },
                  { x: 248, y: 158, label: "光", fill: "#332c19", stroke: "#f5e4ad", text: "#f5e4ad" },
                  { x: 132, y: 158, label: "闇", fill: "#1e2230", stroke: "#a8b5d8", text: "#a8b5d8" },
                  { x: 68, y: 101, label: "水", fill: "#182838", stroke: "#79bce8", text: "#79bce8" },
                ].map((n) => (
                  <g key={n.label}>
                    <circle cx={n.x} cy={n.y} r="22" fill={n.fill} stroke={n.stroke} strokeWidth="2" />
                    <text x={n.x} y={n.y + 5} textAnchor="middle" fill={n.text} fontSize="15" fontWeight="800">
                      {n.label}
                    </text>
                  </g>
                ))}
                <text x="190" y="96" textAnchor="middle" fill="#edeae2" fontSize="12" fontWeight="800">
                  6属性循環
                </text>
                <text x="190" y="114" textAnchor="middle" fill="#98a0ae" fontSize="10" fontWeight="600">
                  矢印方向へ有利 ×1.25
                </text>
              </svg>
            </div>
            <p className="lll-mission-meta">
              弱点命中時はダメージ ×1.25 に加え、共鳴バーストゲージの蓄積量も増加します。
            </p>
          </div>

          {/* 属性反応テーブル */}
          <div className="lll-panel">
            <div className="lll-panel-head">
              <h2 className="lll-panel-title">属性反応（状態異常 × 攻撃属性）</h2>
              <span className="lll-chip">全{ELEMENTAL_REACTIONS.length}種</span>
            </div>
            <div className="lll-table-wrap">
              <table className="lll-rates-table">
                <thead>
                  <tr>
                    <th>反応名</th>
                    <th>発動条件</th>
                    <th>効果</th>
                  </tr>
                </thead>
                <tbody>
                  {ELEMENTAL_REACTIONS.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                      </td>
                      <td>
                        {STATUS_JP[r.requiredStatus] ?? r.requiredStatus} ×{" "}
                        {r.triggerElement === "light_or_dark" ? "光 / 闇" : ELEMENT_LABEL[r.triggerElement]}
                      </td>
                      <td>{r.extraEffect}（+{Math.round(r.bonusRatio * 100)}%）</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 編成属性共鳴 */}
          <div className="lll-panel">
            <div className="lll-panel-head">
              <h2 className="lll-panel-title">編成の属性共鳴</h2>
              <span className="lll-chip lll-chip-lumen">現在発動：{activeResonance.name}</span>
            </div>
            <div className="lll-codex-list">
              {PARTY_RESONANCE_CATALOG.map((r) => {
                const isCurrent = activeResonance.id === r.id;
                return (
                  <div key={r.id} className={`lll-codex-row${isCurrent ? " lll-codex-row-active" : ""}`}>
                    <div className="lll-codex-row-head">
                      <strong>{r.name}</strong>
                      <span className="lll-chip">{r.shortLabel}</span>
                    </div>
                    <p className="lll-mission-meta">{r.description}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* フィールド地脈 */}
          <div className="lll-panel">
            <div className="lll-panel-head">
              <h2 className="lll-panel-title">
                <IconField size={15} /> フィールド地脈（アリーナ効果）
              </h2>
              <span className="lll-chip">全{BATTLE_FIELDS.length}種</span>
            </div>
            <div className="lll-codex-list">
              {BATTLE_FIELDS.map((f) => (
                <div key={f.id} className="lll-codex-row">
                  <div className="lll-codex-row-head">
                    <span className="lll-field-dot" style={{ background: f.accentHex }} aria-hidden="true" />
                    <strong>{f.name}</strong>
                    <span className="lll-chip">{f.shortTag}</span>
                  </div>
                  <p className="lll-mission-meta">{f.description}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 共鳴バースト */}
          <div className="lll-panel lll-codex-span">
            <div className="lll-panel-head">
              <h2 className="lll-panel-title">
                <IconBolt size={15} /> 共鳴バースト（チーム必殺技）
              </h2>
              <span className="lll-chip">ゲージ 100% で発動可能</span>
            </div>
            <p className="lll-mission-meta">
              攻撃・被弾・防御・戦術カード・属性反応で共通ゲージが蓄積。100% 時に手番アクターの属性に応じたチーム必殺技を放ちます。
            </p>
            <div className="lll-burst-catalog">
              {ALL_ELEMENTS.map((el) => (
                <div key={el} className="lll-codex-row">
                  <div className="lll-codex-row-head">
                    <span className={`lll-el-pill lll-element-${el}`}>
                      <ElementIcon element={el} size={13} />
                      {ELEMENT_LABEL[el]}
                    </span>
                    <strong>{RESONANCE_BURST_INFO[el].name}</strong>
                  </div>
                  <p className="lll-mission-meta">{RESONANCE_BURST_INFO[el].summary}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 遺物カタログ */}
          <div className="lll-panel lll-codex-span">
            <div className="lll-panel-head">
              <h2 className="lll-panel-title">
                <IconRelic size={15} /> 遺物（最大2枠装備）
              </h2>
              <span className="lll-chip">解放済 {profile.unlockedRelics?.length ?? 0}/{RELICS.length}</span>
            </div>
            <div className="lll-burst-catalog">
              {RELICS.map((r) => {
                const owned = profile.unlockedRelics?.includes(r.id) ?? false;
                const equipped = profile.equippedRelics?.includes(r.id) ?? false;
                return (
                  <div key={r.id} className={`lll-codex-row${equipped ? " lll-codex-row-active" : ""}`}>
                    <div className="lll-codex-row-head">
                      <strong>{r.name}</strong>
                      <span className="lll-chip">{equipped ? "装備中" : owned ? "所持" : "未鍛造"}</span>
                    </div>
                    <p className="lll-mission-meta">{r.summary}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="lll-panel">
          <div className="lll-panel-head">
            <h2 className="lll-panel-title">ミッション &amp; 実績一覧</h2>
            <div className="lll-soundbar">
              <button
                type="button"
                className={`lll-snd-btn${missionKind === "daily" ? " lll-snd-on" : ""}`}
                onClick={() => setMissionKind("daily")}
              >
                デイリー {dailyReady > 0 ? `(${dailyReady})` : ""}
              </button>
              <button
                type="button"
                className={`lll-snd-btn${missionKind === "achievement" ? " lll-snd-on" : ""}`}
                onClick={() => setMissionKind("achievement")}
              >
                実績 {achReady > 0 ? `(${achReady})` : ""}
              </button>
            </div>
          </div>

          {missionKind === "daily" ? (
            <ul className="lll-mission-list">
              {DAILY_MISSIONS.map((m) => {
                const cur = Math.min(m.target, profile.dailyProgress?.[m.metric] ?? 0);
                const pct = Math.round((cur / m.target) * 100);
                const claimed = profile.dailyClaimed?.includes(m.id) ?? false;
                const ready = cur >= m.target && !claimed;
                return (
                  <li key={m.id} className="lll-mission-item">
                    <div className="lll-mission-info">
                      <span className="lll-mission-title">
                        {m.title}（{cur}/{m.target}）
                      </span>
                      <div className="lll-mission-bar" aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                      <span className="lll-mission-meta lll-reward-inline">
                        <IconShard size={12} /> 欠片 {m.reward.shards}
                        <IconLumen size={12} /> ルーメン {m.reward.lumen}
                        {m.reward.tickets > 0 && (
                          <>
                            <IconTicket size={12} /> 券 {m.reward.tickets}
                          </>
                        )}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`lll-btn${ready ? " lll-btn-primary" : ""}`}
                      disabled={busy || !ready}
                      onClick={() => onClaimMission("daily", m.id)}
                    >
                      {claimed ? "受取済" : ready ? "受取" : "進行中"}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="lll-mission-list">
              {ACHIEVEMENTS.map((a) => {
                const done = checkAchievementDone(profile, a.id);
                const claimed = profile.achievementsClaimed?.includes(a.id) ?? false;
                const ready = done && !claimed;
                return (
                  <li key={a.id} className="lll-mission-item">
                    <div className="lll-mission-info">
                      <span className="lll-mission-title">{a.title}</span>
                      <span className="lll-mission-meta">
                        {a.description} ・ 欠片 {a.reward.shards} / ルーメン {a.reward.lumen}
                        {a.reward.tickets > 0 ? ` / 券 ${a.reward.tickets}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`lll-btn${ready ? " lll-btn-primary" : ""}`}
                      disabled={busy || !ready}
                      onClick={() => onClaimMission("achievement", a.id)}
                    >
                      {claimed ? "受取済" : ready ? "受取" : "未達成"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
