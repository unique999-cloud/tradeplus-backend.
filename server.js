const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// API KEYS — stored as environment variables in Glitch
// In Glitch: go to .env file and add:
// TWELVE_KEY=5c791b3f0363487995830d787cd234be
// NEWS_KEY=cf9094777d43494b98720d3349fdc549
// ============================================================
const TWELVE_KEY = process.env.TWELVE_KEY;
const NEWS_KEY   = process.env.NEWS_KEY;
const PAIRS      = ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','EUR/GBP','XAU/USD'];

// CACHE — prevents hammering free API
const cache = {};
const TTL = 4 * 60 * 1000; // 4 minutes

// ============================================================
// FETCH CANDLES FROM TWELVE DATA
// ============================================================
async function getCandles(symbol) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=4h&outputsize=52&apikey=${TWELVE_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.values) return null;
    return data.values.map(c => ({
      time:  c.datetime,
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    })).reverse(); // oldest first
  } catch(e) { return null; }
}

// ============================================================
// RSI CALCULATION
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
// MACD CALCULATION
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
    macd: parseFloat(macdLine.toFixed(5)),
    signal: parseFloat(signalLine.toFixed(5)),
    histogram: parseFloat((macdLine-signalLine).toFixed(5)),
    bullish: macdLine > signalLine
  };
}

// ============================================================
// MARKET STRUCTURE (Higher Highs / Lower Lows)
// ============================================================
function detectStructure(candles) {
  if(candles.length<10) return 'NEUTRAL';
  const recent=candles.slice(-10);
  const highs=recent.map(c=>c.high), lows=recent.map(c=>c.low);
  const recentHigh=Math.max(...highs.slice(-3)), prevHigh=Math.max(...highs.slice(0,5));
  const recentLow=Math.min(...lows.slice(-3)),  prevLow=Math.min(...lows.slice(0,5));
  if(recentHigh>prevHigh && recentLow>prevLow) return 'BULLISH';  // Higher Highs + Higher Lows
  if(recentHigh<prevHigh && recentLow<prevLow) return 'BEARISH';  // Lower Highs + Lower Lows
  return 'NEUTRAL';
}

// ============================================================
// SLIPPAGE / SPREAD FILTER
// ============================================================
function getEstimatedSpread(symbol) {
  const spreads = {
    'EUR/USD':1.1,'GBP/USD':1.8,'USD/JPY':1.2,
    'AUD/USD':1.5,'USD/CAD':2.1,'EUR/GBP':1.3,'XAU/USD':3.5
  };
  return spreads[symbol] || 2.0;
}

// ============================================================
// NEWS BLACKOUT CHECK (server-side)
// ============================================================
function isInBlackout() {
  const now = new Date();
  const watHour = (now.getUTCHours() + 1) % 24;
  const watMin  = now.getUTCMinutes();
  const watMins = watHour * 60 + watMin;
  const watDay  = now.getUTCDay();
  const events = [
    {h:14,m:30,day:5}, // NFP - Friday 14:30 WAT
    {h:19,m:0, day:3}, // FOMC - Wednesday 19:00 WAT
    {h:13,m:15,day:4}, // ECB - Thursday 13:15 WAT
    {h:13,m:30,day:3}, // US CPI - Wednesday 13:30 WAT
  ];
  for(const ev of events) {
    const evMins = ev.h*60+ev.m;
    if(ev.day===watDay && Math.abs(watMins-evMins)<=10) return true;
  }
  return false;
}

// ============================================================
// SESSION DETECTOR
// ============================================================
function getSession() {
  const now = new Date();
  const watHour = (now.getUTCHours() + 1) % 24;
  if(watHour >= 8  && watHour < 13)  return 'LONDON';
  if(watHour >= 13 && watHour < 17)  return 'LONDON+NY OVERLAP'; // Best time to trade
  if(watHour >= 17 && watHour < 22)  return 'NEW YORK';
  if(watHour >= 23 || watHour < 8)   return 'ASIAN';
  return 'OFF-HOURS';
}

// ============================================================
// GENERATE REAL SIGNAL WITH ALL FILTERS
// ============================================================
function genSignal(rsi, macd, structure, price, candles, symbol) {
  let bull=0, bear=0;

  // RSI scoring
  if(rsi!==null){
    if(rsi<30)       bull+=3; // strongly oversold
    else if(rsi<45)  bull+=1;
    if(rsi>70)       bear+=3; // strongly overbought
    else if(rsi>55)  bear+=1;
  }

  // MACD scoring
  if(macd!==null){
    if(macd.bullish)      bull+=2; else bear+=2;
    if(macd.histogram>0)  bull+=1; else bear+=1;
  }

  // Structure scoring (weighted highest for accuracy)
  if(structure==='BULLISH')      bull+=4;
  else if(structure==='BEARISH') bear+=4;

  const tot=bull+bear;
  const conf=tot>0?Math.round((Math.max(bull,bear)/tot)*100):50;

  let signal='WAIT';
  if(bull>bear && conf>=60) signal='BUY';
  else if(bear>bull && conf>=60) signal='SELL';

  // Apply spread filter
  const spread=getEstimatedSpread(symbol);
  const spreadBlocked=spread>2; // default 2 pip limit

  // Apply blackout filter
  const blackout=isInBlackout();

  if(blackout) signal='WAIT';
  if(spreadBlocked && signal!=='WAIT') signal='WAIT';

  // Calculate entry levels
  const atr=candles.slice(-14).reduce((s,c,i)=>i===0?s:s+Math.abs(c.high-c.low),0)/13;
  const dp=price>10?2:4;
  const rLows=candles.slice(-10).map(c=>c.low);
  const rHighs=candles.slice(-10).map(c=>c.high);
  let sl, tp;
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

  return {
    signal,confidence:conf,entry:price.toFixed(dp),sl,tp,
    rsi,macd:macd?.macd||null,macdBullish:macd?.bullish??null,
    structure,spread,spreadBlocked,blackout,
    session:getSession()
  };
}

// ============================================================
// BUILD EDUCATIONAL REASONS
// ============================================================
function buildReasons(sig, rsi, macd, structure, spread, blackout, session) {
  const r=[];
  if(blackout) r.push({icon:'⏸',text:'Trading paused — high-impact news event within 10 minutes. Safety first.'});
  if(spread>2) r.push({icon:'🚫',text:`Spread at ${spread} pips — exceeds safe limit. Signal blocked to protect you from slippage.`});
  if(structure==='BULLISH') r.push({icon:'📈',text:'Higher Highs + Higher Lows confirmed on H4 — bullish market structure active'});
  if(structure==='BEARISH') r.push({icon:'📉',text:'Lower Highs + Lower Lows confirmed on H4 — bearish market structure active'});
  if(rsi!==null){
    if(rsi<30) r.push({icon:'📊',text:`RSI at ${rsi} — strongly oversold. Sellers exhausted, reversal up is highly probable`});
    else if(rsi<45) r.push({icon:'📊',text:`RSI at ${rsi} — approaching oversold, bullish momentum building`});
    else if(rsi>70) r.push({icon:'📊',text:`RSI at ${rsi} — strongly overbought. Buyers exhausted, reversal down is highly probable`});
    else r.push({icon:'📊',text:`RSI at ${rsi} — neutral zone, momentum confirms trend direction`});
  }
  if(macd){
    if(macd.bullish) r.push({icon:'⚡',text:'MACD line crossed above signal — bullish momentum confirmed on H4'});
    else r.push({icon:'⚡',text:'MACD line crossed below signal — bearish momentum confirmed on H4'});
  }
  r.push({icon:'🕐',text:`Current session: ${session} — ${session==='LONDON+NY OVERLAP'?'Best trading hours (highest liquidity)':session+' session active'}`});
  if(sig==='WAIT') r.push({icon:'⏳',text:'No clear confluence — waiting for stronger setup before risking capital'});
  if(sig==='BUY')  r.push({icon:'✅',text:'All indicators aligned bullish — high probability setup'});
  if(sig==='SELL') r.push({icon:'🔴',text:'All indicators aligned bearish — high probability setup'});
  return r;
}

// ============================================================
// MAIN SIGNAL FUNCTION (with caching)
// ============================================================
async function getSignal(symbol) {
  const now=Date.now();
  if(cache[symbol]&&(now-cache[symbol].ts)<TTL) return cache[symbol].data;
  const candles=await getCandles(symbol);
  if(!candles||candles.length<30) return null;
  const price=candles[candles.length-1].close;
  const rsi=calcRSI(candles), macd=calcMACD(candles), structure=detectStructure(candles);
  const sig=genSignal(rsi,macd,structure,price,candles,symbol);
  const reasons=buildReasons(sig.signal,rsi,macd,structure,sig.spread,sig.blackout,sig.session);
  const result={
    symbol,...sig,
    price:price.toFixed(price>10?2:4),
    reasons,
    candles:candles.slice(-30).map(c=>({time:c.time,close:c.close,high:c.high,low:c.low})),
    updatedAt:new Date().toISOString()
  };
  cache[symbol]={ts:now,data:result};
  return result;
}

// ============================================================
// API ROUTES
// ============================================================
app.get('/', (req,res) => {
  res.json({
    status:'TRADEPLUS BACKEND LIVE ✅',
    time:new Date().toISOString(),
    session:getSession(),
    blackout:isInBlackout(),
    pairs:PAIRS.length
  });
});

app.get('/api/signals', async(req,res) => {
  try {
    const results=await Promise.allSettled(PAIRS.map(getSignal));
    const signals=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
    res.json({success:true, signals, count:signals.length, blackout:isInBlackout(), session:getSession()});
  } catch(e) { res.status(500).json({success:false, error:e.message}); }
});

app.get('/api/signal/:symbol', async(req,res) => {
  try {
    const sym=req.params.symbol.replace('-','/').toUpperCase();
    const data=await getSignal(sym);
    if(!data) return res.status(400).json({success:false,error:'Could not fetch data'});
    res.json({success:true, data});
  } catch(e) { res.status(500).json({success:false, error:e.message}); }
});

app.get('/api/news', async(req,res) => {
  try {
    const url=`https://newsapi.org/v2/everything?q=forex+dollar+ECB+Fed+interest+rates+gold+inflation&language=en&sortBy=publishedAt&pageSize=12&apiKey=${NEWS_KEY}`;
    const r=await fetch(url), d=await r.json();
    if(!d.articles) return res.json({success:true,news:[]});
    const news=d.articles.map(a=>({
      headline:a.title, source:a.source.name, time:a.publishedAt, url:a.url,
      impact:a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis/)? 'high':
             a.title.toLowerCase().match(/oil|gold|trade|data/)? 'med':'low',
      sentiment:a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|beat|rally/)? 'bullish':'bearish'
    }));
    res.json({success:true, news});
  } catch(e) { res.status(500).json({success:false, error:e.message}); }
});

app.get('/api/health', (req,res) => {
  res.json({alive:true, time:new Date().toISOString(), session:getSession(), blackout:isInBlackout()});
});

const PORT=process.env.PORT||3000;
app.listen(PORT, ()=>console.log(`✅ TRADEPLUS Backend running on port ${PORT}`));
