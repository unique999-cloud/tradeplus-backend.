const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const app = express();

// ============================================================
// CORS — allow all origins explicitly
// ============================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json());

// ============================================================
// API KEYS — set in Railway Variables:
// ALPHA_KEY = UAP1QV54EGYN7DRT
// NEWS_KEY  = cf9094777d43494b98720d3349fdc549
// ============================================================
const ALPHA_KEY = process.env.ALPHA_KEY;
const NEWS_KEY  = process.env.NEWS_KEY;

// ============================================================
// PAIRS — limited to 5 to stay within Alpha Vantage free tier
// (5 calls per minute max on free plan)
// ============================================================
const PAIRS = [
  { symbol: 'EUR/USD', from: 'EUR', to: 'USD' },
  { symbol: 'GBP/USD', from: 'GBP', to: 'USD' },
  { symbol: 'USD/JPY', from: 'USD', to: 'JPY' },
  { symbol: 'AUD/USD', from: 'AUD', to: 'USD' },
  { symbol: 'XAU/USD', from: 'XAU', to: 'USD' },
];

// Cache — prevents hitting rate limits
const cache = {};
const TTL = 10 * 60 * 1000; // 10 minutes (safe for free tier)

// ============================================================
// FETCH CANDLES FROM ALPHA VANTAGE
// ============================================================
async function getCandles(pair) {
  try {
    let url;
    if (pair.from === 'XAU') {
      // Gold uses commodity endpoint
      url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=XAUUSD&interval=60min&outputsize=compact&apikey=${ALPHA_KEY}`;
    } else {
      url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${pair.from}&to_symbol=${pair.to}&interval=60min&outputsize=compact&apikey=${ALPHA_KEY}`;
    }
    const res = await fetch(url);
    const data = await res.json();

    // Find the time series key (varies by endpoint)
    const key = Object.keys(data).find(k =>
      k.includes('Time Series') || k.includes('Time Series FX')
    );
    if (!key || !data[key]) return null;

    const series = data[key];
    const candles = Object.entries(series)
      .slice(0, 50)
      .map(([time, v]) => ({
        time,
        open:  parseFloat(v['1. open']),
        high:  parseFloat(v['2. high']),
        low:   parseFloat(v['3. low']),
        close: parseFloat(v['4. close']),
      }))
      .reverse(); // oldest first

    return candles.length >= 10 ? candles : null;
  } catch(e) {
    console.error(`Candle fetch error for ${pair.symbol}:`, e.message);
    return null;
  }
}

// ============================================================
// RSI — Real Strength Index
// ============================================================
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i-1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i-1].close;
    avgGain = ((avgGain * (period-1)) + (diff > 0 ? diff : 0)) / period;
    avgLoss = ((avgLoss * (period-1)) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - (100 / (1 + avgGain/avgLoss))).toFixed(2));
}

// ============================================================
// MACD
// ============================================================
function ema(values, period) {
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}
function calcMACD(candles) {
  if (candles.length < 26) return null;
  const closes = candles.map(c => c.close);
  const macdLine   = ema(closes.slice(-12), 12) - ema(closes.slice(-26), 26);
  const signalLine = ema(closes.slice(-9), 9);
  return {
    macd:      parseFloat(macdLine.toFixed(6)),
    signal:    parseFloat(signalLine.toFixed(6)),
    histogram: parseFloat((macdLine - signalLine).toFixed(6)),
    bullish:   macdLine > signalLine
  };
}

// ============================================================
// MARKET STRUCTURE — Higher Highs/Lows detection
// ============================================================
function detectStructure(candles) {
  if (candles.length < 10) return 'NEUTRAL';
  const recent = candles.slice(-10);
  const highs  = recent.map(c => c.high);
  const lows   = recent.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(-3));
  const prevHigh   = Math.max(...highs.slice(0, 5));
  const recentLow  = Math.min(...lows.slice(-3));
  const prevLow    = Math.min(...lows.slice(0, 5));
  if (recentHigh > prevHigh && recentLow > prevLow) return 'BULLISH';
  if (recentHigh < prevHigh && recentLow < prevLow) return 'BEARISH';
  return 'NEUTRAL';
}

// ============================================================
// SPREAD ESTIMATES (in pips)
// ============================================================
function getSpread(symbol) {
  const spreads = {
    'EUR/USD': 1.1, 'GBP/USD': 1.8, 'USD/JPY': 1.2,
    'AUD/USD': 1.5, 'XAU/USD': 3.5
  };
  return spreads[symbol] || 2.0;
}

// ============================================================
// NEWS BLACKOUT — pauses signals ±10min around major events
// ============================================================
function isBlackout() {
  const now  = new Date();
  const watH = (now.getUTCHours() + 1) % 24;
  const watM = now.getUTCMinutes();
  const watDay = now.getUTCDay();
  const nowMins = watH * 60 + watM;
  const events = [
    { h:14, m:30, day:5 }, // NFP — every Friday 14:30 WAT
    { h:19, m:0,  day:3 }, // FOMC — Wednesday 19:00 WAT
    { h:13, m:15, day:4 }, // ECB — Thursday 13:15 WAT
    { h:13, m:30, day:3 }, // US CPI — Wednesday 13:30 WAT
    { h:7,  m:0,  day:3 }, // UK CPI — Wednesday 07:00 WAT
  ];
  for (const ev of events) {
    const evMins = ev.h * 60 + ev.m;
    if (ev.day === watDay && Math.abs(nowMins - evMins) <= 10) return true;
  }
  return false;
}

// ============================================================
// SESSION DETECTOR
// ============================================================
function getSession() {
  const watH = (new Date().getUTCHours() + 1) % 24;
  if (watH >= 8  && watH < 13) return 'LONDON';
  if (watH >= 13 && watH < 17) return 'LONDON+NY OVERLAP';
  if (watH >= 17 && watH < 22) return 'NEW YORK';
  if (watH >= 23 || watH < 8)  return 'ASIAN';
  return 'OFF-HOURS';
}

// ============================================================
// SIGNAL GENERATOR — accuracy and safety first
// ============================================================
function generateSignal(rsi, macd, structure, price, candles, symbol) {
  let bullScore = 0, bearScore = 0;

  // RSI scoring (weighted)
  if (rsi !== null) {
    if (rsi < 30)      bullScore += 3; // Strongly oversold
    else if (rsi < 40) bullScore += 2;
    else if (rsi < 50) bullScore += 1;
    if (rsi > 70)      bearScore += 3; // Strongly overbought
    else if (rsi > 60) bearScore += 2;
    else if (rsi > 50) bearScore += 1;
  }

  // MACD scoring
  if (macd !== null) {
    if (macd.bullish)       bullScore += 2; else bearScore += 2;
    if (macd.histogram > 0) bullScore += 1; else bearScore += 1;
  }

  // Structure scoring (highest weight — most reliable)
  if (structure === 'BULLISH')      bullScore += 4;
  else if (structure === 'BEARISH') bearScore += 4;

  const total = bullScore + bearScore;
  const confidence = total > 0
    ? Math.round((Math.max(bullScore, bearScore) / total) * 100)
    : 50;

  // Only signal when confidence is strong enough
  let signal = 'WAIT';
  if (bullScore > bearScore && confidence >= 62) signal = 'BUY';
  else if (bearScore > bullScore && confidence >= 62) signal = 'SELL';

  // Safety filters
  const spread    = getSpread(symbol);
  const blackout  = isBlackout();
  const session   = getSession();

  // Block during blackout or wide spread
  if (blackout || spread > 2.5) signal = 'WAIT';

  // Calculate entry levels using ATR
  const atr = candles.slice(-14).reduce((sum, c, i, arr) => {
    if (i === 0) return sum;
    return sum + Math.abs(c.high - c.low);
  }, 0) / 13;

  const dp = price > 10 ? 2 : 4;
  const recentLows  = candles.slice(-10).map(c => c.low);
  const recentHighs = candles.slice(-10).map(c => c.high);
  let sl, tp;

  if (signal === 'BUY') {
    sl = (Math.min(...recentLows) - atr * 0.3).toFixed(dp);
    tp = (price + (price - parseFloat(sl)) * 2).toFixed(dp); // 1:2 R:R
  } else if (signal === 'SELL') {
    sl = (Math.max(...recentHighs) + atr * 0.3).toFixed(dp);
    tp = (price - (parseFloat(sl) - price) * 2).toFixed(dp); // 1:2 R:R
  } else {
    sl = (price - atr).toFixed(dp);
    tp = (price + atr).toFixed(dp);
  }

  return {
    signal, confidence,
    entry: price.toFixed(dp), sl, tp,
    rsi, macd: macd?.macd || null,
    macdBullish: macd?.bullish ?? null,
    structure, spread, blackout, session,
    bullScore, bearScore
  };
}

// ============================================================
// BUILD EDUCATIONAL REASONS
// ============================================================
function buildReasons(sig) {
  const r = [];
  if (sig.blackout) {
    r.push({ icon:'⏸', text:'High-impact news event within 10 minutes — trading paused for your safety' });
  }
  if (sig.spread > 2.5) {
    r.push({ icon:'🚫', text:`Spread at ${sig.spread} pips — too wide, signal blocked to protect from slippage` });
  }
  if (sig.structure === 'BULLISH') {
    r.push({ icon:'📈', text:'Price forming Higher Highs + Higher Lows — bullish market structure confirmed on H1' });
  } else if (sig.structure === 'BEARISH') {
    r.push({ icon:'📉', text:'Price forming Lower Highs + Lower Lows — bearish market structure confirmed on H1' });
  } else {
    r.push({ icon:'↔️', text:'Market is ranging — no clear higher highs or lower lows yet, waiting for breakout' });
  }
  if (sig.rsi !== null) {
    if (sig.rsi < 30) {
      r.push({ icon:'📊', text:`RSI at ${sig.rsi} — market strongly oversold, sellers exhausted, reversal up is highly probable` });
    } else if (sig.rsi < 40) {
      r.push({ icon:'📊', text:`RSI at ${sig.rsi} — approaching oversold territory, bullish momentum building` });
    } else if (sig.rsi > 70) {
      r.push({ icon:'📊', text:`RSI at ${sig.rsi} — market strongly overbought, buyers exhausted, reversal down is highly probable` });
    } else if (sig.rsi > 60) {
      r.push({ icon:'📊', text:`RSI at ${sig.rsi} — approaching overbought territory, bearish pressure building` });
    } else {
      r.push({ icon:'📊', text:`RSI at ${sig.rsi} — neutral zone, no extreme conditions, trend momentum is the guide` });
    }
  }
  if (sig.macd !== null) {
    if (sig.macdBullish) {
      r.push({ icon:'⚡', text:'MACD line crossed above signal line — bullish momentum confirmed, buyers in control' });
    } else {
      r.push({ icon:'⚡', text:'MACD line crossed below signal line — bearish momentum confirmed, sellers in control' });
    }
  }
  r.push({
    icon: '🕐',
    text: `Current session: ${sig.session} — ${sig.session === 'LONDON+NY OVERLAP'
      ? 'This is the best time to trade — highest liquidity and tightest spreads'
      : sig.session === 'OFF-HOURS'
      ? 'Market is outside main sessions — lower liquidity, be extra cautious'
      : sig.session + ' session active'}`
  });
  if (sig.signal === 'BUY') {
    r.push({ icon:'✅', text:`All indicators aligned bullish with ${sig.confidence}% confidence — risk/reward is 1:2 minimum` });
  } else if (sig.signal === 'SELL') {
    r.push({ icon:'🔴', text:`All indicators aligned bearish with ${sig.confidence}% confidence — risk/reward is 1:2 minimum` });
  } else {
    r.push({ icon:'⏳', text:'Not enough confluence yet — patience is the most profitable strategy. Wait for a clearer setup.' });
  }
  return r;
}

// ============================================================
// MAIN SIGNAL FUNCTION WITH CACHING
// ============================================================
async function getSignalForPair(pair) {
  const now = Date.now();
  if (cache[pair.symbol] && (now - cache[pair.symbol].ts) < TTL) {
    return cache[pair.symbol].data;
  }

  // Stagger API calls to avoid rate limiting
  const index = PAIRS.findIndex(p => p.symbol === pair.symbol);
  if (index > 0) {
    await new Promise(resolve => setTimeout(resolve, index * 13000)); // 13s between calls
  }

  const candles = await getCandles(pair);
  if (!candles || candles.length < 15) {
    console.log(`No candles for ${pair.symbol}`);
    return null;
  }

  const price     = candles[candles.length - 1].close;
  const rsi       = calcRSI(candles);
  const macd      = calcMACD(candles);
  const structure = detectStructure(candles);
  const sigData   = generateSignal(rsi, macd, structure, price, candles, pair.symbol);
  const reasons   = buildReasons(sigData);

  const result = {
    symbol:  pair.symbol,
    price:   price.toFixed(price > 10 ? 2 : 4),
    ...sigData,
    reasons,
    candles: candles.slice(-40).map(c => ({
      time:  c.time,
      close: c.close,
      high:  c.high,
      low:   c.low,
      open:  c.open
    })),
    updatedAt: new Date().toISOString()
  };

  cache[pair.symbol] = { ts: now, data: result };
  return result;
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status:   'TRADEPLUS BACKEND LIVE ✅',
    version:  '3.0',
    source:   'Alpha Vantage — Real-time Forex Data',
    session:  getSession(),
    blackout: isBlackout(),
    pairs:    PAIRS.map(p => p.symbol),
    time:     new Date().toISOString()
  });
});

// All signals — fetched sequentially to respect rate limits
app.get('/api/signals', async (req, res) => {
  try {
    const signals = [];
    for (const pair of PAIRS) {
      const sig = await getSignalForPair(pair);
      if (sig) signals.push(sig);
    }
    res.json({
      success:  true,
      signals,
      count:    signals.length,
      blackout: isBlackout(),
      session:  getSession(),
      time:     new Date().toISOString()
    });
  } catch(e) {
    console.error('Signals error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Single pair signal
app.get('/api/signal/:symbol', async (req, res) => {
  try {
    const symbolInput = req.params.symbol.replace('-', '/').toUpperCase();
    const pair = PAIRS.find(p => p.symbol === symbolInput);
    if (!pair) return res.status(404).json({ success: false, error: 'Pair not found' });
    const data = await getSignalForPair(pair);
    if (!data) return res.status(500).json({ success: false, error: 'Could not fetch data' });
    res.json({ success: true, data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// News feed
app.get('/api/news', async (req, res) => {
  try {
    const url = `https://newsapi.org/v2/everything?q=forex+dollar+ECB+Fed+interest+rates+gold+inflation&language=en&sortBy=publishedAt&pageSize=12&apiKey=${NEWS_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.articles) return res.json({ success: true, news: [] });
    const news = d.articles.map(a => ({
      headline:  a.title,
      source:    a.source?.name || '',
      time:      a.publishedAt,
      url:       a.url,
      impact:    a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis|emergency/) ? 'high' :
                 a.title.toLowerCase().match(/oil|gold|trade|data|bank|growth/) ? 'med' : 'low',
      sentiment: a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|beat|rally|jump|soar/) ? 'bullish' : 'bearish'
    }));
    res.json({ success: true, news });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    alive:    true,
    session:  getSession(),
    blackout: isBlackout(),
    cached:   Object.keys(cache).length,
    time:     new Date().toISOString()
  });
});

// Keep Railway awake — ping self every 14 minutes
setInterval(() => {
  fetch(`http://localhost:${process.env.PORT || 3000}/api/health`)
    .catch(() => {});
}, 14 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ TRADEPLUS v3 Backend running on port ${PORT}`));
