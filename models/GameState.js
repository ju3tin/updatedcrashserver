// models/GameState.js
const mongoose = require('mongoose');

const GameStateSchema = new mongoose.Schema({
  key: { type: String, unique: true }, // e.g. "currentRoundId", "gameState", "vault", etc.

  // Used for singleton patterns
  currentRound: { type: mongoose.Schema.Types.ObjectId, ref: 'GameRound' },
  gameState: { 
    type: String, 
    enum: ['waiting', 'running', 'crashed'], 
    default: 'waiting' 
  },
  currentMultiplier: { type: Number, default: 1.00 },
  timeElapsed: { type: Number, default: 0 },
  realVault: { type: Number, default: 0 },        // actual on-chain SOL
  displayedVault: { type: Number, default: 0 },   // 8× inflated
  lastVaultUpdate: { type: Date, default: Date.now },
});

module.exports = mongoose.model('GameState', GameStateSchema);