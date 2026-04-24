const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const app = express();

app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.status(200).end();return;}
  next();
});
app.use(express.json());

// ============================================================
// API KEYS
// ============================================================
const TWELVE_KEY = process.env.TWELVE_KEY; // H4 candles
const NEWS_KEY   = process.env.NEWS_KEY;   // News feed

// ============================================================
// PAIRS
// ============================================================
const PAIRS = [
  { symbol:'EUR/USD', twelve:'EUR/USD', stooq:'eurusd',   dp:4 },
  { symbol:'GBP/USD', twelve:'GBP/USD', stooq:'gbpusd',   dp:4 },
  { symbol:'USD/JPY', twelve:'USD/JPY', stooq:'usdjpy',   dp:3 },
  { symbol:'XAU/USD', twelve:'XAU/USD', stooq:'xauusd.cf',dp:2 },
];

// ============================================================
// CACHE
// ============================================================
const cache = {
  h4Candles:   {},  // H4 candles from Twelve Data — refresh every 4 hours
  dailyCandles:{},  // Daily candles from Stooq — refresh every 24 hours
  signals:     {},  // Locked signals — refresh only at H4 candle close
  livePrice:   {},  // Live prices from Stooq — refresh every 30 seconds
  news:        { data:[], ts:0 },
};

const H4_TTL    = 4  * 60 * 60 * 1000; // 4 hours
const DAILY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PRICE_TTL = 30 * 1000;           // 30 seconds
const NEWS_TTL  = 10 * 60 * 1000;      // 10 minutes

// ============================================================
// STOOQ — LIVE PRICE (matches MT5/Exness)
// ============================================================
async function getStooqPrice(stooqSymbol) {
  const key = `price_${stooqSymbol}`, now = Date.now();
  if (cache.livePrice[key] && (now - cache.livePrice[key].ts) < PRICE_TTL) {
    return cache.livePrice[key].price;
  }
  try {
    const url  = `https://stooq.com/q/l/?s=${stooqSymbol}&f=sd2t2ohlcv&h&e=csv`;
    const res  = await fetch(url, { timeout:6000 });
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(',');
    const price = parseFloat(parts[6]);
    if (!price || isNaN(price) || price <= 0) return null;
    // Gold sanity check
    if (stooqSymbol.includes('xau') && (price < 1000 || price > 6000)) return null;
    cache.livePrice[key] = { price, ts: now };
    return price;
  } catch(e) { return cache.livePrice[key]?.price || null; }
}

// ============================================================
// STOOQ — DAILY CANDLES (for daily trend bias)
// ============================================================
async function getDailyCandles(stooqSymbol) {
  const key = `daily_${stooqSymbol}`, now = Date.now();
  if (cache.dailyCandles[key] && (now - cache.dailyCandles[key].ts) < DAILY_TTL) {
    return cache.dailyCandles[key].data;
  }
  try {
    const url  = `https://stooq.com/q/d/l/?s=${stooqSymbol}&i=d`;
    const res  = await fetch(url, { timeout:10000 });
    const text = await res.text();
    if (text.includes('apikey') || text.includes('Get your')) return null;
    const lines = text.trim().split('\n');
    if (lines.length < 5) return null;
    const candles = lines.slice(1).slice(-100).map(line => {
      const p = line.split(',');
      if (p.length < 5) return null;
      return { time:p[0], open:parseFloat(p[1]), high:parseFloat(p[2]), low:parseFloat(p[3]), close:parseFloat(p[4]) };
    }).filter(c => c && !isNaN(c.close) && c.close > 0);
    if (candles.length < 5) return null;
    cache.dailyCandles[key] = { data:candles, ts:now };
    return candles;
  } catch(e) { return cache.dailyCandles[key]?.data || null; }
}

// ============================================================
// TWELVE DATA — H4 CANDLES (for signal generation)
// ============================================================
async function getH4Candles(twelveSymbol) {
  const key = `h4_${twelveSymbol}`, now = Date.now();
  if (cache.h4Candles[key] && (now - cache.h4Candles[key].ts) < H4_TTL) {
    return cache.h4Candles[key].data;
  }
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${twelveSymbol}&interval=4h&outputsize=100&apikey=${TWELVE_KEY}`;
    const res  = await fetch(url, { timeout:10000 });
    const data = await res.json();
    if (!data.values || data.status === 'error') return null;
    const candles = data.values.map(c => ({
      time:  c.datetime,
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    })).reverse();
    if (candles.length < 10) return null;
    cache.h4Candles[key] = { data:candles, ts:now };
    return candles;
  } catch(e) { return cache.h4Candles[key]?.data || null; }
}

// ============================================================
// TECHNICAL INDICATORS
// ============================================================
function calcRSI(c, p=14) {
  if (c.length < p+1) return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){const d=c[i].close-c[i-1].close;if(d>=0)g+=d;else l+=Math.abs(d);}
  let ag=g/p,al=l/p;
  for(let i=p+1;i<c.length;i++){const d=c[i].close-c[i-1].close;ag=((ag*(p-1))+(d>0?d:0))/p;al=((al*(p-1))+(d<0?Math.abs(d):0))/p;}
  if(al===0)return 100;
  return parseFloat((100-(100/(1+ag/al))).toFixed(2));
}

function ema(vals,p) {
  if(!vals||vals.length===0)return 0;
  const k=2/(p+1);let e=vals[0];
  for(let i=1;i<vals.length;i++)e=vals[i]*k+e*(1-k);
  return e;
}

function calcMACD(c) {
  if(c.length<26)return null;
  const cl=c.map(x=>x.close);
  const m=ema(cl.slice(-12),12)-ema(cl.slice(-26),26);
  const s=ema(cl.slice(-9),9);
  return{macd:parseFloat(m.toFixed(6)),signal:parseFloat(s.toFixed(6)),histogram:parseFloat((m-s).toFixed(6)),bullish:m>s};
}

function calcEMAs(c) {
  if(c.length<5)return null;
  const cl=c.map(x=>x.close),price=cl[cl.length-1];
  const e20=c.length>=20?ema(cl.slice(-20),20):null;
  const e50=c.length>=50?ema(cl.slice(-50),50):null;
  const e100=c.length>=100?ema(cl.slice(-100),100):null;
  const e200=c.length>=200?ema(cl.slice(-200),200):null;
  return{ema20:e20,ema50:e50,ema100:e100,ema200:e200,
    aboveEma20:e20?price>e20:null,aboveEma50:e50?price>e50:null,
    aboveEma100:e100?price>e100:null,aboveEma200:e200?price>e200:null};
}

function calcBollinger(c,p=20) {
  if(c.length<p)return null;
  const cl=c.slice(-p).map(x=>x.close);
  const mean=cl.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(cl.reduce((s,v)=>s+Math.pow(v-mean,2),0)/p);
  const price=c[c.length-1].close;
  return{upper:mean+2*std,middle:mean,lower:mean-2*std,
    nearUpper:price>(mean+1.5*std),nearLower:price<(mean-1.5*std)};
}

function calcStoch(c,kp=14) {
  if(c.length<kp)return null;
  const r=c.slice(-kp);
  const h=Math.max(...r.map(x=>x.high)),l=Math.min(...r.map(x=>x.low));
  const price=c[c.length-1].close;
  const k=h===l?50:((price-l)/(h-l))*100;
  return{k:parseFloat(k.toFixed(2)),overbought:k>80,oversold:k<20};
}

function calcADX(c,p=14) {
  if(c.length<p+1)return null;
  const dms=[];
  for(let i=1;i<c.length;i++){
    const up=c[i].high-c[i-1].high,dn=c[i-1].low-c[i].low;
    dms.push({dmP:(up>dn&&up>0)?up:0,dmM:(dn>up&&dn>0)?dn:0,
      tr:Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close))});
  }
  const r=dms.slice(-p),atr=r.reduce((s,d)=>s+d.tr,0)/p;
  if(!atr)return null;
  const diP=(r.reduce((s,d)=>s+d.dmP,0)/p/atr)*100;
  const diM=(r.reduce((s,d)=>s+d.dmM,0)/p/atr)*100;
  const dx=Math.abs(diP-diM)/(diP+diM)*100;
  return{adx:parseFloat(dx.toFixed(2)),trending:dx>25,strongTrend:dx>40,bullish:diP>diM};
}

function detectStructure(c) {
  if(c.length<20)return'NEUTRAL';
  const r=c.slice(-20),h=r.map(x=>x.high),l=r.map(x=>x.low);
  const rH=Math.max(...h.slice(-5)),pH=Math.max(...h.slice(0,10));
  const rL=Math.min(...l.slice(-5)),pL=Math.min(...l.slice(0,10));
  if(rH>pH&&rL>pL)return'BULLISH';
  if(rH<pH&&rL<pL)return'BEARISH';
  return'NEUTRAL';
}

function calcSR(c) {
  if(c.length<20)return null;
  const r=c.slice(-50),price=c[c.length-1].close;
  const res=r.map(x=>x.high).sort((a,b)=>b-a).slice(0,3).reduce((a,b)=>a+b,0)/3;
  const sup=r.map(x=>x.low).sort((a,b)=>a-b).slice(0,3).reduce((a,b)=>a+b,0)/3;
  const range=res-sup;
  return{resistance:res,support:sup,
    nearResistance:range>0&&price>(res-range*0.1),
    nearSupport:range>0&&price<(sup+range*0.1)};
}

function detectCandle(c) {
  if(c.length<3)return'NONE';
  const x=c[c.length-1],p=c[c.length-2],p2=c[c.length-3];
  const body=Math.abs(x.close-x.open),range=x.high-x.low;
  const uw=x.high-Math.max(x.open,x.close),lw=Math.min(x.open,x.close)-x.low;
  if(range>0&&body/range<0.1)return'DOJI';
  if(lw>body*2&&uw<body*0.5&&x.close>x.open)return'HAMMER';
  if(uw>body*2&&lw<body*0.5&&x.close<x.open)return'SHOOTING_STAR';
  if(x.close>x.open&&p.close<p.open&&x.open<p.close&&x.close>p.open)return'BULLISH_ENGULFING';
  if(x.close<x.open&&p.close>p.open&&x.open>p.close&&x.close<p.open)return'BEARISH_ENGULFING';
  if(p2.close<p2.open&&Math.abs(p.close-p.open)<Math.abs(p2.close-p2.open)*0.3&&x.close>x.open&&x.close>(p2.open+p2.close)/2)return'MORNING_STAR';
  if(p2.close>p2.open&&Math.abs(p.close-p.open)<Math.abs(p2.close-p2.open)*0.3&&x.close<x.open&&x.close<(p2.open+p2.close)/2)return'EVENING_STAR';
  return'NONE';
}

function calcFib(c) {
  if(c.length<20)return null;
  const r=c.slice(-50),h=Math.max(...r.map(x=>x.high)),l=Math.min(...r.map(x=>x.low));
  const range=h-l,price=c[c.length-1].close;
  return{fib382:h-range*0.382,fib500:h-range*0.500,fib618:h-range*0.618,
    nearFib:[0.236,0.382,0.500,0.618,0.786].some(f=>Math.abs(price-(h-range*f))/price<0.003)};
}

function calcPivots(c) {
  if(c.length<2)return null;
  const p=c[c.length-2],pivot=(p.high+p.low+p.close)/3,price=c[c.length-1].close;
  return{pivot,r1:2*pivot-p.low,r2:pivot+(p.high-p.low),
    s1:2*pivot-p.high,s2:pivot-(p.high-p.low),abovePivot:price>pivot};
}

function calcATR(c,p=14) {
  if(c.length<p+1)return null;
  const trs=[];
  for(let i=1;i<c.length;i++)trs.push(Math.max(c[i].high-c[i].low,
    Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
  return trs.slice(-p).reduce((s,v)=>s+v,0)/p;
}

function calcMomentum(c,p=10) {
  if(c.length<p+1)return null;
  const cur=c[c.length-1].close,prev=c[c.length-1-p].close;
  return{value:cur-prev,bullish:cur>prev,strong:Math.abs(cur-prev)/prev>0.002};
}

function detectFVG(c) {
  if(c.length<3)return null;
  const c1=c[c.length-3],c3=c[c.length-1];
  if(c1.high<c3.low)return{type:'BULLISH',gap:c3.low-c1.high};
  if(c1.low>c3.high)return{type:'BEARISH',gap:c1.low-c3.high};
  return null;
}

function detectBOS(c) {
  if(c.length<20)return null;
  const r=c.slice(-10),m=c.slice(-20,-10);
  if(!m.length)return null;
  if(Math.max(...r.map(x=>x.high))>Math.max(...m.map(x=>x.high)))return{type:'BULLISH_BOS'};
  if(Math.min(...r.map(x=>x.low))<Math.min(...m.map(x=>x.low)))return{type:'BEARISH_BOS'};
  return null;
}

// ============================================================
// DAILY TREND BIAS — only trade in direction of daily trend
// ============================================================
function getDailyBias(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 20) return 'NEUTRAL';
  const cl  = dailyCandles.map(c => c.close);
  const ema50Daily  = dailyCandles.length >= 50 ? ema(cl.slice(-50), 50) : null;
  const ema200Daily = dailyCandles.length >= 200 ? ema(cl.slice(-200), 200) : null;
  const price = cl[cl.length-1];
  const structure = detectStructure(dailyCandles);
  let bullPoints = 0, bearPoints = 0;
  if (structure === 'BULLISH') bullPoints += 2;
  else if (structure === 'BEARISH') bearPoints += 2;
  if (ema50Daily && price > ema50Daily) bullPoints++;
  else if (ema50Daily) bearPoints++;
  if (ema200Daily && price > ema200Daily) bullPoints++;
  else if (ema200Daily) bearPoints++;
  if (bullPoints > bearPoints) return 'BULLISH';
  if (bearPoints > bullPoints) return 'BEARISH';
  return 'NEUTRAL';
}

// ============================================================
// MARKET CONDITIONS
// ============================================================
function getSession() {
  const h=(new Date().getUTCHours()+1)%24;
  if(h>=8&&h<13)  return{name:'LONDON',quality:3};
  if(h>=13&&h<17) return{name:'LONDON+NY OVERLAP',quality:5};
  if(h>=17&&h<22) return{name:'NEW YORK',quality:3};
  if(h>=1&&h<8)   return{name:'ASIAN',quality:2};
  return{name:'OFF-HOURS',quality:1};
}

function isBlackout() {
  const now=new Date(),watH=(now.getUTCHours()+1)%24,watM=now.getUTCMinutes();
  const day=now.getUTCDay(),mins=watH*60+watM;
  return [{h:14,m:30,day:5},{h:19,m:0,day:3},{h:13,m:15,day:4},{h:13,m:30,day:3},{h:7,m:0,day:3}]
    .some(ev=>ev.day===day&&Math.abs(mins-(ev.h*60+ev.m))<=10);
}

// Check if high impact news is coming in next 4 hours
function isNewsComingSoon() {
  const now=new Date(),watH=(now.getUTCHours()+1)%24,watM=now.getUTCMinutes();
  const day=now.getUTCDay(),mins=watH*60+watM;
  const events=[{h:14,m:30,day:5},{h:19,m:0,day:3},{h:13,m:15,day:4},{h:13,m:30,day:3}];
  return events.some(ev=>{
    if(ev.day!==day)return false;
    const evMins=ev.h*60+ev.m;
    return evMins>mins&&evMins-mins<=240; // within 4 hours
  });
}

function getSpread(s) {
  return{'EUR/USD':0.8,'GBP/USD':1.2,'USD/JPY':0.9,'XAU/USD':2.5}[s]||1.5;
}

// ============================================================
// DEEP H4 SIGNAL ENGINE
// ============================================================
function deepH4Engine(h4Candles, dailyBias, price, symbol) {
  let bull=0, bear=0, factors=[];

  // Safety checks
  if (isBlackout()) return { signal:'WAIT', phase:'BLACKOUT', confidence:0, bull:0, bear:0, factors:['⏸ News blackout active'] };
  if (getSpread(symbol) > 3) return { signal:'WAIT', phase:'WIDE_SPREAD', confidence:0, bull:0, bear:0, factors:['🚫 Spread too wide'] };

  // Calculate all indicators
  const rsi       = calcRSI(h4Candles);
  const macd      = calcMACD(h4Candles);
  const emas      = calcEMAs(h4Candles);
  const bollinger = calcBollinger(h4Candles);
  const stoch     = calcStoch(h4Candles);
  const adx       = calcADX(h4Candles);
  const structure = detectStructure(h4Candles);
  const sr        = calcSR(h4Candles);
  const candle    = detectCandle(h4Candles);
  const fib       = calcFib(h4Candles);
  const pivots    = calcPivots(h4Candles);
  const atr       = calcATR(h4Candles);
  const momentum  = calcMomentum(h4Candles);
  const fvg       = detectFVG(h4Candles);
  const bos       = detectBOS(h4Candles);
  const session   = getSession();

  // ── DAILY BIAS FILTER (weight 5) ──
  // Most important — only trade with the daily trend
  if (dailyBias === 'BULLISH') {
    bull += 5;
    factors.push(`✅ Daily trend is BULLISH — H4 BUY signals preferred`);
  } else if (dailyBias === 'BEARISH') {
    bear += 5;
    factors.push(`✅ Daily trend is BEARISH — H4 SELL signals preferred`);
  } else {
    factors.push(`⚠️ Daily trend NEUTRAL — extra caution required`);
  }

  // ── H4 MARKET STRUCTURE (weight 4) ──
  if (structure==='BULLISH') { bull+=4; factors.push('✅ H4 Higher Highs + Higher Lows confirmed'); }
  else if (structure==='BEARISH') { bear+=4; factors.push('✅ H4 Lower Highs + Lower Lows confirmed'); }

  // ── RSI (weight 3) ──
  if (rsi!==null) {
    if (rsi<30)      { bull+=3; factors.push(`✅ RSI ${rsi} — strongly oversold`); }
    else if (rsi<40) { bull+=2; factors.push(`✅ RSI ${rsi} — oversold`); }
    else if (rsi<45) { bull+=1; }
    else if (rsi>70) { bear+=3; factors.push(`✅ RSI ${rsi} — strongly overbought`); }
    else if (rsi>60) { bear+=2; factors.push(`✅ RSI ${rsi} — overbought`); }
    else if (rsi>55) { bear+=1; }
  }

  // ── MACD (weight 3) ──
  if (macd) {
    if (macd.bullish && macd.histogram>0) { bull+=3; factors.push('✅ MACD bullish crossover + positive histogram'); }
    else if (macd.bullish) { bull+=2; factors.push('✅ MACD bullish crossover'); }
    else if (!macd.bullish && macd.histogram<0) { bear+=3; factors.push('✅ MACD bearish crossover + negative histogram'); }
    else if (!macd.bullish) { bear+=2; factors.push('✅ MACD bearish crossover'); }
  }

  // ── MOVING AVERAGES (weight 3) ──
  if (emas) {
    let s=0;
    if(emas.aboveEma20===true)s++;else if(emas.aboveEma20===false)s--;
    if(emas.aboveEma50===true)s++;else if(emas.aboveEma50===false)s--;
    if(emas.aboveEma100===true)s++;else if(emas.aboveEma100===false)s--;
    if(emas.aboveEma200===true)s++;else if(emas.aboveEma200===false)s--;
    if(s>=3)      { bull+=3; factors.push('✅ Price above all major EMAs'); }
    else if(s>=2) { bull+=2; }
    else if(s>=1) { bull+=1; }
    else if(s<=-3){ bear+=3; factors.push('✅ Price below all major EMAs'); }
    else if(s<=-2){ bear+=2; }
    else if(s<=-1){ bear+=1; }
  }

  // ── ADX TREND STRENGTH (weight 2) ──
  if (adx && adx.trending) {
    if (adx.bullish && adx.strongTrend) { bull+=2; factors.push(`✅ ADX ${adx.adx} — strong bullish trend`); }
    else if (adx.bullish) { bull+=1; }
    else if (!adx.bullish && adx.strongTrend) { bear+=2; factors.push(`✅ ADX ${adx.adx} — strong bearish trend`); }
    else if (!adx.bullish) { bear+=1; }
  }

  // ── BOLLINGER BANDS (weight 2) ──
  if (bollinger) {
    if (bollinger.nearLower) { bull+=2; factors.push('✅ Price at Bollinger lower band — bounce zone'); }
    else if (bollinger.nearUpper) { bear+=2; factors.push('✅ Price at Bollinger upper band — rejection zone'); }
  }

  // ── STOCHASTIC (weight 2) ──
  if (stoch) {
    if (stoch.oversold)  { bull+=2; factors.push(`✅ Stochastic ${stoch.k} — oversold`); }
    if (stoch.overbought){ bear+=2; factors.push(`✅ Stochastic ${stoch.k} — overbought`); }
  }

  // ── SUPPORT/RESISTANCE (weight 2) ──
  if (sr) {
    if (sr.nearSupport)    { bull+=2; factors.push('✅ Price at key support level'); }
    if (sr.nearResistance) { bear+=2; factors.push('✅ Price at key resistance level'); }
  }

  // ── CANDLESTICK PATTERN (weight 2) ──
  const bullC=['HAMMER','BULLISH_ENGULFING','MORNING_STAR'];
  const bearC=['SHOOTING_STAR','BEARISH_ENGULFING','EVENING_STAR'];
  if (bullC.includes(candle)) { bull+=2; factors.push(`✅ ${candle} — bullish reversal pattern`); }
  if (bearC.includes(candle)) { bear+=2; factors.push(`✅ ${candle} — bearish reversal pattern`); }

  // ── BREAK OF STRUCTURE (weight 2) ──
  if (bos) {
    if (bos.type==='BULLISH_BOS') { bull+=2; factors.push('✅ Bullish break of structure'); }
    if (bos.type==='BEARISH_BOS') { bear+=2; factors.push('✅ Bearish break of structure'); }
  }

  // ── FIBONACCI (weight 1) ──
  if (fib && fib.nearFib) {
    if (bull>bear) { bull+=1; factors.push('✅ Price at Fibonacci support level'); }
    else { bear+=1; factors.push('✅ Price at Fibonacci resistance level'); }
  }

  // ── PIVOTS (weight 1) ──
  if (pivots) { if(pivots.abovePivot)bull+=1; else bear+=1; }

  // ── MOMENTUM (weight 1) ──
  if (momentum && momentum.strong) {
    if(momentum.bullish){bull+=1;factors.push('✅ Strong bullish momentum');}
    else{bear+=1;factors.push('✅ Strong bearish momentum');}
  }

  // ── FVG (weight 1) ──
  if (fvg) {
    if(fvg.type==='BULLISH'){bull+=1;factors.push('✅ Bullish fair value gap');}
    if(fvg.type==='BEARISH'){bear+=1;factors.push('✅ Bearish fair value gap');}
  }

  // ── SESSION QUALITY (weight 1) ──
  if (session.quality>=4) {
    if(bull>bear)bull+=1; else if(bear>bull)bear+=1;
    factors.push(`✅ ${session.name} — peak liquidity`);
  }

  // ── DAILY/H4 CONFLUENCE BONUS ──
  // Extra weight when H4 structure agrees with daily bias
  if (dailyBias==='BULLISH' && structure==='BULLISH') {
    bull+=3;
    factors.push('🌟 STRONG CONFLUENCE — Daily AND H4 both bullish');
  } else if (dailyBias==='BEARISH' && structure==='BEARISH') {
    bear+=3;
    factors.push('🌟 STRONG CONFLUENCE — Daily AND H4 both bearish');
  }

  // ── CONFLICT PENALTY ──
  // If H4 disagrees with daily trend — reduce score
  if (dailyBias==='BULLISH' && structure==='BEARISH') {
    bull = Math.max(0, bull-3);
    bear = Math.max(0, bear-3);
    factors.push('⚠️ H4 conflicts with daily trend — signal weakened');
  } else if (dailyBias==='BEARISH' && structure==='BULLISH') {
    bull = Math.max(0, bull-3);
    bear = Math.max(0, bear-3);
    factors.push('⚠️ H4 conflicts with daily trend — signal weakened');
  }

  const total = bull+bear;
  const conf  = Math.min(total>0?Math.round((Math.max(bull,bear)/total)*100):50, 85);

  // ── SIGNAL WITH CONFIDENCE TIERS ──
  let signal = 'WAIT';
  let phase  = 'ANALYSING';

  // Need score >= 10 AND confidence >= 65% for a signal
  // This is higher than before for extra safety and accuracy
  if (bull>bear && bull>=10 && conf>=65) {
    signal = 'BUY';
    if (conf>=80)      phase = 'STRONG_BUY';
    else if (conf>=70) phase = 'MODERATE_BUY';
    else               phase = 'WEAK_BUY';
  } else if (bear>bull && bear>=10 && conf>=65) {
    signal = 'SELL';
    if (conf>=80)      phase = 'STRONG_SELL';
    else if (conf>=70) phase = 'MODERATE_SELL';
    else               phase = 'WEAK_SELL';
  } else if (bull>=7 || bear>=7) {
    // Setup forming but not ready yet
    phase = bull>=7 ? 'BUY_FORMING' : 'SELL_FORMING';
  }

  // News coming soon warning
  if (isNewsComingSoon() && signal !== 'WAIT') {
    phase = signal + '_NEWS_CAUTION';
    factors.push('⚠️ High-impact news within 4 hours — trade with caution');
  }

  return { signal, phase, confidence:conf, bull, bear, factors,
    indicators:{ rsi, macd, emas, bollinger, stoch, adx, structure,
      sr, candle, fib, pivots, atr, momentum, fvg, bos, session } };
}

// ============================================================
// CALCULATE SL/TP
// ============================================================
function calcLevels(signal, price, atr, symbol, sr, pivots) {
  const minAtr = {'EUR/USD':0.0020,'GBP/USD':0.0025,'USD/JPY':0.25,'XAU/USD':8.0}[symbol]||0.002;
  const safeAtr = Math.max(atr||0, minAtr);
  const dp = symbol==='USD/JPY'?3:symbol==='XAU/USD'?2:4;
  let sl, tp;

  if (signal==='BUY') {
    // SL below recent support or 1.5x ATR below entry
    const supportLevel = sr ? Math.min(sr.support, price - safeAtr*1.5) : price - safeAtr*1.5;
    sl = parseFloat((Math.min(supportLevel, price - safeAtr*1.5)).toFixed(dp));
    tp = parseFloat((price + Math.abs(price-sl)*2.5).toFixed(dp)); // 1:2.5 RR
    if(sl>=price)sl=parseFloat((price-safeAtr*2).toFixed(dp));
    if(tp<=price)tp=parseFloat((price+safeAtr*5).toFixed(dp));
  } else if (signal==='SELL') {
    // SL above recent resistance or 1.5x ATR above entry
    const resistLevel = sr ? Math.max(sr.resistance, price + safeAtr*1.5) : price + safeAtr*1.5;
    sl = parseFloat((Math.max(resistLevel, price + safeAtr*1.5)).toFixed(dp));
    tp = parseFloat((price - Math.abs(sl-price)*2.5).toFixed(dp)); // 1:2.5 RR
    if(sl<=price)sl=parseFloat((price+safeAtr*2).toFixed(dp));
    if(tp>=price)tp=parseFloat((price-safeAtr*5).toFixed(dp));
  } else {
    sl = parseFloat((price-safeAtr*1.5).toFixed(dp));
    tp = parseFloat((price+safeAtr*1.5).toFixed(dp));
  }

  const rr = signal!=='WAIT' ? Math.abs(tp-price)/Math.abs(sl-price) : 0;
  return { sl:sl.toFixed(dp), tp:tp.toFixed(dp), rr:parseFloat(rr.toFixed(2)) };
}

// ============================================================
// BUILD REASONS (educational)
// ============================================================
function buildReasons(result, signal, phase, dailyBias, symbol) {
  const r = [];
  const { bull, bear, factors, indicators } = result;
  const { rsi, macd, structure, adx, session, candle, emas, stoch, bollinger } = indicators;

  if (isBlackout()) { r.push({icon:'⏸',text:'High-impact news event — trading paused for safety'}); return r; }

  // Daily bias
  if (dailyBias==='BULLISH') r.push({icon:'📅',text:'Daily chart is bullish — overall market trend favours BUY trades'});
  else if (dailyBias==='BEARISH') r.push({icon:'📅',text:'Daily chart is bearish — overall market trend favours SELL trades'});

  // H4 Structure
  if (structure==='BULLISH') r.push({icon:'📈',text:'H4 structure: Higher Highs + Higher Lows — bullish trend on 4-hour chart'});
  else if (structure==='BEARISH') r.push({icon:'📉',text:'H4 structure: Lower Highs + Lower Lows — bearish trend on 4-hour chart'});
  else r.push({icon:'↔️',text:'H4 structure: Ranging — no clear directional trend yet'});

  // RSI
  if (rsi!==null) {
    if (rsi<30) r.push({icon:'📊',text:`RSI ${rsi} — strongly oversold on H4. Sellers are exhausted. Reversal up is highly probable`});
    else if (rsi<40) r.push({icon:'📊',text:`RSI ${rsi} — oversold on H4. Bullish pressure building`});
    else if (rsi>70) r.push({icon:'📊',text:`RSI ${rsi} — strongly overbought on H4. Buyers are exhausted. Reversal down is highly probable`});
    else if (rsi>60) r.push({icon:'📊',text:`RSI ${rsi} — approaching overbought. Bearish pressure building`});
    else r.push({icon:'📊',text:`RSI ${rsi} — neutral zone on H4`});
  }

  // MACD
  if (macd) {
    if (macd.bullish) r.push({icon:'⚡',text:'MACD crossed above signal line on H4 — bullish momentum confirmed'});
    else r.push({icon:'⚡',text:'MACD crossed below signal line on H4 — bearish momentum confirmed'});
  }

  // ADX
  if (adx) {
    if (adx.strongTrend) r.push({icon:'💪',text:`ADX ${adx.adx} — strong trend active on H4. Good conditions for trend following`});
    else if (!adx.trending) r.push({icon:'😴',text:`ADX ${adx.adx} — weak trend. Market may be consolidating`});
  }

  // EMA
  if (emas && emas.aboveEma200!==null) {
    if (emas.aboveEma200) r.push({icon:'📏',text:'Price above 200 EMA — long-term bullish bias confirmed'});
    else r.push({icon:'📏',text:'Price below 200 EMA — long-term bearish bias confirmed'});
  }

  // Candle
  const bullC=['HAMMER','BULLISH_ENGULFING','MORNING_STAR'];
  const bearC=['SHOOTING_STAR','BEARISH_ENGULFING','EVENING_STAR'];
  if (bullC.includes(candle)) r.push({icon:'🕯️',text:`${candle.replace(/_/g,' ')} pattern on H4 — bullish reversal signal`});
  if (bearC.includes(candle)) r.push({icon:'🕯️',text:`${candle.replace(/_/g,' ')} pattern on H4 — bearish reversal signal`});

  // Session
  r.push({icon:'🕐',text:`Session: ${session.name}${session.quality>=4?' — peak liquidity, best time to trade with H4 signals':''}`});

  // Score
  r.push({icon:'🔢',text:`Confluence: ${Math.max(bull,bear)} bullish-side vs ${Math.min(bull,bear)} bearish-side (minimum 10 required for signal)`});

  // Signal conclusion
  if (phase==='STRONG_BUY')     r.push({icon:'🟢',text:`STRONG BUY signal — high probability setup. Set SL and TP on MT5 immediately`});
  else if (phase==='MODERATE_BUY')  r.push({icon:'🟠',text:`MODERATE BUY — good setup. Use proper risk management`});
  else if (phase==='WEAK_BUY')      r.push({icon:'🟡',text:`WEAK BUY — possible setup but lower probability. Use minimal lot size`});
  else if (phase==='STRONG_SELL')   r.push({icon:'🔴',text:`STRONG SELL signal — high probability setup. Set SL and TP on MT5 immediately`});
  else if (phase==='MODERATE_SELL') r.push({icon:'🟠',text:`MODERATE SELL — good setup. Use proper risk management`});
  else if (phase==='WEAK_SELL')     r.push({icon:'🟡',text:`WEAK SELL — possible setup but lower probability. Use minimal lot size`});
  else if (phase==='BUY_FORMING')   r.push({icon:'👀',text:`BUY SETUP FORMING — conditions are building. Watch this pair closely`});
  else if (phase==='SELL_FORMING')  r.push({icon:'👀',text:`SELL SETUP FORMING — conditions are building. Watch this pair closely`});
  else r.push({icon:'⏳',text:`Score ${Math.max(bull,bear)}/10 minimum needed. Market still forming. Patience protects your capital`});

  return r;
}

// ============================================================
// RISK CALCULATOR
// ============================================================
function calcRisk(price, sl, balance, riskPct, symbol) {
  const dp  = symbol==='USD/JPY'?3:symbol==='XAU/USD'?2:4;
  const riskAmount = balance * (riskPct/100);
  const slPips = Math.abs(price - parseFloat(sl));
  const pipValue = symbol==='USD/JPY' ? 0.01 : symbol==='XAU/USD' ? 0.1 : 0.0001;
  const slInPips = slPips / pipValue;
  const lotSize = slInPips > 0 ? (riskAmount / (slInPips * 10)) : 0.01;
  return {
    riskAmount: riskAmount.toFixed(2),
    slPips:     slInPips.toFixed(1),
    suggestedLot: Math.min(Math.max(parseFloat(lotSize.toFixed(2)), 0.01), 10),
  };
}

// ============================================================
// MAIN SIGNAL FUNCTION
// ============================================================
async function getSignalForPair(pair) {
  const now = Date.now();
  if (cache.signals[pair.symbol] && (now - cache.signals[pair.symbol].ts) < PRICE_TTL) {
    // Update live price only — don't recalculate signal
    const livePrice = await getStooqPrice(pair.stooq);
    if (livePrice) cache.signals[pair.symbol].data.price = livePrice.toFixed(pair.dp);
    return cache.signals[pair.symbol].data;
  }

  // Fetch both data sources in parallel
  const [h4Candles, dailyCandles, livePrice] = await Promise.all([
    getH4Candles(pair.twelve),
    getDailyCandles(pair.stooq),
    getStooqPrice(pair.stooq),
  ]);

  if (!livePrice) return null;

  // Use H4 candles for signal, fall back to daily if H4 unavailable
  const signalCandles = h4Candles || dailyCandles;
  if (!signalCandles || signalCandles.length < 15) return null;

  const dailyBias = getDailyBias(dailyCandles);
  const result    = deepH4Engine(signalCandles, dailyBias, livePrice, pair.symbol);
  const levels    = calcLevels(result.signal, livePrice, result.indicators.atr?.toFixed ? result.indicators.atr : null, pair.symbol, result.indicators.sr, result.indicators.pivots);
  const reasons   = buildReasons(result, result.signal, result.phase, dailyBias, pair.symbol);
  const risk      = calcRisk(livePrice, levels.sl, 1000, 1, pair.symbol); // example $1000 balance

  const data = {
    symbol:     pair.symbol,
    price:      livePrice.toFixed(pair.dp),
    signal:     result.signal,
    phase:      result.phase,
    confidence: result.confidence,
    entry:      livePrice.toFixed(pair.dp),
    sl:         levels.sl,
    tp:         levels.tp,
    rr:         levels.rr,
    bullScore:  result.bull,
    bearScore:  result.bear,
    dailyBias,
    rsi:        result.indicators.rsi,
    adx:        result.indicators.adx?.adx||null,
    structure:  result.indicators.structure,
    candle:     result.indicators.candle,
    spread:     getSpread(pair.symbol),
    blackout:   isBlackout(),
    newsComingSoon: isNewsComingSoon(),
    session:    result.indicators.session.name,
    dataSource: h4Candles ? 'Twelve Data H4 (real)' : 'Stooq Daily (fallback)',
    reasons,
    risk,
    candles: signalCandles.slice(-40).map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close})),
    updatedAt: new Date().toISOString()
  };

  cache.signals[pair.symbol] = { ts:now, data };
  return data;
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req,res) => res.json({
  status:   'TRADEPLUS BACKEND LIVE ✅',
  version:  '10.0',
  engine:   'Professional H4 Deep Signal Engine',
  sources:  'Twelve Data (H4 signals) + Stooq (live price)',
  features: ['Daily trend bias','H4 signal analysis','15+ indicators','Pre-signal warning','Confidence tiers','Risk calculator','1:2.5 RR minimum'],
  session:  getSession().name,
  blackout: isBlackout(),
  pairs:    PAIRS.map(p=>p.symbol),
  time:     new Date().toISOString()
}));

app.get('/api/signals', async(req,res) => {
  try {
    const results = await Promise.allSettled(PAIRS.map(getSignalForPair));
    const signals = results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
    res.json({success:true,signals,count:signals.length,
      blackout:isBlackout(),session:getSession().name,
      time:new Date().toISOString()});
  } catch(e) { res.status(500).json({success:false,error:e.message}); }
});

app.get('/api/news', async(req,res) => {
  const now=Date.now();
  if(cache.news.data.length&&(now-cache.news.ts)<NEWS_TTL){
    return res.json({success:true,news:cache.news.data});
  }
  try {
    const url=`https://newsapi.org/v2/everything?q=forex+dollar+ECB+Fed+interest+rates+gold+inflation&language=en&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_KEY}`;
    const r=await fetch(url),d=await r.json();
    if(!d.articles)return res.json({success:true,news:[]});
    const news=d.articles.map(a=>({
      headline:a.title,source:a.source?.name||'',time:a.publishedAt,url:a.url,
      impact:a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis/)? 'high':a.title.toLowerCase().match(/oil|gold|trade|data/)? 'med':'low',
      sentiment:a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|beat|rally/)? 'bullish':'bearish'
    }));
    cache.news={data:news,ts:now};
    res.json({success:true,news});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/health', (req,res) => res.json({
  alive:true,version:'10.0',
  session:getSession().name,blackout:isBlackout(),
  newsComingSoon:isNewsComingSoon(),
  cached:Object.keys(cache.signals).length,
  time:new Date().toISOString()
}));

// Keep Railway awake
setInterval(()=>{fetch(`http://localhost:${process.env.PORT||3000}/api/health`).catch(()=>{});},14*60*1000);

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`✅ TRADEPLUS v10 Professional H4 Engine on port ${PORT}`));
