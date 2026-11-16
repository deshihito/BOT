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

function broadcast(space, exceptWs, obj) {
  const text = JSON.stringify(obj);
  for (const [ws, info] of clients) {
    if (ws === exceptWs || info.space !== space || ws.readyState !== 1) continue;
    try {
      ws.send(text);
    } catch { /* noop */ }
  }
}

if (wss) {
  wss.on("connection", (ws) => {
    const auth = ws._rtAuth;
    const info = { pid: auth.pid, name: auth.name, space: null, joined: false, lastMsgAt: 0, alive: true };
    clients.set(ws, info);
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
      if (!msg || msg.t !== "hb") return;
      const entry = core.acceptHeartbeat(room, info.pid, info.name, msg, now);
      if (!entry) return;
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
    });
    const onGone = () => {
      if (!clients.delete(ws)) return;
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
  const kvCfg = botkv.botKvConfig();
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
      if (kind === "tiles" || kind === "mobs") {
        sendTo(() => true, { t: "kv", kind, changes });
      } else if (kind === "board") {
        for (const c of changes) {
          if (c.key === "messages") sendTo(() => true, { t: "kv", kind: "board", value: c.value });
        }
      } else if (kind === "nations") {
        sendTo(() => true, { t: "sync", kind: "nations" });
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
    console.log("[realtime] kv watch enabled (chat/party/tiles/mobs/board/nations)");
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
