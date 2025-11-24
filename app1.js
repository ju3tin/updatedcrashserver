// server.js - SOLANA + SPL TOKEN VAULT CRASH (real on-chain balance)
require("dotenv").config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const mongoose = require("mongoose");
const path = require("path");


const { startGame, handleBet, handleCashout } = require("./controllers/GameController");


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsClients = new Map(); // ws -> { id, username }
let clientCounter = 0;
app.use(express.static('public'));

// ====================== CONFIG ======================
const RPC_URL = "https://api.mainnet-beta.solana.com"; // or your own RPC
const connection = new Connection(RPC_URL, 'confirmed');


const VAULT_WALLET = new PublicKey("6ZJ1Zy8vE6FivX3vK77LkZq2q9i6CqpNzWWu6hxv7RtW");
const TOKEN_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
//const VAULT_WALLET = new PublicKey("YOUR_VAULT_WALLET_ADDRESS_HERE"); // ← PUT YOUR VAULT WALLET HERE
//const TOKEN_MINT = null; // null = SOL, or put USDC mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")

const VAULT_DISPLAY_MULTIPLIER = 8;     // Show 8× real vault (psychology)
const MAX_PROFIT_PERCENT = 0.30;        // Max 30% loss per round
const MAX_BET_RATIO = 0.08;             // Max 8% of vault per bet
const SYNC_INTERVAL = 15000;            // Refresh vault every 15s

let vault = 0;          // Real on-chain balance (in smallest unit: lamports or token decimals)
let displayedVault = 0;
let lastKnownVault = 0;

// Utility: broadcast to all clients
function broadcast(action, payload) {
  const message = JSON.stringify({ action, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

// ====================== FETCH VAULT FROM SOLANA ======================
async function updateVaultFromChain() {
  try {
    let balance;
    if (!TOKEN_MINT) {
      // Native SOL
      balance = await connection.getBalance(VAULT_WALLET);
      vault = balance / 1e9; // lamports → SOL
    } else {
      // SPL Token (USDC, USDT, etc.)
      const ata = await getAssociatedTokenAddress(TOKEN_MINT, VAULT_WALLET);
      try {
        const tokenAccount = await getAccount(connection, ata);
        vault = Number(tokenAccount.amount) / Math.pow(10, tokenAccount.mint.decimals || 6);
      } catch (e) {
        vault = 0; // No token account yet
      }
    }

    lastKnownVault = vault;
    displayedVault = Math.floor(vault * VAULT_DISPLAY_MULTIPLIER);

    console.log(`Vault updated: ${vault.toFixed(6)} → Players see: ${displayedVault}`);
   broadcast(wss,  { action: "vault-updated",vault: displayedVault });

  } catch (err) {
    console.error("Failed to fetch vault:", err.message);
    vault = lastKnownVault;
  }
}

// ====================== CRASH GAME (same logic, now with real SOL vault) ======================
let currentRound = null;
let history = [];
let roundNonce = 0;
let serverSeed = crypto.randomBytes(32).toString('hex');
let clientSeed = crypto.randomBytes(16).toString('hex');

function generateCrashPoint() {
  const hash = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}-${roundNonce}`).digest('hex');
  const hs = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  let crash = Math.floor((0.99 * e) / (e - hs) * 100) / 100;
  return crash < 1.00 ? 1.00 : crash;
}

function startNewRound() {
  roundNonce++;
  clientSeed = crypto.randomBytes(16).toString('hex');
  const crashPoint = generateCrashPoint();

  currentRound = {
    id: Date.now(),
    crashPoint,
    multiplier: 1.00,
    startedAt: null,
    status: 'waiting',
    bets: []
  };

  broadcast(wss, {
    action: 'ROUND_STARTED',
    roundId: currentRound.id,
    hash: crypto.createHash('sha256').update(serverSeed + '-' + clientSeed + '-' + roundNonce).digest('hex'),
    nextClientSeed: clientSeed,
    timeLeft: 6,
    vault: displayedVault
  });

  setTimeout(() => {
    currentRound.status = 'running';
    currentRound.startedAt = Date.now();
    broadcast(wss, {action:"ROUND_STARTED", roundId: currentRound.id });
    tickGame();
  }, 6000);
}

function tickGame() {
  if (currentRound.status !== 'running') return;
  const elapsed = (Date.now() - currentRound.startedAt) / 1000;
  const target = 1 + (elapsed / 10);
  currentRound.multiplier = Math.min(target * 8, currentRound.crashPoint + 0.05);

 /* broadcast('CNT_MULTIPLY', {
    multiplier: parseFloat(currentRound.multiplier.toFixed(2)),
    vault: displayedVault
  }); */
  broadcast(wss, {
    action: "CNT_MULTIPLY",
    multiplier: parseFloat(currentRound.multiplier.toFixed(2)),
    vault: displayedVault
  });


  if (currentRound.multiplier >= currentRound.crashPoint) endRound();
  else setTimeout(tickGame, 100);
}

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

  // MAX PROFIT CAP
  const maxLoss = vault * MAX_PROFIT_PERCENT;
  if (totalPayout > maxLoss && winners.length > 0) {
    const ratio = maxLoss / totalPayout;
    winners.forEach(w => w.payout *= ratio);
    broadcast(wss, {action:'max-profit-hit', reduction: ((1 - ratio) * 100).toFixed(1) });
  }

  history.unshift({
    crash: parseFloat(currentRound.crashPoint.toFixed(2)),
    vaultAfter: displayedVault
  });
  if (history.length > 20) history.pop();


  broadcast(wss, {
    action: "ROUND_CRASHED",
    crashPoint: parseFloat(currentRound.crashPoint.toFixed(2)),
    vault: displayedVault,
    history
  });

  setTimeout(startNewRound, 8000);
}

// ====================== WEBSOCKET actionS ======================
wss.on('connection', (ws) => {
  const clientId = `ws-${++clientCounter}`;
  wsClients.set(ws, { id: clientId, username: `Player-${clientCounter}` });
  ws.send(JSON.stringify({ action: 'init', payload: {
    vault: displayedVault,
    history,
    serverSeedHashed: crypto.createHash('sha256').update(serverSeed).digest('hex'),
    token: TOKEN_MINT ? "USDC" : "SOL"
  } }));
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch { return ws.send(JSON.stringify({ action: 'error', payload: { msg: 'Invalid JSON payload' } })); }
    const client = wsClients.get(ws);
    if (!client) return;
    const payload = data.payload || {};
    switch(data.action) {
      case 'place-bet': {
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
        broadcast(wss, {
          action:'bet-placed',
          username: bet.username,
          amount: bet.amount,
          auto: bet.autoCashout
        });
        break;
      }
      case 'cashout': {
        if (!currentRound || currentRound.status !== 'running') return;
        const bet = currentRound.bets.find(b => b.userId === client.id && !b.cashoutAt);
        if (!bet) return;
        bet.cashoutAt = currentRound.multiplier;
        const profit = bet.amount * (bet.cashoutAt - 1);
        broadcast('player-cashout', {
          username: bet.username,
          multiplier: bet.cashoutAt.toFixed(2),
          profit: profit.toFixed(4)
        });
        break;
      }
      case 'set-username': {
        if (typeof payload.username === 'string' && payload.username.trim()) {
          client.username = payload.username.slice(0,12);
          ws.send(JSON.stringify({ action: 'username-updated', payload: { username: client.username } }));
        }
        break;
      }
      default:
        ws.send(JSON.stringify({ action: 'error', payload: { msg: 'Unknown action' } }));
    }
  });
  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

// Auto cashout
setInterval(() => {
  if (!currentRound || currentRound.status !== 'running') return;
  currentRound.bets.forEach(bet => {
    if (!bet.cashoutAt && bet.autoCashout && currentRound.multiplier >= bet.autoCashout) {
      bet.cashoutAt = currentRound.multiplier;
      broadcast('player-cashout', { username: bet.username, multiplier: bet.cashoutAt.toFixed(2), auto: true });
    }
  });
}, 100);

// ====================== START ======================
updateVaultFromChain();
setInterval(updateVaultFromChain, SYNC_INTERVAL);

setTimeout(() => {
  startNewRound();
}, 3000);


server.listen(3000, () => {
  console.log("\nSOLANA VAULT CRASH LIVE");
  console.log("http://localhost:3000");
  console.log("Vault wallet:", VAULT_WALLET.toBase58());
  console.log("Token:", TOKEN_MINT ? TOKEN_MINT.toBase58() : "Native SOL");
});

app.get("/api/status", async (req, res) => {
  const GameRound = require("./models/GameRound");
  const lastRound = await GameRound.findOne().sort({ startTime: -1 }).exec();
  res.json({
    currentRoundId: lastRound ? lastRound._id : null,
    seedHash: lastRound ? lastRound.seedHash : null,
    crashMultiplier: lastRound ? lastRound.crashMultiplier : null,
  });
});
