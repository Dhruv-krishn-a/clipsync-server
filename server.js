const WebSocket = require('ws');
const { spawn } = require('child_process');
const os = require('os');
const qrcode = require('qrcode-terminal');

const PORT = 5050;
const KEY = Math.floor(100000 + Math.random() * 900000).toString();

// Simplified function for Arch Linux (checks for Wayland/X11)
const getCopyCommand = () => {
  if (process.env.WAYLAND_DISPLAY) {
    console.log("💡 Wayland session detected. Using 'wl-copy'.");
    return { cmd: 'wl-copy', args: [] };
  } else {
    console.log("💡 X11 session detected. Using 'xclip'.");
    return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  }
};

const copyCommand = getCopyCommand();

const getLocalIP = () => {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // Fallback
};

const ip = getLocalIP();

console.log(`\n📲 ClipSync Server for Arch Linux`);
console.log(`===================================`);
console.log(`📡 Server running at ws://${ip}:${PORT}`);
console.log(`🔐 Pairing Key: ${KEY}\n`);

// Display QR code with all connection info
const qrData = JSON.stringify({ ip, port: PORT, key: KEY });
console.log("Scan this QR code with the mobile app to connect automatically:");
qrcode.generate(qrData, { small: true });

const wss = new WebSocket.Server({ port: PORT });

wss.on('connection', (ws) => {
  console.log("\n🔗 Mobile client connection request received.");
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

      // 1. Handle Verification
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
      
      // 2. Handle Clipboard Data
      if (data.text) {
        const text = data.text;
        console.log(`[📋 Received]: ${text.substring(0, 70)}...`);
        
        const copy = spawn(copyCommand.cmd, copyCommand.args);
        copy.stdin.write(text);
        copy.stdin.end();

        copy.on('exit', () => {
          console.log("📎 Copied to system clipboard.");
        });
        copy.on('error', (err) => {
          console.error(`❌ Failed to run clipboard command. Make sure '${copyCommand.cmd}' is installed.`);
          console.error(err.message);
        });
      }
    } catch (err) {
      console.error("❌ Failed to process message:", err.message);
    }
  });

  ws.on('close', () => {
    clearTimeout(verificationTimeout);
    console.log("🔌 Mobile client disconnected.");
  });
});
