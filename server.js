// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");       // ✅ Correct import
const mongoose = require("mongoose");
const path = require("path");

// Import controller functions
const { startGame, handleBet, handleCashout } = require("./controllers/GameController1");

// ❌ REMOVE this — it crashes immediately
// new WebSocketServer();

// Environment variables
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/bustafair";
const PORT = parseInt(process.env.PORT || "3000", 10);

// Create Express app and HTTP server
const app = express();
const httpServer = http.createServer(app);

// Serve static UI
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {});

// Simple API route
app.get("/api/status", async (req, res) => {
  const GameRound = require("./models/GameRound");
  const lastRound = await GameRound.findOne().sort({ startTime: -1 }).exec();
  res.json({
    currentRoundId: lastRound ? lastRound._id : null,
    seedHash: lastRound ? lastRound.seedHash : null,
    crashMultiplier: lastRound ? lastRound.crashMultiplier : null,
  });
});

// Start HTTP server
httpServer.listen(PORT, () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
});

// ✅ Create WebSocket server correctly
const wss = new WebSocketServer({ server: httpServer });

// WebSocket handling
wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket");

  ws.send(JSON.stringify({ action: "WELCOME", message: "Connected to provably-fair crash server" }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Invalid JSON" }));
    }

    if (msg.action === "PLACE_BET") {
      handleBet(ws, msg, wss);
    } else if (msg.action === "CASHOUT") {
      handleCashout(ws, msg, wss);
    } else if (msg.action === "GET_STATUS") {
      const GameRound = require("./models/GameRound");
      GameRound.findOne().sort({ startTime: -1 }).then((r) => {
        ws.send(JSON.stringify({ action: "STATUS", round: r }));
      });
    } else {
      ws.send(JSON.stringify({ action: "ERROR", message: "Unknown action" }));
    }
  });
});

// Start the game loop
startGame(wss);
