const http = require('http');
const WebSocket = require('ws');
const { randomBytes } = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 5050;
const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

const pairs = new Map(); // pairId -> { token, pc: ws, app: ws }

function generatePairId() {
  return randomBytes(3).toString('hex'); // e.g., '43f2f2'
}

function generateToken() {
  return randomBytes(16).toString('hex'); // one-time secret token
}

// ---------------------------
// HTTP Endpoint: /pair
// ---------------------------
server.on('request', (req, res) => {
  if (req.method === 'POST' && req.url === '/pair') {
    const pairId = generatePairId();
    const token = generateToken();
    pairs.set(pairId, { token, pc: null, app: null });

    // Expire if unused after 2 minutes
    setTimeout(() => {
      const p = pairs.get(pairId);
      if (p && (!p.pc || !p.app)) {
        console.log(`⏰ Expired unused pair: ${pairId}`);
        pairs.delete(pairId);
      }
    }, 2 * 60 * 1000);

    console.log(`🔐 New Pair: ${pairId} [token: ${token.slice(0, 8)}...]`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pairId, token }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ---------------------------
// WebSocket Upgrade Handling
// ---------------------------
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
  let pairId = null;
  let role = null;

  console.log("🔗 New WebSocket connection");

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // Step 1: Initial identification { pairId, token, role: 'pc' | 'app' }
      if (!pairId && data.pairId && data.role && data.token) {
        const entry = pairs.get(data.pairId);

        console.log(`🔐 Incoming [${data.role}] for ${data.pairId}...`);

        if (!entry) {
          ws.send(JSON.stringify({ status: 'invalid_pair' }));
          ws.close(1008, 'Invalid Pair ID');
          return;
        }

        if (entry.token !== data.token) {
          console.warn(`❌ Token mismatch for pair ${data.pairId}`);
          ws.send(JSON.stringify({ status: 'unauthorized' }));
          ws.close(1008, 'Unauthorized Token');
          return;
        }

        if (entry[data.role]) {
          console.warn(`⚠️ Duplicate role "${data.role}" in pair ${data.pairId}`);
          ws.send(JSON.stringify({ status: 'role_taken' }));
          ws.close(1008, 'Duplicate Role');
          return;
        }

        // Accept connection
        entry[data.role] = ws;
        pairId = data.pairId;
        role = data.role;
        ws.send(JSON.stringify({ status: 'verified', pairId }));
        console.log(`✅ ${role.toUpperCase()} verified for ${pairId}`);
        return;
      }

      // Step 2: Relay text between paired devices
      if (pairId && data.text) {
        const entry = pairs.get(pairId);
        const target = role === 'pc' ? entry.app : entry.pc;

        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ text: data.text }));
          console.log(`📤 Routed clipboard ${role} → ${role === 'pc' ? 'app' : 'pc'}`);
        } else {
          console.log("⚠️ No paired device connected.");
        }
      }
    } catch (err) {
      console.error("❌ JSON parse error:", err.message);
      ws.close(1008, 'Invalid JSON');
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Socket closed (code=${code}, reason="${reason}")`);
    if (pairId && role) {
      const entry = pairs.get(pairId);
      if (entry) {
        entry[role] = null;
        if (!entry.pc && !entry.app) {
          pairs.delete(pairId);
          console.log(`🗑️ Cleaned up pair: ${pairId}`);
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error("⚠️ WebSocket error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`✅ ClipSync Secure Server running on port ${PORT}`);
});