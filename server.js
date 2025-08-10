// server.js
const http = require("http");
const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 5050;
const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

// Stores all active pairs: pairId -> { token, pc, app }
const pairs = new Map();

/**
 * Generate a random pairing ID (6 hex characters)
 */
function generatePairId() {
  return randomBytes(3).toString("hex");
}

/**
 * Generate a secure token for authentication
 */
function generateToken() {
  return randomBytes(16).toString("hex");
}

/**
 * Log helper
 */
function log(context, message, data) {
  console.log(`[${context}] ${message}`, data || "");
}

/**
 * Clean up a pair
 */
function cleanupPair(pairId) {
  if (pairs.has(pairId)) {
    log("CLEANUP", `Removing pair ${pairId}`);
    pairs.delete(pairId);
  }
}

// Handle WebSocket connections
wss.on("connection", (ws, request, clientType, pairId, token, deviceName) => {
  log("CONNECT", `${clientType} connected for pair ${pairId} (${deviceName})`);

  const pair = pairs.get(pairId);

  if (!pair) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid pairId" }));
    ws.close();
    return;
  }

  // Attach the socket to the pair
  pair[clientType] = ws;

  // Notify successful connection
  ws.send(
    JSON.stringify({
      type: "status",
      message: `${clientType} registered successfully.`,
    })
  );

  // If both are connected, notify them
  if (pair.pc && pair.app) {
    log("PAIR", `Both PC and App are connected for pair ${pairId}`);
    pair.pc.send(
      JSON.stringify({
        type: "status",
        message: "Mobile connected and ready.",
      })
    );
    pair.app.send(
      JSON.stringify({
        type: "status",
        message: "PC connected and ready.",
      })
    );
  }

  // Listen for messages
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      log("MESSAGE", `${clientType} -> ${JSON.stringify(data)}`);

      if (data.type === "clipboard") {
        const target = clientType === "pc" ? pair.app : pair.pc;
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(
            JSON.stringify({
              type: "clipboard",
              from: deviceName,
              content: data.content,
            })
          );
          log(
            "FORWARD",
            `Clipboard sent from ${clientType} to ${
              clientType === "pc" ? "app" : "pc"
            }`
          );
        }
      }
    } catch (err) {
      log("ERROR", `Invalid message from ${clientType}`, err);
    }
  });

  // Handle disconnects
  ws.on("close", () => {
    log("DISCONNECT", `${clientType} disconnected from pair ${pairId}`);
    cleanupPair(pairId);
  });
});

// HTTP upgrade for WebSocket
server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname === "/pair") {
    const pairId = generatePairId();
    const token = generateToken();
    pairs.set(pairId, { token, pc: null, app: null });

    socket.write(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(
        { pairId, token }
      )}`
    );
    socket.destroy();
  } else if (pathname === "/connect") {
    const { pairId, token, type, deviceName } = query;

    if (!pairs.has(pairId)) {
      socket.destroy();
      return;
    }

    const pair = pairs.get(pairId);
    if (pair.token !== token) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, type, pairId, token, deviceName);
    });
  } else {
    socket.destroy();
  }
});

// Start the server
server.listen(PORT, () => {
  log("SERVER", `Running on port ${PORT}`);
});
