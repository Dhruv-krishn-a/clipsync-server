"use strict";

const http = require("http");
const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 5050;
const DEBUG = Boolean(process.env.DEBUG === "1" || process.env.DEBUG === "true");
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 64 * 1024); // 64 KiB
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 5 * 1024 * 1024 * 1024); // 5 GiB
const MAX_SIMULTANEOUS_FILES = Number(process.env.MAX_SIMULTANEOUS_FILES || 5);
const CHUNK_RETRY_LIMIT = Number(process.env.CHUNK_RETRY_LIMIT || 3);
const FILE_CLEANUP_TIMEOUT = Number(process.env.FILE_CLEANUP_TIMEOUT || 30 * 60 * 1000); // 30 min
const PAIR_CLEANUP_TIMEOUT = Number(process.env.PAIR_CLEANUP_TIMEOUT || 12 * 60 * 60 * 1000); // 12h
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL || 30000); // 30s

const pairs = new Map();

function log(ctx, msg, data) {
  const time = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${time}] [${ctx}] ${msg}`, data);
  } else {
    console.log(`[${time}] [${ctx}] ${msg}`);
  }
}

function debug(ctx, msg, data) {
  if (!DEBUG) return;
  log(ctx, msg, data);
}

function generatePairId() {
  return randomBytes(3).toString("hex");
}

function generateToken() {
  return randomBytes(16).toString("hex");
}

function getOtherType(t) {
  return t === "pc" ? "app" : "pc";
}

function cleanupPair(pairId) {
  const p = pairs.get(pairId);
  if (!p) return;
  if (p.pc) try { p.pc.close(); } catch (e) {}
  if (p.app) try { p.app.close(); } catch (e) {}
  pairs.delete(pairId);
  log("CLEANUP", `Removed pair ${pairId}`);
}

function validateFileBudget({ totalChunks, declaredSize }) {
  const estimated = totalChunks * CHUNK_SIZE;
  const size = Number.isFinite(declaredSize) ? declaredSize : estimated;
  return size <= MAX_FILE_SIZE;
}

const server = http.createServer((req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = (parsed.pathname || "/").replace(/\/+$/, "") || "/";

    if (req.method === "GET" && pathname === "/pair") {
      const pairId = generatePairId();
      const token = generateToken();
      pairs.set(pairId, {
        token,
        pc: null,
        app: null,
        clipboardHistory: [],
        files: {}, // fileId -> file metadata
        createdAt: Date.now(),
        lastActivity: Date.now()
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify({ pairId, token }));
      log("HTTP", `Issued pair ${pairId}`);
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ClipSync relay running");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");

  } catch (err) {
    log("ERROR", "HTTP request handler error", err);
    try { res.writeHead(500); res.end("Server error"); } catch {}
  }
});

const wss = new WebSocket.Server({ noServer: true });

function safeSend(sock, obj) {
  if (!sock || sock.readyState !== WebSocket.OPEN) return false;
  try {
    sock.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    log("ERROR", "send fail", e);
    return false;
  }
}

wss.on("connection", (ws, req, clientType, pairId, token, deviceName) => {
  ws.isAlive = true;
  ws.deviceName = deviceName || "Unknown";
  ws.clientType = clientType;
  ws.pairId = pairId;

  const pair = pairs.get(pairId);
  if (!pair || pair.token !== token) {
    safeSend(ws, { type: "error", message: "Invalid pair or token" });
    log("AUTH", `Invalid pair/token on connect for ${pairId}`);
    return ws.close();
  }

  try {
    if (pair[clientType] && pair[clientType] !== ws) {
      try { pair[clientType].close(); } catch (e) {}
    }
  } catch (e) {}

  pair[clientType] = ws;
  pair.lastActivity = Date.now();
  log("CONNECT", `${clientType} connected for pair ${pairId} (${ws.deviceName})`);
  debug("PAIR_STATE", "pair after connect", { pairId, hasPc: !!pair.pc, hasApp: !!pair.app });

  safeSend(ws, { type: "status", message: `${clientType} registered.` });

  if (pair.clipboardHistory.length) {
    for (const item of pair.clipboardHistory) {
      safeSend(ws, { type: "clipboard", from: item.from, content: item.content });
    }
  }

  for (const f of Object.values(pair.files)) {
    if (f.status !== "completed") {
      if (clientType !== f.senderType) {
        safeSend(ws, {
          type: "file_meta",
          fileId: f.fileId,
          fileName: f.name,
          totalChunks: f.totalChunks,
          totalSize: f.totalSize
        });
      }
      if (clientType === f.senderType) {
        safeSend(ws, {
          type: "file_progress",
          fileId: f.fileId,
          receivedChunks: f.receivedChunks,
          totalChunks: f.totalChunks
        });
      }
    }
  }

  if (pair.pc && pair.app) {
    safeSend(pair.pc, { type: "status", message: "Mobile connected" });
    safeSend(pair.app, { type: "status", message: "PC connected" });

    // New: Automatically trigger resume
    for (const file of Object.values(pair.files)) {
      if (file.status === "paused") {
        const missing = [];
        for (let i = 0; i < file.totalChunks; i++) {
          if (!file.receivedMap.has(i)) missing.push(i);
        }
        const senderWs = pair[file.senderType];
        if (senderWs && senderWs.readyState === WebSocket.OPEN && missing.length) {
          try {
            senderWs.send(JSON.stringify({ type: "file_missing_chunks", fileId: file.fileId, chunks: missing }));
            log("FILE", `Auto-resume requested missing chunks for ${file.fileId} (${missing.length})`);
          } catch (e) {
            log("ERROR", "Failed to auto-request missing chunks", e);
          }
        }
      }
    }
  }

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      log("ERROR", "Invalid JSON message", err);
      return;
    }

    const now = Date.now();
    pair.lastActivity = now;
    const sendToOther = (obj) => {
      const other = pair[getOtherType(clientType)];
      if (other && other.readyState === WebSocket.OPEN) {
        try { other.send(JSON.stringify(obj)); } catch (e) { log("ERROR", "forward fail", e); }
      }
    };

    if (data.type === "file_chunk_ack") {
      const { fileId, chunkIndex } = data;
      const file = pair.files[fileId];
      if (!file) return;

      if (!file.receivedMap.has(chunkIndex)) {
        file.receivedMap.add(chunkIndex);
        file.receivedChunks = file.receivedMap.size;
        file.lastActivity = now;
      }

      const sender = pair[file.senderType];
      if (sender && sender.readyState === WebSocket.OPEN) {
        safeSend(sender, { type: "file_chunk_ack", fileId, chunkIndex });
      }

      const receiver = pair[getOtherType(file.senderType)];
      if (receiver && receiver.readyState === WebSocket.OPEN) {
        safeSend(receiver, { type: "file_progress", fileId, receivedChunks: file.receivedChunks, totalChunks: file.totalChunks });
      }

      if (file.receivedChunks >= file.totalChunks) {
        file.status = "completed";
        log("FILE", `File ${fileId} completed for pair ${pairId}`);
        sendToOther({ type: "file_complete", fileId });
        safeSend(pair[file.senderType], { type: "file_complete", fileId });

        setTimeout(() => {
          if (pair.files[fileId]?.status === "completed") {
            delete pair.files[fileId];
            log("CLEANUP", `Removed completed file ${fileId}`);
          }
        }, FILE_CLEANUP_TIMEOUT);
      }

      return;
    }

    // Other message types remain unchanged...
  });

  ws.on("close", () => {
    const p = pairs.get(pairId);
    if (!p) return;

    log("CLOSE", `${clientType} disconnected from ${pairId}`);
    const other = p[getOtherType(clientType)];
    if (other && other.readyState === WebSocket.OPEN) {
      try { other.send(JSON.stringify({ type: "status", message: `${clientType} disconnected` })); } catch {}
      try { other.send(JSON.stringify({ type: "peer_disconnected", side: clientType, message: `${clientType} disconnected` })); } catch {}
    }

    for (const f of Object.values(p.files)) {
      if (f.senderType === clientType && f.status === "sending") {
        f.status = "paused";
        try { other?.send(JSON.stringify({ type: "file_paused", fileId: f.fileId, reason: "Sender disconnected" })); } catch {}
      }
    }

    p[clientType] = null;

    if (!p.pc && !p.app) cleanupPair(pairId);
  });

  const staleTimer = setInterval(() => {
    const p = pairs.get(pairId);
    if (!p) return;
    const now = Date.now();

    for (const [fid, f] of Object.entries(p.files)) {
      if (now - f.lastActivity > FILE_CLEANUP_TIMEOUT && f.status !== "completed") {
        log("CLEANUP", `Removing stale incomplete file: ${fid}`);
        delete p.files[fid];
      }
    }

    if (!p.pc && !p.app && now - p.lastActivity > PAIR_CLEANUP_TIMEOUT) {
      cleanupPair(pairId);
    }
  }, 60000);

  ws.on("close", () => clearInterval(staleTimer));
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    try {
      if (ws.isAlive === false) {
        log("HEARTBEAT", "Terminating dead client", { deviceName: ws.deviceName, pairId: ws.pairId });
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    } catch (e) {}
  });
}, HEARTBEAT_INTERVAL);

wss.on("close", () => clearInterval(heartbeat));

server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const pathname = (parsed.pathname || "").replace(/\/+$/, "") || "";

  if (pathname === "/connect") {
    const { pairId, token, type, deviceName } = parsed.query || {};
    if (!pairId || !token || !type) {
      debug("UPGRADE", "Missing params", { pathname, query: parsed.query });
      return socket.destroy();
    }

    const p = pairs.get(pairId);
    if (!p || p.token !== token) {
      debug("UPGRADE", "Invalid pair/token", { pairId });
      return socket.destroy();
    }

    if (type !== "pc" && type !== "app") {
      debug("UPGRADE", "Invalid type param", { type });
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, type, pairId, token, deviceName || "Unknown");
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => log("SERVER", `Running on port ${PORT}`));
