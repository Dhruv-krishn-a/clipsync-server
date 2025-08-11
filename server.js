// server.js (improved logging + tolerant routing + disconnect notifications)
const http = require("http");
const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 5050;
const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const pairs = new Map();

function generatePairId() {
  return randomBytes(3).toString("hex");
}
function generateToken() {
  return randomBytes(16).toString("hex");
}

function log(context, message, data) {
  console.log(`[${new Date().toISOString()}] [${context}] ${message}`, data || "");
}

function cleanupPair(pairId) {
  if (pairs.has(pairId)) {
    log("CLEANUP", `Removing pair ${pairId}`);
    pairs.delete(pairId);
  }
}

// HTTP endpoints
server.on("request", (req, res) => {
  try {
    const parsed = url.parse(req.url, true);

    // Normalize pathname (drop trailing slash)
    const pathname = (parsed.pathname || "/").replace(/\/+$/, "") || "/";

    log("HTTP", `${req.method} ${req.url} -> normalized ${pathname}`);

    if (req.method === "GET" && pathname === "/pair") {
      const pairId = generatePairId();
      const token = generateToken();
      pairs.set(pairId, { token, pc: null, app: null });

      log("PAIR", `Created pair ${pairId}`);

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify({ pairId, token }));
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ClipSync server running");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    log("ERROR", "Request handler error", err && err.stack ? err.stack : err);
    res.writeHead(500);
    res.end("Server error");
  }
});

// WebSocket connection handling
wss.on("connection", (ws, request, clientType, pairId, token, deviceName) => {
  log("CONNECT", `${clientType} connected for pair ${pairId} (${deviceName})`);

  const pair = pairs.get(pairId);
  if (!pair) {
    try { ws.send(JSON.stringify({ type: "error", message: "Invalid pairId" })); } catch {}
    ws.close();
    return;
  }

  pair[clientType] = ws;

  try { ws.send(JSON.stringify({ type: "status", message: `${clientType} registered.` })); } catch {}

  if (pair.pc && pair.app) {
    try {
      pair.pc.send(JSON.stringify({ type: "status", message: "Mobile connected" }));
      pair.app.send(JSON.stringify({ type: "status", message: "PC connected" }));
    } catch (e) {
      log("ERROR", "Sending initial status failed", e);
    }
  }

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "clipboard") {
        const target = clientType === "pc" ? pair.app : pair.pc;
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            type: "clipboard",
            from: deviceName,
            content: data.content
          }));
        }
      }
    } catch (err) {
      log("ERROR", "Invalid message", err);
    }
  });

  ws.on("close", () => {
    log("CLOSE", `WebSocket closed for ${clientType} ${pairId}`);

    const otherType = clientType === "pc" ? "app" : "pc";
    const pairData = pairs.get(pairId);
    if (pairData && pairData[otherType] && pairData[otherType].readyState === WebSocket.OPEN) {
      try {
        pairData[otherType].send(JSON.stringify({ 
          type: "status", 
          message: `${clientType === "pc" ? "PC" : "Mobile"} disconnected` 
        }));
      } catch (e) {
        log("ERROR", "Failed to send disconnect message", e);
      }
    }

    cleanupPair(pairId);
  });
});

// Upgrade HTTP -> WebSocket
server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const pathname = (parsed.pathname || "").replace(/\/+$/, "") || "";

  log("UPGRADE", `Attempt upgrade: ${req.url} -> ${pathname}`);

  if (pathname === "/connect") {
    const { pairId, token, type, deviceName } = parsed.query || {};
    if (!pairId || !token) {
      log("UPGRADE", "Missing pairId/token on upgrade", parsed.query);
      return socket.destroy();
    }
    if (!pairs.has(pairId)) {
      log("UPGRADE", `Unknown pairId ${pairId}`);
      return socket.destroy();
    }

    const pair = pairs.get(pairId);
    if (pair.token !== token) {
      log("UPGRADE", `Invalid token for pair ${pairId}`);
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, type, pairId, token, deviceName);
    });
  } else {
    log("UPGRADE", `Bad upgrade path: ${pathname}`);
    socket.destroy();
  }
});

server.listen(PORT, () => {
  log("SERVER", `Running on port ${PORT}`);
});