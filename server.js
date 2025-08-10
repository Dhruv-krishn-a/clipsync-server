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
  console.log(`[${context}] ${message}`, data || "");
}

function cleanupPair(pairId) {
  if (pairs.has(pairId)) {
    log("CLEANUP", `Removing pair ${pairId}`);
    pairs.delete(pairId);
  }
}

// Normal HTTP endpoints
server.on("request", (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "GET" && parsed.pathname === "/pair") {
    const pairId = generatePairId();
    const token = generateToken();
    pairs.set(pairId, { token, pc: null, app: null });

    log("PAIR", `Created pair ${pairId}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pairId, token }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket connections
wss.on("connection", (ws, request, clientType, pairId, token, deviceName) => {
  log("CONNECT", `${clientType} connected for pair ${pairId} (${deviceName})`);

  const pair = pairs.get(pairId);
  if (!pair) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid pairId" }));
    ws.close();
    return;
  }

  pair[clientType] = ws;

  ws.send(JSON.stringify({ type: "status", message: `${clientType} registered.` }));

  if (pair.pc && pair.app) {
    pair.pc.send(JSON.stringify({ type: "status", message: "Mobile connected" }));
    pair.app.send(JSON.stringify({ type: "status", message: "PC connected" }));
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
    cleanupPair(pairId);
  });
});

// Upgrade HTTP -> WebSocket
server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname === "/connect") {
    const { pairId, token, type, deviceName } = query;
    if (!pairs.has(pairId)) return socket.destroy();

    const pair = pairs.get(pairId);
    if (pair.token !== token) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, type, pairId, token, deviceName);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  log("SERVER", `Running on port ${PORT}`);
});
