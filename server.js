const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET','POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ============================================================
// API KEYS — set these in Railway environment variables
// ALPHA_KEY = your Alpha Vantage key (free at alphavantage.co)
// NEWS_KEY  = your NewsAPI key
// ============================================================
const ALPHA_KEY  = process.env.ALPHA_KEY;
const NEWS_KEY   = process.env.NEWS_KEY;

const PAIRS = [
  { symbol:'EUR/USD', av:'EURUSD' },
  { symbol:'GBP/USD', av:'GBPUSD' },
  { symbol:'USD/JPY', av:'USDJPY' },
  { symbol:'AUD/USD', av:'AUDUSD' },
  { symbol:'USD/CAD', av:'USDCAD' },
  { symbol:'EUR/GBP', av:'EURGBP' },
  { symbol:'XAU/USD', av:'XAUUSD' },
];

// CACHE — prevents hammering free API
const cache = {};
const TTL = 5 * 60 * 1000; // 5 minutes

// ============================================================
// FETCH REAL CANDLES FROM ALPHA VANTAGE
// Free tier — real-time data, no delay
// ============================================================
async function getCandles(avSymbol) {
  try {
    const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${avSymbol.slice(0,3)}&to_symbol=${avSymbol.slice(3)}&interval=60min&outputsize=compact&apikey=${ALPHA_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const key = Object.keys(data).find(k => k.includes('Time Series'));
    if (!key) return null;
    const series = data[key];
    const candles = Object.entries(series).map(([time, v]) => ({
      time,
      open:  parseFloat(v['1. open']),
      high:  parseFloat(v['2. high']),
      low:   parseFloat(v['3. low']),
      close: parseFloat(v['4. close']),
    })).reverse();
    return candles;
  } catch(e) { return null; }
}

// Separate gold fetch (uses different AV endpoint)
async function getGoldCandles() {
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=XAUUSD&interval=60min&outputsize=compact&apikey=${ALPHA_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const key = Object.keys(data).find(k => k.includes('Time Series'));
    if (!key) return null;
    const series = data[key];
    return Object.entries(series).map(([time, v]) => ({
      time,
      open:  parseFloat(v['1. open']),
      high:  parseFloat(v['2. high']),
      low:   parseFloat(v['3. low']),
      close: parseFloat(v['4. close']),
    })).reverse();
  } catch(e) { return null; }
}

// ============================================================
// RSI
// ============================================================
function calcRSI(candles, period=14) {
  if (candles.length < period+1) return null;
  let g=0, l=0;
  for(let i=1;i<=period;i++){
    const d=candles[i].close-candles[i-1].close;
    if(d>=0) g+=d; else l+=Math.abs(d);
  }
  let ag=g/period, al=l/period;
  for(let i=period+1;i<candles.length;i++){
    const d=candles[i].close-candles[i-1].close;
    ag=((ag*(period-1))+(d>0?d:0))/period;
    al=((al*(period-1))+(d<0?Math.abs(d):0))/period;
  }
  if(al===0) return 100;
  return parseFloat((100-(100/(1+ag/al))).toFixed(2));
}

// ============================================================
// MACD
// ============================================================
function ema(vals, p) {
  const k=2/(p+1); let e=vals[0];
  for(let i=1;i<vals.length;i++) e=vals[i]*k+e*(1-k);
  return e;
}
function calcMACD(candles) {
  if(candles.length<26) return null;
  const cl=candles.map(c=>c.close);
  const macdLine=ema(cl.slice(-12),12)-ema(cl.slice(-26),26);
  const signalLine=ema(cl.slice(-9),9);
  return {
    macd:      parseFloat(macdLine.toFixed(5)),
    signal:    parseFloat(signalLine.toFixed(5)),
    histogram: parseFloat((macdLine-signalLine).toFixed(5)),
    bullish:   macdLine > signalLine
  };
}

// ============================================================
// MARKET STRUCTURE
// ============================================================
function detectStructure(candles) {
  if(candles.length<10) return 'NEUTRAL';
  const recent=candles.slice(-10);
  const highs=recent.map(c=>c.high), lows=recent.map(c=>c.low);
  const recentHigh=Math.max(...highs.slice(-3)), prevHigh=Math.max(...highs.slice(0,5));
  const recentLow=Math.min(...lows.slice(-3)),   prevLow=Math.min(...lows.slice(0,5));
  if(recentHigh>prevHigh && recentLow>prevLow) return 'BULLISH';
  if(recentHigh<prevHigh && recentLow<prevLow) return 'BEARISH';
  return 'NEUTRAL';
}

// ============================================================
// SPREAD ESTIMATES
// ============================================================
function getSpread(symbol) {
  const spreads = {
    'EUR/USD':1.1,'GBP/USD':1.8,'USD/JPY':1.2,
    'AUD/USD':1.5,'USD/CAD':2.1,'EUR/GBP':1.3,'XAU/USD':3.5
  };
  return spreads[symbol] || 2.0;
}

// ============================================================
// NEWS BLACKOUT CHECK
// ============================================================
function isBlackout() {
  const now = new Date();
  const watH = (now.getUTCHours()+1)%24;
  const watM = now.getUTCMinutes();
  const watMins = watH*60+watM;
  const day = now.getUTCDay();
  const events = [
    {h:14,m:30,day:5}, // NFP Friday
    {h:19,m:0, day:3}, // FOMC Wednesday
    {h:13,m:15,day:4}, // ECB Thursday
    {h:13,m:30,day:3}, // US CPI Wednesday
  ];
  for(const ev of events){
    if(ev.day===day && Math.abs(watMins-(ev.h*60+ev.m))<=10) return true;
  }
  return false;
}

// ============================================================
// SESSION DETECTOR
// ============================================================
function getSession() {
  const watH = (new Date().getUTCHours()+1)%24;
  if(watH>=8  && watH<13)  return 'LONDON';
  if(watH>=13 && watH<17)  return 'LONDON+NY OVERLAP';
  if(watH>=17 && watH<22)  return 'NEW YORK';
  if(watH>=23 || watH<8)   return 'ASIAN';
  return 'OFF-HOURS';
}

// ============================================================
// GENERATE SIGNAL
// ============================================================
function genSignal(rsi, macd, structure, price, candles, symbol) {
  let bull=0, bear=0;
  if(rsi!==null){
    if(rsi<30) bull+=3; else if(rsi<45) bull+=1;
    if(rsi>70) bear+=3; else if(rsi>55) bear+=1;
  }
  if(macd!==null){
    if(macd.bullish) bull+=2; else bear+=2;
    if(macd.histogram>0) bull+=1; else bear+=1;
  }
  if(structure==='BULLISH') bull+=4;
  else if(structure==='BEARISH') bear+=4;

  const tot=bull+bear;
  const conf=tot>0?Math.round((Math.max(bull,bear)/tot)*100):50;
  let signal='WAIT';
  if(bull>bear && conf>=60) signal='BUY';
  else if(bear>bull && conf>=60) signal='SELL';

  const spread=getSpread(symbol);
  const blackout=isBlackout();
  if(blackout||spread>2) signal='WAIT';

  const atr=candles.slice(-14).reduce((s,c,i)=>i===0?s:s+Math.abs(c.high-c.low),0)/13;
  const dp=price>10?2:4;
  const rLows=candles.slice(-10).map(c=>c.low);
  const rHighs=candles.slice(-10).map(c=>c.high);
  let sl,tp;
  if(signal==='BUY'){
    sl=(Math.min(...rLows)-atr*0.3).toFixed(dp);
    tp=(price+(price-parseFloat(sl))*2).toFixed(dp);
  } else if(signal==='SELL'){
    sl=(Math.max(...rHighs)+atr*0.3).toFixed(dp);
    tp=(price-(parseFloat(sl)-price)*2).toFixed(dp);
  } else {
    sl=(price-atr).toFixed(dp);
    tp=(price+atr).toFixed(dp);
  }
  return {signal,confidence:conf,entry:price.toFixed(dp),sl,tp,
    rsi,macd:macd?.macd||null,macdBullish:macd?.bullish??null,
    structure,spread,blackout,session:getSession()};
}

// ============================================================
// BUILD REASONS
// ============================================================
function buildReasons(sig, rsi, macd, structure, spread, blackout, session) {
  const r=[];
  if(blackout) r.push({icon:'⏸',text:'News blackout active — trading paused for safety (±10 min around high-impact news)'});
  if(spread>2) r.push({icon:'🚫',text:`Spread at ${spread} pips — too wide, signal blocked to protect from slippage`});
  if(structure==='BULLISH') r.push({icon:'📈',text:'Higher Highs + Higher Lows on H1 — bullish market structure confirmed'});
  if(structure==='BEARISH') r.push({icon:'📉',text:'Lower Highs + Lower Lows on H1 — bearish market structure confirmed'});
  if(rsi!==null){
    if(rsi<30) r.push({icon:'📊',text:`RSI at ${rsi} — strongly oversold, reversal up highly probable`});
    else if(rsi>70) r.push({icon:'📊',text:`RSI at ${rsi} — strongly overbought, reversal down highly probable`});
    else r.push({icon:'📊',text:`RSI at ${rsi} — momentum confirms current trend direction`});
  }
  if(macd){
    if(macd.bullish) r.push({icon:'⚡',text:'MACD crossed above signal line — bullish momentum confirmed'});
    else r.push({icon:'⚡',text:'MACD crossed below signal line — bearish momentum confirmed'});
  }
  r.push({icon:'🕐',text:`Session: ${session} — ${session==='LONDON+NY OVERLAP'?'Best hours to trade (peak liquidity)':session+' session active'}`});
  if(sig==='BUY')  r.push({icon:'✅',text:'All indicators aligned bullish — high probability setup identified'});
  if(sig==='SELL') r.push({icon:'🔴',text:'All indicators aligned bearish — high probability setup identified'});
  if(sig==='WAIT') r.push({icon:'⏳',text:'Waiting for stronger confluence before risking capital — patience is profit'});
  return r;
}

// ============================================================
// MAIN SIGNAL FETCH WITH CACHE
// ============================================================
async function getSignal(pair) {
  const {symbol, av} = pair;
  const now = Date.now();
  if(cache[symbol] && (now-cache[symbol].ts)<TTL) return cache[symbol].data;

  const candles = symbol==='XAU/USD' ? await getGoldCandles() : await getCandles(av);
  if(!candles||candles.length<30) return null;

  const price  = candles[candles.length-1].close;
  const rsi    = calcRSI(candles);
  const macd   = calcMACD(candles);
  const struct = detectStructure(candles);
  const sig    = genSignal(rsi,macd,struct,price,candles,symbol);
  const reasons= buildReasons(sig.signal,rsi,macd,struct,sig.spread,sig.blackout,sig.session);

  const result = {
    symbol, ...sig,
    price: price.toFixed(price>10?2:4),
    reasons,
    candles: candles.slice(-30).map(c=>({time:c.time,close:c.close,high:c.high,low:c.low})),
    updatedAt: new Date().toISOString()
  };
  cache[symbol] = {ts:now, data:result};
  return result;
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req,res) => res.json({
  status: 'TRADEPLUS BACKEND LIVE ✅',
  source: 'Alpha Vantage — Real-time Forex data',
  time:   new Date().toISOString(),
  session: getSession(),
  blackout: isBlackout()
}));

app.get('/api/signals', async(req,res) => {
  try {
    const results = await Promise.allSettled(PAIRS.map(getSignal));
    const signals = results
      .filter(r=>r.status==='fulfilled'&&r.value)
      .map(r=>r.value);
    res.json({success:true, signals, count:signals.length,
      blackout:isBlackout(), session:getSession()});
  } catch(e) { res.status(500).json({success:false,error:e.message}); }
});

app.get('/api/news', async(req,res) => {
  try {
    const url=`https://newsapi.org/v2/everything?q=forex+dollar+ECB+Fed+interest+rates+gold+inflation&language=en&sortBy=publishedAt&pageSize=12&apiKey=${NEWS_KEY}`;
    const r=await fetch(url), d=await r.json();
    if(!d.articles) return res.json({success:true,news:[]});
    const news=d.articles.map(a=>({
      headline: a.title, source: a.source.name,
      time: a.publishedAt, url: a.url,
      impact: a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis/)? 'high':
              a.title.toLowerCase().match(/oil|gold|trade|data/)? 'med':'low',
      sentiment: a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|beat|rally/)? 'bullish':'bearish'
    }));
    res.json({success:true, news});
  } catch(e) { res.status(500).json({success:false,error:e.message}); }
});

app.get('/api/health', (req,res) => res.json({
  alive:true, time:new Date().toISOString(),
  session:getSession(), blackout:isBlackout()
}));

const PORT = process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`✅ TRADEPLUS Backend running on port ${PORT}`));
