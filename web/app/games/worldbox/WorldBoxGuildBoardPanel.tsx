"use client";
// AGO WORLD BOX のギルドボードパネル（ロビー中央広場のギルドボード専用）。
// タブは3つ: 「依頼」（ユニオン内のアイテム依頼: 投稿・納品・取消）と
// 「役職」（国 = Discord サーバーへの建国・参加・離脱と自分の役職）と
// 「冒険役職」（剣士/守護/斥候/採掘者/薬師の選択と熟練ランク表示）。
// 役職まわりの home はここ: ≡ メニューには置かない。
// コインの正は AGO コイン本体: 依頼の預かり・報酬・返金は API 側が
// 経済ブリッジのオプとして積む（このパネルは結果を表示するだけ）。
import { useCallback, useEffect, useState } from "react";
import { ITEMS, itemById } from "@/lib/worldbox/items";
import type { NationRole, NationsResponse } from "@/lib/worldbox/nations";
import type { PlayerProfile } from "@/lib/worldbox/profile";
import { ADVENTURE_ROLES, masteryRankOf, type AdventureRoleId } from "@/lib/worldbox/roles";
import type { GuildRequest } from "@/lib/worldbox/requests";

const ROLE_LABEL: Record<NationRole, string> = { king: "王", minister: "大臣", citizen: "国民" };

const REQUEST_ERROR_LABEL: Record<string, string> = {
  not_enough_coins: "コインが足りません",
  not_enough_items: "アイテムが足りません",
  too_many_guild: "依頼がいっぱいです",
  too_many_poster: "自分の依頼がいっぱいです",
  not_in_nation: "国に所属していません",
  not_at_guild_board: "ギルドボードの前で操作してください",
  invalid_reward: "報酬が不正です",
  invalid_count: "個数が不正です",
  unknown_item: "アイテムが不正です",
  not_found: "依頼が見つかりません",
  requests_unavailable: "いま使えません",
  economy_unavailable: "いま使えません",
  economy_failed: "受け付けられませんでした",
  store_failed: "保存に失敗しました",
  unauthorized: "ログインが必要です",
  discord_required: "Discord ログインが必要です",
};

type RequestView = GuildRequest & { mine: boolean };

type RequestsData = {
  loggedIn: boolean;
  me: { guildId: string; guildName: string; role: NationRole } | null;
  requests: RequestView[];
};

const root: React.CSSProperties = {
  position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
  width: "min(430px, calc(100% - 24px))", maxHeight: "calc(100% - 24px)", overflowY: "auto",
  padding: 14, borderRadius: 12, zIndex: 6, textAlign: "left",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(10,12,20,0.94)", color: "#fff",
  boxShadow: "0 10px 32px rgba(0,0,0,0.55)",
};
const btn: React.CSSProperties = {
  minHeight: 38, padding: "4px 14px", borderRadius: 10, cursor: "pointer",
  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.07)", color: "inherit",
  touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
};
const tabBtn: React.CSSProperties = { ...btn, minHeight: 34, padding: "2px 12px", fontSize: 13 };
const tabOn: React.CSSProperties = {
  background: "rgba(255,210,62,0.22)", borderColor: "rgba(255,210,62,0.8)",
};
const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
  padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.08)",
};
const input: React.CSSProperties = {
  minHeight: 38, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)",
  background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14,
};

function ItemIcon({ id, size = 24 }: { id: string; size?: number }) {
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

export default function WorldBoxGuildBoardPanel({
  nations,
  nationMsg,
  onNationAction,
  profile,
  onProfileChange,
  getPlayerPos,
  onClose,
}: {
  nations: NationsResponse;
  nationMsg: string;
  onNationAction: (body: Record<string, unknown>) => void;
  profile: PlayerProfile | null;
  onProfileChange: (profile: PlayerProfile) => void;
  getPlayerPos: () => { x: number; y: number };
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"requests" | "roles" | "adventure" | "board">("requests");
  // ユニオン掲示（チャット）と Discord 連携設定
  const [unionMsgs, setUnionMsgs] = useState<{ name: string; text: string; at: number }[]>([]);
  const [unionRole, setUnionRole] = useState<string>("");
  const [unionChannelId, setUnionChannelId] = useState("");
  const [unionChannelInput, setUnionChannelInput] = useState("");
  const refreshUnion = useCallback(async () => {
    try {
      const [chatRes, setRes] = await Promise.all([
        fetch("/api/worldbox/chat?channel=union", { headers: { Accept: "application/json" } }),
        fetch("/api/worldbox/union-settings", { headers: { Accept: "application/json" } }),
      ]);
      if (chatRes.ok) {
        const data = (await chatRes.json()) as { messages?: { name: string; text: string; at: number }[] };
        setUnionMsgs(data.messages ?? []);
      }
      if (setRes.ok) {
        const data = (await setRes.json()) as { role?: string; chatChannelId?: string };
        setUnionRole(data.role ?? "");
        setUnionChannelId(data.chatChannelId ?? "");
        setUnionChannelInput(data.chatChannelId ?? "");
      }
    } catch { /* 読めなくてもパネルは開いたままにする */ }
  }, []);
  useEffect(() => {
    if (tab === "board") void refreshUnion();
  }, [tab, refreshUnion]);
  const saveUnionChannel = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/worldbox/union-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: unionChannelInput.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as { chatChannelId?: string; error?: string };
      if (res.ok) {
        setUnionChannelId(json.chatChannelId ?? "");
        setMsg("保存した");
      } else {
        setMsg(json.error === "invalid_channel_id" ? "チャンネルIDが不正" : "保存できない");
      }
    } catch {
      setMsg("保存できない");
    } finally {
      setBusy(false);
    }
  };
  const [data, setData] = useState<RequestsData | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [formItem, setFormItem] = useState<string>(ITEMS[0]?.id ?? "");
  const [formCount, setFormCount] = useState(1);
  const [formReward, setFormReward] = useState(100);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/worldbox/requests", { headers: { Accept: "application/json" } });
      if (res.ok) setData((await res.json()) as RequestsData);
    } catch { /* 読めなくてもパネルは開いたままにする */ }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (body: Record<string, unknown>, done?: (res: Record<string, unknown>) => void) => {
    setMsg("");
    setBusy(true);
    try {
      const res = await fetch("/api/worldbox/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setMsg(REQUEST_ERROR_LABEL[json.error as string] ?? "失敗しました");
        return;
      }
      if (Array.isArray(json.requests)) {
        setData((prev) => (prev ? { ...prev, requests: json.requests as RequestView[] } : prev));
      }
      done?.(json);
    } catch {
      setMsg("失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const me = nations.me;
  const myNation = me ? nations.nations.find((n) => n.id === me.nationId) ?? null : null;
  const foundable = nations.myGuilds.filter((g) => g.owner && !g.hasNation);
  const joinable = nations.myGuilds.filter((g) => g.hasNation);
  const myGuildIds = new Set(nations.myGuilds.map((g) => g.guildId));
  const others = [...nations.nations]
    .filter((n) => !myGuildIds.has(n.guildId))
    .sort((a, b) => b.prosperity - a.prosperity);
  const pos = getPlayerPos();

  return (
    <div style={root} role="dialog" aria-label="ギルドボード">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>ギルドボード</strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...tabBtn, ...(tab === "requests" ? tabOn : {}) }}
          aria-pressed={tab === "requests"}
          onClick={() => setTab("requests")}
        >
          依頼
        </button>
        <button
          type="button"
          style={{ ...tabBtn, ...(tab === "roles" ? tabOn : {}) }}
          aria-pressed={tab === "roles"}
          onClick={() => setTab("roles")}
        >
          役職
        </button>
        <button
          type="button"
          style={{ ...tabBtn, ...(tab === "adventure" ? tabOn : {}) }}
          aria-pressed={tab === "adventure"}
          onClick={() => setTab("adventure")}
        >
          冒険役職
        </button>
        <button
          type="button"
          style={{ ...tabBtn, ...(tab === "board" ? tabOn : {}) }}
          aria-pressed={tab === "board"}
          onClick={() => setTab("board")}
        >
          掲示
        </button>
        <button type="button" style={tabBtn} onClick={onClose}>
          閉じる
        </button>
      </div>

      {tab === "requests" && (
        <div style={{ marginTop: 10 }}>
          {data === null ? (
            <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>読み込み中…</p>
          ) : !data.loggedIn ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, opacity: 0.75 }}>ログインが必要</span>
              <a
                href="/api/auth/discord/authorize?next=/games/worldbox"
                style={{ ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              >
                Discordでログイン
              </a>
            </div>
          ) : !data.me ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, opacity: 0.75 }}>国に所属していません</span>
              <button type="button" style={btn} onClick={() => setTab("roles")}>
                役職を見る
              </button>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 14 }}>{data.me.guildName}</strong>
                <span style={{ fontSize: 13, opacity: 0.75 }}>{ROLE_LABEL[data.me.role]}</span>
              </div>
              {data.requests.length === 0 ? (
                <p style={{ margin: "10px 0 0", fontSize: 13, opacity: 0.75 }}>依頼はありません</p>
              ) : (
                <div style={{ marginTop: 6 }}>
                  {data.requests.map((r) => {
                    const def = itemById(r.itemId);
                    const have = profile?.items[r.itemId] ?? 0;
                    return (
                      <div key={r.id} style={rowStyle}>
                        <ItemIcon id={r.itemId} />
                        <span style={{ fontSize: 14 }}>
                          {def?.name ?? r.itemId} ×{r.count}
                        </span>
                        <span style={{ fontSize: 13, color: "#ffd23e" }}>{r.reward}</span>
                        <span style={{ fontSize: 12, opacity: 0.75 }}>{r.posterName}</span>
                        <span style={{ flex: 1 }} />
                        {r.mine ? (
                          <button
                            type="button"
                            style={btn}
                            disabled={busy}
                            onClick={() => void act({ action: "cancel", requestId: r.id })}
                          >
                            取消
                          </button>
                        ) : (
                          <button
                            type="button"
                            style={btn}
                            disabled={busy || have < r.count}
                            onClick={() => void act(
                              { action: "fulfill", requestId: r.id },
                              (res) => {
                                if (res.profile) onProfileChange(res.profile as PlayerProfile);
                              },
                            )}
                          >
                            納品（所持 {have}）
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
                  marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.15)",
                }}
              >
                <select
                  aria-label="アイテム"
                  value={formItem}
                  onChange={(e) => setFormItem(e.target.value)}
                  style={{ ...input, maxWidth: 150 }}
                >
                  {ITEMS.map((item) => (
                    <option key={item.id} value={item.id} style={{ color: "#000" }}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="個数"
                  type="number"
                  min={1}
                  max={99}
                  value={formCount}
                  onChange={(e) => setFormCount(Number(e.target.value))}
                  style={{ ...input, width: 64 }}
                />
                <input
                  aria-label="報酬"
                  type="number"
                  min={1}
                  value={formReward}
                  onChange={(e) => setFormReward(Number(e.target.value))}
                  style={{ ...input, width: 96 }}
                />
                <button
                  type="button"
                  style={btn}
                  disabled={busy}
                  onClick={() => void act({
                    action: "post", itemId: formItem, count: formCount, reward: formReward,
                  })}
                >
                  依頼を出す
                </button>
              </div>
            </div>
          )}
          {msg && <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{msg}</p>}
        </div>
      )}

      {tab === "adventure" && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {Object.values(ADVENTURE_ROLES).map((r) => {
            const rank = profile ? masteryRankOf(profile, r.id) : 1;
            const current = profile?.role === r.id;
            return (
              <div key={r.id} style={{ ...rowStyle, justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    aria-hidden
                    style={{
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 26, height: 26, borderRadius: 7, fontSize: 14, fontWeight: 700,
                      border: "1px solid rgba(255,255,255,0.35)",
                      background: current ? "rgba(255,210,62,0.25)" : "rgba(255,255,255,0.08)",
                    }}
                  >
                    {r.symbol}
                  </span>
                  <strong>{r.name}</strong>
                  <span aria-label={`熟練ランク ${rank}`} style={{ letterSpacing: 2, fontSize: 11 }}>
                    {"●".repeat(rank)}
                    <span style={{ opacity: 0.3 }}>{"●".repeat(5 - rank)}</span>
                  </span>
                </span>
                <button
                  type="button"
                  style={{ ...btn, ...(current ? tabOn : {}) }}
                  disabled={busy || current || !profile}
                  onClick={async () => {
                    setBusy(true);
                    setMsg("");
                    try {
                      const res = await fetch("/api/worldbox/roles", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ action: "set_role", role: r.id as AdventureRoleId }),
                      });
                      const json = (await res.json().catch(() => ({}))) as { profile?: PlayerProfile; error?: string };
                      if (res.ok && json.profile) {
                        onProfileChange(json.profile);
                        setMsg(`${r.name}になりました`);
                      } else {
                        setMsg(json.error === "not_at_guild_board" ? "ギルドボードの前で操作してください" : "変更できませんでした");
                      }
                    } catch {
                      setMsg("変更できませんでした");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {current ? "選択中" : "選ぶ"}
                </button>
              </div>
            );
          })}
          {msg && <div style={{ fontSize: 13 }}>{msg}</div>}
        </div>
      )}

      {tab === "board" && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }}>
            {unionMsgs.length === 0 ? (
              <span style={{ fontSize: 13, opacity: 0.75 }}>まだ投稿がない</span>
            ) : (
              [...unionMsgs].reverse().map((m, i) => (
                <div key={i} style={{ fontSize: 13 }}>
                  <strong>{m.name}</strong>
                  <span style={{ opacity: 0.6, marginLeft: 6, fontSize: 11 }}>
                    {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <div>{m.text}</div>
                </div>
              ))
            )}
          </div>
          {(unionRole === "king" || unionRole === "minister") && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, opacity: 0.8 }}>Discord連携</span>
              <input
                value={unionChannelInput}
                onChange={(e) => setUnionChannelInput(e.target.value)}
                placeholder="チャンネルID"
                inputMode="numeric"
                style={{ flex: 1, minWidth: 140, padding: "6px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: 13 }}
              />
              <button type="button" style={btn} disabled={busy} onClick={() => { void saveUnionChannel(); }}>
                保存
              </button>
              {unionChannelId && <span style={{ fontSize: 12, opacity: 0.75 }}>連携中</span>}
            </div>
          )}
          {msg && <div style={{ fontSize: 13, marginTop: 6 }}>{msg}</div>}
        </div>
      )}

      {tab === "roles" && (
        <div style={{ marginTop: 10 }}>
          {me && myNation ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: myNation.color, display: "inline-block" }} />
              <strong>{myNation.name}</strong>
              <span>{ROLE_LABEL[me.role]}</span>
              <span style={{ opacity: 0.75, fontSize: 13 }}>国民 {myNation.members}人</span>
              <span style={{ opacity: 0.75, fontSize: 13 }}>繁栄度 {myNation.prosperity}</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={btn}
                onClick={() => onNationAction({ action: "leave" })}
              >
                {me.role === "king" && myNation.members <= 1 ? "解散" : "離脱"}
              </button>
            </div>
          ) : (
            <div>
              {nations.loggedIn && nations.guildsScopeRequired && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                  <span style={{ fontSize: 13, opacity: 0.75 }}>サーバー一覧の取得に再ログインが必要</span>
                  <a
                    href="/api/auth/discord/authorize?next=/games/worldbox"
                    style={{ ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                  >
                    Discordで再ログイン
                  </a>
                </div>
              )}
              {nations.loggedIn && !nations.guildsScopeRequired && foundable.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <p style={{ margin: "0 0 6px", fontSize: 13 }}>建国できるサーバー</p>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                    {foundable.map((g) => (
                      <li key={g.guildId} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <strong>{g.name}</strong>
                        <span style={{ flex: 1 }} />
                        <button type="button" style={btn} onClick={() => onNationAction({ action: "found", guildId: g.guildId })}>
                          建国
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {nations.loggedIn && !nations.guildsScopeRequired && joinable.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <p style={{ margin: "0 0 6px", fontSize: 13 }}>国があるサーバー</p>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                    {joinable.map((g) => {
                      const n = nations.nations.find((x) => x.guildId === g.guildId);
                      return (
                        <li key={g.guildId} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          {n && (
                            <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: n.color, display: "inline-block" }} />
                          )}
                          <strong>{g.name}</strong>
                          <span style={{ opacity: 0.75, fontSize: 13 }}>{ROLE_LABEL[g.myRole]}{n ? ` ・ ${n.members}人` : ""}</span>
                          <span style={{ flex: 1 }} />
                          <button type="button" style={btn} onClick={() => onNationAction({ action: "join", guildId: g.guildId })}>
                            参加
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {others.length === 0 && joinable.length === 0 ? (
                <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>まだ国はありません</p>
              ) : others.length > 0 ? (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                  {others.map((n) => {
                    const dist = Math.round(Math.hypot(n.capital.x + 0.5 - pos.x, n.capital.y + 0.5 - pos.y));
                    return (
                      <li key={n.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", opacity: 0.55 }}>
                        <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: n.color, display: "inline-block" }} />
                        <strong>{n.name}</strong>
                        <span style={{ fontSize: 13 }}>{n.members}人 ・ 繁栄度 {n.prosperity} ・ {dist}タイル</span>
                        <span style={{ flex: 1 }} />
                        {nations.loggedIn && (
                          <button type="button" style={btn} disabled>
                            参加
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {!nations.loggedIn && (
                <p style={{ margin: "10px 0 0", fontSize: 13, opacity: 0.75 }}>建国・参加はログイン後</p>
              )}
            </div>
          )}
          {nationMsg && (
            <p role="status" style={{ margin: "10px 0 0", fontSize: 13 }}>{nationMsg}</p>
          )}
        </div>
      )}
    </div>
  );
}
