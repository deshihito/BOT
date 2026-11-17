"use strict";
// AGO WORLD BOX リアルタイム中継ラッパー（本番専用の起動エントリ）。
// deploy-web.sh が standalone の server.js を next-server.js へ改名し、
// このファイルを server.js としてリリースへ設置する。
// 通常の HTTP は内部ポートの Next へそのまま流し、
// /api/worldbox/realtime の WebSocket だけをここで受けてプレゼンスを中継する。
// 中継が初期化に失敗してもサイト本体は動き続け、クライアントは従来の
// ポーリング（REST プレゼンス）へ戻る。
const http = require("node:http");
const path = require("node:path");

const PUBLIC_PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
const NEXT_PORT = Number(process.env.AGOBOT_NEXT_PORT || 3100);
const REALTIME_PATH = "/api/worldbox/realtime";

// Next 本体（standalone の元 server.js）を内部ポートで起動する
process.env.PORT = String(NEXT_PORT);
require(path.join(__dirname, "next-server.js"));

// ---- HTTP プロキシ（Next へ素通し） ----
const server = http.createServer((req, res) => {
  const up = http.request(
    { host: "127.0.0.1", port: NEXT_PORT, path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("bad gateway");
  });
  req.pipe(up);
});

// ---- WebSocket 中継 ----
const core = require(path.join(__dirname, "realtime", "relay-core.js"));
const botkv = require(path.join(__dirname, "realtime", "botkv.js"));
const watchCore = require(path.join(__dirname, "realtime", "watch-core.js"));
const secret = process.env.DISCORD_SESSION_SECRET || process.env.DISCORD_CLIENT_SECRET || "";

let wss = null;
try {
  const { WebSocketServer } = require("ws");
  wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
} catch (err) {
  console.error("[realtime] ws module unavailable; relay disabled:", err && err.message);
}

const room = core.createRoom();
/** ws -> { pid, name, space, joined, lastMsgAt, alive } */
const clients = new Map();
/** bot-api の設定（未設定なら null = relay の kv 機能は無効）。 */
const kvCfg = botkv.botKvConfig();

function broadcast(space, exceptWs, obj) {
  const text = JSON.stringify(obj);
  for (const [ws, info] of clients) {
    if (ws === exceptWs || info.space !== space || ws.readyState !== 1) continue;
    try {
      ws.send(text);
    } catch { /* noop */ }
  }
}

// ---- 移動連続性の外部基準（B4） ----
// 部屋に前回が無い再接続後の初回ハートビートを照合する基準。bot_kv の
// プレゼンス（ts 付きなら時刻基準）、無ければセーブ（ts 無しのため固定距離）。
// 読み終わるまで受信ハートビートをためておき、未照合のまま通さない。

/** プレゼンス値（JSON）→ { x, y, space, ts }。壊れていれば null。 */
function parsePresenceBaseline(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.x !== "number" || typeof v.y !== "number" || typeof v.ts !== "number") return null;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.ts)) return null;
    return { x: v.x, y: v.y, space: typeof v.space === "string" ? v.space : "world", ts: v.ts };
  } catch {
    return null;
  }
}

/** セーブ値（JSON）→ { x, y, space }（ts 無し）。壊れていれば null。 */
function parseSaveBaseline(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.x !== "number" || typeof v.y !== "number") return null;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return { x: v.x, y: v.y, space: typeof v.space === "string" ? v.space : "world" };
  } catch {
    return null;
  }
}

/** bot_kv から外部基準を読む。読めなければ null（= 照合なしで受け入れる）。 */
async function loadExternalBaseline(ownerKey) {
  if (!kvCfg || !ownerKey) return null;
  try {
    const pres = parsePresenceBaseline(await botkv.kvGet(kvCfg, "worldbox_presence", ownerKey));
    if (pres) return pres;
    return parseSaveBaseline(await botkv.kvGet(kvCfg, "worldbox_save", ownerKey));
  } catch {
    return null;
  }
}

if (wss) {
  /** ハートビート1件の処理（中継・集約書き込み・配信）。却下された申告は
   * 保存せず、送り主へ保管位置（jump）を返してそこへ戻させる。 */
  const handleHeartbeat = (ws, info, msg, now) => {
    const entry = core.acceptHeartbeat(room, info.pid, info.name, msg, now, info.baseline, info.avatar);
    if (!entry) return;
    if (entry.rejected) {
      try {
        ws.send(JSON.stringify({ t: "jump", x: entry.x, y: entry.y, space: entry.space }));
      } catch { /* noop */ }
      return;
    }
    info.lastEntry = entry;
    writePresenceKv(info, entry, false);
    const prevSpace = info.space;
    info.space = entry.space;
    if (prevSpace && prevSpace !== entry.space) {
      broadcast(prevSpace, ws, { t: "bye", id: info.pid });
    }
    if (!info.joined) {
      info.joined = true;
      try {
        ws.send(JSON.stringify({ t: "snap", now, players: core.snapshot(room, entry.space, info.pid, now) }));
      } catch { /* noop */ }
    }
    broadcast(entry.space, ws, { t: "up", now, p: entry });
  };

  wss.on("connection", (ws) => {
    const auth = ws._rtAuth;
    const info = { pid: auth.pid, name: auth.name, ok: auth.ok ?? null, avatar: auth.av ?? null, space: null, joined: false, lastMsgAt: 0, alive: true, lastEntry: null, baseline: undefined, pendingHbs: [] };
    clients.set(ws, info);
    // タブ世代（同一アカウントの分身防止）: 旧世代の接続は受け付けず、
    // 世代交代時は旧世代の接続をすべて閉じる（閉じられた側は再接続しない）。
    const admit = core.admitTab(room, auth.pid, auth.tab, auth.tabAt);
    if (admit.verdict === "reject") {
      clients.delete(ws);
      try {
        ws.close(4001, "tab_superseded");
      } catch { /* noop */ }
      return;
    }
    if (admit.evict) {
      for (const [otherWs, otherInfo] of clients) {
        if (otherWs !== ws && otherInfo.pid === auth.pid) {
          try {
            otherWs.close(4001, "tab_superseded");
          } catch { /* noop */ }
        }
      }
    }
    // 移動連続性の外部基準（B4）: 接続時に bot_kv から1回だけ読む。
    // 読み終わるまで受信ハートビートをため、解決後に受信時刻つきで順に処理する。
    if (kvCfg && info.ok) {
      loadExternalBaseline(info.ok).then((b) => {
        // 解決前に切断されていたら、ためた分は捨てる
        if (!clients.has(ws)) return;
        info.baseline = b;
        const queued = info.pendingHbs.splice(0);
        for (const q of queued) handleHeartbeat(ws, info, q.msg, q.now);
      });
    } else {
      info.baseline = null;
    }
    // プレゼンス集約の合図（Phase 2）: 集約が有効で所有者キーがある
    // 接続にだけ送る。これを受けたクライアントは REST ハートビートを止める。
    if (aggState.on && info.ok) {
      try {
        ws.send(JSON.stringify({ t: "hello", now: Date.now(), agg: 1 }));
      } catch { /* noop */ }
    }
    ws.on("pong", () => {
      info.alive = true;
    });
    ws.on("message", (data) => {
      const now = Date.now();
      if (now - info.lastMsgAt < 40) return; // 1接続あたり 25 msg/秒まで
      info.lastMsgAt = now;
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg && msg.t === "note") {
        // ピアノの音: ロビーにいる奏者の音だけを、同じロビーの全員へ中継する
        const notes = core.sanitizePianoNotes(msg.notes);
        if (notes && info.space === "lobby") {
          broadcast("lobby", ws, { t: "note", notes, id: info.pid });
        }
        return;
      }
      if (!msg || msg.t !== "hb") return;
      // 外部基準が未解決ならためておき、解決後に受信時刻つきで処理する
      if (info.baseline === undefined) {
        info.pendingHbs.push({ msg, now });
        return;
      }
      handleHeartbeat(ws, info, msg, now);
    });
    const onGone = () => {
      if (!clients.delete(ws)) return;
      // 同じ pid の接続がまだ残っているなら、プレイヤーは在席のまま（世代交代で
      // 閉じられた旧タブの後始末で現行エントリや最終位置を上書きしない）。
      for (const otherInfo of clients.values()) {
        if (otherInfo.pid === info.pid) return;
      }
      // 切断時は最終位置を鮮度つきで書き残す（bot_kv 側は鮮度切れで自然に
      // 消える。REST の DELETE は従来どおりクライアント側の退室処理が担う）
      if (info.lastEntry && info.ok) {
        writePresenceKv(info, { ...info.lastEntry, ts: Date.now() }, true);
      }
      core.forgetPresenceWrite(aggregator, info.pid);
      for (const space of core.removePlayer(room, info.pid)) {
        broadcast(space, ws, { t: "bye", id: info.pid });
      }
    };
    ws.on("close", onGone);
    ws.on("error", onGone);
  });

  // 死活監視（30秒ごとに ping、応答が無ければ切る）
  setInterval(() => {
    for (const [ws, info] of clients) {
      if (!info.alive) {
        try {
          ws.terminate();
        } catch { /* noop */ }
        continue;
      }
      info.alive = false;
      try {
        ws.ping();
      } catch { /* noop */ }
    }
  }, 30_000);

  // 鮮度切れの掃除（切断通知が漏れた場合の保険）
  setInterval(() => {
    const now = Date.now();
    for (const gone of core.pruneRoom(room, now)) {
      broadcast(gone.space, null, { t: "bye", id: gone.id });
    }
  }, 5_000);

  // 時計同期と生存通知の定期 tick: 無人の空間でもクライアントの時計補正
  // （snap/up の now と同じ経路）が進み、WS の生存判定（無応答検知）が
  // 効くようにする。プレゼンス REST ポーリング間引き（Phase 0）の前提。
  setInterval(() => {
    const text = JSON.stringify({ t: "tick", now: Date.now() });
    for (const [ws] of clients) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(text);
      } catch { /* noop */ }
    }
  }, 15_000);

  // ---- watch: bot_kv のサーバー側一括監視と差分配信（Phase 1） ----
  // クライアント全員が各自に叩いていた読み取りポーリング（chat/party/
  // tiles/mobs/board/nations）を、relay が名前空間ごとに1回だけ読んで
  // 差分を配る形に集約する。bot-api 未設定なら watch は無効で、
  // クライアントは従来ポーリングのまま動く。
  // （kvCfg は接続時の外部基準読みにも使うため、ファイル冒頭で定義済み）

  // ---- プレゼンス集約書き込み（Phase 2） ----
  // WS で受けた位置を relay が bot_kv（worldbox_presence）へスロットル
  // 書き込みし、クライアントの REST ハートビートを置き換える。bot_kv が
  // サーバー検証の正である点は従来どおり（書く者が relay に移るだけ）。
  // 集約が有効なのは bot-api 設定済み + トークンに所有者キーがある場合
  // のみで、接続時に { t: "hello", agg: 1 } で合図する。書き込み失敗が
  // 続いたら { t: "agg", on: false } で知らせ、クライアントは REST へ戻る。
  const aggregator = core.createAggregator();
  const aggState = { on: Boolean(kvCfg), failStreak: 0 };
  const broadcastAggState = () => {
    const text = JSON.stringify({ t: "agg", on: aggState.on });
    for (const [ws] of clients) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(text);
      } catch { /* noop */ }
    }
  };
  const writePresenceKv = (info, entry, force) => {
    if (!kvCfg || !info.ok) return;
    if (!core.planPresenceWrite(aggregator, info.pid, entry, Date.now(), force)) return;
    botkv.kvSet(kvCfg, "worldbox_presence", info.ok, core.presenceKvValue(entry)).then(
      () => {
        // 失敗が続いて集約を止めた後の復旧（書き込み自体は止めずに試し続け、
        // 成功が戻ったらクライアントへ再開を知らせる）
        if (aggState.failStreak >= 3) {
          aggState.failStreak = 0;
          aggState.on = true;
          broadcastAggState();
        } else {
          aggState.failStreak = 0;
        }
      },
      (err) => {
        aggState.failStreak += 1;
        if (aggState.failStreak === 1) {
          console.error("[realtime] presence kv write failed:", err && err.message);
        }
        if (aggState.failStreak >= 3 && aggState.on) {
          aggState.on = false;
          broadcastAggState();
        }
      },
    ).catch(() => { /* noop */ });
  };

  if (kvCfg) {
    const sendTo = (predicate, obj) => {
      const text = JSON.stringify(obj);
      for (const [ws, info] of clients) {
        if (ws.readyState !== 1 || !predicate(info)) continue;
        try {
          ws.send(text);
        } catch { /* noop */ }
      }
    };
    const routeWatchChanges = (kind, changes, prev) => {
      if (changes.length === 0) return;
      if (kind === "tiles" || kind === "mobs" || kind === "objects" || kind === "fishing") {
        sendTo(() => true, { t: "kv", kind, changes });
      } else if (kind === "board") {
        for (const c of changes) {
          if (c.key === "messages") sendTo(() => true, { t: "kv", kind: "board", value: c.value });
        }
      } else if (kind === "nations") {
        sendTo(() => true, { t: "sync", kind: "nations" });
      } else if (kind === "requests") {
        // 依頼は所属ギルドで絞った本人向け応答が正なので poke のみ
        sendTo(() => true, { t: "sync", kind: "requests" });
      } else if (kind === "guildShop") {
        // 区画の借り手・出品は全員に見える表示（地図のギルド名・パネル）
        // が正なので poke のみ
        sendTo(() => true, { t: "sync", kind: "guildShop" });
      } else if (kind === "chat") {
        const scopes = new Map();
        for (const c of changes) {
          const scope = watchCore.chatKeyScope(c.key);
          if (scope) scopes.set(c.key, scope);
        }
        for (const scope of scopes.values()) {
          sendTo(
            (info) => info.space === scope.space,
            { t: "sync", kind: "chat", channel: scope.channel, space: scope.space },
          );
        }
      } else if (kind === "unionChat") {
        const guilds = new Set();
        for (const c of changes) {
          const gid = watchCore.unionBoardGuildId(c.key);
          if (gid) guilds.add(gid);
        }
        for (const guildId of guilds) {
          sendTo(() => true, { t: "sync", kind: "chat", channel: "union", guildId });
        }
      } else if (kind === "party") {
        const pids = new Set();
        for (const c of changes) {
          for (const pid of watchCore.partyTargetPids(c.key, c.value)) pids.add(pid);
          if (prev && prev.has(c.key)) {
            for (const pid of watchCore.partyTargetPids(c.key, prev.get(c.key))) pids.add(pid);
          }
        }
        if (pids.size > 0) sendTo((info) => pids.has(info.pid), { t: "sync", kind: "party" });
      } else if (kind === "instances") {
        // インスタンス状態は本人向け加工（個人状態・セッション要約）が
        // 要るため poke にし、宛先はキーから解決する: 共有状態は同じ
        // 空間、セッションは同じ入口のダンジョン、個人状態は本人だけ
        const spaces = new Set();
        const prefixes = new Set();
        const pids = new Set();
        for (const c of changes) {
          const scope = watchCore.instanceKeyScope(c.key);
          if (!scope) continue;
          if (scope.space) spaces.add(scope.space);
          if (scope.spacePrefix) prefixes.add(scope.spacePrefix);
          if (scope.pid) pids.add(scope.pid);
        }
        if (spaces.size > 0 || prefixes.size > 0) {
          sendTo(
            (info) => !!info.space && (spaces.has(info.space) || [...prefixes].some((p) => info.space.startsWith(p))),
            { t: "sync", kind: "instances" },
          );
        }
        if (pids.size > 0) sendTo((info) => pids.has(info.pid), { t: "sync", kind: "instances" });
      } else if (kind === "economy") {
        // 経済オプの確定は本人のみに合図する（金額・内容は載せない）
        const pids = new Set();
        for (const c of changes) {
          const prevValue = prev && prev.has(c.key) ? prev.get(c.key) : null;
          for (const pid of watchCore.economyTargetPids(prevValue, c.value)) pids.add(pid);
        }
        if (pids.size > 0) sendTo((info) => pids.has(info.pid), { t: "sync", kind: "economy" });
      }
    };
    watchCore.WATCH_PLAN.forEach((plan, idx) => {
      const state = { prev: null, busy: false, failed: false };
      const run = async () => {
        if (state.busy) return;
        state.busy = true;
        try {
          const next = await botkv.kvList(kvCfg, plan.namespace);
          const changes = watchCore.diffKv(state.prev, next);
          routeWatchChanges(plan.kind, changes, state.prev);
          state.prev = next;
          state.failed = false;
        } catch (err) {
          if (!state.failed) {
            state.failed = true;
            console.error(`[realtime] watch ${plan.namespace} failed:`, err && err.message);
          }
        } finally {
          state.busy = false;
        }
      };
      setTimeout(() => {
        void run();
        setInterval(() => void run(), plan.intervalMs);
      }, 500 + idx * 300);
    });
    console.log("[realtime] kv watch enabled (chat/party/requests/tiles/mobs/board/nations/instances/economy/objects/fishing/guildShop)");
  } else {
    console.log("[realtime] kv watch disabled (bot api not configured)");
  }
}

server.on("upgrade", (req, socket, head) => {
  let url = null;
  try {
    url = new URL(req.url || "", "http://localhost");
  } catch { /* noop */ }
  if (wss && url && url.pathname === REALTIME_PATH) {
    const auth = core.verifyToken(url.searchParams.get("t") || "", secret, Date.now());
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // タブ世代の申告（任意。無い接続は世代管理の対象外）
    const tabParam = url.searchParams.get("tab");
    const tabAtParam = Number(url.searchParams.get("tabAt"));
    auth.tab = typeof tabParam === "string" && tabParam.length > 0 ? tabParam.slice(0, 64) : undefined;
    auth.tabAt = Number.isFinite(tabAtParam) && tabAtParam > 0 ? tabAtParam : undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._rtAuth = auth;
      wss.emit("connection", ws, req);
    });
    return;
  }
  // それ以外の upgrade は本番の Next が使わないため切る（開発時の HMR は対象外）
  socket.destroy();
});

server.listen(PUBLIC_PORT, HOSTNAME, () => {
  console.log(`[realtime] wrapper listening on ${HOSTNAME}:${PUBLIC_PORT} (next: ${NEXT_PORT}, relay: ${wss ? "on" : "off"})`);
});
