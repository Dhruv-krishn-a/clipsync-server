const WebSocket = require('ws');
const http = require('http');

// Render gives you a dynamic port via environment variable
const PORT = process.env.PORT || 5050;

// Generate a temporary key for verification
const KEY = Math.floor(100000 + Math.random() * 900000).toString();

console.log(`🔐 Pairing Key: ${KEY}`);

const server = http.createServer(); // needed for Render's WebSocket proxy
const wss = new WebSocket.Server({ server });

console.log("🚀 WebSocket server starting...");

wss.on('connection', (ws) => {
  console.log("🔗 Client connected");

  let verified = false;

  const verificationTimeout = setTimeout(() => {
    if (!verified) {
      console.log("⏰ Verification timed out. Disconnecting client.");
      ws.close();
    }
  }, 5000);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (!verified && data.key === KEY) {
        verified = true;
        clearTimeout(verificationTimeout);
        console.log("✅ Client verified successfully.");
        ws.send(JSON.stringify({ status: 'verified' }));
        return;
      }

      if (!verified) {
        ws.send(JSON.stringify({ status: 'unauthorized' }));
        ws.close();
        return;
      }

      if (data.text) {
        console.log(`[📋 Received]: ${data.text.substring(0, 70)}...`);
        // Cloud version doesn't support clipboard — desktop client will do that
      }

    } catch (err) {
      console.error("❌ Failed to process message:", err.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(verificationTimeout);
    console.log("🔌 Client disconnected.");
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
