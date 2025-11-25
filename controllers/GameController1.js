// controllers/GameController.js
const crypto = require("crypto");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddress, getAccount } = require("@solana/spl-token");

const GameRound = require("../models/GameRound");
const User = require("../models/User");
const ProvablyFairSeed = require("../models/ProvablyFairSeed");
const GameState = require("../models/GameState");
const GameConfig = require("../models/GameConfig");

// —————————————— CONFIG CACHE (auto-refreshed) ——————————————
let CONFIG = {
  rpcUrl: "https://api.mainnet-beta.solana.com",
  vaultWallet: "6ZJ1Zy8vE6FivX3vK77LkZq2q9i6CqpNzWWu6hxv7RtW",
  tokenMint: null,
  vaultDisplayMultiplier: 8,
  maxPayoutPercent: 0.30,
  maxSingleBetRatio: 0.08,
};

let connection = new Connection(CONFIG.rpcUrl, "confirmed");

// Refresh config from MongoDB every 15s
async function refreshConfig() {
  try {
    const docs = await GameConfig.find({});
    const updated = {};
    docs.forEach(doc => updated[doc.key] = doc.value);

    if (updated.rpcUrl && updated.rpcUrl !== CONFIG.rpcUrl) {
      connection = new Connection(updated.rpcUrl, "confirmed");
      console.log("RPC switched →", updated.rpcUrl);
    }

    CONFIG = { ...CONFIG, ...updated };
  } catch (err) {
    console.error("Config refresh failed:", err.message);
  }
}
refreshConfig();
setInterval(refreshConfig, 15_000);

// —————————————— SAFE STATE UPDATERS (NO ParallelSaveError) ——————————————
async function setGameState(updates) {
  await GameState.findOneAndUpdate(
    { key: "singleton" },
    { $set: updates },
    { upsert: true, new: true }
  );
}

async function getCurrentState() {
  return await GameState.findOne({ key: "singleton" }) || {
    gameState: "waiting",
    currentMultiplier: 1.00,
    timeElapsed: 0,
    realVault: 0,
    displayedVault: 0,
    currentRound: null
  };
}

// —————————————— VAULT UPDATE ——————————————
async function updateVault() {
  try {
    const vaultPubkey = new PublicKey(CONFIG.vaultWallet);
    let balance;

    if (!CONFIG.tokenMint) {
      balance = (await connection.getBalance(vaultPubkey)) / 1e9;
    } else {
      const mint = new PublicKey(CONFIG.tokenMint);
      const ata = await getAssociatedTokenAddress(mint, vaultPubkey);
      const acc = await getAccount(connection, ata);
      balance = Number(acc.amount) / 1e6;
    }

    await setGameState({
      realVault: balance,
      displayedVault: Math.floor(balance * CONFIG.vaultDisplayMultiplier),
      lastVaultUpdate: new Date()
    });

    console.log(`Vault: ${balance.toFixed(6)} → Shown: ${Math.floor(balance * CONFIG.vaultDisplayMultiplier)}`);
  } catch (err) {
    console.error("Vault update failed:", err.message);
  }
}

// —————————————— BROADCAST ——————————————
function broadcast(wss, msg) {
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  });
}

// —————————————— PROVABLY FAIR ——————————————
async function ensureSeed() {
  let seed = await ProvablyFairSeed.findOne({ revealed: false });
  if (!seed) {
    const serverSeed = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(serverSeed).digest("hex");
    seed = new ProvablyFairSeed({ serverSeed, serverSeedHash: hash, revealed: false });
    await seed.save();
  }
  return seed;
}

function hashToMultiplier(hash) {
  const h = parseInt(hash.slice(0, 13), 16);
  const r = h / Math.pow(2, 52);
  return parseFloat((1.5 + r * 8.5).toFixed(2));
}

// —————————————— LIABILITY ——————————————
function getMaxLiability(round) {
  if (!round?.bets) return 0;
  return round.bets
    .filter(b => !b.cashedOut)
    .reduce((sum, b) => sum + b.amount * 10.0, 0);
}

// —————————————— START GAME ——————————————
async function startGame(wss) {
  await updateVault();

  const seedDoc = await ensureSeed();

  const round = new GameRound({
    startTime: new Date(),
    seedHash: seedDoc.serverSeedHash,
    bets: []
  });
  await round.save();

  await setGameState({
    gameState: "waiting",
    currentMultiplier: 1.00,
    timeElapsed: 0,
    currentRound: round._id
  });

  const state = await getCurrentState();
  broadcast(wss, { action: "GAME_WAITING", vault: state.displayedVault });

  let countdown = 10;
  const timer = setInterval(() => {
    broadcast(wss, { action: "COUNTDOWN", time: countdown-- });
    if (countdown < 0) clearInterval(timer);
  }, 1000);

  setTimeout(() => launchRound(wss, round, seedDoc), 11000);
}

// —————————————— LAUNCH ROUND ——————————————
async function launchRound(wss, round, seedDoc) {
  const nonce = await GameRound.countDocuments();
  const hash = crypto.createHash("sha256")
    .update(`${seedDoc.serverSeed}:global:${nonce}`)
    .digest("hex");
  const crashPoint = hashToMultiplier(hash);

  round.roundHash = hash;
  round.crashMultiplier = crashPoint;
  await round.save();

  await setGameState({ gameState: "running" });
  broadcast(wss, { action: "ROUND_STARTED", seedHash: seedDoc.serverSeedHash });

  console.log(`Round started → crashes at ${crashPoint}x`);

  const interval = setInterval(async () => {
    const state = await getCurrentState();
    const newElapsed = state.timeElapsed + 0.05;
    const newMultiplier = Math.pow(2, newElapsed / 10);

    await setGameState({
      timeElapsed: newElapsed,
      currentMultiplier: newMultiplier
    });

    broadcast(wss, {
      action: "MULTIPLIER_UPDATE",
      multiplier: Number(newMultiplier.toFixed(2))
    });

    if (newMultiplier >= crashPoint) {
      clearInterval(interval);
      await endRound(wss, round._id, crashPoint);
    }
  }, 50);
}

// —————————————— END ROUND ——————————————
async function endRound(wss, roundId, crashPoint) {
  await setGameState({
    gameState: "crashed",
    currentMultiplier: crashPoint
  });

  broadcast(wss, {
    action: "ROUND_CRASHED",
    multiplier: Number(crashPoint.toFixed(2))
  });

  console.log(`CRASHED at ${crashPoint.toFixed(2)}x`);

  // Reveal seed every 100 rounds
  if ((await GameRound.countDocuments()) % 100 === 0) {
    const seed = await ProvablyFairSeed.findOneAndUpdate(
      { revealed: false },
      { revealed: true, revealedAt: new Date() },
      { new: true }
    );
    if (seed) {
      broadcast(wss, { action: "SEED_REVEALED", serverSeed: seed.serverSeed });
    }
  }

  setTimeout(() => startGame(wss), 5000);
}

// —————————————— HANDLE BET (30% vault cap enforced) ——————————————
async function handleBet(ws, data, wss) {
  try {
    const { walletAddress, amount, currency = "SOL" } = data;
    const state = await getCurrentState();

    if (state.gameState !== "waiting") {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Betting closed" }));
    }

    if (!amount || amount <= 0) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Invalid amount" }));
    }

    const round = await GameRound.findById(state.currentRound);
    if (!round) return ws.send(JSON.stringify({ action: "ERROR", message: "No active round" }));

    // Use live config
    const maxSingle = CONFIG.maxSingleBetRatio || 0.08;
    const maxPayoutPct = CONFIG.maxPayoutPercent || 0.30;

    if (amount > state.realVault * maxSingle) {
      return ws.send(JSON.stringify({
        action: "ERROR",
        message: `Max bet: ${(state.realVault * maxSingle).toFixed(4)} SOL`
      }));
    }

    const currentLiability = getMaxLiability(round);
    if (currentLiability + amount * 10.0 > state.realVault * maxPayoutPct) {
      return ws.send(JSON.stringify({
        action: "ERROR",
        message: "Bet rejected — exceeds house risk limit (30% vault cap)"
      }));
    }

    const user = await User.findOne({ walletAddress });
    if (!user || (user.balances[currency] || 0) < amount) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Insufficient balance" }));
    }

    user.balances[currency] -= amount;
    await user.save();

    round.bets.push({ walletAddress, amount, currency, cashedOut: false });
    await round.save();

    ws.send(JSON.stringify({ action: "BET_PLACED" }));
    broadcast(wss, {
      action: "PLAYER_BET",
      walletAddress,
      amount,
      liabilityPct: ((getMaxLiability(round) / state.realVault) * 100).toFixed(2)
    });

  } catch (err) {
    console.error("Bet error:", err);
    ws.send(JSON.stringify({ action: "ERROR", message: "Server error" }));
  }
}

// —————————————— HANDLE CASHOUT ——————————————
async function handleCashout(ws, data, wss) {
  try {
    const { walletAddress } = data;
    const state = await getCurrentState();

    if (state.gameState !== "running") {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Game not running" }));
    }

    const round = await GameRound.findById(state.currentRound);
    const bet = round.bets.find(b => b.walletAddress === walletAddress && !b.cashedOut);
    if (!bet) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "No active bet" }));
    }

    const payout = Math.floor(bet.amount * state.currentMultiplier * 100) / 100;

    const user = await User.findOne({ walletAddress });
    user.balances[bet.currency] = (user.balances[bet.currency] || 0) + payout;
    await user.save();

    bet.cashedOut = true;
    await round.save();

    ws.send(JSON.stringify({ action: "CASHOUT_SUCCESS", winnings: payout }));
    broadcast(wss, {
      action: "PLAYER_CASHED_OUT",
      walletAddress,
      winnings: payout,
      multiplier: Number(state.currentMultiplier.toFixed(2))
    });
  } catch (err) {
    console.error("Cashout error:", err);
  }
}

// —————————————— AUTO REFRESH ——————————————
setInterval(updateVault, 15_000);
updateVault();

// Start first round when server boots
setTimeout(() => {
  const wss = global.wss || require("../server").wss; // adjust if needed
  if (wss) startGame(wss);
}, 3000);

module.exports = {
  startGame,
  handleBet,
  handleCashout,
  refreshConfig,
  updateVault
};