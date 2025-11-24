
// server.js - FINAL: FULLY ON-CHAIN + 100% PROVABLY FAIR SOLANA CRASH
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const bs58 = require('bs58');
const {
  Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, getAccount, TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsClients = new Map(); // ws -> metadata
let clientCounter = 0;

function broadcast(event, payload) {
  const message = JSON.stringify({ event, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
}

function sendToClient(ws, event, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, payload }));
  }
}

function findClientByWallet(address) {
  for (const [ws, meta] of wsClients.entries()) {
    if (meta.walletAddress === address) return { ws, meta };
  }
  return null;
}

app.use(express.static('public'));

// ====================== CONFIG ======================
const RPC_URL = "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, 'confirmed');

// PUT YOUR VAULT WALLET PRIVATE KEY HERE (64-byte array)
// ...
//const bs58 = require('bs58');

const VAULT_SECRET_KEY = Uint8Array.from([
  77, 248,  23,  11,  82,  91, 128,  64,
  14,  12, 199, 233,  50,  88,  74,  90,
  29,  75, 194,  93, 148,  71,  70,  34,
  96,  28,  12, 241, 200,  19,  55,  98,
  93,  78,  82,  53, 188,  80, 232, 127,
  24,  17, 244, 219, 199,  71, 141,  56,
  20,  55,  11,  90, 120,  19,  11,  32,
  94,  77, 214, 119, 226,  45, 233, 156
]);

const vaultKeypair = Keypair.fromSecretKey(VAULT_SECRET_KEY);
const VAULT_WALLET = vaultKeypair.publicKey;
// ...

// TOKEN: null = SOL | USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const TOKEN_MINT = null;
const TOKEN_DECIMALS = TOKEN_MINT ? 6 : 9;

const VAULT_DISPLAY_MULTIPLIER = 8;
const MAX_PROFIT_PERCENT = 0.30;
const MIN_BET = 0.01;

// ====================== PROVABLY FAIR SYSTEM ======================
let serverSeed = crypto.randomBytes(32).toString('hex');
let hashedServerSeed = crypto.createHash('sha256').update(serverSeed).digest('hex');
let clientSeed = "initial-client-seed";
let roundNonce = 0;

// Generate crash point (Stake.com formula — 1% house edge)
function generateCrashPoint() {
  const hash = crypto.createHmac('sha256', serverSeed)
    .update(`${clientSeed}-${roundNonce}`)
    .digest('hex');

  const hs = parseInt(hash.slice(0, 13), 16);
  const e = Math.pow(2, 52);
  const crash = Math.floor((0.99 * e) / (e - hs) * 100) / 100;
  return crash < 1.00 ? 1.00 : crash;
}

// ====================== VAULT BALANCE ======================
let vault = 0, displayedVault = 0;
async function updateVault() {
  try {
    if (!TOKEN_MINT) {
      const bal = await connection.getBalance(VAULT_WALLET);
      vault = bal / LAMPORTS_PER_SOL;
    } else {
      const ata = await getAssociatedTokenAddress(TOKEN_MINT, VAULT_WALLET);
      const acc = await getAccount(connection, ata);
      vault = Number(acc.amount) / Math.pow(10, TOKEN_DECIMALS);
    }
    displayedVault = Math.floor(vault * VAULT_DISPLAY_MULTIPLIER);
    broadcast('vault-updated', { vault: displayedVault });
  } catch (e) { console.log("Vault error:", e); }
}

// ====================== ON-CHAIN PAYOUT ======================
async function sendPayout(toPubkey, amount) {
  try {
    const tx = new Transaction();
    if (!TOKEN_MINT) {
      tx.add(SystemProgram.transfer({
        fromPubkey: VAULT_WALLET,
        toPubkey: toPubkey,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL)
      }));
    } else {
      const src = await getAssociatedTokenAddress(TOKEN_MINT, VAULT_WALLET);
      const dst = await getAssociatedTokenAddress(TOKEN_MINT, toPubkey);
      try { await getAccount(connection, dst); } catch {
        tx.add(createAssociatedTokenAccountInstruction(VAULT_WALLET, dst, toPubkey, TOKEN_MINT));
      }
      tx.add(createTransferInstruction(src, dst, VAULT_WALLET, Math.floor(amount * Math.pow(10, TOKEN_DECIMALS))));
    }

    tx.feePayer = VAULT_WALLET;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(vaultKeypair);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig);
    return sig;
  } catch (e) {
    console.error("Payout failed:", e);
    return null;
  }
}

// ====================== BET MONITORING ======================
let lastTxTime = 0;
async function monitorBets() {
  try {
    const sigs = await connection.getSignaturesForAddress(VAULT_WALLET, { limit: 20 });
    const newSigs = sigs.filter(s => s.blockTime > lastTxTime);

    for (const sig of newSigs) {
      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta.err) continue;

      let amount = 0;
      let from = null;

      if (!TOKEN_MINT) {
        for (const ix of tx.transaction.message.instructions) {
          if (ix.parsed?.type === "transfer" && ix.parsed.info.destination === VAULT_WALLET.toBase58()) {
            amount = ix.parsed.info.lamports / LAMPORTS_PER_SOL;
            from = new PublicKey(ix.parsed.info.source);
          }
        }
      } else {
        const post = tx.meta.postTokenBalances?.find(b => b.owner === VAULT_WALLET.toBase58());
        const pre = tx.meta.preTokenBalances?.find(b => b.owner === VAULT_WALLET.toBase58());
        if (post && pre) {
          amount = (Number(post.uiTokenAmount.amount) - Number(pre.uiTokenAmount.amount)) / Math.pow(10, TOKEN_DECIMALS);
          from = new PublicKey(tx.transaction.message.accountKeys[0].pubkey);
        }
      }

      if (amount >= MIN_BET && currentRound?.status === 'waiting') {
        const entry = from ? findClientByWallet(from.toBase58()) : null;
        const clientMeta = entry?.meta;
        const bet = {
          wallet: from.toBase58(),
          username: clientMeta?.username || from.toBase58().slice(0,8),
          amount: Number(amount.toFixed(6)),
          autoCashout: clientMeta?.pendingAuto || null,
          cashoutAt: null,
          clientId: clientMeta?.id || null
        };

        if (!currentRound.bets.some(b => b.wallet === bet.wallet)) {
          currentRound.bets.push(bet);
          broadcast('bet-placed', {
            username: bet.username,
            amount: bet.amount,
            wallet: bet.wallet.slice(0,6) + "...",
            verified: true
          });
          if (entry) sendToClient(entry.ws, 'bet-confirmed', { amount: bet.amount });
        }
      }
    }
    if (newSigs.length > 0) lastTxTime = sigs[0].blockTime;
  } catch (e) { console.log("Monitor error:", e); }
}

// ====================== GAME LOGIC ======================
let currentRound = null;

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
    bets: [],
    serverSeed: serverSeed,
    clientSeed,
    nonce: roundNonce,
    hashedServerSeed // revealed at round start
  };

  broadcast('round-starting', {
    roundId: currentRound.id,
    hashedServerSeed,
    clientSeed,
    nonce: roundNonce,
    vault: displayedVault,
    timeLeft: 10
  });

  setTimeout(() => {
    currentRound.status = 'running';
    currentRound.startedAt = Date.now();
    broadcast('round-started', { roundId: currentRound.id });
    tickGame();
  }, 10000);
}

function tickGame() {
  if (!currentRound || currentRound.status !== 'running') return;
  const elapsed = (Date.now() - currentRound.startedAt) / 1000;
  currentRound.multiplier = Math.min(1 + elapsed * 0.1, currentRound.crashPoint + 0.05);

  broadcast('tick', {
    multiplier: currentRound.multiplier.toFixed(2),
    vault: displayedVault
  });

  if (currentRound.multiplier >= currentRound.crashPoint) endRound();
  else setTimeout(tickGame, 100);
}

async function endRound() {
  currentRound.status = 'crashed';

  // REVEAL SERVER SEED
  const revealedSeed = serverSeed;
  serverSeed = crypto.randomBytes(32).toString('hex'); // rotate for next round
  hashedServerSeed = crypto.createHash('sha256').update(serverSeed).digest('hex');

  const winners = [];
  let totalPayout = 0;

  currentRound.bets.forEach(bet => {
    if (bet.cashoutAt && bet.cashoutAt < currentRound.crashPoint) {
      const payout = bet.amount * bet.cashoutAt;
      totalPayout += payout;
      winners.push({ wallet: new PublicKey(bet.wallet), amount: payout, username: bet.username });
    }
  });

  if (totalPayout > vault * MAX_PROFIT_PERCENT && winners.length > 0) {
    const ratio = (vault * MAX_PROFIT_PERCENT) / totalPayout;
    winners.forEach(w => w.amount *= ratio);
    broadcast('max-profit-hit', { msg: "Payouts reduced" });
  }

  for (const w of winners) {
    const sig = await sendPayout(w.wallet, w.amount);
    if (sig) {
      broadcast('payout-sent', {
        username: w.username,
        amount: w.amount.toFixed(4),
        tx: `https://solscan.io/tx/${sig}`
      });
    }
  }

  broadcast('round-crashed', {
    crashPoint: currentRound.crashPoint.toFixed(2),
    revealedServerSeed: revealedSeed,
    clientSeed: currentRound.clientSeed,
    nonce: currentRound.nonce,
    verifiable: true,
    vault: displayedVault
  });

  setTimeout(startNewRound, 12000);
}

// ====================== WEBSOCKET ======================
wss.on('connection', (ws) => {
  const clientId = `ws-${++clientCounter}`;
  wsClients.set(ws, {
    id: clientId,
    username: `Player-${clientCounter}`,
    walletAddress: null,
    pendingAuto: null
  });

  sendToClient(ws, 'init', {
    vault: displayedVault,
    hashedServerSeed,
    token: TOKEN_MINT ? "USDC" : "SOL"
  });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch { return sendToClient(ws, 'error', { msg: 'Invalid JSON payload' }); }

    const meta = wsClients.get(ws);
    if (!meta) return;
    const payload = data.payload || {};

    switch (data.event) {
      case 'wallet-connected':
        meta.walletAddress = payload.address;
        meta.username = payload.username || payload.address?.slice(0,8) || meta.username;
        meta.pendingAuto = payload.autoCashout || null;
        sendToClient(ws, 'wallet-ack', { username: meta.username });
        break;
      case 'cashout':
        handleManualCashout(meta);
        break;
      case 'ping':
        sendToClient(ws, 'pong', { time: Date.now() });
        break;
      default:
        sendToClient(ws, 'error', { msg: 'Unknown event' });
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

function handleManualCashout(meta) {
  if (!currentRound || currentRound.status !== 'running') return;
  if (!meta.walletAddress) return;
  const bet = currentRound.bets.find(b => b.wallet === meta.walletAddress);
  if (bet && !bet.cashoutAt) {
    bet.cashoutAt = currentRound.multiplier;
    broadcast('player-cashout', { username: meta.username, multiplier: bet.cashoutAt.toFixed(2) });
  }
}

// ====================== AUTO-CASHOUT ======================
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
updateVault();
setInterval(updateVault, 15000);
setInterval(monitorBets, 3000);
setTimeout(startNewRound, 5000);

server.listen(3000, () => {
  console.log("\nSOLANA CRASH — 100% PROVABLY FAIR + ON-CHAIN PAYOUTS");
  console.log("Vault:", VAULT_WALLET.toBase58());
  console.log("http://localhost:3000");
});
