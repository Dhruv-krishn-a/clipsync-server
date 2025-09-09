// server.js
// ClipSync relay server — improved for 1 GiB transfers, robust pause/resume, and cleaner handling.

"use strict";

const http = require("http");
const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const url = require("url");

// ---------------- Config ----------------
const PORT = process.env.PORT || 5050;
const CHUNK_SIZE = 64 * 1024; // 64 KiB (must match clients unless you negotiate)
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024); // 1 GiB
const MAX_SIMULTANEOUS_FILES = Number(process.env.MAX_SIMULTANEOUS_FILES || 5);
const CHUNK_RETRY_LIMIT = Number(process.env.CHUNK_RETRY_LIMIT || 3);
const FILE_CLEANUP_TIMEOUT = Number(process.env.FILE_CLEANUP_TIMEOUT || 30 * 60 * 1000); // 30 min
const PAIR_CLEANUP_TIMEOUT = Number(process.env.PAIR_CLEANUP_TIMEOUT || 12 * 60 * 60 * 1000); // 12h
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL || 30000); // 30s

// ---------------- State ----------------
/**
 * pairs map:
 * pairId -> {
 *   token,
 *   pc: ws | null,
 *   app: ws | null,
 *   clipboardHistory: Array<{from, content, timestamp}>,
 *   files: {
 *     [fileId]: {
 *       fileId, name, totalChunks, totalSize?: number,
 *       receivedChunks: number,
 *       receivedMap: Set<number>, // which chunk indices have been relayed
 *       status: 'sending' | 'paused' | 'completed',
 *       senderType: 'pc' | 'app',
 *       createdAt: number,
 *       lastActivity: number
 *     }
 *   },
 *   createdAt: number,
 *   lastActivity: number
 * }
 */
const pairs = new Map();

// ---------------- Utilities ----------------
function log(ctx, msg, data) {
  if (data !== undefined) {
    console.log(`[${new Date().toISOString()}] [${ctx}] ${msg}`, data);
  } else {
    console.log(`[${new Date().toISOString()}] [${ctx}] ${msg}`);
  }
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
  if (p.pc) try { p.pc.close(); } catch {}
  if (p.app) try { p.app.close(); } catch {}
  pairs.delete(pairId);
  log("CLEANUP", `Removed pair ${pairId}`);
}

function validateFileBudget({ totalChunks, declaredSize }) {
  // Prefer explicit size if the sender provides it, otherwise estimate.
  const estimated = totalChunks * CHUNK_SIZE;
  const size = Number.isFinite(declaredSize) ? declaredSize : estimated;

  return size <= MAX_FILE_SIZE;
}

// ---------------- HTTP server ----------------
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
        files: {},
        createdAt: Date.now(),
        lastActivity: Date.now()
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify({ pairId, token }));
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
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

// ---------------- WebSocket server ----------------
const wss = new WebSocket.Server({ noServer: true });

// Attach connection with extra metadata
wss.on("connection", (ws, req, clientType, pairId, token, deviceName) => {
  ws.isAlive = true; // heartbeat
  ws.deviceName = deviceName || "Unknown";
  ws.clientType = clientType;
  ws.pairId = pairId;

  const pair = pairs.get(pairId);
  if (!pair || pair.token !== token) {
    try { ws.send(JSON.stringify({ type: "error", message: "Invalid pair or token" })); } catch {}
    return ws.close();
  }

  // Keep only one socket per side
  try {
    if (pair[clientType] && pair[clientType] !== ws) {
      try { pair[clientType].close(); } catch {}
    }
  } catch {}

  pair[clientType] = ws;
  pair.lastActivity = Date.now();

  log("CONNECT", `${clientType} connected for pair ${pairId} (${ws.deviceName})`);

  // Initial status + warm state
  const safeSend = (sock, obj) => {
    if (!sock || sock.readyState !== WebSocket.OPEN) return;
    try { sock.send(JSON.stringify(obj)); } catch (e) { log("ERROR", "send fail", e); }
  };

  safeSend(ws, { type: "status", message: `${clientType} registered.` });

  // Send clipboard history to the just-connected client
  if (pair.clipboardHistory.length > 0) {
    for (const item of pair.clipboardHistory) {
      safeSend(ws, { type: "clipboard", from: item.from, content: item.content });
    }
  }

  // Send file status to sync state
  for (const f of Object.values(pair.files)) {
    if (f.status !== "completed") {
      // Inform receiver about incoming file
      if (clientType !== f.senderType) {
        safeSend(ws, {
          type: "file_meta",
          fileId: f.fileId,
          fileName: f.name,
          totalChunks: f.totalChunks
        });
      }
      // Inform sender about progress
      if (clientType === f.senderType && f.receivedChunks > 0) {
        safeSend(ws, {
          type: "file_progress",
          fileId: f.fileId,
          receivedChunks: f.receivedChunks,
          totalChunks: f.totalChunks
        });
      }
    }
  }

  // Notify both sides if fully paired
  if (pair.pc && pair.app) {
    safeSend(pair.pc, { type: "status", message: "Mobile connected" });
    safeSend(pair.app, { type: "status", message: "PC connected" });
  }

  // Heartbeat for this socket
  ws.on("pong", () => { ws.isAlive = true; });

  // --------------- Message handling ---------------
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

    // ---- Clipboard ----
    if (data.type === "clipboard") {
      pair.clipboardHistory.push({
        from: ws.deviceName,
        content: data.content || "",
        timestamp: now
      });
      if (pair.clipboardHistory.length > 50) {
        pair.clipboardHistory = pair.clipboardHistory.slice(-50);
      }
      sendToOther({ type: "clipboard", from: ws.deviceName, content: data.content || "" });
      return;
    }

    // ---- File metadata ----
    if (data.type === "file_meta") {
      const { fileId, fileName, totalChunks, totalSize } = data || {};
      // Limits
      const active = Object.values(pair.files).filter(
        (f) => f.status === "sending" || f.status === "paused"
      ).length;

      if (active >= MAX_SIMULTANEOUS_FILES) {
        return safeSend(ws, {
          type: "error",
          message: `Too many simultaneous file transfers. Maximum is ${MAX_SIMULTANEOUS_FILES}`
        });
      }

      if (!Number.isInteger(totalChunks) || totalChunks <= 0 || !fileId || !fileName) {
        return safeSend(ws, { type: "error", message: "Invalid file meta" });
      }

      if (!validateFileBudget({ totalChunks, declaredSize: totalSize })) {
        return safeSend(ws, {
          type: "error",
          message: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))}MB`
        });
      }

      pair.files[fileId] = {
        fileId,
        name: fileName,
        totalChunks,
        totalSize: typeof totalSize === "number" ? totalSize : undefined,
        receivedChunks: 0,
        receivedMap: new Set(),
        status: "sending",
        senderType: clientType,
        createdAt: now,
        lastActivity: now
      };

      // forward meta to receiver
      sendToOther({ type: "file_meta", fileId, fileName, totalChunks });
      return;
    }

    // ---- File chunk ----
    if (data.type === "file_chunk") {
      const { fileId, chunkIndex, data: base64 } = data || {};
      const file = pair.files[fileId];
      if (!file) return;
      if (file.status === "paused") return;

      // Mark received only once per index
      if (!file.receivedMap.has(chunkIndex)) {
        file.receivedMap.add(chunkIndex);
        file.receivedChunks += 1;
        file.lastActivity = now;
      }

      const target = pair[getOtherType(clientType)];
      if (!target || target.readyState !== WebSocket.OPEN) {
        // Receiver not available -> pause and notify both
        file.status = "paused";
        safeSend(ws, { type: "file_paused", fileId, reason: "Receiver unavailable" });
        sendToOther({ type: "file_paused", fileId, reason: "Receiver unavailable" });
        return;
      }

      // Try forwarding with basic retry
      let retries = 0;
      const payload = {
        type: "file_chunk",
        fileId,
        chunkIndex,
        totalChunks: file.totalChunks,
        data: base64 // still JSON+base64 for compatibility
      };

      const attempt = () => {
        try {
          target.send(JSON.stringify(payload));
        } catch (err) {
          if (retries < CHUNK_RETRY_LIMIT) {
            retries++;
            setTimeout(attempt, 100 * retries);
          } else {
            log("ERROR", `Failed to relay chunk ${chunkIndex} for file ${fileId} after ${retries} retries`, err);
            file.status = "paused";
            safeSend(ws, { type: "file_paused", fileId, reason: "Relay failed" });
            sendToOther({ type: "file_paused", fileId, reason: "Relay failed" });
          }
        }
      };
      attempt();

      return;
    }

    // ---- File complete ----
    if (data.type === "file_complete") {
      const { fileId } = data || {};
      const file = pair.files[fileId];
      if (!file) return;

      file.status = "completed";
      file.lastActivity = now;

      sendToOther({ type: "file_complete", fileId });

      // Cleanup file entry later
      setTimeout(() => {
        if (pair.files[fileId]?.status === "completed") {
          delete pair.files[fileId];
          log("CLEANUP", `Removed completed file ${fileId}`);
        }
      }, FILE_CLEANUP_TIMEOUT);

      return;
    }

    // ---- Pause file ----
    if (data.type === "pause_file") {
      const { fileId } = data || {};
      const file = pair.files[fileId];
      if (!file) return;
      file.status = "paused";
      file.lastActivity = now;

      safeSend(ws, { type: "file_paused", fileId });
      sendToOther({ type: "file_paused", fileId });
      return;
    }

    // ---- Resume file ----
    if (data.type === "resume_file") {
      const { fileId } = data || {};
      const file = pair.files[fileId];
      if (!file || file.status === "completed") return;

      file.status = "sending";
      file.lastActivity = now;

      // Notify both sides
      safeSend(ws, { type: "file_resumed", fileId });
      sendToOther({ type: "file_resumed", fileId });

      // Compute missing and ask the *sender* to resend them (no matter who resumed)
      const missing = [];
      for (let i = 0; i < file.totalChunks; i++) {
        if (!file.receivedMap.has(i)) missing.push(i);
      }
      const senderWs = pair[file.senderType];
      if (senderWs && senderWs.readyState === WebSocket.OPEN && missing.length) {
        try {
          senderWs.send(JSON.stringify({ type: "file_missing_chunks", fileId, chunks: missing }));
        } catch (e) {
          log("ERROR", "Failed to request missing chunks from sender", e);
        }
      }
      return;
    }

    // ---- Request specific chunks (from receiver) ----
    // If a client explicitly asks for some chunks, ensure the request reaches the sender.
    if (data.type === "request_chunks") {
      const { fileId, chunks } = data || {};
      const file = pair.files[fileId];
      if (!file) return;
      const senderWs = pair[file.senderType];
      if (senderWs && senderWs.readyState === WebSocket.OPEN && Array.isArray(chunks) && chunks.length) {
        try {
          senderWs.send(JSON.stringify({ type: "file_missing_chunks", fileId, chunks }));
        } catch (e) {
          log("ERROR", "Failed to forward chunk request to sender", e);
        }
      }
      return;
    }
  });

  ws.on("close", () => {
    const p = pairs.get(pairId);
    if (!p) return;

    log("CLOSE", `${clientType} disconnected from ${pairId}`);
    const otherType = getOtherType(clientType);
    const other = p[otherType];
    if (other && other.readyState === WebSocket.OPEN) {
      try { other.send(JSON.stringify({ type: "status", message: `${clientType} disconnected` })); } catch {}
    }

    // Pause all active files where this client is the sender
    for (const f of Object.values(p.files)) {
      if (f.senderType === clientType && f.status === "sending") {
        f.status = "paused";
        try { other?.send(JSON.stringify({ type: "file_paused", fileId: f.fileId, reason: "Sender disconnected" })); } catch {}
      }
    }

    p[clientType] = null;

    // Cleanup pair if nobody is connected
    if (!p.pc && !p.app) {
      cleanupPair(pairId);
    }
  });

  // Periodic stale files cleanup for this connection's pair
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

    // Pair-level idle cleanup
    if (!p.pc && !p.app && now - p.lastActivity > PAIR_CLEANUP_TIMEOUT) {
      cleanupPair(pairId);
    }
  }, 60000);

  ws.on("close", () => clearInterval(staleTimer));
});

// Global heartbeat to drop dead sockets
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_INTERVAL);

wss.on("close", () => clearInterval(heartbeat));

// ---------------- HTTP -> WS upgrade ----------------
server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const pathname = (parsed.pathname || "").replace(/\/+$/, "") || "";

  if (pathname === "/connect") {
    const { pairId, token, type, deviceName } = parsed.query || {};
    if (!pairId || !token || !type) return socket.destroy();
    const p = pairs.get(pairId);
    if (!p || p.token !== token) return socket.destroy();

    if (type !== "pc" && type !== "app") return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, type, pairId, token, deviceName || "Unknown");
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => log("SERVER", `Running on port ${PORT}`));
