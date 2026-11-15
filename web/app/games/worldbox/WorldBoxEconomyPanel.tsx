"use client";
// AGO WORLD BOX の経済パネル（かばん・ショップ・合成・steal・労働）。
// Discord ボット側の経済機能（items / workshop craft / circulation steal）の
// 規則をそのまま使い、状態は /api/worldbox/profile が正とする。
import { useCallback, useEffect, useRef, useState } from "react";
import { ITEMS, RECIPES, itemById, sellPrice } from "@/lib/worldbox/items";
import type { PlayerProfile } from "@/lib/worldbox/profile";

type Tab = "bag" | "shop" | "craft" | "steal";
type LoadState = "loading" | "ready" | "guest" | "unavailable";
type StealTarget = { id: string; name: string };

const ERROR_LABEL: Record<string, string> = {
  not_enough_coins: "コインが足りません",
  not_enough_items: "アイテムが足りません",
  hunger_full: "もう満腹です",
  too_tired: "空腹度が足りません。食べてから働きましょう",
  steal_cooldown: "steal はクールダウン中です",
  target_protected: "その相手からは盗めません（所持金が少ないか、防犯チャームで保護されています）",
  target_recently_stolen: "その相手は最近盗まれたばかりで保護されています",
  self_target: "自分からは盗めません",
  unauthorized: "ログインが必要です",
};

const panel: React.CSSProperties = {
  maxWidth: 640, margin: "12px auto 0", padding: 14, borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.04)", textAlign: "left",
};
const btn: React.CSSProperties = {
  minHeight: 36, padding: "4px 12px", borderRadius: 10, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
  touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
};
const row: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
  padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.08)",
};

export default function WorldBoxEconomyPanel() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [tab, setTab] = useState<Tab>("bag");
  const [targets, setTargets] = useState<StealTarget[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const refreshProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/profile", { headers: { Accept: "application/json" } });
      if (res.status === 401) {
        if (aliveRef.current) setLoadState("guest");
        return;
      }
      if (!res.ok) {
        if (aliveRef.current) setLoadState("unavailable");
        return;
      }
      const data = (await res.json()) as { profile: PlayerProfile };
      if (aliveRef.current) {
        setProfile(data.profile);
        setLoadState("ready");
      }
    } catch {
      if (aliveRef.current) setLoadState("unavailable");
    }
  }, []);

  const refreshTargets = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/presence", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { players?: StealTarget[] };
      if (aliveRef.current && Array.isArray(data.players)) {
        setTargets(data.players.map((p) => ({ id: p.id, name: p.name })));
      }
    } catch { /* 対象が読めなくても他の機能は使える */ }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void refreshProfile();
    void refreshTargets();
    return () => {
      aliveRef.current = false;
    };
  }, [refreshProfile, refreshTargets]);

  const act = async (payload: Record<string, unknown>, describe: (data: Record<string, unknown>) => string) => {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/worldbox/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        profile?: PlayerProfile; error?: string;
      };
      if (!res.ok || !data.profile) {
        setMsg(ERROR_LABEL[data.error ?? ""] ?? "できませんでした");
        return;
      }
      setProfile(data.profile);
      setMsg(describe(data));
    } catch {
      setMsg("できませんでした");
    } finally {
      setBusy(false);
    }
  };

  if (loadState === "loading") return <div style={panel}>読み込み中…</div>;
  if (loadState === "guest") {
    return (
      <div style={panel}>
        経済機能（かばん・ショップ・合成・steal）を使うにはログインが必要です。
      </div>
    );
  }
  if (loadState === "unavailable" || !profile) {
    return <div style={panel}>いまは経済機能を使えません。</div>;
  }

  const owned = ITEMS.filter((item) => (profile.items[item.id] ?? 0) > 0);
  const tabBtn = (t: Tab, label: string) => (
    <button
      type="button"
      style={{ ...btn, ...(tab === t ? { background: "rgba(255,210,62,0.18)", borderColor: "rgba(255,210,62,0.55)" } : {}) }}
      onClick={() => setTab(t)}
      aria-pressed={tab === t}
    >
      {label}
    </button>
  );

  return (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong>経済</strong>
        <span>所持金 <strong>{profile.coins}</strong> コイン</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          空腹度
          <span style={{ width: 90, height: 10, borderRadius: 5, background: "rgba(255,255,255,0.12)", overflow: "hidden", display: "inline-block" }}>
            <span style={{ display: "block", width: `${profile.hunger}%`, height: "100%", background: profile.hunger <= 20 ? "#ff7a59" : "#ffd23e" }} />
          </span>
          <strong>{profile.hunger}</strong>
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={btn}
          disabled={busy}
          onClick={() => void act({ action: "work" }, () => "働いて 20 コイン得た（空腹度 -10）")}
        >
          労働する
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        {tabBtn("bag", "かばん")}
        {tabBtn("shop", "ショップ")}
        {tabBtn("craft", "合成")}
        {tabBtn("steal", "steal")}
      </div>

      {tab === "bag" && (
        <div style={{ marginTop: 6 }}>
          {owned.length === 0 && <p className="muted">かばんは空です。ショップで買うか、合成で作りましょう。</p>}
          {owned.map((item) => (
            <div key={item.id} style={row}>
              <strong>{item.name}</strong>
              <span className="muted">× {profile.items[item.id]}</span>
              <span className="muted">{item.desc}</span>
              <span style={{ flex: 1 }} />
              {item.hunger && (
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act({ action: "eat", itemId: item.id }, () => `${item.name}を食べて空腹度が回復した`)}>
                  食べる（+{item.hunger}）
                </button>
              )}
              <button type="button" style={btn} disabled={busy}
                onClick={() => void act({ action: "sell", itemId: item.id }, () => `${item.name}を ${sellPrice(item)} コインで売った`)}>
                売る（{sellPrice(item)}）
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "shop" && (
        <div style={{ marginTop: 6 }}>
          {ITEMS.map((item) => (
            <div key={item.id} style={row}>
              <strong>{item.name}</strong>
              <span className="muted">{item.desc}</span>
              {item.hunger ? <span className="muted">空腹度 +{item.hunger}</span> : null}
              <span style={{ flex: 1 }} />
              <span>{item.price} コイン</span>
              <button type="button" style={btn} disabled={busy}
                onClick={() => void act({ action: "buy", itemId: item.id }, () => `${item.name}を買った`)}>
                買う
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "craft" && (
        <div style={{ marginTop: 6 }}>
          {RECIPES.map((recipe) => {
            const output = itemById(recipe.output);
            const inputs = Object.entries(recipe.inputs)
              .map(([id, n]) => `${itemById(id)?.name ?? id}×${n}（所持 ${profile.items[id] ?? 0}）`)
              .join(" + ");
            return (
              <div key={recipe.id} style={row}>
                <strong>{output?.name ?? recipe.output}</strong>
                <span className="muted">{inputs}</span>
                {recipe.rareItem && <span className="muted">レア: {itemById(recipe.rareItem)?.name}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" style={btn} disabled={busy}
                  onClick={() => void act(
                    { action: "craft", recipeId: recipe.id },
                    (data) => `${output?.name ?? "アイテム"}を作った${data.rareId ? `（レア: ${itemById(data.rareId as string)?.name}も手に入れた！）` : ""}`,
                  )}>
                  合成する
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === "steal" && (
        <div style={{ marginTop: 6 }}>
          <p className="muted" style={{ margin: "4px 0" }}>
            いま歩いている相手からコインを盗みます。成功率40%、失敗すると罰金20コイン。
            所持金50未満の相手と防犯チャーム持ちは保護されます。実行後は10分間できません。
          </p>
          <button type="button" style={btn} disabled={busy} onClick={() => void refreshTargets()}>
            対象を更新
          </button>
          {targets.length === 0 && <p className="muted">いま対象にできる相手がいません。</p>}
          {targets.map((t) => (
            <div key={t.id} style={row}>
              <strong>{t.name}</strong>
              <span style={{ flex: 1 }} />
              <button type="button" style={btn} disabled={busy}
                onClick={() => void act(
                  { action: "steal", targetId: t.id },
                  (data) => data.success
                    ? `${t.name}から ${data.amount} コインを盗んだ！`
                    : `失敗… ${t.name}に罰金 ${data.amount} コインを払った`,
                )}>
                steal
              </button>
            </div>
          ))}
        </div>
      )}

      {msg && <p role="status" style={{ margin: "10px 0 0" }}>{msg}</p>}
    </div>
  );
}
