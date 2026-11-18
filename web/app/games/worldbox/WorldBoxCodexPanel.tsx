"use client";
// AGO WORLD BOX の冒険手帳パネル（実績・称号・レシピ図鑑）。
// 達成状況はプロフィール累計統計（stats）と発見済みレシピ（discoveredRecipes）を参照し、
// 解放済み称号の着脱は POST /api/worldbox/profile { action: "set_title" } で行う。
import { useEffect, useMemo, useState } from "react";
import {
  ACHIEVEMENT_CATEGORY_NAMES, ACHIEVEMENTS, evaluateAchievements,
  type AchievementCategory,
} from "@/lib/worldbox/achievements";
import { RECIPES, itemById, recipeKind, type RecipeKind } from "@/lib/worldbox/items";
import type { PlayerProfile } from "@/lib/worldbox/profile";
import { ItemAnnotation, ItemIcon, ItemSlot, ItemSlotGrid } from "./ItemSlotGrid";

const panelStyle: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(430px, calc(100% - 20px))", maxHeight: "calc(100% - 24px)",
  overflowY: "auto", overscrollBehavior: "contain", zIndex: 31,
  padding: "12px 14px", borderRadius: 12, textAlign: "left",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(10,12,20,0.95)", color: "#fff",
  boxShadow: "0 10px 32px rgba(0,0,0,0.55)",
};
const btn: React.CSSProperties = {
  minHeight: 32, padding: "3px 10px", borderRadius: 8, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.08)", color: "inherit",
  fontSize: 12, touchAction: "manipulation", userSelect: "none",
};
const tabBtn: React.CSSProperties = { ...btn, minHeight: 34, padding: "3px 12px", fontSize: 13 };
const tabOn: React.CSSProperties = {
  background: "rgba(255,210,62,0.22)", borderColor: "rgba(255,210,62,0.85)", fontWeight: 700,
};
const rowStyle: React.CSSProperties = {
  padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.08)",
  display: "flex", flexDirection: "column", gap: 5,
};
const unknownSlotStyle: React.CSSProperties = {
  boxSizing: "border-box",
  width: 48, height: 48, minWidth: 48, minHeight: 48, padding: 4,
  display: "flex", alignItems: "center", justifyContent: "center",
  borderRadius: 10, fontSize: 11, fontWeight: 700, opacity: 0.4,
  border: "1px dashed rgba(255,255,255,0.28)", background: "rgba(255,255,255,0.03)", color: "inherit",
};

const RECIPE_KIND_LABELS: Record<RecipeKind, string> = {
  craft: "合成",
  smelt: "精錬",
  cook: "調理",
  weave: "織り",
};

export default function WorldBoxCodexPanel({
  profile,
  onProfileChange,
  onClose,
}: {
  profile: PlayerProfile | null;
  onProfileChange: (profile: PlayerProfile) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"achievements" | "recipes">("achievements");
  const [cat, setCat] = useState<"all" | AchievementCategory>("all");
  const [rKind, setRKind] = useState<"all" | RecipeKind>("all");
  const [selRecipeId, setSelRecipeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const progress = useMemo(
    () =>
      evaluateAchievements({
        stats: profile?.stats,
        discoveredRecipes: profile?.discoveredRecipes,
      }),
    [profile?.stats, profile?.discoveredRecipes],
  );
  const unlockedCount = useMemo(() => progress.filter((a) => a.unlocked).length, [progress]);
  const filteredAch = useMemo(
    () => (cat === "all" ? progress : progress.filter((a) => a.def.category === cat)),
    [progress, cat],
  );

  const discoveredSet = useMemo(
    () => new Set(profile?.discoveredRecipes ?? []),
    [profile?.discoveredRecipes],
  );
  const filteredRecipes = useMemo(
    () => (rKind === "all" ? RECIPES : RECIPES.filter((r) => recipeKind(r) === rKind)),
    [rKind],
  );
  const selectedRecipe = useMemo(
    () => (selRecipeId ? RECIPES.find((r) => r.id === selRecipeId) ?? null : null),
    [selRecipeId],
  );

  const setTitle = async (title: string) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/worldbox/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_title", title }),
      });
      const json = (await res.json().catch(() => ({}))) as { profile?: PlayerProfile; error?: string };
      if (!res.ok || !json.profile) {
        setMsg(json.error === "title_locked" ? "未解放の称号" : "変更に失敗しました");
        return;
      }
      onProfileChange(json.profile);
      setMsg(title ? `称号「${title}」を装備` : "称号を外した");
    } catch {
      setMsg("変更に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={panelStyle} role="dialog" aria-label="冒険手帳" className="wb-panel">
      <div
        style={{
          display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
          position: "sticky", top: -12, zIndex: 3,
          margin: "-12px -14px 8px", padding: "12px 14px 8px",
          background: "rgba(10,12,20,0.98)",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <strong style={{ fontSize: 15 }}>冒険手帳</strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...tabBtn, ...(tab === "achievements" ? tabOn : {}) }}
          aria-pressed={tab === "achievements"}
          onClick={() => setTab("achievements")}
        >
          実績・称号
        </button>
        <button
          type="button"
          style={{ ...tabBtn, ...(tab === "recipes" ? tabOn : {}) }}
          aria-pressed={tab === "recipes"}
          onClick={() => setTab("recipes")}
        >
          レシピ図鑑
        </button>
        <button type="button" style={tabBtn} onClick={onClose}>
          閉じる
        </button>
      </div>

      {tab === "achievements" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>
              達成 {unlockedCount} / {ACHIEVEMENTS.length}
            </span>
            {profile?.title ? (
              <>
                <span style={{ fontSize: 12, color: "#ffd75e", fontWeight: 700 }}>
                  装備中: {profile.title}
                </span>
                <button type="button" style={btn} disabled={busy} onClick={() => void setTitle("")}>
                  外す
                </button>
              </>
            ) : (
              <span style={{ fontSize: 12, opacity: 0.6 }}>称号: なし</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <button
              type="button"
              style={{ ...btn, ...(cat === "all" ? tabOn : {}) }}
              aria-pressed={cat === "all"}
              onClick={() => setCat("all")}
            >
              すべて
            </button>
            {(Object.keys(ACHIEVEMENT_CATEGORY_NAMES) as AchievementCategory[]).map((k) => (
              <button
                key={k}
                type="button"
                style={{ ...btn, ...(cat === k ? tabOn : {}) }}
                aria-pressed={cat === k}
                onClick={() => setCat(k)}
              >
                {ACHIEVEMENT_CATEGORY_NAMES[k]}
              </button>
            ))}
          </div>
          <div>
            {filteredAch.map((a) => {
              const equipped = profile?.title === a.def.title;
              const pct = Math.min(100, Math.round((a.current / Math.max(1, a.target)) * 100));
              return (
                <div key={a.def.id} style={rowStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13, color: a.unlocked ? "#ffd75e" : "#fff" }}>
                      {a.def.name}
                    </strong>
                    <span style={{ fontSize: 11, opacity: 0.72 }}>{a.def.label}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, opacity: a.unlocked ? 1 : 0.75 }}>
                      {a.unlocked ? "達成" : `${a.current} / ${a.target}`}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div
                      aria-hidden
                      style={{
                        flex: 1, height: 5, borderRadius: 99, overflow: "hidden",
                        background: "rgba(255,255,255,0.12)",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`, height: "100%",
                          background: a.unlocked ? "#46a758" : "#ffd23e",
                        }}
                      />
                    </div>
                    {a.unlocked ? (
                      <button
                        type="button"
                        style={{ ...btn, ...(equipped ? tabOn : {}) }}
                        disabled={busy}
                        onClick={() => void setTitle(equipped ? "" : a.def.title)}
                      >
                        {equipped ? `装備中: ${a.def.title}` : `称号: ${a.def.title}`}
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, opacity: 0.55 }}>称号: {a.def.title}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "recipes" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>
              発見 {discoveredSet.size} / {RECIPES.length}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <button
              type="button"
              style={{ ...btn, ...(rKind === "all" ? tabOn : {}) }}
              aria-pressed={rKind === "all"}
              onClick={() => { setRKind("all"); setSelRecipeId(null); }}
            >
              すべて
            </button>
            {(Object.keys(RECIPE_KIND_LABELS) as RecipeKind[]).map((k) => (
              <button
                key={k}
                type="button"
                style={{ ...btn, ...(rKind === k ? tabOn : {}) }}
                aria-pressed={rKind === k}
                onClick={() => { setRKind(k); setSelRecipeId(null); }}
              >
                {RECIPE_KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <ItemSlotGrid>
            {filteredRecipes.map((r) => {
              const found = discoveredSet.has(r.id);
              if (!found) {
                return (
                  <button
                    key={r.id}
                    type="button"
                    disabled
                    aria-label="未発見レシピ"
                    style={unknownSlotStyle}
                  >
                    ???
                  </button>
                );
              }
              return (
                <ItemSlot
                  key={r.id}
                  itemId={r.output}
                  count={r.outputCount > 1 ? r.outputCount : undefined}
                  selected={selRecipeId === r.id}
                  onClick={() => setSelRecipeId((cur) => (cur === r.id ? null : r.id))}
                />
              );
            })}
          </ItemSlotGrid>
          {selectedRecipe && discoveredSet.has(selectedRecipe.id) && (
            <ItemAnnotation itemId={selectedRecipe.output}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                <span style={{ fontSize: 12, opacity: 0.75 }}>
                  {RECIPE_KIND_LABELS[recipeKind(selectedRecipe)]}
                </span>
                {Object.entries(selectedRecipe.inputs).map(([matId, count]) => (
                  <span
                    key={matId}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 4,
                      fontSize: 12, padding: "2px 6px", borderRadius: 6,
                      background: "rgba(255,255,255,0.07)",
                    }}
                  >
                    <ItemIcon id={matId} size={16} />
                    <span>{itemById(matId)?.name ?? matId}×{count}</span>
                  </span>
                ))}
              </div>
            </ItemAnnotation>
          )}
        </div>
      )}

      {msg && (
        <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{msg}</p>
      )}
    </div>
  );
}
