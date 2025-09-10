// server.js
// ClipSync relay server — improved for large transfers (up to 5GB by default),
// robust per-chunk acknowledgements, pause/resume, explicit disconnect notifications,
// verbose terminal debug output for both sides.
//
// Summary of enhancements:
// - MAX_FILE_SIZE default increased to 5GB
// - Per-chunk ACKs: receiver must send file_chunk_ack => server forwards ack to sender
//   this creates server-driven flow-control and allows clients to keep small "inFlight"
// - Missing-chunk & resume request support remains but now uses ack state to compute missing
// - Explicit status messages on connect/disconnect forwarded to peers
// - Extensive console logging and an optional DEBUG flag to toggle even more logs
//
// Note: Clients must implement the ACK message (file_chunk_ack) and honor file_chunk_request/file_missing_chunks.

"use strict";

const http = require("http");
const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const url = require("url");

// ---------------- Config ----------------
const PORT = process.env.PORT || 5050;
const DEBUG = Boolean(process.env.DEBUG === "1" || process.env.DEBUG === "true");

const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 64 * 1024); // 64 KiB
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 5 * 1024 * 1024 * 1024); // 5 GiB default
const MAX_SIMULTANEOUS_FILES = Number(process.env.MAX_SIMULTANEOUS_FILES || 5);
const CHUNK_RETRY_LIMIT = Number(process.env.CHUNK_RETRY_LIMIT || 3);
const FILE_CLEANUP_TIMEOUT = Number(process.env.FILE_CLEANUP_TIMEOUT || 30 * 60 * 1000); // 30 min
const PAIR_CLEANUP_TIMEOUT = Number(process.env.PAIR_CLEANUP_TIMEOUT || 12 * 60 * 60 * 1000); // 12h
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL || 30000); // 30s

// ---------------- State ----------------
// pairs: Map(pairId -> pairObject)
const pairs = new Map();

// ---------------- Utilities ----------------
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

// ---------------- WebSocket server ----------------
const wss = new WebSocket.Server({ noServer: true });

// Helper: safe send (stringify + guard)
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

// When a ws connection is established with metadata (clientType, pairId, token, deviceName)
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

  // Replace any existing socket on this side
  try {
    if (pair[clientType] && pair[clientType] !== ws) {
      try { pair[clientType].close(); } catch (e) {}
    }
  } catch (e) {}

  pair[clientType] = ws;
  pair.lastActivity = Date.now();

  log("CONNECT", `${clientType} connected for pair ${pairId} (${ws.deviceName})`);
  debug("PAIR_STATE", "pair after connect", { pairId, hasPc: !!pair.pc, hasApp: !!pair.app });

  // Send registration ack
  safeSend(ws, { type: "status", message: `${clientType} registered.` });

  // Send clipboard history
  if (pair.clipboardHistory && pair.clipboardHistory.length) {
    for (const item of pair.clipboardHistory) {
      safeSend(ws, { type: "clipboard", from: item.from, content: item.content });
    }
  }

  // Sync incomplete files (tell the other side about currently transferring files)
  for (const f of Object.values(pair.files)) {
    if (f.status !== "completed") {
      // If this client is the receiver, inform about incoming meta
      if (clientType !== f.senderType) {
        safeSend(ws, {
          type: "file_meta",
          fileId: f.fileId,
          fileName: f.name,
          totalChunks: f.totalChunks,
          totalSize: f.totalSize
        });
      }
      // If this client is the sender, let it know how many chunks server has relayed to receiver
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

  // If both connected, notify both sides explicitly
  if (pair.pc && pair.app) {
    safeSend(pair.pc, { type: "status", message: "Mobile connected" });
    safeSend(pair.app, { type: "status", message: "PC connected" });
  }

  // Heartbeat pong handler
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

    // helper to send to other side
    const sendToOther = (obj) => {
      const other = pair[getOtherType(clientType)];
      if (other && other.readyState === WebSocket.OPEN) {
        try { other.send(JSON.stringify(obj)); } catch (e) { log("ERROR", "forward fail", e); }
      }
    };

    // --- clipboard ---
    if (data.type === "clipboard") {
      pair.clipboardHistory.push({ from: ws.deviceName, content: data.content || "", timestamp: now });
      if (pair.clipboardHistory.length > 50) pair.clipboardHistory = pair.clipboardHistory.slice(-50);
      sendToOther({ type: "clipboard", from: ws.deviceName, content: data.content || "" });
      log("CLIP", `Clipboard from ${clientType} (${ws.deviceName}) forwarded to ${getOtherType(clientType)}`);
      return;
    }

    // --- file_meta (new transfer) ---
    if (data.type === "file_meta") {
      const { fileId, fileName, totalChunks, totalSize } = data || {};
      const active = Object.values(pair.files).filter(f => f.status === "sending" || f.status === "paused").length;

      if (active >= MAX_SIMULTANEOUS_FILES) {
        safeSend(ws, { type: "error", message: `Too many simultaneous file transfers. Maximum is ${MAX_SIMULTANEOUS_FILES}` });
        log("FILE", `Rejecting ${fileId} — too many active files`);
        return;
      }

      if (!Number.isInteger(totalChunks) || totalChunks <= 0 || !fileId || !fileName) {
        safeSend(ws, { type: "error", message: "Invalid file meta" });
        return;
      }

      if (!validateFileBudget({ totalChunks, declaredSize: totalSize })) {
        safeSend(ws, { type: "error", message: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / (1024*1024))}MB` });
        return;
      }

      // Create file record. receivedMap tracks chunk indices forwarded to receiver
      pair.files[fileId] = {
        fileId,
        name: fileName,
        totalChunks,
        totalSize: typeof totalSize === "number" ? totalSize : undefined,
        receivedChunks: 0,            // how many unique chunks delivered to receiver
        receivedMap: new Set(),       // set of chunk indices forwarded to receiver
        status: "sending",
        senderType: clientType,
        createdAt: now,
        lastActivity: now,
        // flow control: keep a small map of retries per chunk
        retries: {}
      };

      // forward metadata to receiver
      sendToOther({ type: "file_meta", fileId, fileName, totalChunks, totalSize });
      log("FILE", `file_meta ${fileId} from ${clientType} forwarded to ${getOtherType(clientType)} (${fileName})`);
      return;
    }

    // --- file_chunk: sender -> server -> server forwards to receiver ---
    if (data.type === "file_chunk") {
      const { fileId, chunkIndex, data: base64 } = data || {};
      const file = pair.files[fileId];
      if (!file) {
        debug("FILE", "Received chunk for unknown file", { fileId, pairId });
        return;
      }
      if (file.status === "paused") {
        // ignore chunks while file marked paused on server
        debug("FILE", "Ignoring chunk because file paused", { fileId, chunkIndex });
        return;
      }

      // If receiver not available, pause and notify
      const receiver = pair[getOtherType(clientType)];
      if (!receiver || receiver.readyState !== WebSocket.OPEN) {
        file.status = "paused";
        file.lastActivity = now;
        safeSend(ws, { type: "file_paused", fileId, reason: "Receiver unavailable" });
        sendToOther({ type: "file_paused", fileId, reason: "Receiver unavailable" });
        log("FILE", `Paused ${fileId} because receiver unavailable`);
        return;
      }

      // Check duplication: if we already forwarded this chunk, ignore duplicates
      if (file.receivedMap.has(chunkIndex)) {
        debug("FILE", `Duplicate chunk ${chunkIndex} for ${fileId} ignored`);
        return;
      }

      // Forward chunk to receiver. Wrap in safe attempt with retries stored for this chunk index.
      const payload = { type: "file_chunk", fileId, chunkIndex, totalChunks: file.totalChunks, data: base64 };
      const attemptSend = (attemptsLeft = CHUNK_RETRY_LIMIT) => {
        try {
          receiver.send(JSON.stringify(payload));
          // Mark that server forwarded the chunk; final ACK (receiver->server) will mark it received.
          file.retries[chunkIndex] = (file.retries[chunkIndex] || 0);
          debug("FILE", `Forwarded chunk ${chunkIndex} for ${fileId} to receiver (attemptsLeft=${attemptsLeft})`);
        } catch (err) {
          if (attemptsLeft > 0) {
            setTimeout(() => attemptSend(attemptsLeft - 1), 100 * (CHUNK_RETRY_LIMIT - attemptsLeft + 1));
          } else {
            log("ERROR", `Failed to forward chunk ${chunkIndex} for ${fileId}`, err);
            file.status = "paused";
            safeSend(ws, { type: "file_paused", fileId, reason: "Relay failed" });
            sendToOther({ type: "file_paused", fileId, reason: "Relay failed" });
          }
        }
      };

      attemptSend();
      return;
    }

    // --- file_chunk_ack: receiver -> server (receiver says "I have chunk X") ---
    // Important for flow-control: server forwards ack to sender so sender can advance window/inFlight
    if (data.type === "file_chunk_ack") {
      const { fileId, chunkIndex } = data || {};
      const file = pair.files[fileId];
      if (!file) return;

      // Mark chunk as acknowledged (receiver actually wrote it)
      if (!file.receivedMap.has(chunkIndex)) {
        file.receivedMap.add(chunkIndex);
        file.receivedChunks = file.receivedMap.size;
        file.lastActivity = now;
      }

      // Forward ack to the sender so it can decrement in-flight and continue
      const sender = pair[file.senderType];
      if (sender && sender.readyState === WebSocket.OPEN) {
        safeSend(sender, { type: "file_chunk_ack", fileId, chunkIndex });
      }

      // Also notify receiver (optional) about progress
      const receiver = pair[getOtherType(file.senderType)];
      if (receiver && receiver.readyState === WebSocket.OPEN) {
        safeSend(receiver, { type: "file_progress", fileId, receivedChunks: file.receivedChunks, totalChunks: file.totalChunks });
      }

      // If we've received all chunks, we can mark completed and notify both sides
      if (file.receivedChunks >= file.totalChunks) {
        file.status = "completed";
        log("FILE", `File ${fileId} completed for pair ${pairId}`);
        sendToOther({ type: "file_complete", fileId });
        safeSend(pair[file.senderType], { type: "file_complete", fileId });
        // schedule cleanup
        setTimeout(() => {
          if (pair.files[fileId]?.status === "completed") {
            delete pair.files[fileId];
            log("CLEANUP", `Removed completed file ${fileId}`);
          }
        }, FILE_CLEANUP_TIMEOUT);
      }

      return;
    }

    // --- file_complete (sender informs server it's done sending) ---
    if (data.type === "file_complete") {
      const { fileId } = data || {};
      const file = pair.files[fileId];
      if (!file) return;
      // Mark lastActivity; completion will be finalized once receiver acks all chunks
      file.lastActivity = now;
      debug("FILE", `Sender reported file_complete for ${fileId}`);
      // forward to receiver (so UI can know sender finished sending)
      sendToOther({ type: "file_complete", fileId });
      return;
    }

    // --- pause / resume ---
    if (data.type === "pause_file") {
      const { fileId } = data || {};
      const file = pair.files[fileId];
      if (!file) return;
      file.status = "paused";
      file.lastActivity = now;
      // inform both sides
      safeSend(ws, { type: "file_paused", fileId });
      sendToOther({ type: "file_paused", fileId });
      log("FILE", `Paused file ${fileId} by ${clientType}`);
      return;
    }

    if (data.type === "resume_file") {
      const { fileId } = data || {};
      const file = pair.files[fileId];
      if (!file || file.status === "completed") return;

      file.status = "sending";
      file.lastActivity = now;
      safeSend(ws, { type: "file_resumed", fileId });
      sendToOther({ type: "file_resumed", fileId });

      // Compute missing chunks and request sender to resend them:
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
      log("FILE", `Resume requested for ${fileId} (${missing.length} missing)`);
      return;
    }

    // --- request_chunks: explicit forwarding from receiver to sender via server ---
    if (data.type === "request_chunks") {
      const { fileId, chunks } = data || {};
      const file = pair.files[fileId];
      if (!file) return;
      const senderWs = pair[file.senderType];
      if (senderWs && senderWs.readyState === WebSocket.OPEN && Array.isArray(chunks) && chunks.length) {
        try {
          senderWs.send(JSON.stringify({ type: "file_missing_chunks", fileId, chunks }));
          log("FILE", `Forwarded request_chunks for ${fileId} (${chunks.length})`);
        } catch (e) {
          log("ERROR", "Failed to forward chunk request to sender", e);
        }
      }
      return;
    }

    // --- file_missing_chunks (sender responding with missing chunks) ---
    if (data.type === "file_missing_chunks") {
      // Sender sending some chunks directly to server as "resend"
      // We will forward these chunks same as regular file_chunk handling above.
      const { fileId, chunks } = data || {};
      // chunks is expected to be array of { chunkIndex, data } or maybe array of indices (older behavior)
      if (!Array.isArray(chunks)) return;
      // If chunks are objects with data, forward each
      for (const item of chunks) {
        if (typeof item === "object" && item.chunkIndex !== undefined && item.data !== undefined) {
          // reuse forwarding path: send to receiver
          const receiver = pair[getOtherType(clientType)];
          if (receiver && receiver.readyState === WebSocket.OPEN) {
            const payload = { type: "file_chunk", fileId, chunkIndex: item.chunkIndex, totalChunks: pair.files[fileId]?.totalChunks, data: item.data };
            try { receiver.send(JSON.stringify(payload)); } catch (e) { log("ERROR", "Failed forward missing chunk", e); }
          }
        } else if (typeof item === "number") {
          // it's an index only — request sender to send that chunk's data to server (sender already the origin of this message)
          // Typically sender will read from disk and send file_chunk messages for those indices.
        }
      }
      return;
    }

    // Unknown message
    debug("MSG", "Unhandled message type", data.type);
  });

  // when socket closes, notify peer and update state
  ws.on("close", () => {
    const p = pairs.get(pairId);
    if (!p) return;
    log("CLOSE", `${clientType} disconnected from ${pairId}`);
    const otherType = getOtherType(clientType);
    const other = p[otherType];
    // notify peer with reason "peer_disconnected"
    if (other && other.readyState === WebSocket.OPEN) {
      try { other.send(JSON.stringify({ type: "status", message: `${clientType} disconnected` })); } catch (e) {}
      try { other.send(JSON.stringify({ type: "peer_disconnected", side: clientType, message: `${clientType} disconnected` })); } catch (e) {}
    }

    // Pause senders if they were sending
    for (const f of Object.values(p.files)) {
      if (f.senderType === clientType && f.status === "sending") {
        f.status = "paused";
        try { other?.send(JSON.stringify({ type: "file_paused", fileId: f.fileId, reason: "Sender disconnected" })); } catch {}
      }
    }

    p[clientType] = null;

    // cleanup pair if nobody connected
    if (!p.pc && !p.app) cleanupPair(pairId);
  });

  // Stale file cleanup timer for this pair
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

// Global heartbeat to terminate dead sockets
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

// ---------------- HTTP -> WS upgrade ----------------
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
