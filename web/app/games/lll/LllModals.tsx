"use client";
// LLL モーダル集（ログインボーナス祝福・排出率／仕様案内・カスタム30枚戦術デッキビルダー）。
import { useState } from "react";
import { TACTIC_CARDS } from "@/lib/lll/lll-tactics";
import type { RewardBundle } from "@/lib/lll/lll-game";
import { IconLumen, IconShard, IconTicket } from "./LllIcons";

export function LoginBonusModal({
  bonus,
  onClose,
}: {
  bonus: { day: number; reward: RewardBundle };
  onClose: () => void;
}) {
  return (
    <div className="lll-overlay" role="dialog" aria-label="ログインボーナス" onClick={onClose}>
      <div className="lll-modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="lll-panel-title">ログインボーナス {bonus.day}日目</h2>
        <p className="lll-mission-meta">本日のログイン報酬を獲得しました。</p>
        <div className="lll-currencies">
          <span className="lll-chip lll-chip-shards">
            <IconShard size={13} /> 欠片 +{bonus.reward.shards}
          </span>
          <span className="lll-chip lll-chip-lumen">
            <IconLumen size={13} /> ルーメン +{bonus.reward.lumen}
          </span>
          {bonus.reward.tickets > 0 && (
            <span className="lll-chip lll-chip-ticket">
              <IconTicket size={13} /> スカウト券 +{bonus.reward.tickets}
            </span>
          )}
        </div>
        <div className="lll-actions">
          <button type="button" className="lll-btn lll-btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

export function DropRatesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="lll-overlay" role="dialog" aria-label="提供割合・鑑定仕様" onClick={onClose}>
      <div className="lll-modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="lll-panel-title">提供割合・鑑定仕様</h2>
        <table className="lll-rates-table">
          <thead>
            <tr>
              <th>方式</th>
              <th>レジェンド</th>
              <th>エリート</th>
              <th>ノーマル</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>画像スカウト（色彩・複雑度依存）</td>
              <td>〜18%</td>
              <td>〜38%</td>
              <td>残り</td>
            </tr>
            <tr>
              <td>チケット召喚（エリート以上確定）</td>
              <td>20%</td>
              <td>80%</td>
              <td>0%</td>
            </tr>
          </tbody>
        </table>
        <p className="lll-mission-meta">
          同じ画像を再スカウトすると強化の欠片を獲得し、既存の同名カードが自動で限界突破 +1（最大+5）します。
        </p>
        <div className="lll-actions">
          <button type="button" className="lll-btn lll-btn-primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

export function CustomDeckModal({
  initialCounts,
  busy,
  onSave,
  onClose,
}: {
  initialCounts: Record<string, number>;
  busy: boolean;
  onSave: (counts: Record<string, number>) => void;
  onClose: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>(() => ({ ...initialCounts }));
  const total = Object.values(counts).reduce((sum, n) => sum + (n || 0), 0);

  const adjust = (id: string, delta: number) => {
    setCounts((prev) => {
      const nextVal = Math.max(0, Math.min(3, (prev[id] ?? 0) + delta));
      return { ...prev, [id]: nextVal };
    });
  };

  return (
    <div className="lll-overlay" role="dialog" aria-label="カスタム戦術デッキ編成" onClick={onClose}>
      <div className="lll-deck-builder" onClick={(e) => e.stopPropagation()}>
        <div className="lll-panel-head">
          <h2 className="lll-panel-title">カスタム戦術デッキ編成（{total}/30枚）</h2>
          <button
            type="button"
            className="lll-btn"
            onClick={() => setCounts({})}
          >
            クリア
          </button>
        </div>
        <p className="lll-mission-meta">36種の戦術カードから同名3枚まで、合計ちょうど30枚で組みます。</p>
        <div className="lll-deck-card-list">
          {TACTIC_CARDS.map((card) => {
            const count = counts[card.id] ?? 0;
            return (
              <div key={card.id} className="lll-deck-card-item">
                <div className="lll-panel-head">
                  <strong>
                    [{card.id}] {card.name}
                  </strong>
                  <span>TP{card.cost}</span>
                </div>
                <span className="lll-mission-meta">{card.text}</span>
                <div className="lll-actions" style={{ justifyContent: "space-between", marginTop: 4 }}>
                  <span>枚数: {count}/3</span>
                  <div className="lll-soundbar">
                    <button type="button" className="lll-snd-btn" onClick={() => adjust(card.id, -1)} disabled={count <= 0}>
                      －
                    </button>
                    <button
                      type="button"
                      className="lll-snd-btn lll-snd-on"
                      onClick={() => adjust(card.id, 1)}
                      disabled={count >= 3 || total >= 30}
                    >
                      ＋
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="lll-actions">
          <button
            type="button"
            className="lll-btn lll-btn-primary"
            disabled={busy || total !== 30}
            onClick={() => onSave(counts)}
          >
            30枚で保存して使用
          </button>
          <button type="button" className="lll-btn" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
