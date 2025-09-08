// server.js
const http = require("http");
const WebSocket = require("ws");
const { randomBytes } = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 5050;
const server = http.createServer();
const wss = new WebSocket.Server({ noServer: true });

// Configuration
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB max file size
const MAX_SIMULTANEOUS_FILES = 5; // Max 5 files transferring at once per pair
const CHUNK_RETRY_LIMIT = 3; // Max retries for failed chunks
const FILE_CLEANUP_TIMEOUT = 10 * 60 * 1000; // 10 minutes

// Store pairs with structure { token, pc: ws, app: ws, clipboardHistory: [], files: {} }
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

function validateFileSize(totalChunks) {
  const estimatedSize = totalChunks * 64 * 1024; // 64KB per chunk
  return estimatedSize <= MAX_FILE_SIZE;
}

// ---------------- HTTP ----------------
server.on("request", (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const pathname = (parsed.pathname || "/").replace(/\/+$/, "") || "/";

    log("HTTP", `${req.method} ${req.url} -> normalized ${pathname}`);

    if (req.method === "GET" && pathname === "/pair") {
      const pairId = generatePairId();
      const token = generateToken();
      pairs.set(pairId, { 
        token, 
        pc: null, 
        app: null, 
        clipboardHistory: [],
        files: {} 
      });

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
    log("ERROR", "Request handler error", err);
    res.writeHead(500);
    res.end("Server error");
  }
});

// ---------------- WebSocket ----------------
wss.on("connection", (ws, req, clientType, pairId, token, deviceName) => {
  log("CONNECT", `${clientType} connected for pair ${pairId} (${deviceName})`);

  const pair = pairs.get(pairId);
  if (!pair || pair.token !== token) {
    ws.send(JSON.stringify({ type: "error", message: "Invalid pair or token" }));
    return ws.close();
  }

  pair[clientType] = ws;

  try { 
    ws.send(JSON.stringify({ type: "status", message: `${clientType} registered.` })); 
    
    // Send clipboard history to newly connected client
    if (pair.clipboardHistory.length > 0) {
      pair.clipboardHistory.forEach(item => {
        ws.send(JSON.stringify({ 
          type: "clipboard", 
          from: item.from, 
          content: item.content 
        }));
      });
    }

    // Send file status for incomplete files
    Object.entries(pair.files).forEach(([fileId, file]) => {
      if (file.status !== 'completed') {
        // Notify about existing files
        if (clientType !== file.senderType) {
          ws.send(JSON.stringify({
            type: "file_meta",
            fileId: file.fileId,
            fileName: file.name,
            totalChunks: file.totalChunks
          }));
        }

        // Send progress for files sent by this client
        if (clientType === file.senderType && file.receivedChunks > 0) {
          ws.send(JSON.stringify({
            type: "file_progress",
            fileId: file.fileId,
            receivedChunks: file.receivedChunks,
            totalChunks: file.totalChunks
          }));
        }
      }
    });
  } catch (e) { log("ERROR", "Initial status failed", e); }

  // Notify both sides if connected
  if (pair.pc && pair.app) {
    try {
      pair.pc.send(JSON.stringify({ type: "status", message: "Mobile connected" }));
      pair.app.send(JSON.stringify({ type: "status", message: "PC connected" }));
    } catch (e) { log("ERROR", "Initial status failed", e); }
  }

  // ---------------- Messages ----------------
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // Clipboard
      if (data.type === "clipboard") {
        // Add to history
        pair.clipboardHistory.push({
          from: deviceName,
          content: data.content,
          timestamp: Date.now()
        });
        
        // Keep only the last 50 items
        if (pair.clipboardHistory.length > 50) {
          pair.clipboardHistory = pair.clipboardHistory.slice(-50);
        }
        
        const target = clientType === "pc" ? pair.app : pair.pc;
        if (target?.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ 
            type: "clipboard", 
            from: deviceName, 
            content: data.content 
          }));
        }
      }

      // File meta
      if (data.type === "file_meta") {
        // Check file size limit
        if (!validateFileSize(data.totalChunks)) {
          ws.send(JSON.stringify({ 
            type: "error", 
            message: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` 
          }));
          return;
        }

        // Check simultaneous files limit
        const activeFiles = Object.values(pair.files).filter(f => 
          f.status === 'sending' || f.status === 'receiving'
        ).length;
        
        if (activeFiles >= MAX_SIMULTANEOUS_FILES) {
          ws.send(JSON.stringify({ 
            type: "error", 
            message: `Too many simultaneous file transfers. Maximum is ${MAX_SIMULTANEOUS_FILES}` 
          }));
          return;
        }

        pair.files[data.fileId] = {
          fileId: data.fileId,
          name: data.fileName,
          totalChunks: data.totalChunks,
          receivedChunks: 0,
          chunks: {}, // Track received chunks for resuming
          status: 'sending',
          senderType: clientType,
          createdAt: Date.now()
        };
        
        const target = clientType === "pc" ? pair.app : pair.pc;
        if (target?.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            type: "file_meta",
            fileId: data.fileId,
            fileName: data.fileName,
            totalChunks: data.totalChunks
          }));
        }
      }

      // File chunk
      if (data.type === "file_chunk") {
        const file = pair.files[data.fileId];
        if (!file) return;

        // Skip if file is paused
        if (file.status === 'paused') return;

        file.receivedChunks += 1;
        file.chunks[data.chunkIndex] = true; // Mark this chunk as received

        const target = clientType === "pc" ? pair.app : pair.pc;
        if (target?.readyState === WebSocket.OPEN) {
          // Try to send with retry logic
          let retries = 0;
          const sendChunk = () => {
            try {
              target.send(JSON.stringify({
                type: "file_chunk",
                fileId: data.fileId,
                chunkIndex: data.chunkIndex,
                totalChunks: file.totalChunks,
                data: data.data
              }));
            } catch (err) {
              if (retries < CHUNK_RETRY_LIMIT) {
                retries++;
                setTimeout(sendChunk, 100 * retries); // Exponential backoff
              } else {
                log("ERROR", `Failed to send chunk ${data.chunkIndex} for file ${data.fileId} after ${retries} retries`, err);
                // Pause the file transfer on persistent failure
                file.status = 'paused';
                ws.send(JSON.stringify({
                  type: "file_paused",
                  fileId: data.fileId,
                  reason: "Failed to send chunk after multiple retries"
                }));
              }
            }
          };
          
          sendChunk();
        }
      }

      // File complete
      if (data.type === "file_complete") {
        const file = pair.files[data.fileId];
        if (!file) return;

        file.status = 'completed';
        const target = clientType === "pc" ? pair.app : pair.pc;
        if (target?.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ 
            type: "file_complete", 
            fileId: data.fileId 
          }));
        }
        
        // Clean up file data after a while
        setTimeout(() => {
          delete pair.files[data.fileId];
        }, FILE_CLEANUP_TIMEOUT);
      }

      // Pause file transfer
      if (data.type === "pause_file") {
        const file = pair.files[data.fileId];
        if (file) {
          file.status = 'paused';
          log("FILE", `Paused file transfer: ${data.fileId}`);
          
          // Notify the receiver
          const target = clientType === "pc" ? pair.app : pair.pc;
          if (target?.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({
              type: "file_paused",
              fileId: data.fileId
            }));
          }
        }
      }

      // Resume file transfer
      if (data.type === "resume_file") {
        const file = pair.files[data.fileId];
        if (file && file.status === 'paused') {
          file.status = 'sending';
          log("FILE", `Resumed file transfer: ${data.fileId}`);
          
          // Notify the receiver
          const target = clientType === "pc" ? pair.app : pair.pc;
          if (target?.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({
              type: "file_resumed",
              fileId: data.fileId
            }));
          }

          // If this is the sender resuming, we might need to resend missing chunks
          if (clientType === file.senderType) {
            // Find missing chunks and request them
            const missingChunks = [];
            for (let i = 0; i < file.totalChunks; i++) {
              if (!file.chunks[i]) {
                missingChunks.push(i);
              }
            }
            
            if (missingChunks.length > 0) {
              ws.send(JSON.stringify({
                type: "file_missing_chunks",
                fileId: data.fileId,
                chunks: missingChunks
              }));
            }
          }
        }
      }

      // Request specific chunks (for resuming)
      if (data.type === "request_chunks") {
        const file = pair.files[data.fileId];
        if (file && clientType === file.senderType) {
          // The sender should respond by sending the requested chunks
          ws.send(JSON.stringify({
            type: "resend_chunks",
            fileId: data.fileId,
            chunks: data.chunks
          }));
        }
      }

    } catch (err) { 
      log("ERROR", "Invalid message", err); 
    }
  });

  ws.on("close", () => {
    log("CLOSE", `${clientType} disconnected from ${pairId}`);

    const otherType = clientType === "pc" ? "app" : "pc";
    const other = pair[otherType];
    if (other?.readyState === WebSocket.OPEN) {
      other.send(JSON.stringify({ 
        type: "status", 
        message: `${clientType} disconnected` 
      }));
    }

    // Pause all files from this client
    Object.values(pair.files).forEach(file => {
      if (file.senderType === clientType && file.status === 'sending') {
        file.status = 'paused';
        log("FILE", `Auto-paused file ${file.fileId} due to sender disconnect`);
      }
    });

    // Only cleanup if both clients are disconnected
    if (!pair.pc && !pair.app) {
      cleanupPair(pairId);
    } else {
      pair[clientType] = null;
    }
  });

  // Set up periodic cleanup for stale files
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    Object.entries(pair.files).forEach(([fileId, file]) => {
      // Clean up files that have been inactive for too long
      if (now - file.createdAt > FILE_CLEANUP_TIMEOUT && file.status !== 'completed') {
        log("CLEANUP", `Removing stale file: ${fileId}`);
        delete pair.files[fileId];
      }
    });
  }, 60000); // Check every minute

  // Clear interval when connection closes
  ws.on('close', () => {
    clearInterval(cleanupInterval);
  });
});

// ---------------- HTTP -> WS Upgrade ----------------
server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const pathname = (parsed.pathname || "").replace(/\/+$/, "") || "";

  if (pathname === "/connect") {
    const { pairId, token, type, deviceName } = parsed.query || {};
    if (!pairId || !token || !type) return socket.destroy();
    if (!pairs.has(pairId) || pairs.get(pairId).token !== token) return socket.destroy();

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req, type, pairId, token, deviceName || "Unknown");
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => log("SERVER", `Running on port ${PORT}`));
