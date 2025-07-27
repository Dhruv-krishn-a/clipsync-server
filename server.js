const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 5050;
const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

console.log("🚀 ClipSync Server starting...");

const pairings = new Map(); // key -> [ws1, ws2]
const pending = new Map(); // ws -> key

function generateKey() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

server.on('request', (req, res) => {
  const { method, url: path } = req;

  // Generate a pairing key
  if (method === 'GET' && path === '/pair') {
    const key = generateKey();
    pairings.set(key, []);
    console.log("🔐 New pairing key generated:", key);

    // Expire key after 2 minutes
    setTimeout(() => {
      if (pairings.get(key)?.length === 0) {
        console.log("⏰ Pairing key expired:", key);
        pairings.delete(key);
      }
    }, 2 * 60 * 1000);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key }));
    return;
  }

  // Not found
  res.writeHead(404);
  res.end('Not found');
});

// Handle WebSocket upgrades
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
  console.log("🔗 WebSocket client connected");

  let pairedKey = null;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);

      // Step 1: Pair using key
      if (data.key && !pairedKey) {
        const list = pairings.get(data.key);
        if (list && list.length < 2) {
          list.push(ws);
          pending.set(ws, data.key);
          pairedKey = data.key;
          ws.send(JSON.stringify({ status: 'verified' }));
          console.log("✅ Client verified with key:", data.key);

          if (list.length === 2) {
            console.log("🔗 Pair complete. Two clients connected for key:", data.key);
          }
        } else {
          ws.send(JSON.stringify({ status: 'unauthorized' }));
          ws.close();
        }
        return;
      }

      // Step 2: Relay clipboard
      if (pairedKey && data.text) {
        const others = pairings.get(pairedKey)?.filter(c => c !== ws && c.readyState === WebSocket.OPEN);
        if (others) {
          for (const client of others) {
            client.send(JSON.stringify({ text: data.text }));
          }
        }
      }
    } catch (err) {
      console.error("❌ Error handling message:", err.message);
    }
  });

  ws.on('close', () => {
    const key = pending.get(ws);
    if (key) {
      const group = pairings.get(key);
      if (group) {
        pairings.set(key, group.filter(c => c !== ws));
      }
      pending.delete(ws);
      console.log("🔌 WebSocket closed. Key:", key);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
