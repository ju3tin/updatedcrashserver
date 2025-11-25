// scripts/seedConfig.js
const mongoose = require('mongoose');
const GameConfig = require('../models/GameConfig');

const defaults = [
  { key: 'rpcUrl',               value: 'https://api.mainnet-beta.solana.com' },
  { key: 'vaultWallet',          value: '6ZJ1Zy8vE6FivX3vK77LkZq2q9i6CqpNzWWu6hxv7RtW' },
  { key: 'tokenMint',            value: null },
  { key: 'vaultDisplayMultiplier', value: 8 },
  { key: 'maxPayoutPercent',     value: 0.30 },
  { key: 'maxSingleBetRatio',    value: 0.08 },
];

(async () => {
  await mongoose.connect('mongodb+srv://dude45:onelove@cluster0.ia9rd.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0mongodb://localhost:27017/bustafair');
  for (const item of defaults) {
    await GameConfig.updateOne({ key: item.key }, item, { upsert: true });
  }
  console.log('Config seeded – you can now edit live in MongoDB');
  process.exit();
})();