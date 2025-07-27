const http = require('http');
const WebSocket = require('ws');
const { randomBytes } = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 5050;

const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const pairs = new Map(); // pairId → { pc: ws, app: ws }

function generatePairId() {
  return randomBytes(3).toString('hex'); // e.g., "a7b9c2"
}

// -------------------------
// HTTP Endpoint for /pair
// -------------------------
server.on('request', (req, res) => {
  const { method, url: path } = req;

  if (method === 'POST' && path === '/pair') {
    const pairId = generatePairId();
    pairs.set(pairId, { pc: null, app: null });

    // Auto-expire after 2 mins if not connected
    setTimeout(() => {
      const entry = pairs.get(pairId);
      if (entry && (!entry.pc || !entry.app)) {
        console.log(`⏰ Expiring unused pairId: ${pairId}`);
        pairs.delete(pairId);
      }
    }, 2 * 60 * 1000);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pairId }));
    console.log(`🔐 New pairId generated: ${pairId}`);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// -------------------------
// WebSocket Handling
// -------------------------
server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url);

  if (pathname === '/') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  let pairedId = null;
  let role = null; // 'pc' or 'app'

  console.log("🔗 New WebSocket connection");

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // First message must be: { pairId, role: 'pc' | 'app' }
      if (!pairedId && data.pairId && (data.role === 'pc' || data.role === 'app')) {
        const entry = pairs.get(data.pairId);
        if (!entry) {
          ws.send(JSON.stringify({ status: 'invalid_pair' }));
          ws.close();
          return;
        }

        if (entry[data.role]) {
          ws.send(JSON.stringify({ status: 'role_taken' }));
          ws.close();
          return;
        }

        entry[data.role] = ws;
        pairedId = data.pairId;
        role = data.role;

        ws.send(JSON.stringify({ status: 'verified', pairId: pairedId }));
        console.log(`✅ ${role.toUpperCase()} verified for pairId: ${pairedId}`);
        return;
      }

      // Relay clipboard text to the other peer
      if (pairedId && data.text) {
        const entry = pairs.get(pairedId);
        const target = role === 'pc' ? entry.app : entry.pc;

        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ text: data.text }));
          console.log(`📤 Routed clipboard from ${role} → ${role === 'pc' ? 'app' : 'pc'}`);
        } else {
          console.log("⚠️ Paired client not connected.");
        }
      }
    } catch (err) {
      console.error("❌ Message error:", err.message);
    }
  });

  ws.on('close', () => {
    if (pairedId && role) {
      const entry = pairs.get(pairedId);
      if (entry) {
        entry[role] = null;
        if (!entry.pc && !entry.app) {
          pairs.delete(pairedId);
          console.log(`🗑️ Cleaned up pairId: ${pairedId}`);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ ClipSync Multi-User Server running on port ${PORT}`);
});
