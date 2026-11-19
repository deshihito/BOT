"use client";
// LLL ホームハブ（整理された出撃拠点）。
// 左: 主力カード 3D/2D ステージ + 編成パーティ・属性共鳴・装備遺物サマリー。
// 右: 4モード直接出撃ランチャー + 工房・規則ショートカット + 連続ログイン & 未受取報酬。
import { useMemo, type ReactNode } from "react";
import {
  ACHIEVEMENTS,
  BATTLE_FIELD_BY_ID,
  DAILY_MISSIONS,
  LADDER_TIERS,
  LOGIN_BONUS_REWARDS,
  MAX_EQUIPPED_RELICS,
  RELIC_BY_ID,
  cardPowerScore,
  evaluatePartyResonance,
  fieldForAbyssFloor,
  fieldForLadderTier,
} from "@/lib/lll/lll-game";
import LllCard, { ELEMENT_LABEL, TIER_LABEL } from "./LllCard";
import {
  ElementIcon,
  IconArrowRight,
  IconCodex,
  IconDeck,
  IconField,
  IconRelic,
  IconScout,
  IconSwords,
  IconTune,
} from "./LllIcons";
import { cardToView, checkAchievementDone, type ArenaMode, type CardT, type Profile, type Tab } from "./LllTypes";

interface Props {
  profile: Profile;
  busy: boolean;
  canUse3D: boolean;
  viewer3D: (card: CardT) => ReactNode;
  onClaimMission: (kind: "daily" | "achievement", id: string) => void;
  onSwitchTab: (tab: Tab) => void;
  onLaunchArena: (mode: ArenaMode) => void;
  onOpenDeckModal: () => void;
  onInspectCard: (cardId: string) => void;
}

export default function LllHomeView({
  profile,
  busy,
  canUse3D,
  viewer3D,
  onClaimMission,
  onSwitchTab,
  onLaunchArena,
  onOpenDeckModal,
  onInspectCard,
}: Props) {
  const featuredCard =
    profile.cards.find((c) => c.id === profile.favoriteCardId) ??
    profile.cards.find((c) => c.id === profile.teamIds[0]) ??
    profile.cards[0];

  const teamCards = useMemo(
    () =>
      profile.teamIds
        .map((id) => profile.cards.find((c) => c.id === id))
        .filter((c): c is CardT => !!c),
    [profile.cards, profile.teamIds],
  );

  const resonance = useMemo(() => evaluatePartyResonance(teamCards), [teamCards]);
  const teamPower = teamCards.reduce((sum, c) => sum + cardPowerScore(c), 0);
  const equippedRelics = (profile.equippedRelics ?? [])
    .map((id) => RELIC_BY_ID[id])
    .filter((r): r is NonNullable<typeof r> => !!r);

  const loginDay = ((profile.loginStreak ?? 1) - 1) % LOGIN_BONUS_REWARDS.length;
  const maxCleared = profile.clearedTiers.reduce((m, t) => Math.max(m, t), -1);
  const nextTierIdx = Math.min(LADDER_TIERS.length - 1, maxCleared + 1);
  const nextTier = LADDER_TIERS[nextTierIdx];
  const nextLadderField = BATTLE_FIELD_BY_ID[fieldForLadderTier(nextTierIdx)];
  const nextAbyssFloor = (profile.abyssBestFloor ?? 0) + 1;
  const nextAbyssField = BATTLE_FIELD_BY_ID[fieldForAbyssFloor(nextAbyssFloor)];

  const claimableDaily = DAILY_MISSIONS.filter((m) => {
    const cur = profile.dailyProgress?.[m.metric] ?? 0;
    return cur >= m.target && !(profile.dailyClaimed?.includes(m.id) ?? false);
  });
  const claimableAch = ACHIEVEMENTS.filter(
    (a) => checkAchievementDone(profile, a.id) && !(profile.achievementsClaimed?.includes(a.id) ?? false),
  );
  const readyTotal = claimableDaily.length + claimableAch.length;

  return (
    <section className="lll-hub" aria-label="LLL ホームハブ">
      {/* 左カラム: 推しカードプレビュー & 編成・共鳴・遺物サマリー */}
      <div className="lll-hub-left">
        {featuredCard && (
          <div className="lll-showcase">
            <div className="lll-showcase-head">
              <div className="lll-showcase-title">
                <span className={`lll-el-pill lll-element-${featuredCard.element}`}>
                  <ElementIcon element={featuredCard.element} size={13} />
                  {ELEMENT_LABEL[featuredCard.element]}
                </span>
                <strong>{featuredCard.name}</strong>
              </div>
              <span className="lll-chip">
                {TIER_LABEL[featuredCard.tier]} ・ Lv{featuredCard.level}
                {(featuredCard.limitBreak ?? 0) > 0 ? ` +${featuredCard.limitBreak}` : ""}
              </span>
            </div>

            <div className="lll-showcase-stage">
              {canUse3D ? (
                viewer3D(featuredCard)
              ) : (
                <LllCard
                  view={cardToView(featuredCard, profile)}
                  size="lg"
                  onClick={() => onInspectCard(featuredCard.id)}
                />
              )}
            </div>

            <div className="lll-showcase-meta">
              <span className="lll-mission-meta">特性：{featuredCard.trait.name}（{featuredCard.trait.description}）</span>
              <div className="lll-showcase-actions">
                <button type="button" className="lll-btn lll-btn-primary" onClick={() => onInspectCard(featuredCard.id)}>
                  <IconTune size={14} /> 強化・調律
                </button>
                <button type="button" className="lll-btn" onClick={() => onSwitchTab("binder")}>
                  編成・遺物へ
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 現在の出撃編成 + 属性共鳴 + 装備遺物 */}
        <div className="lll-panel">
          <div className="lll-panel-head">
            <h2 className="lll-panel-title">出撃パーティ</h2>
            <span className="lll-chip lll-chip-lumen">総戦力 {teamPower}</span>
          </div>

          <div className="lll-party-strip">
            {teamCards.map((card, i) => (
              <button
                key={card.id}
                type="button"
                className="lll-party-mini"
                onClick={() => onInspectCard(card.id)}
              >
                <span className="lll-party-slot">{i + 1}</span>
                <div className="lll-party-mini-info">
                  <strong>{card.name}</strong>
                  <small>
                    {ELEMENT_LABEL[card.element]} ・ Lv{card.level} ・ 戦力 {cardPowerScore(card)}
                  </small>
                </div>
              </button>
            ))}
          </div>

          <div className="lll-synergy-strip">
            <div className="lll-synergy-row">
              <span className="lll-synergy-label">属性共鳴</span>
              <strong className="lll-synergy-val">{resonance.name}</strong>
              <span className="lll-mission-meta">{resonance.description}</span>
            </div>
            <div className="lll-synergy-row">
              <span className="lll-synergy-label">
                装備遺物 ({equippedRelics.length}/{MAX_EQUIPPED_RELICS})
              </span>
              {equippedRelics.length > 0 ? (
                <div className="lll-currencies">
                  {equippedRelics.map((r) => (
                    <span key={r.id} className="lll-chip" title={r.summary}>
                      <IconRelic size={12} /> {r.name}
                    </span>
                  ))}
                </div>
              ) : (
                <button type="button" className="lll-inline-link" onClick={() => onSwitchTab("binder")}>
                  遺物工房で鍛造・装備する
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 右カラム: 戦績KPI・4モード直接出撃ハブ・工房ショートカット・報酬ボード */}
      <div className="lll-hub-right">
        <div className="lll-kpi-grid" aria-label="戦績サマリー">
          <div className="lll-kpi-box">
            <span>通算戦績</span>
            <strong>
              {profile.wins}勝 {profile.losses}敗
            </strong>
          </div>
          <div className="lll-kpi-box">
            <span>PvPレート</span>
            <strong>{profile.pvpRating ?? 1000}</strong>
          </div>
          <div className="lll-kpi-box">
            <span>深淵到達</span>
            <strong>{profile.abyssBestFloor ?? 0}F</strong>
          </div>
          <div className="lll-kpi-box">
            <span>図鑑・遺物</span>
            <strong>
              {profile.cards.length}/60 ・ {profile.unlockedRelics?.length ?? 0}個
            </strong>
          </div>
        </div>

        {/* モード直接出撃ランチャー */}
        <div className="lll-panel">
          <div className="lll-panel-head">
            <h2 className="lll-panel-title">出撃・スカウト</h2>
            <span className="lll-mission-meta">各モードへ直接移動</span>
          </div>

          <div className="lll-mode-grid">
            <button
              type="button"
              className="lll-mode-card lll-mode-card-primary"
              onClick={() => onLaunchArena("ladder")}
            >
              <div className="lll-mode-card-top">
                <span className="lll-mode-icon">
                  <IconSwords size={18} />
                </span>
                <strong>ラダー戦</strong>
                <IconArrowRight size={15} className="lll-mode-arrow" />
              </div>
              <p className="lll-mode-sub">
                次目標：{nextTier?.name ?? "試し切り"}（敵Lv{nextTier?.enemyLevel ?? 1}）
              </p>
              <span className="lll-field-tag">
                <span className="lll-field-dot" style={{ background: nextLadderField.accentHex }} />
                地脈：{nextLadderField.name}（{nextLadderField.shortTag}）
              </span>
            </button>

            <button type="button" className="lll-mode-card" onClick={() => onLaunchArena("abyss")}>
              <div className="lll-mode-card-top">
                <span className="lll-mode-icon">
                  <IconField size={18} />
                </span>
                <strong>深淵の試練</strong>
                <IconArrowRight size={15} className="lll-mode-arrow" />
              </div>
              <p className="lll-mode-sub">
                挑戦階層：第{nextAbyssFloor}階層{nextAbyssFloor % 5 === 0 ? "（ボス階・券確定）" : ""}
              </p>
              <span className="lll-field-tag">
                <span className="lll-field-dot" style={{ background: nextAbyssField.accentHex }} />
                地脈：{nextAbyssField.name}
              </span>
            </button>

            <button type="button" className="lll-mode-card" onClick={() => onLaunchArena("pvp")}>
              <div className="lll-mode-card-top">
                <span className="lll-mode-icon">
                  <IconSwords size={18} />
                </span>
                <strong>模擬 PvP</strong>
                <IconArrowRight size={15} className="lll-mode-arrow" />
              </div>
              <p className="lll-mode-sub">現在レート {profile.pvpRating ?? 1000} ・ ゴースト対戦</p>
              <span className="lll-field-tag">相手ごとに固有の地脈が発動</span>
            </button>

            <button type="button" className="lll-mode-card" onClick={() => onSwitchTab("scout")}>
              <div className="lll-mode-card-top">
                <span className="lll-mode-icon">
                  <IconScout size={18} />
                </span>
                <strong>写真スカウト / 召喚</strong>
                {(profile.tickets ?? 0) > 0 ? (
                  <span className="lll-count-pill">{profile.tickets}</span>
                ) : (
                  <IconArrowRight size={15} className="lll-mode-arrow" />
                )}
              </div>
              <p className="lll-mode-sub">
                {(profile.tickets ?? 0) > 0
                  ? `SR以上確定スカウト券 ×${profile.tickets}枚`
                  : "手元の画像から固有カードを鑑定"}
              </p>
              <span className="lll-field-tag">同画像の重複時は自動で限界突破 +1</span>
            </button>
          </div>
        </div>

        {/* 工房・準備ショートカット */}
        <div className="lll-shortcut-row">
          <button type="button" className="lll-shortcut-btn" onClick={() => onSwitchTab("binder")}>
            <IconRelic size={16} />
            <div>
              <strong>編成・遺物工房</strong>
              <small>属性共鳴・遺物鍛造・カード調律</small>
            </div>
          </button>
          <button type="button" className="lll-shortcut-btn" onClick={onOpenDeckModal}>
            <IconDeck size={16} />
            <div>
              <strong>カスタム戦術デッキ</strong>
              <small>30枚構成（現在：{profile.tacticDeckId === "custom" ? "カスタム" : "標準"}）</small>
            </div>
          </button>
          <button type="button" className="lll-shortcut-btn" onClick={() => onSwitchTab("codex")}>
            <IconCodex size={16} />
            <div>
              <strong>図鑑・戦闘規則</strong>
              <small>属性反応・地脈・バースト一覧</small>
            </div>
          </button>
        </div>

        {/* 報酬ボード（連続ログイン + 未受取ミッション即回収） */}
        <div className="lll-panel">
          <div className="lll-panel-head">
            <h2 className="lll-panel-title">連続ログイン &amp; 報酬</h2>
            <div className="lll-currencies">
              <span className="lll-chip lll-chip-lumen">連続 {profile.loginStreak ?? 1}日目</span>
              <button type="button" className="lll-snd-btn" onClick={() => onSwitchTab("codex")}>
                ミッション一覧 {readyTotal > 0 ? `(${readyTotal}件受取可)` : ""}
              </button>
            </div>
          </div>

          <div className="lll-login-strip">
            {LOGIN_BONUS_REWARDS.map((rew, idx) => {
              const done = idx <= loginDay;
              const today = idx === loginDay;
              return (
                <div
                  key={idx}
                  className={`lll-login-day${done ? " lll-login-day-done" : ""}${today ? " lll-login-day-today" : ""}`}
                >
                  <strong>{today ? "本日" : `${idx + 1}日`}</strong>
                  <span>欠片{rew.shards}</span>
                  <span>L{rew.lumen}</span>
                  {rew.tickets > 0 && <span className="lll-login-ticket">券+{rew.tickets}</span>}
                </div>
              );
            })}
          </div>

          {readyTotal > 0 && (
            <ul className="lll-mission-list">
              {claimableDaily.slice(0, 3).map((m) => (
                <li key={m.id} className="lll-mission-item">
                  <div className="lll-mission-info">
                    <span className="lll-mission-title">デイリー達成：{m.title}</span>
                    <span className="lll-mission-meta">
                      欠片 +{m.reward.shards} / ルーメン +{m.reward.lumen}
                      {m.reward.tickets > 0 ? ` / 券 +${m.reward.tickets}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="lll-btn lll-btn-primary"
                    disabled={busy}
                    onClick={() => onClaimMission("daily", m.id)}
                  >
                    受取
                  </button>
                </li>
              ))}
              {claimableAch.slice(0, 2).map((a) => (
                <li key={a.id} className="lll-mission-item">
                  <div className="lll-mission-info">
                    <span className="lll-mission-title">実績達成：{a.title}</span>
                    <span className="lll-mission-meta">
                      欠片 +{a.reward.shards} / ルーメン +{a.reward.lumen}
                      {a.reward.tickets > 0 ? ` / 券 +${a.reward.tickets}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="lll-btn lll-btn-primary"
                    disabled={busy}
                    onClick={() => onClaimMission("achievement", a.id)}
                  >
                    受取
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
