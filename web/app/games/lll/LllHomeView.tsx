"use client";
// LLL ソシャゲ風ホームロビー画面。
// 左: 推しカード 3D/2D ステージ＋調律者バナー＋キャラの一言セリフ。
// 右: イベント／出撃クイックバナー＋現在の編成パーティ＋7日ログイン＋ミッション/実績（進捗バー＆未受取バッジ）。
import { useMemo, useState, type ReactNode } from "react";
import {
  ACHIEVEMENTS,
  DAILY_MISSIONS,
  LADDER_TIERS,
  LOGIN_BONUS_REWARDS,
  cardPowerScore,
} from "@/lib/lll/lll-game";
import LllCard, { ELEMENT_LABEL, TIER_LABEL } from "./LllCard";
import { cardToView, checkAchievementDone, type CardT, type Profile, type Tab } from "./LllTypes";

interface Props {
  profile: Profile;
  busy: boolean;
  canUse3D: boolean;
  viewer3D: (card: CardT) => ReactNode;
  onSavePlayerName: (name: string) => void;
  onClaimMission: (kind: "daily" | "achievement", id: string) => void;
  onSwitchTab: (tab: Tab) => void;
  onInspectCard: (cardId: string) => void;
}

export default function LllHomeView({
  profile,
  busy,
  canUse3D,
  viewer3D,
  onSavePlayerName,
  onClaimMission,
  onSwitchTab,
  onInspectCard,
}: Props) {
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(profile.playerName ?? "調律者");
  const [missionTab, setMissionTab] = useState<"daily" | "achievement">("daily");
  const [quoteIdx, setQuoteIdx] = useState(0);

  const favoriteCard =
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

  const teamPower = teamCards.reduce((sum, c) => sum + cardPowerScore(c), 0);
  const loginDay = ((profile.loginStreak ?? 1) - 1) % LOGIN_BONUS_REWARDS.length;
  const maxCleared = profile.clearedTiers.reduce((m, t) => Math.max(m, t), -1);
  const nextTierName = LADDER_TIERS[Math.min(LADDER_TIERS.length - 1, maxCleared + 1)]?.name ?? "試し切り";

  // 未受取件数バッジ
  const dailyReadyCount = DAILY_MISSIONS.filter((m) => {
    const cur = profile.dailyProgress?.[m.metric] ?? 0;
    return cur >= m.target && !(profile.dailyClaimed?.includes(m.id) ?? false);
  }).length;

  const achReadyCount = ACHIEVEMENTS.filter(
    (a) => checkAchievementDone(profile, a.id) && !(profile.achievementsClaimed?.includes(a.id) ?? false),
  ).length;

  const quotes = useMemo(() => {
    if (!favoriteCard) return ["新しい切り札をスカウトしよう。"];
    return [
      favoriteCard.flavor || `「${favoriteCard.name}、いつでも出撃できる。」`,
      `特性【${favoriteCard.trait.name}】: ${favoriteCard.trait.description}`,
      (profile.tickets ?? 0) > 0
        ? `スカウト券が ${profile.tickets} 枚あるな。SR以上確定召喚を試してみないか？`
        : `次の目標は「${nextTierName}」や深淵第${(profile.abyssBestFloor ?? 0) + 1}階層の攻略だ。`,
    ];
  }, [favoriteCard, nextTierName, profile.abyssBestFloor, profile.tickets]);

  const currentQuote = quotes[quoteIdx % quotes.length];

  return (
    <section className="lll-home-stage">
      {/* 上段ヒーローロビー: 左=推し3Dステージ / 右=調律者ステータス & メイン出撃導線 */}
      <div className="lll-home-hero">
        <div className={`lll-lobby-character lll-lobby-el-${favoriteCard?.element ?? "light"}`}>
          <div className="lll-lobby-top-meta">
            <span className="lll-chip">♥ 推しパートナー</span>
            {favoriteCard && (
              <span className="lll-chip">
                {TIER_LABEL[favoriteCard.tier]} ・ {ELEMENT_LABEL[favoriteCard.element]}
              </span>
            )}
          </div>

          {favoriteCard && (
            <div className="lll-lobby-viewer">
              {canUse3D ? (
                viewer3D(favoriteCard)
              ) : (
                <div style={{ display: "grid", placeItems: "center" }}>
                  <LllCard
                    view={cardToView(favoriteCard, profile)}
                    size="lg"
                    onClick={() => onInspectCard(favoriteCard.id)}
                  />
                </div>
              )}
            </div>
          )}

          {favoriteCard && (
            <button
              type="button"
              className="lll-home-quote"
              onClick={() => setQuoteIdx((i) => i + 1)}
              title="タップでセリフ切替"
            >
              <span className="lll-quote-speaker">
                {favoriteCard.name} <small>Lv{favoriteCard.level} {(favoriteCard.limitBreak ?? 0) > 0 ? `★${favoriteCard.limitBreak}` : ""}</small>
              </span>
              <span className="lll-quote-text">{currentQuote}</span>
            </button>
          )}

          {favoriteCard && (
            <div className="lll-actions">
              <button type="button" className="lll-btn" onClick={() => onInspectCard(favoriteCard.id)}>
                強化・限界突破・詳細
              </button>
              <button type="button" className="lll-btn" onClick={() => onSwitchTab("binder")}>
                推し変更 / 編成
              </button>
            </div>
          )}
        </div>

        {/* 右カラム: 調律者IDカード + 主役CTAバナー + 現在の3枚編成 */}
        <div className="lll-home-command">
          {/* 調律者プロフィールカード */}
          <div className="lll-panel lll-trainer-card">
            <div className="lll-panel-head">
              {!editingName ? (
                <div className="lll-trainer-id">
                  <span className="lll-trainer-badge">TUNER</span>
                  <strong className="lll-trainer-name">{profile.playerName ?? "調律者"}</strong>
                  <button
                    type="button"
                    className="lll-snd-btn"
                    onClick={() => {
                      setNameInput(profile.playerName ?? "調律者");
                      setEditingName(true);
                    }}
                  >
                    名前変更
                  </button>
                </div>
              ) : (
                <form
                  className="lll-name-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (nameInput.trim()) {
                      onSavePlayerName(nameInput.trim());
                      setEditingName(false);
                    }
                  }}
                >
                  <input
                    type="text"
                    className="lll-input"
                    maxLength={16}
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    aria-label="プレイヤー名"
                  />
                  <button type="submit" className="lll-btn lll-btn-primary" disabled={busy || !nameInput.trim()}>
                    保存
                  </button>
                  <button type="button" className="lll-btn" onClick={() => setEditingName(false)}>
                    取消
                  </button>
                </form>
              )}
              <span className="lll-chip lll-chip-picked">総戦力 {teamPower}</span>
            </div>

            <div className="lll-kpi-grid">
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
                <span>深淵最高到達</span>
                <strong>{profile.abyssBestFloor ?? 0}F</strong>
              </div>
              <div className="lll-kpi-box">
                <span>図鑑コレクション</span>
                <strong>{profile.cards.length}/60</strong>
              </div>
            </div>
          </div>

          {/* ソシャゲ主役アクションバナー */}
          <div className="lll-home-banners">
            <button type="button" className="lll-banner lll-banner-quest" onClick={() => onSwitchTab("arena")}>
              <div className="lll-banner-copy">
                <span className="lll-banner-tag">BATTLE / ABYSS / PvP</span>
                <strong>⚔ クエスト・アリーナへ出撃</strong>
                <small>挑戦目安：{nextTierName} ／ 深淵第{(profile.abyssBestFloor ?? 0) + 1}階層</small>
              </div>
              <span className="lll-banner-arrow">→</span>
            </button>

            <div className="lll-home-subbanners">
              <button type="button" className="lll-banner lll-banner-gacha" onClick={() => onSwitchTab("scout")}>
                <div className="lll-banner-copy">
                  <span className="lll-banner-tag">GACHA / APPRAISE</span>
                  <strong>✦ スカウト召喚</strong>
                  <small>
                    {(profile.tickets ?? 0) > 0
                      ? `🎫 SR以上確定券 ×${profile.tickets}枚`
                      : "写真から新たな切り札を鑑定"}
                  </small>
                </div>
                {(profile.tickets ?? 0) > 0 && <span className="lll-badge-pill">{profile.tickets}</span>}
              </button>

              <button type="button" className="lll-banner lll-banner-deck" onClick={() => onSwitchTab("binder")}>
                <div className="lll-banner-copy">
                  <span className="lll-banner-tag">PARTY &amp; UPGRADE</span>
                  <strong>🃏 バインダー編成</strong>
                  <small>現在パーティ {teamCards.length}/3 枚</small>
                </div>
              </button>
            </div>
          </div>

          {/* 現在のパーティプレビュー */}
          <div className="lll-panel">
            <div className="lll-panel-head">
              <h2 className="lll-panel-title">出撃パーティ</h2>
              <button type="button" className="lll-snd-btn" onClick={() => onSwitchTab("binder")}>
                編成を変える
              </button>
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
                      {ELEMENT_LABEL[card.element]} ・ Lv{card.level}
                      {(card.limitBreak ?? 0) > 0 ? ` ★${card.limitBreak}` : ""} ・ 戦力{cardPowerScore(card)}
                    </small>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 下段ワイドパネル: 7日ログインボーナス + デイリーミッション／実績 */}
      <div className="lll-home-bottom">
        <div className="lll-panel">
          <div className="lll-panel-head">
            <h2 className="lll-panel-title">連続ログインボーナス</h2>
            <span className="lll-chip lll-chip-lumen">現在 {profile.loginStreak ?? 1}日目</span>
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
                  <strong>{today ? "TODAY" : `${idx + 1}日目`}</strong>
                  <span>◆{rew.shards}</span>
                  <span>●{rew.lumen}</span>
                  {rew.tickets > 0 && <span>🎫{rew.tickets}</span>}
                </div>
              );
            })}
          </div>
        </div>

        <div className="lll-panel">
          <div className="lll-panel-head">
            <h2 className="lll-panel-title">ミッション &amp; 実績</h2>
            <div className="lll-soundbar">
              <button
                type="button"
                className={`lll-snd-btn${missionTab === "daily" ? " lll-snd-on" : ""}`}
                onClick={() => setMissionTab("daily")}
              >
                デイリー {dailyReadyCount > 0 ? `(${dailyReadyCount})` : ""}
              </button>
              <button
                type="button"
                className={`lll-snd-btn${missionTab === "achievement" ? " lll-snd-on" : ""}`}
                onClick={() => setMissionTab("achievement")}
              >
                実績 {achReadyCount > 0 ? `(${achReadyCount})` : ""}
              </button>
            </div>
          </div>

          {missionTab === "daily" ? (
            <ul className="lll-mission-list">
              {DAILY_MISSIONS.map((m) => {
                const cur = Math.min(m.target, profile.dailyProgress?.[m.metric] ?? 0);
                const pct = Math.round((cur / m.target) * 100);
                const claimed = profile.dailyClaimed?.includes(m.id) ?? false;
                const ready = cur >= m.target && !claimed;
                return (
                  <li key={m.id} className="lll-mission-item">
                    <div className="lll-mission-info" style={{ flex: 1, minWidth: 200 }}>
                      <span className="lll-mission-title">
                        {m.title}（{cur}/{m.target}）
                      </span>
                      <div className="lll-mission-bar" aria-hidden="true">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                      <span className="lll-mission-meta">
                        報酬：◆欠片{m.reward.shards} / ●ルーメン{m.reward.lumen}
                        {m.reward.tickets > 0 ? ` / 🎫スカウト券${m.reward.tickets}` : ""}
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
                        {a.description} ・ 報酬：◆{a.reward.shards} / ●{a.reward.lumen}
                        {a.reward.tickets > 0 ? ` / 🎫${a.reward.tickets}` : ""}
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
      </div>
    </section>
  );
}
