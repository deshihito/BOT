"use client";
// AGO WORLD BOX のアイテムスロット共通部品（§8: スロット統一と深さ）。
// 第1層はスロット: アイコン + 個数バッジ + その画面の主情報1つ（badge）だけ。
// 名前・説明・効果・アクションは第2層の注釈（ItemAnnotation）に置き、
// スロットをタップした時だけ開く。ホットバー/コンテナの SlotContent と
// 同じ文法（ピクセル絵・右下の個数・選択時は金枠）に揃える。
import type { ReactNode } from "react";
import { itemById } from "@/lib/worldbox/items";

/** アイテムのドット絵アイコン（無いアイテムは名前ラベルのみで出す）。 */
export function ItemIcon({ id, size = 24 }: { id: string; size?: number }) {
  const def = itemById(id);
  if (!def?.icon) return null;
  return (
    <img
      src={def.icon}
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={{ imageRendering: "pixelated", flexShrink: 0 }}
    />
  );
}

const slotStyle: React.CSSProperties = {
  position: "relative", boxSizing: "border-box",
  width: 48, height: 48, minWidth: 48, minHeight: 48, padding: 4,
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
  borderRadius: 10, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
  touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
};

/**
 * 第1層のスロット。表示はアイコン + 右下の個数バッジ（count）+
 * 主情報1つ（badge、例: 価格）+ 選択枠だけ。名前・説明は出さない
 * （識別は aria-label と注釈が担う）。
 */
export function ItemSlot({
  itemId, count, badge, selected, disabled, onClick,
}: {
  itemId: string;
  count?: number;
  badge?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const def = itemById(itemId);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={!!selected}
      aria-label={def?.name ?? itemId}
      style={{
        ...slotStyle,
        ...(selected
          ? { background: "rgba(255,210,62,0.18)", borderColor: "rgba(255,210,62,0.85)" }
          : {}),
        ...(disabled ? { cursor: "default", opacity: 0.55 } : {}),
      }}
    >
      {def?.icon ? (
        <ItemIcon id={itemId} size={badge ? 24 : 28} />
      ) : (
        <span
          aria-hidden
          style={{ width: 18, height: 18, borderRadius: 4, border: "1px dashed rgba(255,255,255,0.45)", display: "block" }}
        />
      )}
      {badge ? (
        <span
          aria-hidden
          style={{ fontSize: 10, fontWeight: 700, lineHeight: 1, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.9)", pointerEvents: "none" }}
        >
          {badge}
        </span>
      ) : null}
      {count !== undefined ? (
        <span
          aria-hidden
          style={{
            position: "absolute", right: 3, bottom: 2, fontSize: 10, fontWeight: 700,
            lineHeight: 1, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.9)", pointerEvents: "none",
          }}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** スロットを flex-wrap で並べるだけのグリッド。 */
export function ItemSlotGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {children}
    </div>
  );
}

/**
 * 第2層の注釈カード。アイテム名 + desc を出し、children
 * （効果行・アクションボタン群）を続ける。同時に開くのは1つだけ
 * （開く側が選択状態を1つに保つ）。
 */
export function ItemAnnotation({ itemId, children }: { itemId: string; children?: ReactNode }) {
  const def = itemById(itemId);
  if (!def) return null;
  return (
    <div
      style={{
        marginTop: 10, padding: "9px 10px", borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <ItemIcon id={itemId} />
        <strong>{def.name}</strong>
        <span className="muted">{def.desc}</span>
      </div>
      {children}
    </div>
  );
}
