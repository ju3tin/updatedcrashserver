// controllers/GameController.js
const crypto = require("crypto");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddress, getAccount } = require("@solana/spl-token");

const GameRound = require("../models/GameRound");
const User = require("../models/User");
const ProvablyFairSeed = require("../models/ProvablyFairSeed");
const GameState = require("../models/GameState");
const GameConfig = require("../models/GameConfig");

// —————————————— CONFIG CACHE (refreshed every 15s) ——————————————
let CONFIG = {
  rpcUrl: "https://api.mainnet-beta.solana.com",
  vaultWallet: "6ZJ1Zy8vE6FivX3vK77LkZq2q9i6CqpNzWWu6hxv7RtW",
  tokenMint: null,
  vaultDisplayMultiplier: 8,
  maxPayoutPercent: 0.30,
  maxSingleBetRatio: 0.08,
};

let connection = new Connection(CONFIG.rpcUrl, "confirmed");

// Load fresh config from DB
async function refreshConfig() {
  try {
    const docs = await GameConfig.find({});
    const newConfig = {};
    docs.forEach((doc) => (newConfig[doc.key] = doc.value));

    // Only recreate connection if RPC changed
    if (newConfig.rpcUrl && newConfig.rpcUrl !== CONFIG.rpcUrl) {
      connection = new Connection(newConfig.rpcUrl, "confirmed");
      console.log("RPC updated →", newConfig.rpcUrl);
    }

    CONFIG = { ...CONFIG, ...newConfig };
    console.log("Config refreshed from MongoDB");
  } catch (err) {
    console.error("Config refresh failed:", err.message);
  }
}

// Initial load + every 15 seconds
refreshConfig();
setInterval(refreshConfig, 15_000);

// —————————————— HELPERS ——————————————
async function getGameState() {
  let state = await GameState.findOne({ key: "singleton" });
  if (!state) {
    state = new GameState({ key: "singleton" });
    await state.save();
  }
  return state;
}

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
      balance = Number(acc.amount) / 1e6; // USDC = 6 decimals
    }

    const state = await getGameState();
    state.realVault = balance;
    state.displayedVault = Math.floor(balance * CONFIG.vaultDisplayMultiplier);
    await state.save();

    return balance;
  } catch (e) {
    console.error("Vault update error:", e.message);
  }
}

function broadcast(wss, msg) {
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  });
}

// —————————————— MAX LIABILITY ——————————————
function getMaxLiability(round) {
  if (!round?.bets) return 0;
  return round.bets
    .filter((b) => !b.cashedOut)
    .reduce((sum, b) => sum + b.amount * 10.0, 0);
}

// —————————————— START GAME ——————————————
async function startGame(wss) {
  await updateVault();

  const state = await getGameState();
  state.gameState = "waiting";
  state.currentMultiplier = 1.00;
  state.timeElapsed = 0;
  await state.save();

  const seedDoc = await ensureSeed();

  const round = new GameRound({
    startTime: new Date(),
    seedHash: seedDoc.serverSeedHash,
    bets: [],
  });
  await round.save();

  state.currentRound = round._id;
  await state.save();

  broadcast(wss, { action: "GAME_WAITING", vault: state.displayedVault });

  let cd = 10;
  const timer = setInterval(() => {
    broadcast(wss, { action: "COUNTDOWN", time: cd-- });
    if (cd < 0) clearInterval(timer);
  }, 1000);

  setTimeout(() => launchRound(wss, round, seedDoc), 11000);
}

// —————————————— LAUNCH ROUND ——————————————
async function launchRound(wss, round, seedDoc) {
  const state = await getGameState();
  state.gameState = "running";
  await state.save();

  const nonce = await GameRound.countDocuments();
  const hash = crypto
    .createHash("sha256")
    .update(`${seedDoc.serverSeed}:global:${nonce}`)
    .digest("hex");
  const crashPoint = hashToMultiplier(hash);

  round.roundHash = hash;
  round.crashMultiplier = crashPoint;
  await round.save();

  broadcast(wss, { action: "ROUND_STARTED", seedHash: seedDoc.serverSeedHash });

  const interval = setInterval(async () => {
    state.timeElapsed += 0.05;
    state.currentMultiplier = Math.pow(2, state.timeElapsed / 10);
    await state.save();

    broadcast(wss, {
      action: "MULTIPLIER_UPDATE",
      multiplier: Number(state.currentMultiplier.toFixed(2)),
    });

    if (state.currentMultiplier >= crashPoint) {
      clearInterval(interval);
      endRound(wss, round._id, crashPoint);
    }
  }, 50);
}

// —————————————— END ROUND ——————————————
async function endRound(wss, roundId, crashPoint) {
  const state = await getGameState();
  state.gameState = "crashed";
  state.currentMultiplier = crashPoint;
  await state.save();

  broadcast(wss, {
    action: "ROUND_CRASHED",
    multiplier: Number(crashPoint.toFixed(2)),
  });

  setTimeout(() => startGame(wss), 5000);
}

// —————————————— HANDLE BET (30% protection) ——————————————
async function handleBet(ws, data, wss) {
  try {
    const { walletAddress, amount, currency = "SOL" } = data;
    const state = await getGameState();

    if (state.gameState !== "waiting") {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Betting closed" }));
    }

    if (amount <= 0) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Invalid amount" }));
    }

    // ——— Use live config values (no await in expression) ———
    const maxSingleRatio = CONFIG.maxSingleBetRatio || 0.08;
    const maxPayoutPct = CONFIG.maxPayoutPercent || 0.30;

    if (amount > state.realVault * maxSingleRatio) {
      return ws.send(
        JSON.stringify({ action: "ERROR", message: `Max bet: ${(state.realVault * maxSingleRatio).toFixed(4)} SOL` })
      );
    }

    const round = await GameRound.findById(state.currentRound);
    const currentLiability = getMaxLiability(round);

    if (currentLiability + amount * 10.0 > state.realVault * maxPayoutPct) {
      return ws.send(
        JSON.stringify({ action: "ERROR", message: "Bet rejected — exceeds house risk limit (30% vault cap)" })
      );
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
      liabilityPct: ((getMaxLiability(round) / state.realVault) * 100).toFixed(2),
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
    const state = await getGameState();

    if (state.gameState !== "running") {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Game not running" }));
    }

    const round = await GameRound.findById(state.currentRound);
    const bet = round.bets.find((b) => b.walletAddress === walletAddress && !b.cashedOut);
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
      multiplier: Number(state.currentMultiplier.toFixed(2)),
    });
  } catch (err) {
    console.error("Cashout error:", err);
  }
}

// —————————————— PROVABLY FAIR ——————————————
async function ensureSeed() {
  let seed = await ProvablyFairSeed.findOne({ revealed: false });
  if (!seed) {
    const serverSeed = crypto.randomBytes(32).toString("hex");
    seed = new ProvablyFairSeed({
      serverSeed,
      serverSeedHash: crypto.createHash("sha256").update(serverSeed).digest("hex"),
      revealed: false,
    });
    await seed.save();
  }
  return seed;
}

function hashToMultiplier(hash) {
  const h = parseInt(hash.slice(0, 13), 16);
  const r = h / Math.pow(2, 52);
  return parseFloat((1.5 + r * 8.5).toFixed(2));
}

// —————————————— AUTO REFRESH VAULT ——————————————
setInterval(updateVault, 15_000);
updateVault();

// Export
module.exports = {
  startGame,
  handleBet,
  handleCashout,
  refreshConfig,
  updateVault,
};