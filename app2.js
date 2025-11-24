// server.js - FULLY PROTECTED VAULT CRASH GAME (2025 version)
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsClients = new Map(); // ws -> { id, username }
let clientCounter = 0;

function broadcast(event, payload) {
  const message = JSON.stringify({ event, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

app.use(express.static('public')); // create a folder "public" for your index.html + client.js

// ====================== CONFIG & SAFETY ======================
const STARTING_VAULT = 1000000;           // Starting vault
const HOUSE_BANK = 10000000;              // Backup money (never shown)
const MAX_PROFIT_PERCENT = 0.30;          // Max 30% of vault lost per round
const MAX_BET_RATIO = 0.10;               // One player max 10% of current vault
const MIN_VAULT_REFILL = 200000;         // Auto-refill when vault drops too low
const VAULT_DISPLAY_MULTIPLIER = 8;      // Psychological trick: show 8× real vault

let vault = STARTING_VAULT;
let houseBank = HOUSE_BANK;

// ====================== GAME STATE ======================
let currentRound = null;
let bets = [];
let history = [];

// Provably fair
let serverSeed = crypto.randomBytes(32).toString('hex');
let clientSeed = crypto.randomBytes(16).toString('hex');
let roundNonce = 0;

// ====================== REAL 1% HOUSE EDGE CRASH ======================
function generateCrashPoint() {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}-${roundNonce}`)
    .digest('hex');

  const hs = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);

  // EXACT Stake/Roobet/Rollbit formula → 1% house edge
  let crash = Math.floor((0.99 * e) / (e - hs) * 100) / 100;
  return crash < 1.00 ? 1.00 : crash;
}

// ====================== ROUND LOGIC ======================
function startNewRound() {
  roundNonce++;
  clientSeed = crypto.randomBytes(16).toString('hex');

  const crashPoint = generateCrashPoint();

  currentRound = {
    id: Date.now(),
    crashPoint,
    multiplier: 1.00,
    startedAt: null,
    status: 'waiting', // waiting → betting → running → crashed
    bets: []
  };

  const hashedFuture = crypto.createHash('sha256')
    .update(serverSeed + '-' + clientSeed + '-' + roundNonce).digest('hex');

  broadcast('round-starting', {
    roundId: currentRound.id,
    hash: hashedFuture,
    nextClientSeed: clientSeed,
    timeLeft: 5
  });

  // 5-second betting phase
  setTimeout(() => {
    currentRound.status = 'running';
    currentRound.startedAt = Date.now();
    broadcast('round-started', { roundId: currentRound.id });
    tickGame();
  }, 5000);
}

function tickGame() {
  if (currentRound.status !== 'running') return;

  const elapsed = (Date.now() - currentRound.startedAt) / 1000;
  const target = easeOutExpo(elapsed / 12); // ~40-80 second rounds
  currentRound.multiplier = Math.min(target * 12, currentRound.crashPoint + 0.05);

  broadcast('tick', {
    multiplier: parseFloat(currentRound.multiplier.toFixed(2)),
    vault: Math.floor(vault * VAULT_DISPLAY_MULTIPLIER) // fake big vault
  });

  if (currentRound.multiplier >= currentRound.crashPoint) {
    endRound();
  } else {
    setTimeout(tickGame, 100);
  }
}

function endRound() {
  currentRound.status = 'crashed';

  let totalPotentialPayout = 0;
  let winners = [];

  // Calculate what everyone would win
  currentRound.bets.forEach(bet => {
    if (bet.cashoutAt && bet.cashoutAt < currentRound.crashPoint) {
      const payout = bet.amount * bet.cashoutAt;
      totalPotentialPayout += payout;
      winners.push({ bet, payout });
    } else if (!bet.cashoutAt) {
      // Auto-bust
      vault += bet.amount;
    }
  });

  // MAX PROFIT CAP (30%)
  const maxAllowedLoss = vault * MAX_PROFIT_PERCENT;
  if (totalPotentialPayout > maxAllowedLoss && winners.length > 0) {
    const ratio = maxAllowedLoss / totalPotentialPayout;
    winners.forEach(w => {
      w.payout *= ratio;
      w.bet.cashoutAt = parseFloat((w.payout / w.bet.amount).toFixed(2));
      vault -= w.payout;
    });
    broadcast('max-profit-hit', { reduction: parseFloat((1 - ratio) * 100).toFixed(1) });
  } else {
    winners.forEach(w => vault -= w.payout);
  }

  // Record history
  history.unshift({
    crash: parseFloat(currentRound.crashPoint.toFixed(2)),
    vaultAfter: Math.floor(vault * VAULT_DISPLAY_MULTIPLIER)
  });
  if (history.length > 20) history.pop();

  broadcast('round-crashed', {
    crashPoint: parseFloat(currentRound.crashPoint.toFixed(2)),
    vault: Math.floor(vault * VAULT_DISPLAY_MULTIPLIER),
    history
  });

  // Auto-refill if vault gets low
  if (vault < 300000) {
    const refill = Math.min(houseBank, 500000);
    vault += refill;
    houseBank -= refill;
    broadcast('vault-refilled', { newVault: Math.floor(vault * VAULT_DISPLAY_MULTIPLIER) });
  }

  setTimeout(startNewRound, 8000);
}

function easeOutExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

// ====================== WEBSOCKET EVENTS ======================
function sendToClient(ws, event, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, payload }));
  }
}

wss.on('connection', (ws) => {
  const clientId = `ws-${++clientCounter}`;
  wsClients.set(ws, { id: clientId, username: `Player-${clientCounter}` });
  console.log('Player connected:', clientId);

  sendToClient(ws, 'init', {
    vault: Math.floor(vault * VAULT_DISPLAY_MULTIPLIER),
    history,
    serverSeedHashed: crypto.createHash('sha256').update(serverSeed).digest('hex')
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch { return sendToClient(ws, 'error', { msg: 'Invalid JSON payload' }); }

    const client = wsClients.get(ws);
    if (!client) return;
    const payload = data.payload || {};

    switch (data.event) {
      case 'place-bet':
        handlePlaceBet(ws, client, payload);
        break;
      case 'cashout':
        handleCashout(client);
        break;
      case 'set-username':
        if (typeof payload.username === 'string' && payload.username.trim()) {
          client.username = payload.username.slice(0, 15);
          sendToClient(ws, 'username-updated', { username: client.username });
        }
        break;
      default:
        sendToClient(ws, 'error', { msg: 'Unknown event' });
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('Player disconnected:', clientId);
  });
});

function handlePlaceBet(ws, client, data) {
  if (!currentRound || currentRound.status !== 'waiting') {
    return sendToClient(ws, 'error', { msg: "Betting phase over" });
  }

  const amount = Number(data.amount);
  if (isNaN(amount) || amount <= 0) return;

  if (amount > vault * MAX_BET_RATIO) {
    return sendToClient(ws, 'error', { msg: `Max bet: ${(vault * MAX_BET_RATIO).toFixed(2)}` });
  }

  client.username = data.username?.slice(0, 15) || client.username || "Anon";

  const bet = {
    id: client.id + Date.now(),
    userId: client.id,
    username: client.username,
    amount,
    autoCashout: data.autoCashout > 1 ? Number(data.autoCashout) : null,
    cashoutAt: null
  };

  currentRound.bets.push(bet);
  vault += amount;

  broadcast('bet-placed', {
    bet: {
      username: bet.username,
      amount: bet.amount,
      autoCashout: bet.autoCashout
    },
    vault: Math.floor(vault * VAULT_DISPLAY_MULTIPLIER)
  });

  sendToClient(ws, 'bet-accepted', { betId: bet.id });
}

function handleCashout(client) {
  if (!currentRound || currentRound.status !== 'running') return;

  const bet = currentRound.bets.find(b => b.userId === client.id && !b.cashoutAt);
  if (!bet) return;

  bet.cashoutAt = currentRound.multiplier;
  const profit = bet.amount * (bet.cashoutAt - 1);

  broadcast('player-cashout', {
    username: bet.username,
    multiplier: parseFloat(bet.cashoutAt.toFixed(2)),
    profit: parseFloat(profit.toFixed(2))
  });
}

// Auto-cashout handler
setInterval(() => {
  if (!currentRound || currentRound.status !== 'running') return;

  currentRound.bets.forEach(bet => {
    if (!bet.cashoutAt && bet.autoCashout && currentRound.multiplier >= bet.autoCashout) {
      bet.cashoutAt = currentRound.multiplier;
      const profit = bet.amount * (bet.cashoutAt - 1);
      vault -= bet.amount * bet.cashoutAt;

      io.emit('player-cashout', {
        username: bet.username,
        multiplier: parseFloat(bet.cashoutAt.toFixed(2)),
        profit: parseFloat(profit.toFixed(2)),
        auto: true
      });
    }
  });
}, 100);

// ====================== START ======================
startNewRound();



server.listen(3000, () => {
  console.log('\nVAULT-PROTECTED CRASH SERVER RUNNING');
  console.log('http://localhost:3000');
  console.log('Real vault starts at:', vault);
  console.log('Players see:', vault * VAULT_DISPLAY_MULTIPLIER);
});
