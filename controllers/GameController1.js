// controllers/GameController.js
const crypto = require("crypto");
const GameRound = require("../models/GameRound");
const User = require("../models/User");
const ProvablyFairSeed = require("../models/ProvablyFairSeed");
const { Connection, PublicKey } = require('@solana/web3.js');

// ----------------- Configuration -----------------
const RPC_URL = "https://api.mainnet-beta.solana.com"; // Change to devnet if needed
// const RPC_URL = "https://api.devnet.solana.com";

const connection = new Connection(RPC_URL, 'confirmed');

const VAULT_WALLET = new PublicKey("6ZJ1Zy8vE6FivX3vK77LkZq2q9i6CqpNzWWu6hxv7RtW");
const TOKEN_MINT = null; // null = native SOL | set to USDC mint for tokens

const VAULT_DISPLAY_MULTIPLIER = 8;           // Fake bigger vault shown to players
const MAX_PAYOUT_PERCENT_OF_VAULT = 0.30;     // NEVER pay out more than 30% in one round
const MAX_SINGLE_BET_RATIO = 0.08;            // One user can't bet >8% of vault
const ABSOLUTE_MAX_CRASH = 10.00;             // Highest possible multiplier (from your hash function)
const VAULT_SYNC_INTERVAL = 15000;            // Refresh vault every 15s

// ----------------- Global State -----------------
let vault = 0;               // Real on-chain vault (SOL)
let displayedVault = 0;      // Vault shown to players (inflated)
let lastKnownVault = 0;

let currentMultiplier = 1.00;
let gameState = "waiting";   // "waiting" | "running" | "crashed"
let isRunning = false;
let timeElapsed = 0;

// ----------------- Vault Sync -----------------
async function updateVaultFromChain() {
  try {
    let balance;
    if (!TOKEN_MINT) {
      balance = await connection.getBalance(VAULT_WALLET);
      vault = balance / 1e9;
    } else {
      // SPL token support (USDC, etc) - add getAssociatedTokenAddress/getAccount if needed
      const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
      const ata = await getAssociatedTokenAddress(TOKEN_MINT, VAULT_WALLET);
      const account = await getAccount(connection, ata);
      vault = Number(account.amount) / 1e6; // assuming 6 decimals (USDC)
    }

    lastKnownVault = vault;
    displayedVault = Math.floor(vault * VAULT_DISPLAY_MULTIPLIER);

    console.log(`Vault: ${vault.toFixed(6)} SOL → Players see: ${displayedVault}`);
  } catch (err) {
    console.error("Failed to update vault:", err.message);
    vault = lastKnownVault || vault;
  }
}

// ----------------- Provably Fair -----------------
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

async function ensureServerSeed() {
  let seed = await ProvablyFairSeed.findOne({ revealed: false });
  if (!seed) {
    const serverSeed = crypto.randomBytes(32).toString("hex");
    const serverSeedHash = sha256(serverSeed);
    seed = new ProvablyFairSeed({ serverSeed, serverSeedHash, revealed: false });
    await seed.save();
  }
  return seed;
}

function getRoundHash(serverSeed, clientSeed, nonce) {
  return sha256(`${serverSeed}:${clientSeed}:${nonce}`);
}

function hashToMultiplier(hash) {
  const h = parseInt(hash.slice(0, 13), 16);
  const e = 2 ** 52;
  const r = h / e;
  const multiplier = 1.5 + r * 8.5; // 1.5x → 10.0x
  return parseFloat(multiplier.toFixed(2));
}

// ----------------- Liability Helpers -----------------
function getMaxPossiblePayout(round) {
  if (!round?.bets) return 0;
  return round.bets
    .filter(b => !b.cashedOut)
    .reduce((sum, bet) => sum + bet.amount * ABSOLUTE_MAX_CRASH, 0);
}

function wouldExceedRiskLimit(currentMaxPayout, newBetAmount) {
  const projected = currentMaxPayout + (newBetAmount * ABSOLUTE_MAX_CRASH);
  return projected > vault * MAX_PAYOUT_PERCENT_OF_VAULT;
}

// ----------------- Broadcast Helper -----------------
function broadcast(wss, msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(msg));
    }
  });
}

// ----------------- Start New Round -----------------
async function startGame(wss) {
  await updateVaultFromChain();

  gameState = "waiting";
  isRunning = false;
  currentMultiplier = 1.00;
  timeElapsed = 0;

  const seedDoc = await ensureServerSeed();

  const round = new GameRound({
    startTime: new Date(),
    crashMultiplier: 0,
    bets: [],
    seedHash: seedDoc.serverSeedHash,
  });
  await round.save();

  broadcast(wss, { action: "GAME_WAITING", vault: displayedVault });

  // Countdown
  let countdown = 10;
  const timer = setInterval(() => {
    broadcast(wss, { action: "COUNTDOWN", time: countdown });
    if (--countdown < 0) clearInterval(timer);
  }, 1000);

  setTimeout(async () => {
    await startRound(wss, round, seedDoc);
  }, 11000);
}

async function startRound(wss, round, seedDoc) {
  gameState = "running";
  isRunning = true;

  const nonce = await GameRound.countDocuments();
  const clientSeed = "global_client_seed_v1";
  const roundHash = getRoundHash(seedDoc.serverSeed, clientSeed, nonce);
  const crashPoint = hashToMultiplier(roundHash);

  round.roundHash = roundHash;
  round.crashMultiplier = crashPoint;
  await round.save();

  broadcast(wss, {
    action: "ROUND_STARTED",
    roundId: round._id,
    seedHash: seedDoc.serverSeedHash,
  });

  console.log(`Round started | Crash at ${crashPoint}x`);

  const multiplierInterval = setInterval(() => {
    timeElapsed += 0.05;
    currentMultiplier = Math.pow(2, timeElapsed / 10);

    broadcast(wss, {
      action: "MULTIPLIER_UPDATE",
      multiplier: parseFloat(currentMultiplier.toFixed(2)),
    });

    if (currentMultiplier >= crashPoint) {
      clearInterval(multiplierInterval);
      endGame(wss, round._id, crashPoint);
    }
  }, 50);
}

// ----------------- End Game -----------------
async function endGame(wss, roundId, actualCrash) {
  gameState = "crashed";
  isRunning = false;

  const round = await GameRound.findById(roundId);
  if (round) {
    round.crashMultiplier = actualCrash;
    await round.save();
  }

  currentMultiplier = actualCrash;

  broadcast(wss, {
    action: "ROUND_CRASHED",
    multiplier: parseFloat(actualCrash.toFixed(2)),
  });

  console.log(`CRASHED at ${actualCrash.toFixed(2)}x`);

  // Reveal seed every 100 rounds
  const total = await GameRound.countDocuments();
  if (total % 100 === 0) {
    const seed = await ProvablyFairSeed.findOneAndUpdate(
      { revealed: false },
      { revealed: true, revealedAt: new Date() },
      { new: true }
    );
    if (seed) {
      broadcast(wss, {
        action: "SEED_REVEALED",
        serverSeed: seed.serverSeed,
        serverSeedHash: seed.serverSeedHash,
      });
    }
  }

  setTimeout(() => startGame(wss), 5000);
}

// ----------------- Handle Bet (WITH 30% VAULT PROTECTION) -----------------
async function handleBet(ws, data, wss) {
  try {
    const { walletAddress, amount, currency = "SOL" } = data;

    if (gameState !== "waiting") {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Betting is closed" }));
    }

    if (!amount || amount <= 0) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Invalid amount" }));
    }

    // Enforce max single bet
    if (amount > vault * MAX_SINGLE_BET_RATIO) {
      return ws.send(JSON.stringify({
        action: "ERROR",
        message: `Max bet: ${(vault * MAX_SINGLE_BET_RATIO).toFixed(4)} SOL`
      }));
    }

    const user = await User.findOne({ walletAddress });
    if (!user || (user.balances?.[currency] || 0) < amount) {
      return ws.send(JSON.stringify({ action: "ERROR", message: "Insufficient balance" }));
    }

    const round = await GameRound.findOne().sort({ startTime: -1 });
    if (!round) return ws.send(JSON.stringify({ action: "ERROR", message: "No round active" }));

    // CRITICAL: 30% vault cap check
    const currentMaxPayout = getMaxPossiblePayout(round);
    if (wouldExceedRiskLimit(currentMaxPayout, amount)) {
      const maxAllowed = (vault * MAX_PAYOUT_PERCENT_OF_VAULT - currentMaxPayout) / ABSOLUTE_MAX_CRASH;
      return ws.send(JSON.stringify({
        action: "ERROR",
        message: `Bet rejected — house risk limit reached (30% vault cap)`
      }));
    }

    // Deduct from user
    user.balances[currency] = (user.balances[currency] || 0) - amount;
    await user.save();

    // Place bet
    round.bets.push({
      walletAddress,
      amount,
      currency,
      cashedOut: false
    });
    await round.save();

    // Success
    ws.send(JSON.stringify({ action: "BET_PLACED", amount, currency }));

    broadcast(wss, {
      action: "PLAYER_BET",
      walletAddress,
      amount,
      currency,
      totalBets: round.bets.length,
      liabilityPercent: ((getMaxPossiblePayout(round) / vault) * 100).toFixed(2)
    });

    console.log(`Bet placed: ${amount} SOL | Liability: ${((getMaxPossiblePayout(round) / vault) * 100).toFixed(2)}%`);

  } catch (err) {
    console.error("Bet error:", err);
    ws.send(JSON.stringify({ action: "ERROR", message: "Server error" }));
  }
}

// ----------------- Handle Cashout -----------------
async function handleCashout(ws, data, wss) {
  if (!isRunning) {
    return ws.send(JSON.stringify({ action: "ERROR", message: "Game not running" }));
  }

  const { walletAddress } = data;
  const round = await GameRound.findOne().sort({ startTime: -1 });
  if (!round) return;

  const bet = round.bets.find(b => b.walletAddress === walletAddress && !b.cashedOut);
  if (!bet) {
    return ws.send(JSON.stringify({ action: "ERROR", message: "No active bet" }));
  }

  const payout = Math.floor(bet.amount * currentMultiplier * 100) / 100; // 2 decimals

  const user = await User.findOne({ walletAddress });
  user.balances[bet.currency] = (user.balances[bet.currency] || 0) + payout;
  await user.save();

  bet.cashedOut = true;
  await round.save();

  ws.send(JSON.stringify({
    action: "CASHOUT_SUCCESS",
    winnings: payout,
    multiplier: parseFloat(currentMultiplier.toFixed(2))
  }));

  broadcast(wss, {
    action: "PLAYER_CASHED_OUT",
    walletAddress,
    winnings: payout,
    multiplier: parseFloat(currentMultiplier.toFixed(2))
  });
}

// ----------------- Periodic Vault Update -----------------
setInterval(updateVaultFromChain, VAULT_SYNC_INTERVAL);
updateVaultFromChain(); // Initial load

// ----------------- Exports -----------------
module.exports = {
  startGame,
  handleBet,
  handleCashout,
  updateVaultFromChain,
  getMaxPossiblePayout
};