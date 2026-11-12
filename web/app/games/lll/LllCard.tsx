"use client";
// LLL の統一カードコンポーネント（全画面でこれ1つだけを使う）。
// 所持カード（LllCard）とバトル中のアクター（BattleActor）は形が違うので、
// 呼び出し側で LllCardView に正規化してから渡す。比率は常に 5:7、
// 枠はティア（normal=マット / elite=光沢+紫縁 / legend=金箔）で変わる。
import type { CSSProperties, PointerEventHandler, ReactNode } from "react";

export type LllElement = "fire" | "water" | "wind" | "earth" | "light" | "dark";
export type LllTier = "normal" | "elite" | "legend";

export type LllSkillView = {
  name: string;
  kind: string;
  power: number;
  cooldown: number;
  ap: number;
  description: string;
};

export type LllCardView = {
  /** カードID or バトルアクターの key。 */
  id: string;
  name: string;
  flavor?: string;
  element: LllElement;
  tier: LllTier;
  level: number;
  glyph?: string;
  imageDataUrl?: string;
  /** 現在HP（所持カードでは最大HPと同じ）。 */
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  skills: LllSkillView[];
  trait?: { name: string; kind: string; description: string } | null;
  /** バトル用（任意）。 */
  hpBar?: boolean;
  cooldowns?: number[];
  statuses?: { kind: string; turns: number }[];
  shield?: number;
  defending?: boolean;
  alive?: boolean;
};

export const ELEMENT_LABEL: Record<LllElement, string> = {
  fire: "火",
  water: "水",
  wind: "風",
  earth: "土",
  light: "光",
  dark: "闇",
};

export const TIER_LABEL: Record<LllTier, string> = {
  normal: "ノーマル",
  elite: "エリート",
  legend: "レジェンド",
};

const STATUS_LABEL: Record<string, string> = {
  burn: "やけど",
  stun: "スタン",
  guard_break: "盾崩し",
  overdrive: "加速",
};

type Props = {
  view: LllCardView;
  size?: "sm" | "md" | "lg";
  selected?: boolean;
  dimmed?: boolean;
  /** 対象選択中に光らせる。 */
  targetable?: boolean;
  /** 現在の手番アクター。 */
  current?: boolean;
  /** 被弾シェイク中。 */
  hit?: boolean;
  /** 初回ガイド戦で推奨対象として示す（金枠パルス）。 */
  guide?: boolean;
  /** 逐次再生で攻撃側が前進する方向。player は上（敵方向）、cpu は下（自軍方向）。 */
  lunge?: "up" | "down" | null;
  /** シールド吸収・防御の拍でバッジ側を点滅させる。 */
  shieldFlash?: boolean;
  onClick?: () => void;
  /** ドラッグ（Pointer Events）のパススルー。 */
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onPointerMove?: PointerEventHandler<HTMLElement>;
  onPointerUp?: PointerEventHandler<HTMLElement>;
  onPointerCancel?: PointerEventHandler<HTMLElement>;
  draggableClass?: boolean;
  style?: CSSProperties;
  dataKey?: string;
  children?: ReactNode;
};

export default function LllCard({
  view,
  size = "md",
  selected = false,
  dimmed = false,
  targetable = false,
  current = false,
  hit = false,
  guide = false,
  lunge = null,
  shieldFlash = false,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  draggableClass = false,
  style,
  dataKey,
  children,
}: Props) {
  const dead = view.alive === false;
  const hpPct = view.maxHp > 0 ? Math.max(0, Math.min(100, Math.round((view.hp / view.maxHp) * 100))) : 0;
  const classes = [
    "lll-card",
    `lll-card-${size}`,
    `lll-tier-${view.tier}`,
    selected ? "lll-card-selected" : "",
    dimmed ? "lll-card-dimmed" : "",
    targetable ? "lll-card-targetable" : "",
    current ? "lll-card-current" : "",
    hit ? "lll-card-hit" : "",
    guide ? "lll-card-guide" : "",
    lunge === "up" ? "lll-card-lunge-up" : lunge === "down" ? "lll-card-lunge-down" : "",
    shieldFlash ? "lll-card-shieldflash" : "",
    dead ? "lll-card-dead" : "",
    draggableClass ? "lll-draggable" : "",
    onClick ? "lll-card-clickable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article
      className={classes}
      style={style}
      data-actor-key={dataKey}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      aria-label={view.name}
    >
      <div className="lll-card-head">
        <span className="lll-card-name">{view.name}</span>
        <span className="lll-lv">Lv{view.level}</span>
      </div>
      <div className="lll-card-art">
        {view.imageDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="lll-card-img" src={view.imageDataUrl} alt="" draggable={false} />
        ) : (
          <span className="lll-card-glyph" aria-hidden="true">
            {view.glyph ?? "✦"}
          </span>
        )}
        <span className={`lll-element lll-element-${view.element}`}>{ELEMENT_LABEL[view.element] ?? view.element}</span>
        {view.shield !== undefined && view.shield > 0 && <span className="lll-shield-badge">盾{view.shield}</span>}
        {view.defending && <span className="lll-shield-badge lll-defend-badge">防御中</span>}
      </div>
      {view.hpBar ? (
        <div className="lll-hpbar-wrap">
          <div className="lll-hpbar">
            <span className={`lll-hpbar-fill${hpPct <= 25 ? " lll-hpbar-low" : hpPct <= 50 ? " lll-hpbar-mid" : ""}`} style={{ width: `${hpPct}%` }} />
          </div>
          <span className="lll-hp-text">
            HP {Math.max(0, view.hp)}/{view.maxHp}
          </span>
        </div>
      ) : null}
      <div className="lll-stats">
        <span>
          HP <strong>{view.maxHp}</strong>
        </span>
        <span>
          ATK <strong>{view.atk}</strong>
        </span>
        <span>
          DEF <strong>{view.def}</strong>
        </span>
        <span>
          SPD <strong>{view.spd}</strong>
        </span>
      </div>
      {size !== "sm" && (
        <ul className="lll-skills">
          {view.skills.slice(0, 2).map((skill, i) => {
            const cd = view.cooldowns?.[i] ?? 0;
            return (
              <li key={`${skill.name}-${i}`} className={cd > 0 ? "lll-skill-cd" : ""}>
                <span className="lll-skill-name">{skill.name}</span>
                <span className="lll-skill-meta">{cd > 0 ? `CD ${cd}` : `威力${skill.power}`}</span>
              </li>
            );
          })}
          {view.trait && (
            <li className="lll-trait">
              <span className="lll-skill-name">✦{view.trait.name}</span>
            </li>
          )}
        </ul>
      )}
      {size === "sm" && view.trait && <div className="lll-trait-sm">✦{view.trait.name}</div>}
      {view.statuses && view.statuses.length > 0 && (
        <div className="lll-statuses">
          {view.statuses.map((s, i) => (
            <span key={`${s.kind}-${i}`} className="lll-status-chip">
              {STATUS_LABEL[s.kind] ?? s.kind} {s.turns}
            </span>
          ))}
        </div>
      )}
      {size === "lg" && view.flavor && <p className="lll-flavor">{view.flavor}</p>}
      {children}
    </article>
  );
}
