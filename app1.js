// =======================================================================
// SOLANA + SPL TOKEN VAULT CRASH GAME BACKEND (REAL ON-CHAIN BALANCE)
// =======================================================================

require("dotenv").config(); // Load environment variables from .env if present

const express = require('express'); // Express for serving HTTP and static assets
const http = require('http'); // HTTP server
const WebSocket = require('ws'); // Native WebSockets
const crypto = require('crypto'); // For secure randomness, hashing
const { Connection, PublicKey } = require('@solana/web3.js'); // Solana RPC access
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const mongoose = require("mongoose"); // For database/model (unused here but loaded)
const path = require("path");

// Optional: import your custom controllers if using database for crash rounds
const { startGame, handleBet, handleCashout } = require("./controllers/GameController");

const app = express();
const server = http.createServer(app); // Main HTTP server
// WebSocket server (clients connect over same HTTP port as website)
const wss = new WebSocket.Server({ server });
const wsClients = new Map(); // Track connected clients: ws -> { id, username }
let clientCounter = 0; // Unique numeric counter for client IDs
app.use(express.static('public')); // Serve static client files (HTML/JS/CSS, etc)

// ===== CONFIGURATION SECTION =====
const RPC_URL = "https://api.mainnet-beta.solana.com"; // Connection to Solana
const connection = new Connection(RPC_URL, 'confirmed'); // Connect at highest finality

const VAULT_WALLET = new PublicKey("6ZJ1Zy8vE6FivX3vK77LkZq2q9i6CqpNzWWu6hxv7RtW"); // Wallet holding the vault funds
const TOKEN_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC mint, or set null for native SOL vault
//const VAULT_WALLET = new PublicKey("YOUR_VAULT_WALLET_ADDRESS_HERE"); // ← change for your deployment
//const TOKEN_MINT = null; // null = use SOL, or provide custom SPL mint for USDC, USDT, etc

const VAULT_DISPLAY_MULTIPLIER = 8;     // Multiplier for UI (show a bigger vault to players)
const MAX_PROFIT_PERCENT = 0.30;        // Max payout per round (30% of vault)
const MAX_BET_RATIO = 0.08;             // Max bet per user as fraction of vault
const SYNC_INTERVAL = 15000;            // On-chain vault refresh interval, ms

let vault = 0;          // Real vault (on-chain), SOL or tokens
let displayedVault = 0; // Vault shown publicly, usually bigger
let lastKnownVault = 0; // Fallback

// =================== UTILITY: BROADCAST TO ALL CLIENTS ===================
/**
 * Broadcast a JSON message to all connected WebSocket clients
 * @param {string} action - The event or action name
 * @param {object} payload - The event payload
 */
function broadcast(action, payload) {
  const message = JSON.stringify({ action, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// =================== VAULT SYNC: PULL FROM SOLANA ON-CHAIN ===================
/**
 * Updates the vault balance by querying Solana chain (native SOL or SPL Token).
 * Updates the global vault variables.
 * Broadcasts updated vault to all clients.
 */
async function updateVaultFromChain() {
  try {
    let balance;
    if (!TOKEN_MINT) {
      // Native SOL balance mode
      balance = await connection.getBalance(VAULT_WALLET);
      vault = balance / 1e9; // lamports → SOL
    } else {
      // SPL Token mode (USDC, etc)
      const ata = await getAssociatedTokenAddress(TOKEN_MINT, VAULT_WALLET);
      try {
        const tokenAccount = await getAccount(connection, ata);
        vault = Number(tokenAccount.amount) / Math.pow(10, tokenAccount.mint.decimals || 6);
      } catch (e) {
        vault = 0; // No token account on chain yet
      }
    }
    lastKnownVault = vault;
    displayedVault = Math.floor(vault * VAULT_DISPLAY_MULTIPLIER);
    console.log(`Vault updated: ${vault.toFixed(6)} → Players see: ${displayedVault}`);
    broadcast(wss, {action:"vault-updated", vault: displayedVault });
  } catch (err) {
    console.error("Failed to fetch vault:", err.message);
    vault = lastKnownVault; // fallback to previous on error
  }
}

// =================== CRASH GAME STATE ===================
let currentRound = null; // The active round object
let history = []; // Recent round history
let roundNonce = 0; // Reseeded each round for fairness
let serverSeed = crypto.randomBytes(32).toString('hex'); // Provably fair RNG input
let clientSeed = crypto.randomBytes(16).toString('hex'); // Client-visible RNG input

/**
 * Generates a provably fair crash point using HMAC-SHA256.
 * Mirrors common formulas used in popular crash games.
 * @returns {number} Crash multiplier
 */
function generateCrashPoint() {
  const hash = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}-${roundNonce}`).digest('hex');
  const hs = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  let crash = Math.floor((0.99 * e) / (e - hs) * 100) / 100;
  return crash < 1.00 ? 1.00 : crash; // never below 1.00
}

/**
 * Starts a new round, broadcasts new round to players, and sets a 6-second betting window.
 * During the betting period, broadcast a countdown every second.
 */
function startNewRound() {
  roundNonce++;
  clientSeed = crypto.randomBytes(16).toString('hex');
  const crashPoint = generateCrashPoint();
  currentRound = {
    id: Date.now(),
    crashPoint,
    multiplier: 1.00,
    startedAt: null,
    status: 'waiting', // waiting → running → crashed
    bets: [] // bets are added as users join
  };

  const BETTING_SECONDS = 6;
  let timeLeft = BETTING_SECONDS;

  // Broadcast initial betting phase start info (with full time left)
  broadcast(wss, {
    action: 'ROUND_STARTED',
    roundId: currentRound.id,
    hash: crypto.createHash('sha256').update(serverSeed + '-' + clientSeed + '-' + roundNonce).digest('hex'),
    nextClientSeed: clientSeed,
    timeLeft,
    vault: displayedVault
  });

  // Countdown ticker interval: send `countdown` to all clients
  const countdownInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft > 0) {
      broadcast(wss, { action: 'COUNTDOWN', "time": timeLeft });
    } else {
      clearInterval(countdownInterval);
    }
  }, 1000);

  // After countdown, start the round
  setTimeout(() => {
    currentRound.status = 'running';
    currentRound.startedAt = Date.now();
    broadcast(wss, { action:'ROUND_STARTED', roundId: currentRound.id });
    tickGame();
  }, BETTING_SECONDS * 1000);
}

/**
 * Driven by setTimeout, updates the crash "multiplier" over time and keeps the game running until crash.
 * Broadcasts multiplier updates to all clients every 100ms. If crash condition met, closes the round.
 */
function tickGame() {
  if (currentRound.status !== 'running') return;
  const elapsed = (Date.now() - currentRound.startedAt) / 1000;
  const target = 1 + (elapsed / 10); // growth formula for demo
  currentRound.multiplier = Math.min(target * 8, currentRound.crashPoint + 0.05);
  broadcast(wss, {
    action: 'CNT_MULTIPLY',
    multiplier: parseFloat(currentRound.multiplier.toFixed(2)),
    vault: displayedVault,
  });
  if (currentRound.multiplier >= currentRound.crashPoint) endRound();
  else setTimeout(tickGame, 100);
}

/**
 * Ends the round, resolves payouts, and triggers the next round.
 * Handles max profit caps and records round results to the history buffer.
 */
function endRound() {
  currentRound.status = 'crashed';
  let totalPayout = 0;
  let winners = [];
  currentRound.bets.forEach(bet => {
    if (bet.cashoutAt && bet.cashoutAt < currentRound.crashPoint) {
      const payout = bet.amount * bet.cashoutAt;
      totalPayout += payout;
      winners.push({ bet, payout });
    }
  });
  // Enforce max round payout/profit
  const maxLoss = vault * MAX_PROFIT_PERCENT;
  if (totalPayout > maxLoss && winners.length > 0) {
    const ratio = maxLoss / totalPayout;
    winners.forEach(w => w.payout *= ratio);
    broadcast(wss, {action:'max-profit-hit', reduction: ((1 - ratio) * 100).toFixed(1) });
  }
  // Record round to history for chart/recap
  history.unshift({ crash: parseFloat(currentRound.crashPoint.toFixed(2)), vaultAfter: displayedVault });
  if (history.length > 20) history.pop();
  // Notify all clients about the round crash/outcome
  broadcast(wss,{
    action:'ROUND_CRASHED', 
    crashPoint: parseFloat(currentRound.crashPoint.toFixed(2)),
    vault: displayedVault,
    history
  });
  setTimeout(startNewRound, 8000); // wait 8 seconds before next
}

// =================== WEBSOCKET SERVER (CLIENT CONNECTIONS/EVENTS) ===================
/**
 * Handles new WebSocket connections, tracks users, handles events and actions from all connected clients.
 * All client<->server communication is JSON: { action, payload }
 */
wss.on('connection', (ws) => {
  const clientId = `ws-${++clientCounter}`;
  wsClients.set(ws, { id: clientId, username: `Player-${clientCounter}` });
  // Send initial vault, round, and hashed RNG seed state
  ws.send(JSON.stringify({ action: 'init', payload: {
    vault: displayedVault,
    history,
    serverSeedHashed: crypto.createHash('sha256').update(serverSeed).digest('hex'),
    token: TOKEN_MINT ? "USDC" : "SOL"
  }}));
  // Main handler for incoming WebSocket messages from clients
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch { return ws.send(JSON.stringify({ action: 'error', payload: { msg: 'Invalid JSON payload' }})); }
    const client = wsClients.get(ws);
    if (!client) return;
    const payload = data.payload || {};
    switch(data.action) {
      case 'place-bet': {
        // Player sends: { action: 'place-bet', payload: { amount, username, autoCashout } }
        if (!currentRound || currentRound.status !== 'waiting')
          return ws.send(JSON.stringify({ action: 'error', payload: { msg: 'Too late' } }));
        const amount = Number(payload.amount);
        if (amount > vault * MAX_BET_RATIO)
          return ws.send(JSON.stringify({ action: 'error', payload: { msg: `Max bet: ${(vault * MAX_BET_RATIO).toFixed(4)}` } }));
        const bet = {
          userId: client.id,
          username: (payload.username?.slice(0,12)) || client.username || 'Anon',
          amount,
          autoCashout: payload.autoCashout > 1.01 ? Number(payload.autoCashout) : null,
          cashoutAt: null
        };
        currentRound.bets.push(bet);
        // Broadcast bet placement to all clients
        broadcast(wss, {
          action: 'ROUND_STARTED',
          username: bet.username,
          amount: bet.amount,
          auto: bet.autoCashout
        });
        break;
      }
      case 'cashout': {
        // Player sends: { action: 'cashout' }
        if (!currentRound || currentRound.status !== 'running') return;
        const bet = currentRound.bets.find(b => b.userId === client.id && !b.cashoutAt);
        if (!bet) return;
        bet.cashoutAt = currentRound.multiplier;
        const profit = bet.amount * (bet.cashoutAt - 1);
        // Notify all: this player cashed out
        broadcast(wss, {
          action:'player-cashout',
          username: bet.username,
          multiplier: bet.cashoutAt.toFixed(2),
          profit: profit.toFixed(4)
        });
        break;
      }
      case 'set-username': {
        // Optionally allow user to set their username
        if (typeof payload.username === 'string' && payload.username.trim()) {
          client.username = payload.username.slice(0,12);
          ws.send(JSON.stringify({ action: 'username-updated', payload: { username: client.username } }));
        }
        break;
      }
      default:
        // Unknown action received
        ws.send(JSON.stringify({ action: 'error', payload: { msg: 'Unknown action' } }));
    }
  });
  ws.on('close', () => {
    wsClients.delete(ws); // Remove user on disconnect
  });
});

// =================== AUTOCASHOUT HANDLER (RUNS EVERY 100ms) ===================
/**
 * Regularly checks for any bets with autoCashout conditions. If the multiplier is reached, resolves the payout.
 */
setInterval(() => {
  if (!currentRound || currentRound.status !== 'running') return;
  currentRound.bets.forEach(bet => {
    if (!bet.cashoutAt && bet.autoCashout && currentRound.multiplier >= bet.autoCashout) {
      bet.cashoutAt = currentRound.multiplier;
      broadcast(wss, {
        action:'player-cashout',
        username: bet.username, multiplier: bet.cashoutAt.toFixed(2), auto: true
      });
    }
  });
}, 100);

// =================== STARTUP ROUTINE ===================
// On boot: pull vault from Solana and schedule auto-refresh
updateVaultFromChain();
setInterval(updateVaultFromChain, SYNC_INTERVAL);
// Start first round after a short delay
setTimeout(() => {
  startNewRound();
}, 3000);

// Start HTTP + WebSocket server on port 3000
server.listen(3000, () => {
  console.log("\nSOLANA VAULT CRASH LIVE");
  console.log("http://localhost:3000");
  console.log("Vault wallet:", VAULT_WALLET.toBase58());
  console.log("Token:", TOKEN_MINT ? TOKEN_MINT.toBase58() : "Native SOL");
});

// Optionally: HTTP status API for external dashboard/monitor usage
app.get("/api/status", async (req, res) => {
  const GameRound = require("./models/GameRound");
  const lastRound = await GameRound.findOne().sort({ startTime: -1 }).exec();
  res.json({
    currentRoundId: lastRound ? lastRound._id : null,
    seedHash: lastRound ? lastRound.seedHash : null,
    crashMultiplier: lastRound ? lastRound.crashMultiplier : null,
  });
});
