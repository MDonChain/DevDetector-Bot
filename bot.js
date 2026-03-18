const https = require('https');
const http = require('http');

const TOKEN = '8663467707:AAFeZdzU6fFO19a8DPEGIWfXjZDOYypuo7M';
const BASE = `https://api.telegram.org/bot${TOKEN}`;

// ─── TELEGRAM API HELPERS ─────────────────────────────────
function tgRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request(`${BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, parseMode = 'Markdown') {
  return tgRequest('sendMessage', { chat_id: chatId, text, parse_mode: parseMode });
}

// ─── SOLANA SCANNER ───────────────────────────────────────
async function scanSolana(address) {
  const RPC = 'https://mainnet.helius-rpc.com/?api-key=489d8ae3-e737-4415-9192-0683bdbc244e';

  async function rpcCall(method, params, id) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const req = https.request(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          const data = JSON.parse(raw);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  const [accountInfo, signatures] = await Promise.all([
    rpcCall('getAccountInfo', [address, { encoding: 'base64' }], 1),
    rpcCall('getSignaturesForAddress', [address, { limit: 50 }], 2)
  ]);

  const lamports = accountInfo?.value?.lamports ?? 0;
  const solBalance = (lamports / 1e9).toFixed(4);
  const transactions = signatures ?? [];
  const txCount = transactions.length;

  let tokenCount = 0;
  try {
    const tokens = await rpcCall('getTokenAccountsByOwner', [
      address,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed' }
    ], 3);
    tokenCount = tokens?.value?.length ?? 0;
  } catch(_) {}

  let walletAgeMonths = 0;
  let recentBursts = 0;
  if (transactions.length > 0) {
    const oldest = transactions[transactions.length - 1];
    const newest = transactions[0];
    if (oldest?.blockTime && newest?.blockTime) {
      walletAgeMonths = parseFloat(((newest.blockTime - oldest.blockTime) / (30 * 24 * 3600)).toFixed(1));
      recentBursts = transactions.filter(t => t.blockTime && (Date.now()/1000 - t.blockTime) < 7*24*3600).length;
    }
  }

  return computeScore({ chain: 'sol', address, balance: solBalance, balanceSymbol: 'SOL', txCount, tokenCount, walletAgeMonths, recentBursts });
}

// ─── ETHEREUM SCANNER ────────────────────────────────────
async function scanEthereum(address) {
  const RPC = 'https://cloudflare-eth.com';

  async function rpcCall(method, params, id) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      const req = https.request(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          const data = JSON.parse(raw);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  const [balResult, codeResult, nonceResult] = await Promise.all([
    rpcCall('eth_getBalance', [address, 'latest'], 1),
    rpcCall('eth_getCode', [address, 'latest'], 2),
    rpcCall('eth_getTransactionCount', [address, 'latest'], 3)
  ]);

  const wei = parseInt(balResult ?? '0x0', 16);
  const ethBalance = (wei / 1e18).toFixed(4);
  const isContract = codeResult && codeResult !== '0x' && codeResult.length > 4;
  const txCount = parseInt(nonceResult ?? '0x0', 16);

  return computeScore({
    chain: 'eth', address, balance: ethBalance, balanceSymbol: 'ETH',
    txCount, tokenCount: 0,
    walletAgeMonths: txCount > 500 ? 24 : txCount > 100 ? 12 : txCount > 20 ? 6 : 1,
    recentBursts: 0, isContract
  });
}

// ─── SCORING ENGINE ───────────────────────────────────────
function computeScore({ chain, address, balance, balanceSymbol, txCount, tokenCount, walletAgeMonths, recentBursts, isContract }) {
  const flags = [];
  const bal = parseFloat(balance);

  let ageScore = 25;
  if (walletAgeMonths < 0.5) { ageScore = 0; flags.push('🔴 Brand new wallet — zero track record'); }
  else if (walletAgeMonths < 1) { ageScore = 5; flags.push('🔴 Under 1 month old — insufficient history'); }
  else if (walletAgeMonths < 3) { ageScore = 12; flags.push(`🟡 Only ${walletAgeMonths} months old — young wallet`); }
  else if (walletAgeMonths >= 6) { ageScore = 25; flags.push(`🟢 ${walletAgeMonths}+ months history — good track record`); }
  else { ageScore = 18; }

  if (walletAgeMonths > 6 && txCount < 10) {
    ageScore = Math.max(0, ageScore - 10);
    flags.push('🟡 Old wallet with very low activity — possible dormant wallet activated for launch');
  }

  let txScore = 25;
  if (txCount === 0) { txScore = 0; flags.push('🔴 Zero transactions — wallet never used'); }
  else if (txCount < 5) { txScore = 4; flags.push(`🔴 Only ${txCount} transactions — extremely thin history`); }
  else if (txCount < 15) { txScore = 10; flags.push(`🟡 ${txCount} transactions — limited history`); }
  else if (txCount < 50) { txScore = 17; }
  else if (txCount < 200) { txScore = 22; }
  else { txScore = 25; flags.push(`🟢 ${txCount} lifetime transactions — established wallet`); }

  let balScore = 15;
  if (bal === 0) { balScore = 3; flags.push(`🟡 Zero ${balanceSymbol} balance — wallet drained`); }
  else if (bal < 0.01) { balScore = 7; flags.push(`🟡 Dust balance (${balance} ${balanceSymbol})`); }
  else if (bal > 500 && chain === 'sol') { balScore = 10; flags.push(`🟡 Large SOL balance (${balance} SOL) — verify source`); }

  let burstScore = 20;
  const burstRatio = txCount > 0 ? recentBursts / txCount : 0;
  if (recentBursts > 40) { burstScore = 0; flags.push(`🔴 ${recentBursts} txns in 7 days — extreme burst activity`); }
  else if (recentBursts > 20) { burstScore = 6; flags.push(`🟡 ${recentBursts} txns in 7 days — elevated activity`); }
  else if (recentBursts > 10 && burstRatio > 0.8) { burstScore = 10; flags.push(`🟡 ${Math.round(burstRatio*100)}% of activity in last 7 days — sudden activation`); }
  else if (recentBursts === 0 && txCount > 0) { flags.push('🟢 No recent burst activity — low immediate dump risk'); }

  let tokenScore = 15;
  if (chain === 'sol') {
    if (tokenCount > 100) { tokenScore = 2; flags.push(`🔴 ${tokenCount} token types — serial deployer or sniping bot pattern`); }
    else if (tokenCount > 40) { tokenScore = 7; flags.push(`🟡 ${tokenCount} token accounts — high memecoin exposure`); }
    else if (tokenCount === 0) { tokenScore = 8; flags.push('🟡 No token accounts — no SPL token history'); }
    else { tokenScore = 15; flags.push(`🟢 ${tokenCount} token accounts — reasonable exposure`); }
  } else if (isContract) {
    tokenScore = 5; flags.push('🟡 Smart contract address — not a personal wallet');
  }

  let consistencyBonus = 0;
  if (walletAgeMonths > 6 && txCount > 50 && recentBursts < 15) {
    consistencyBonus = 5;
    flags.push('🟢 Consistent long-term activity — strong trust signal');
  }

  let score = Math.max(0, Math.min(100, ageScore + txScore + balScore + burstScore + tokenScore + consistencyBonus));
  if (isContract) score = Math.min(score, 60);

  let verdict, emoji;
  if (score >= 78) { verdict = 'LOW RISK'; emoji = '🟢'; }
  else if (score >= 52) { verdict = 'MEDIUM RISK'; emoji = '🟡'; }
  else if (score >= 30) { verdict = 'HIGH RISK'; emoji = '🔴'; }
  else { verdict = 'CRITICAL RISK'; emoji = '🚨'; }

  return { score, verdict, emoji, flags, balance, balanceSymbol, txCount, tokenCount, walletAgeMonths, chain };
}

// ─── NARRATIVE SCORER ─────────────────────────────────────
function analyseNarrative(text) {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  const len = words.length;
  const exclamations = (text.match(/!/g) || []).length;
  const capsWords = (text.match(/\b[A-Z]{3,}\b/g) || []).length;

  let strength = 45;
  const strongPositives = [['fair launch',12],['no dev wallet',12],['lp locked',10],['liquidity locked',10],['renounced',10],['doxxed',10],['audited',10],['no presale',10]];
  const softRedFlags = [['100x',-10],['1000x',-15],['guaranteed',-15],['buy now',-12],['easy money',-18],['moon',-8]];
  strongPositives.forEach(([p,v]) => { if (lower.includes(p)) strength += v; });
  softRedFlags.forEach(([p,v]) => { if (lower.includes(p)) strength += v; });
  if (len < 5) strength -= 25;
  if (len > 50) strength += 10;
  strength = Math.max(0, Math.min(100, strength));

  const saturated = {dogcoin:['dog','doge','shib','inu'],frogmeme:['pepe','frog','wojak'],catcoin:['cat','kitty'],aicoin:['ai','agent','gpt'],depin:['depin','node','hardware'],rwa:['rwa','real world']};
  const satLevels = {dogcoin:95,frogmeme:90,catcoin:88,aicoin:60,depin:35,rwa:40};
  let detectedCat = 'unknown'; let catSat = 50;
  for (const [cat, terms] of Object.entries(saturated)) {
    if (terms.some(t => lower.includes(t))) { detectedCat = cat; catSat = satLevels[cat]; break; }
  }
  let originality = Math.max(0, Math.min(100, 100 - catSat));

  let hypeScore = 70;
  const shillPhrases = ['gem alert','ape in','dont sleep','just launched','next 100x','going parabolic','to the moon','low cap','hidden gem'];
  shillPhrases.forEach(p => { if (lower.includes(p)) hypeScore -= 12; });
  if (exclamations > 5) hypeScore -= 15;
  if (capsWords > 4) hypeScore -= 12;
  hypeScore = Math.max(0, Math.min(100, hypeScore));

  const overall = Math.round((strength * 0.45) + (originality * 0.30) + (hypeScore * 0.25));

  const flags = [];
  if (lower.includes('guaranteed')) flags.push('🔴 Uses "guaranteed" language — scam signal');
  if (lower.includes('100x') || lower.includes('1000x')) flags.push('🔴 Specific return promises — manipulative pump language');
  if (lower.includes('fair launch') && (lower.includes('presale') || lower.includes('whitelist'))) flags.push('🔴 CONTRADICTION: Claims fair launch but mentions presale');
  if (exclamations > 5) flags.push(`🔴 ${exclamations} exclamation marks — FOMO manipulation`);
  if (lower.includes('lp locked') || lower.includes('liquidity locked')) flags.push('🟢 Claims locked liquidity — verify on-chain');
  if (lower.includes('renounced')) flags.push('🟢 Claims renounced contract — verify on-chain');
  if (lower.includes('audited')) flags.push('🟢 Claims audited — ask for audit link');
  if (detectedCat !== 'unknown') flags.push(`${catSat > 80 ? '🔴' : catSat > 60 ? '🟡' : '🟢'} Category: ${detectedCat} — ${catSat}% market saturation`);
  if (flags.length === 0) flags.push('🟢 No major red flags in narrative language');

  let verdict;
  if (overall >= 70) verdict = '🟢 STRONG NARRATIVE';
  else if (overall >= 50) verdict = '🟡 MODERATE NARRATIVE';
  else if (overall >= 30) verdict = '🔴 WEAK NARRATIVE';
  else verdict = '🚨 SCAM RISK';

  return { overall, strength, originality, hypeScore, verdict, flags };
}

// ─── MESSAGE HANDLER ─────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  if (lower === '/start' || lower === '/help') {
    await sendMessage(chatId,
`*🔍 DevDetector Bot*

Scan wallets and narratives for rugpull signals.

*Commands:*
\`/scan <wallet>\` — Risk score a wallet address
\`/eth <wallet>\` — Scan an Ethereum wallet
\`/narrative <text>\` — Score a tweet or narrative
\`/help\` — Show this message

*Examples:*
\`/scan 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM\`
\`/narrative New dog coin fair launch no dev wallet\`

🌐 Web app: https://resilient-pavlova-cf229c.netlify.app`
    );
    return;
  }

  if (lower.startsWith('/scan ') || lower.startsWith('/sol ')) {
    const address = text.split(' ')[1]?.trim();
    if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      await sendMessage(chatId, '❌ Invalid Solana address. Usage: `/scan <wallet_address>`');
      return;
    }
    await sendMessage(chatId, '⏳ Scanning Solana wallet...');
    try {
      const r = await scanSolana(address);
      const flagText = r.flags.slice(0, 6).join('\n');
      await sendMessage(chatId,
`${r.emoji} *${r.verdict}* — Score: \`${r.score}/100\`

*Wallet:* \`${address.slice(0,8)}...${address.slice(-6)}\`
*Chain:* Solana
*Balance:* ${r.balance} SOL
*Transactions:* ${r.txCount}
*Token accounts:* ${r.tokenCount}
*Wallet age:* ~${r.walletAgeMonths} months

*Signals:*
${flagText}

🌐 Full scan: https://resilient-pavlova-cf229c.netlify.app`
      );
    } catch(e) {
      await sendMessage(chatId, `❌ Scan failed: ${e.message}`);
    }
    return;
  }

  if (lower.startsWith('/eth ')) {
    const address = text.split(' ')[1]?.trim();
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      await sendMessage(chatId, '❌ Invalid Ethereum address. Usage: `/eth 0x...`');
      return;
    }
    await sendMessage(chatId, '⏳ Scanning Ethereum wallet...');
    try {
      const r = await scanEthereum(address);
      const flagText = r.flags.slice(0, 6).join('\n');
      await sendMessage(chatId,
`${r.emoji} *${r.verdict}* — Score: \`${r.score}/100\`

*Wallet:* \`${address.slice(0,8)}...${address.slice(-6)}\`
*Chain:* Ethereum
*Balance:* ${r.balance} ETH
*Transactions:* ${r.txCount}

*Signals:*
${flagText}

🌐 Full scan: https://resilient-pavlova-cf229c.netlify.app`
      );
    } catch(e) {
      await sendMessage(chatId, `❌ Scan failed: ${e.message}`);
    }
    return;
  }

  if (lower.startsWith('/narrative ')) {
    const narrative = text.slice(11).trim();
    if (!narrative || narrative.length < 5) {
      await sendMessage(chatId, '❌ Too short. Usage: `/narrative <text to analyse>`');
      return;
    }
    const r = analyseNarrative(narrative);
    const flagText = r.flags.slice(0, 6).join('\n');
    await sendMessage(chatId,
`${r.verdict} — Score: \`${r.overall}/100\`

*Breakdown:*
• Narrative strength: ${r.strength}/100
• Originality: ${r.originality}/100
• Language risk: ${r.hypeScore}/100

*Signals:*
${flagText}

🌐 Full analysis: https://resilient-pavlova-cf229c.netlify.app`
    );
    return;
  }

  // Unknown command
  await sendMessage(chatId, 'Unknown command. Send /help to see available commands.');
}

// ─── POLLING LOOP ─────────────────────────────────────────
let offset = 0;

async function poll() {
  try {
    const res = await tgRequest('getUpdates', { offset, timeout: 30, limit: 10 });
    const updates = res.result ?? [];
    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message) {
        handleMessage(update.message).catch(console.error);
      }
    }
  } catch(e) {
    console.error('Poll error:', e.message);
  }
  setTimeout(poll, 1000);
}

// ─── KEEP-ALIVE SERVER (required by Render) ───────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DevDetector bot is running');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Starting Telegram poll loop...');
  poll();
});

server.on('error', (err) => {
  console.error('Server error:', err);
});
