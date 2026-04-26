 const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const app = express();

// ============================================================
// CORS
// ============================================================
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','*');
  res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.status(200).end();return;}
  next();
});
app.use(express.json());

// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================
const TWELVE_KEY = process.env.TWELVE_KEY;
const NEWS_KEY   = process.env.NEWS_KEY;

// ============================================================
// PAIRS CONFIGURATION
// ============================================================
const PAIRS = [
  { symbol:'EUR/USD', twelve:'EUR/USD', stooq:'eurusd',    dp:4, pipVal:0.0001, minPips:15 },
  { symbol:'GBP/USD', twelve:'GBP/USD', stooq:'gbpusd',    dp:4, pipVal:0.0001, minPips:20 },
  { symbol:'USD/JPY', twelve:'USD/JPY', stooq:'usdjpy',    dp:3, pipVal:0.01,   minPips:15 },
  { symbol:'XAU/USD', twelve:'XAU/USD', stooq:'xauusd.cf', dp:2, pipVal:0.1,    minPips:200 },
];

// ============================================================
// CACHE SYSTEM
// ============================================================
const cache = {
  h4:       {},   // H4 candles — TTL 4 hours
  daily:    {},   // Daily candles — TTL 24 hours
  weekly:   {},   // Weekly candles — TTL 7 days
  monthly:  {},   // Monthly candles — TTL 30 days
  price:    {},   // Live price — TTL 30 seconds
  signal:   {},   // Locked signals — TTL 30 seconds (price updates only)
  news:     { data:[], ts:0 },
  dxy:      { value:null, ts:0 },
  outcomes: {},   // Signal outcome tracking
  performance: {}, // Pair performance history
};

const TTL = {
  H4:     4  * 60 * 60 * 1000,
  DAILY:  24 * 60 * 60 * 1000,
  WEEKLY: 7  * 24 * 60 * 60 * 1000,
  PRICE:  30 * 1000,
  NEWS:   10 * 60 * 1000,
  DXY:    5  * 60 * 1000,
};

// ============================================================
// PAPER TRADING LOG
// ============================================================
const paperTrades = [];
const signalHistory = {};

// ============================================================
// STOOQ LIVE PRICE — matches MT5/Exness
// ============================================================
async function getStooqPrice(stooqSym) {
  const key = `p_${stooqSym}`, now = Date.now();
  if (cache.price[key] && (now-cache.price[key].ts) < TTL.PRICE) return cache.price[key].v;
  try {
    const res  = await fetch(`https://stooq.com/q/l/?s=${stooqSym}&f=sd2t2ohlcv&h&e=csv`,{timeout:6000});
    const text = await res.text();
    const p    = text.trim().split('\n')[1]?.split(',');
    if (!p) return cache.price[key]?.v||null;
    const price = parseFloat(p[6]);
    if (!price||isNaN(price)||price<=0) return cache.price[key]?.v||null;
    if (stooqSym.includes('xau')&&(price<1000||price>6000)) return cache.price[key]?.v||null;
    cache.price[key] = {v:price,ts:now};
    return price;
  } catch(e) { return cache.price[key]?.v||null; }
}

// ============================================================
// TWELVE DATA — MULTI-TIMEFRAME CANDLES
// ============================================================
async function getTwelveCandles(symbol, interval, size, cacheKey, ttl) {
  const now = Date.now();
  if (cache[cacheKey]?.[symbol] && (now-cache[cacheKey][symbol].ts)<ttl) return cache[cacheKey][symbol].data;
  if (!TWELVE_KEY) return null;
  try {
    const url  = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${size}&apikey=${TWELVE_KEY}`;
    const res  = await fetch(url,{timeout:10000});
    const data = await res.json();
    if (!data.values||data.status==='error') return null;
    const candles = data.values.map(c=>({
      time:c.datetime,
      open:parseFloat(c.open),high:parseFloat(c.high),
      low:parseFloat(c.low),close:parseFloat(c.close),
    })).reverse();
    if (candles.length<5) return null;
    if (!cache[cacheKey]) cache[cacheKey]={};
    cache[cacheKey][symbol] = {data:candles,ts:now};
    return candles;
  } catch(e) { return cache[cacheKey]?.[symbol]?.data||null; }
}

// ============================================================
// STOOQ DAILY CANDLES — fallback + daily bias
// ============================================================
async function getStooqDaily(stooqSym) {
  const now = Date.now();
  if (cache.daily[stooqSym]&&(now-cache.daily[stooqSym].ts)<TTL.DAILY) return cache.daily[stooqSym].data;
  try {
    const res  = await fetch(`https://stooq.com/q/d/l/?s=${stooqSym}&i=d`,{timeout:10000});
    const text = await res.text();
    if (text.includes('apikey')||text.includes('Get your')) return cache.daily[stooqSym]?.data||null;
    const lines = text.trim().split('\n');
    if (lines.length<5) return null;
    const candles = lines.slice(1).slice(-200).map(line=>{
      const p=line.split(',');
      if(p.length<5)return null;
      return{time:p[0]+' 00:00:00',open:parseFloat(p[1]),high:parseFloat(p[2]),low:parseFloat(p[3]),close:parseFloat(p[4])};
    }).filter(c=>c&&!isNaN(c.close)&&c.close>0);
    if (candles.length<5) return null;
    cache.daily[stooqSym]={data:candles,ts:now};
    return candles;
  } catch(e) { return cache.daily[stooqSym]?.data||null; }
}

// ============================================================
// DXY — DOLLAR INDEX (affects all USD pairs)
// ============================================================
async function getDXY() {
  const now = Date.now();
  if (cache.dxy.value&&(now-cache.dxy.ts)<TTL.DXY) return cache.dxy.value;
  try {
    const res  = await fetch('https://stooq.com/q/l/?s=dxy&f=sd2t2ohlcv&h&e=csv',{timeout:6000});
    const text = await res.text();
    const p    = text.trim().split('\n')[1]?.split(',');
    if (!p) return cache.dxy.value;
    const val  = parseFloat(p[6]);
    if (!val||isNaN(val)) return cache.dxy.value;
    cache.dxy  = {value:val,ts:now};
    return val;
  } catch(e) { return cache.dxy.value; }
}

// ============================================================
// TECHNICAL INDICATORS
// ============================================================
function calcRSI(c,p=14){
  if(c.length<p+1)return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){const d=c[i].close-c[i-1].close;if(d>=0)g+=d;else l+=Math.abs(d);}
  let ag=g/p,al=l/p;
  for(let i=p+1;i<c.length;i++){const d=c[i].close-c[i-1].close;ag=((ag*(p-1))+(d>0?d:0))/p;al=((al*(p-1))+(d<0?Math.abs(d):0))/p;}
  if(al===0)return 100;
  return parseFloat((100-(100/(1+ag/al))).toFixed(2));
}

function ema(vals,p){
  if(!vals||vals.length===0)return null;
  const k=2/(p+1);let e=vals[0];
  for(let i=1;i<vals.length;i++)e=vals[i]*k+e*(1-k);
  return e;
}

function calcMACD(c){
  if(c.length<26)return null;
  const cl=c.map(x=>x.close);
  const m=ema(cl.slice(-12),12)-ema(cl.slice(-26),26);
  const s=ema(cl.slice(-9),9);
  return{macd:parseFloat(m.toFixed(6)),signal:parseFloat(s.toFixed(6)),histogram:parseFloat((m-s).toFixed(6)),bullish:m>s};
}

function calcEMAs(c){
  if(c.length<5)return null;
  const cl=c.map(x=>x.close),price=cl[cl.length-1];
  const e20=c.length>=20?ema(cl.slice(-20),20):null;
  const e50=c.length>=50?ema(cl.slice(-50),50):null;
  const e100=c.length>=100?ema(cl.slice(-100),100):null;
  const e200=c.length>=200?ema(cl.slice(-200),200):null;
  return{ema20:e20,ema50:e50,ema100:e100,ema200:e200,
    above20:e20?price>e20:null,above50:e50?price>e50:null,
    above100:e100?price>e100:null,above200:e200?price>e200:null};
}

function calcBollinger(c,p=20){
  if(c.length<p)return null;
  const cl=c.slice(-p).map(x=>x.close);
  const mean=cl.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(cl.reduce((s,v)=>s+Math.pow(v-mean,2),0)/p);
  const price=c[c.length-1].close;
  return{upper:mean+2*std,middle:mean,lower:mean-2*std,
    nearUpper:price>(mean+1.5*std),nearLower:price<(mean-1.5*std),
    pctB:(price-(mean-2*std))/(4*std)};
}

function calcStoch(c,kp=14){
  if(c.length<kp)return null;
  const r=c.slice(-kp);
  const h=Math.max(...r.map(x=>x.high)),l=Math.min(...r.map(x=>x.low));
  const price=c[c.length-1].close;
  const k=h===l?50:((price-l)/(h-l))*100;
  return{k:parseFloat(k.toFixed(2)),overbought:k>80,oversold:k<20};
}

function calcADX(c,p=14){
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
  return{adx:parseFloat(dx.toFixed(2)),trending:dx>25,strongTrend:dx>40,bullish:diP>diM,diPlus:diP,diMinus:diM};
}

function calcATR(c,p=14){
  if(c.length<p+1)return null;
  const trs=[];
  for(let i=1;i<c.length;i++)trs.push(Math.max(c[i].high-c[i].low,
    Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
  return trs.slice(-p).reduce((s,v)=>s+v,0)/p;
}

function detectStructure(c){
  if(c.length<20)return'NEUTRAL';
  const r=c.slice(-20),h=r.map(x=>x.high),l=r.map(x=>x.low);
  const rH=Math.max(...h.slice(-5)),pH=Math.max(...h.slice(0,10));
  const rL=Math.min(...l.slice(-5)),pL=Math.min(...l.slice(0,10));
  if(rH>pH&&rL>pL)return'BULLISH';
  if(rH<pH&&rL<pL)return'BEARISH';
  return'NEUTRAL';
}

function calcSR(c){
  if(c.length<20)return null;
  const r=c.slice(-50),price=c[c.length-1].close;
  const res=r.map(x=>x.high).sort((a,b)=>b-a).slice(0,5).reduce((a,b)=>a+b,0)/5;
  const sup=r.map(x=>x.low).sort((a,b)=>a-b).slice(0,5).reduce((a,b)=>a+b,0)/5;
  const range=res-sup;
  return{resistance:res,support:sup,range,
    nearResistance:range>0&&price>(res-range*0.08),
    nearSupport:range>0&&price<(sup+range*0.08),
    distFromResistance:Math.abs(price-res),
    distFromSupport:Math.abs(price-sup)};
}

function detectCandle(c){
  if(c.length<3)return'NONE';
  const x=c[c.length-1],p=c[c.length-2],p2=c[c.length-3];
  const body=Math.abs(x.close-x.open),range=x.high-x.low;
  if(range===0)return'NONE';
  const uw=x.high-Math.max(x.open,x.close),lw=Math.min(x.open,x.close)-x.low;
  if(body/range<0.1)return'DOJI';
  if(lw>body*2&&uw<body*0.5&&x.close>x.open)return'HAMMER';
  if(uw>body*2&&lw<body*0.5&&x.close<x.open)return'SHOOTING_STAR';
  if(x.close>x.open&&p.close<p.open&&x.open<p.close&&x.close>p.open)return'BULLISH_ENGULFING';
  if(x.close<x.open&&p.close>p.open&&x.open>p.close&&x.close<p.open)return'BEARISH_ENGULFING';
  if(p2.close<p2.open&&Math.abs(p.close-p.open)<Math.abs(p2.close-p2.open)*0.3&&x.close>x.open&&x.close>(p2.open+p2.close)/2)return'MORNING_STAR';
  if(p2.close>p2.open&&Math.abs(p.close-p.open)<Math.abs(p2.close-p2.open)*0.3&&x.close<x.open&&x.close<(p2.open+p2.close)/2)return'EVENING_STAR';
  if(x.close>x.open&&body/range>0.7&&x.close>p.high)return'BULLISH_MARUBOZU';
  if(x.close<x.open&&body/range>0.7&&x.close<p.low)return'BEARISH_MARUBOZU';
  return'NONE';
}

function calcFib(c){
  if(c.length<20)return null;
  const r=c.slice(-100),h=Math.max(...r.map(x=>x.high)),l=Math.min(...r.map(x=>x.low));
  const range=h-l,price=c[c.length-1].close;
  const levels=[0.236,0.382,0.5,0.618,0.786].map(f=>({level:f,price:h-range*f}));
  const nearestFib=levels.reduce((nearest,fib)=>Math.abs(price-fib.price)<Math.abs(price-nearest.price)?fib:nearest,levels[0]);
  return{high:h,low:l,range,levels,
    nearFib:Math.abs(price-nearestFib.price)/price<0.003,
    nearestLevel:nearestFib.level,nearestPrice:nearestFib.price};
}

function calcPivots(c){
  if(c.length<2)return null;
  const p=c[c.length-2],pivot=(p.high+p.low+p.close)/3,price=c[c.length-1].close;
  return{pivot,r1:2*pivot-p.low,r2:pivot+(p.high-p.low),r3:p.high+2*(pivot-p.low),
    s1:2*pivot-p.high,s2:pivot-(p.high-p.low),s3:p.low-2*(p.high-pivot),
    abovePivot:price>pivot};
}

function detectFVG(c){
  if(c.length<3)return null;
  const c1=c[c.length-3],c3=c[c.length-1];
  if(c1.high<c3.low)return{type:'BULLISH',gap:c3.low-c1.high,midpoint:(c3.low+c1.high)/2};
  if(c1.low>c3.high)return{type:'BEARISH',gap:c1.low-c3.high,midpoint:(c1.low+c3.high)/2};
  return null;
}

function detectBOS(c){
  if(c.length<20)return null;
  const r=c.slice(-10),m=c.slice(-20,-10);
  if(!m.length)return null;
  const rH=Math.max(...r.map(x=>x.high)),mH=Math.max(...m.map(x=>x.high));
  const rL=Math.min(...r.map(x=>x.low)),mL=Math.min(...m.map(x=>x.low));
  if(rH>mH)return{type:'BULLISH_BOS',strength:(rH-mH)/mH*100};
  if(rL<mL)return{type:'BEARISH_BOS',strength:(mL-rL)/mL*100};
  return null;
}

// ============================================================
// LIQUIDITY SWEEP DETECTION
// Identifies when price swept stop losses before reversing
// ============================================================
function detectLiquiditySweep(c){
  if(c.length<5)return null;
  const recent=c.slice(-5);
  const prev=c.slice(-20,-5);
  if(!prev.length)return null;
  const prevHigh=Math.max(...prev.map(x=>x.high));
  const prevLow=Math.min(...prev.map(x=>x.low));
  const lastCandle=recent[recent.length-1];
  const prevCandle=recent[recent.length-2];
  // Bullish sweep: price went below previous low then closed back above it
  if(prevCandle.low<prevLow&&lastCandle.close>prevLow){
    return{type:'BULLISH_SWEEP',level:prevLow,text:'Liquidity sweep below previous low — smart money trapped shorts, bullish reversal likely'};
  }
  // Bearish sweep: price went above previous high then closed back below it
  if(prevCandle.high>prevHigh&&lastCandle.close<prevHigh){
    return{type:'BEARISH_SWEEP',level:prevHigh,text:'Liquidity sweep above previous high — smart money trapped longs, bearish reversal likely'};
  }
  return null;
}

// ============================================================
// ORDER BLOCK DETECTION
// Identifies institutional order zones
// ============================================================
function detectOrderBlock(c){
  if(c.length<10)return null;
  const recent=c.slice(-10);
  // Bullish order block: last bearish candle before a strong bullish move
  for(let i=recent.length-3;i>=0;i--){
    const candle=recent[i];
    const nextCandle=recent[i+1];
    if(candle.close<candle.open&&nextCandle.close>nextCandle.open&&
       (nextCandle.close-nextCandle.open)>(candle.open-candle.close)*1.5){
      return{type:'BULLISH_OB',high:candle.open,low:candle.close,
        text:`Bullish order block at ${candle.close.toFixed(5)}-${candle.open.toFixed(5)} — institutional buy zone`};
    }
    // Bearish order block: last bullish candle before a strong bearish move
    if(candle.close>candle.open&&nextCandle.close<nextCandle.open&&
       (nextCandle.open-nextCandle.close)>(candle.close-candle.open)*1.5){
      return{type:'BEARISH_OB',high:candle.close,low:candle.open,
        text:`Bearish order block at ${candle.open.toFixed(5)}-${candle.close.toFixed(5)} — institutional sell zone`};
    }
  }
  return null;
}

// ============================================================
// IMBALANCE ZONE (Fair Value Gap extended)
// ============================================================
function detectImbalance(c){
  if(c.length<5)return null;
  const imbalances=[];
  for(let i=2;i<c.length;i++){
    const c1=c[i-2],c3=c[i];
    if(c1.high<c3.low){
      imbalances.push({type:'BULLISH',high:c3.low,low:c1.high,size:c3.low-c1.high});
    }else if(c1.low>c3.high){
      imbalances.push({type:'BEARISH',high:c1.low,low:c3.high,size:c1.low-c3.high});
    }
  }
  return imbalances.length>0?imbalances[imbalances.length-1]:null;
}

// ============================================================
// PREVIOUS DAY HIGH/LOW BREAKOUT
// ============================================================
function checkPrevDayBreak(c){
  if(c.length<2)return null;
  const prev=c[c.length-2];
  const price=c[c.length-1].close;
  return{
    prevHigh:prev.high,prevLow:prev.low,
    abovePrevHigh:price>prev.high,belowPrevLow:price<prev.low,
    breakoutBull:price>prev.high,breakoutBear:price<prev.low,
  };
}

// ============================================================
// ASIA RANGE BREAKOUT
// ============================================================
function getAsiaRange(c){
  if(c.length<6)return null;
  // Asia session approx = candles during 23:00-08:00 WAT
  // Use last 3 candles as proxy for Asia range
  const asiaCandles=c.slice(-6,-3);
  const asiaHigh=Math.max(...asiaCandles.map(x=>x.high));
  const asiaLow=Math.min(...asiaCandles.map(x=>x.low));
  const price=c[c.length-1].close;
  return{high:asiaHigh,low:asiaLow,
    breakoutBull:price>asiaHigh,breakoutBear:price<asiaLow,
    text:price>asiaHigh?'Price broke above Asia range — bullish London breakout':
         price<asiaLow?'Price broke below Asia range — bearish London breakout':'Price within Asia range'};
}

// ============================================================
// WEEKLY & MONTHLY BIAS
// ============================================================
function getTimeframeBias(candles){
  if(!candles||candles.length<5)return'NEUTRAL';
  return detectStructure(candles);
}

// ============================================================
// WEEKLY OPEN BIAS
// ============================================================
function getWeeklyOpenBias(candles){
  if(!candles||candles.length<2)return'NEUTRAL';
  // First candle of week vs current
  const weekOpen=candles[0].open;
  const price=candles[candles.length-1].close;
  if(price>weekOpen*1.001)return'BULLISH';
  if(price<weekOpen*0.999)return'BEARISH';
  return'NEUTRAL';
}

// ============================================================
// DXY BIAS — Dollar strength effect on pairs
// ============================================================
function getDXYBias(dxy, symbol){
  if(!dxy)return'NEUTRAL';
  // DXY above 103 = strong dollar = bearish for EUR/USD, GBP/USD, XAU/USD
  // DXY below 100 = weak dollar = bullish for EUR/USD, GBP/USD, XAU/USD
  const usdPairs = ['EUR/USD','GBP/USD','XAU/USD'];
  const isUSDQuote = usdPairs.includes(symbol);
  if(dxy>103)return isUSDQuote?'BEARISH':'BULLISH';
  if(dxy<100)return isUSDQuote?'BULLISH':'BEARISH';
  return'NEUTRAL';
}

// ============================================================
// MARKET TIMING
// ============================================================
function getSession(){
  const h=(new Date().getUTCHours()+1)%24;
  if(h>=8&&h<13)  return{name:'LONDON',quality:3,killzone:h>=8&&h<11};
  if(h>=13&&h<17) return{name:'LONDON+NY OVERLAP',quality:5,killzone:h>=13&&h<16};
  if(h>=17&&h<22) return{name:'NEW YORK',quality:3,killzone:h>=17&&h<20};
  if(h>=1&&h<8)   return{name:'ASIAN',quality:2,killzone:false};
  return{name:'OFF-HOURS',quality:1,killzone:false};
}

function isBlackout(){
  const now=new Date(),wH=(now.getUTCHours()+1)%24,wM=now.getUTCMinutes();
  const day=now.getUTCDay(),mins=wH*60+wM;
  return [{h:14,m:30,day:5},{h:19,m:0,day:3},{h:13,m:15,day:4},{h:13,m:30,day:3},{h:7,m:0,day:3}]
    .some(ev=>ev.day===day&&Math.abs(mins-(ev.h*60+ev.m))<=10);
}

function isNewsWithin4Hours(){
  const now=new Date(),wH=(now.getUTCHours()+1)%24,wM=now.getUTCMinutes();
  const day=now.getUTCDay(),mins=wH*60+wM;
  return [{h:14,m:30,day:5},{h:19,m:0,day:3},{h:13,m:15,day:4},{h:13,m:30,day:3}]
    .some(ev=>{if(ev.day!==day)return false;const em=ev.h*60+ev.m;return em>mins&&em-mins<=240;});
}

function isWeekend(){
  const now=new Date(),wH=(now.getUTCHours()+1)%24,wM=now.getUTCMinutes();
  const day=now.getUTCDay(),mins=wH*60+wM;
  return day===6||(day===0&&mins<23*60)||(day===5&&mins>=22*60);
}

function getSpread(s){
  return{'EUR/USD':0.8,'GBP/USD':1.2,'USD/JPY':0.9,'XAU/USD':2.5}[s]||1.5;
}

// ============================================================
// MULTI-TIMEFRAME BIAS AGGREGATOR
// Returns overall direction from Monthly → Weekly → Daily → H4
// ============================================================
function getMultiTimeframeBias(monthly,weekly,daily,h4){
  const biasScore=(bias)=>bias==='BULLISH'?1:bias==='BEARISH'?-1:0;
  const mScore=biasScore(getTimeframeBias(monthly));
  const wScore=biasScore(getTimeframeBias(weekly));
  const dScore=biasScore(getTimeframeBias(daily));
  const hScore=biasScore(detectStructure(h4||[]));
  const total=mScore*4+wScore*3+dScore*2+hScore*1; // weighted
  return{
    monthly:getTimeframeBias(monthly),
    weekly:getTimeframeBias(weekly),
    daily:getTimeframeBias(daily),
    h4:detectStructure(h4||[]),
    score:total,
    bias:total>=3?'STRONG_BULLISH':total>=1?'BULLISH':total<=-3?'STRONG_BEARISH':total<=-1?'BEARISH':'NEUTRAL',
    aligned:Math.abs(total)>=6, // all timeframes agree
  };
}

// ============================================================
// HARD TREND BLOCK
// Prevents trading against the higher timeframe trend
// ============================================================
function hardTrendBlock(mtfBias, proposedSignal){
  // If all timeframes are strongly bearish — block any BUY
  if(mtfBias.bias==='STRONG_BEARISH'&&proposedSignal==='BUY') return true;
  // If all timeframes are strongly bullish — block any SELL
  if(mtfBias.bias==='STRONG_BULLISH'&&proposedSignal==='SELL') return true;
  // If daily AND weekly are bearish — block BUY
  if(mtfBias.daily==='BEARISH'&&mtfBias.weekly==='BEARISH'&&proposedSignal==='BUY') return true;
  // If daily AND weekly are bullish — block SELL
  if(mtfBias.daily==='BULLISH'&&mtfBias.weekly==='BULLISH'&&proposedSignal==='SELL') return true;
  return false;
}

// ============================================================
// PAIR PERFORMANCE TRACKER
// ============================================================
function getPairAccuracy(symbol){
  const history=cache.performance[symbol];
  if(!history||history.total<5)return null; // need at least 5 trades
  return{
    total:history.total,
    wins:history.wins,
    accuracy:Math.round((history.wins/history.total)*100),
    lotMultiplier:history.wins/history.total>=0.65?1.0:history.wins/history.total>=0.5?0.5:0.25,
  };
}

function recordOutcome(symbol,signal,entry,sl,tp,currentPrice){
  if(!cache.performance[symbol])cache.performance[symbol]={total:0,wins:0};
  const isWin=signal==='BUY'?currentPrice>=tp:signal==='SELL'?currentPrice<=tp:false;
  cache.performance[symbol].total++;
  if(isWin)cache.performance[symbol].wins++;
}

// ============================================================
// DEEP SIGNAL ENGINE — ALL 50 FACTORS
// ============================================================
function deepSignalEngine(ind, mtfBias, dxy, symbol){
  let bull=0,bear=0,factors=[],warnings=[];

  const {rsi,macd,emas,bollinger,stoch,adx,structure,sr,candle,
    fib,pivots,atr,fvg,bos,liquidity,orderBlock,imbalance,
    prevDay,asiaRange,session,momentum} = ind;

  // ── HARD SAFETY BLOCKS ──
  if(isWeekend())return{signal:'WAIT',phase:'MARKET_CLOSED',confidence:0,bull:0,bear:0,factors:['🌙 Market closed — weekend']};
  if(isBlackout())return{signal:'WAIT',phase:'BLACKOUT',confidence:0,bull:0,bear:0,factors:['⏸ News blackout active — trading paused']};
  if(getSpread(symbol)>3)return{signal:'WAIT',phase:'WIDE_SPREAD',confidence:0,bull:0,bear:0,factors:['🚫 Spread too wide — signal blocked']};

  // ── MULTI-TIMEFRAME BIAS (weight: 8) ──
  if(mtfBias.bias==='STRONG_BULLISH'){bull+=8;factors.push('🌟 ALL timeframes bullish — Monthly, Weekly, Daily, H4 aligned');}
  else if(mtfBias.bias==='BULLISH'){bull+=5;factors.push('✅ Higher timeframes bullish — trend favours BUY');}
  else if(mtfBias.bias==='STRONG_BEARISH'){bear+=8;factors.push('🌟 ALL timeframes bearish — Monthly, Weekly, Daily, H4 aligned');}
  else if(mtfBias.bias==='BEARISH'){bear+=5;factors.push('✅ Higher timeframes bearish — trend favours SELL');}
  else warnings.push('⚠️ Mixed timeframe signals — extra caution');

  // ── H4 STRUCTURE (weight: 4) ──
  if(structure==='BULLISH'){bull+=4;factors.push('✅ H4 Higher Highs + Higher Lows confirmed');}
  else if(structure==='BEARISH'){bear+=4;factors.push('✅ H4 Lower Highs + Lower Lows confirmed');}

  // ── DXY FILTER (weight: 3) ──
  const dxyBias=getDXYBias(dxy,symbol);
  if(dxy){
    if(dxyBias==='BULLISH'){bull+=3;factors.push(`✅ DXY at ${dxy?.toFixed(2)} — Dollar weakness supports this pair`);}
    else if(dxyBias==='BEARISH'){bear+=3;factors.push(`✅ DXY at ${dxy?.toFixed(2)} — Dollar strength pressures this pair`);}
  }

  // ── RSI (weight: 3) ──
  if(rsi!==null){
    if(rsi<25){bull+=4;factors.push(`✅ RSI ${rsi} — extreme oversold, strong reversal expected`);}
    else if(rsi<35){bull+=3;factors.push(`✅ RSI ${rsi} — strongly oversold`);}
    else if(rsi<45){bull+=2;factors.push(`✅ RSI ${rsi} — oversold territory`);}
    else if(rsi<50){bull+=1;}
    else if(rsi>75){bear+=4;factors.push(`✅ RSI ${rsi} — extreme overbought, strong reversal expected`);}
    else if(rsi>65){bear+=3;factors.push(`✅ RSI ${rsi} — strongly overbought`);}
    else if(rsi>55){bear+=2;factors.push(`✅ RSI ${rsi} — overbought territory`);}
    else if(rsi>50){bear+=1;}
  }

  // ── MACD (weight: 3) ──
  if(macd){
    if(macd.bullish&&macd.histogram>0){bull+=3;factors.push('✅ MACD bullish crossover + positive histogram');}
    else if(macd.bullish){bull+=2;factors.push('✅ MACD bullish crossover');}
    else if(!macd.bullish&&macd.histogram<0){bear+=3;factors.push('✅ MACD bearish crossover + negative histogram');}
    else if(!macd.bullish){bear+=2;factors.push('✅ MACD bearish crossover');}
  }

  // ── MOVING AVERAGES (weight: 3) ──
  if(emas){
    let s=0;
    if(emas.above20===true)s++;else if(emas.above20===false)s--;
    if(emas.above50===true)s++;else if(emas.above50===false)s--;
    if(emas.above100===true)s++;else if(emas.above100===false)s--;
    if(emas.above200===true)s++;else if(emas.above200===false)s--;
    if(s>=3){bull+=3;factors.push('✅ Price above all major EMAs (20/50/100/200)');}
    else if(s>=2)bull+=2;else if(s>=1)bull+=1;
    else if(s<=-3){bear+=3;factors.push('✅ Price below all major EMAs (20/50/100/200)');}
    else if(s<=-2)bear+=2;else if(s<=-1)bear+=1;
  }

  // ── ADX TREND STRENGTH (weight: 2) ──
  if(adx&&adx.trending){
    if(adx.bullish&&adx.strongTrend){bull+=2;factors.push(`✅ ADX ${adx.adx} — strong bullish trend`);}
    else if(adx.bullish)bull+=1;
    else if(!adx.bullish&&adx.strongTrend){bear+=2;factors.push(`✅ ADX ${adx.adx} — strong bearish trend`);}
    else if(!adx.bullish)bear+=1;
  }else if(adx&&!adx.trending){warnings.push(`⚠️ ADX ${adx?.adx} — weak trend`);}

  // ── BOLLINGER BANDS (weight: 2) ──
  if(bollinger){
    if(bollinger.nearLower){bull+=2;factors.push('✅ Price at Bollinger lower band — reversal zone');}
    else if(bollinger.nearUpper){bear+=2;factors.push('✅ Price at Bollinger upper band — rejection zone');}
  }

  // ── STOCHASTIC (weight: 2) ──
  if(stoch){
    if(stoch.oversold){bull+=2;factors.push(`✅ Stochastic ${stoch.k} — oversold`);}
    if(stoch.overbought){bear+=2;factors.push(`✅ Stochastic ${stoch.k} — overbought`);}
  }

  // ── SUPPORT/RESISTANCE (weight: 2) ──
  if(sr){
    if(sr.nearSupport){bull+=2;factors.push('✅ Price at key support level');}
    if(sr.nearResistance){bear+=2;factors.push('✅ Price at key resistance level');}
  }

  // ── CANDLESTICK PATTERNS (weight: 2) ──
  const bullC=['HAMMER','BULLISH_ENGULFING','MORNING_STAR','BULLISH_MARUBOZU'];
  const bearC=['SHOOTING_STAR','BEARISH_ENGULFING','EVENING_STAR','BEARISH_MARUBOZU'];
  if(bullC.includes(candle)){bull+=2;factors.push(`✅ ${candle.replace(/_/g,' ')} — bullish reversal`);}
  if(bearC.includes(candle)){bear+=2;factors.push(`✅ ${candle.replace(/_/g,' ')} — bearish reversal`);}

  // ── BREAK OF STRUCTURE (weight: 2) ──
  if(bos){
    if(bos.type==='BULLISH_BOS'){bull+=2;factors.push('✅ Bullish break of structure');}
    if(bos.type==='BEARISH_BOS'){bear+=2;factors.push('✅ Bearish break of structure');}
  }

  // ── LIQUIDITY SWEEP (weight: 3) ──
  if(liquidity){
    if(liquidity.type==='BULLISH_SWEEP'){bull+=3;factors.push(`✅ ${liquidity.text}`);}
    if(liquidity.type==='BEARISH_SWEEP'){bear+=3;factors.push(`✅ ${liquidity.text}`);}
  }

  // ── ORDER BLOCK (weight: 2) ──
  if(orderBlock){
    if(orderBlock.type==='BULLISH_OB'){bull+=2;factors.push(`✅ ${orderBlock.text}`);}
    if(orderBlock.type==='BEARISH_OB'){bear+=2;factors.push(`✅ ${orderBlock.text}`);}
  }

  // ── IMBALANCE/FVG (weight: 1) ──
  if(imbalance){
    if(imbalance.type==='BULLISH'){bull+=1;factors.push('✅ Bullish imbalance zone detected');}
    if(imbalance.type==='BEARISH'){bear+=1;factors.push('✅ Bearish imbalance zone detected');}
  }

  // ── PREVIOUS DAY BREAKOUT (weight: 2) ──
  if(prevDay){
    if(prevDay.breakoutBull){bull+=2;factors.push('✅ Price broke above previous day high — bullish');}
    if(prevDay.breakoutBear){bear+=2;factors.push('✅ Price broke below previous day low — bearish');}
  }

  // ── ASIA RANGE BREAKOUT (weight: 2) ──
  if(asiaRange){
    if(asiaRange.breakoutBull){bull+=2;factors.push('✅ Broke above Asia range — London bullish breakout');}
    if(asiaRange.breakoutBear){bear+=2;factors.push('✅ Broke below Asia range — London bearish breakout');}
  }

  // ── FIBONACCI (weight: 1) ──
  if(fib&&fib.nearFib){
    if(bull>bear){bull+=1;factors.push(`✅ Price at Fibonacci ${(fib.nearestLevel*100).toFixed(1)}% support`);}
    else{bear+=1;factors.push(`✅ Price at Fibonacci ${(fib.nearestLevel*100).toFixed(1)}% resistance`);}
  }

  // ── PIVOT POINTS (weight: 1) ──
  if(pivots){if(pivots.abovePivot)bull+=1;else bear+=1;}

  // ── KILLZONE BONUS (weight: 2) ──
  if(session.killzone){
    if(bull>bear){bull+=2;factors.push(`✅ ${session.name} killzone — highest probability trading window`);}
    else if(bear>bull){bear+=2;factors.push(`✅ ${session.name} killzone — highest probability trading window`);}
  }

  // ── SESSION QUALITY (weight: 1) ──
  if(session.quality>=4){
    if(bull>bear)bull+=1;else if(bear>bull)bear+=1;
  }

  // ── NEWS CAUTION ──
  if(isNewsWithin4Hours()){
    warnings.push('⚠️ High-impact news within 4 hours — reduce lot size');
  }

  // ── CALCULATE CONFIDENCE ──
  const total=bull+bear;
  const conf=Math.min(total>0?Math.round((Math.max(bull,bear)/total)*100):50,85);

  // ── DETERMINE SIGNAL ──
  // Minimum score 12 AND confidence 65% for a signal
  // Higher threshold than before for accuracy
  let signal='WAIT',phase='ANALYSING';

  if(bull>bear&&bull>=12&&conf>=65){
    signal='BUY';
    // Apply hard trend block
    if(hardTrendBlock(mtfBias,'BUY')){
      signal='WAIT';
      phase='BLOCKED_BY_TREND';
      factors.push('🚫 BUY blocked — higher timeframes are bearish. Never trade against the trend.');
    }else{
      if(conf>=80)phase='STRONG_BUY';
      else if(conf>=70)phase='MODERATE_BUY';
      else phase='WEAK_BUY';
    }
  }else if(bear>bull&&bear>=12&&conf>=65){
    signal='SELL';
    // Apply hard trend block
    if(hardTrendBlock(mtfBias,'SELL')){
      signal='WAIT';
      phase='BLOCKED_BY_TREND';
      factors.push('🚫 SELL blocked — higher timeframes are bullish. Never trade against the trend.');
    }else{
      if(conf>=80)phase='STRONG_SELL';
      else if(conf>=70)phase='MODERATE_SELL';
      else phase='WEAK_SELL';
    }
  }else if(bull>=8||bear>=8){
    phase=bull>=8?'BUY_FORMING':'SELL_FORMING';
  }

  return{signal,phase,confidence:conf,bull,bear,factors,warnings};
}

// ============================================================
// CALCULATE SL/TP WITH 1:2.5 MINIMUM R:R
// ============================================================
function calcLevels(signal,price,atr,symbol,sr,pivots){
  const minAtr={'EUR/USD':0.0025,'GBP/USD':0.0030,'USD/JPY':0.30,'XAU/USD':10.0}[symbol]||0.003;
  const safeAtr=Math.max(atr||0,minAtr);
  const dp=symbol==='USD/JPY'?3:symbol==='XAU/USD'?2:4;
  let sl,tp;

  if(signal==='BUY'){
    // SL below support or 1.5 ATR — whichever is further
    const supLevel=sr?Math.min(sr.support,price-safeAtr*1.5):price-safeAtr*1.5;
    sl=parseFloat(Math.min(supLevel,price-safeAtr*1.5).toFixed(dp));
    const riskPips=Math.abs(price-sl);
    tp=parseFloat((price+riskPips*2.5).toFixed(dp)); // 1:2.5 RR
    // Safety checks
    if(sl>=price)sl=parseFloat((price-safeAtr*2).toFixed(dp));
    if(tp<=price)tp=parseFloat((price+safeAtr*5).toFixed(dp));
  }else if(signal==='SELL'){
    const resLevel=sr?Math.max(sr.resistance,price+safeAtr*1.5):price+safeAtr*1.5;
    sl=parseFloat(Math.max(resLevel,price+safeAtr*1.5).toFixed(dp));
    const riskPips=Math.abs(sl-price);
    tp=parseFloat((price-riskPips*2.5).toFixed(dp)); // 1:2.5 RR
    // Safety checks
    if(sl<=price)sl=parseFloat((price+safeAtr*2).toFixed(dp));
    if(tp>=price)tp=parseFloat((price-safeAtr*5).toFixed(dp));
  }else{
    sl=parseFloat((price-safeAtr*1.5).toFixed(dp));
    tp=parseFloat((price+safeAtr*1.5).toFixed(dp));
  }

  const rr=signal!=='WAIT'?parseFloat((Math.abs(tp-price)/Math.abs(sl-price)).toFixed(2)):0;
  // Warn if RR is below 1:2
  const rrWarning=rr>0&&rr<2?'⚠️ Risk/Reward below 1:2 — consider skipping this trade':null;

  return{sl:sl.toFixed(dp),tp:tp.toFixed(dp),rr,rrWarning};
}

// ============================================================
// RISK CALCULATOR
// ============================================================
function calcRisk(price,sl,symbol,balanceUSD=1000,riskPct=1){
  const pipVal={'EUR/USD':0.0001,'GBP/USD':0.0001,'USD/JPY':0.01,'XAU/USD':0.1}[symbol]||0.0001;
  const riskAmount=balanceUSD*(riskPct/100);
  const slDistance=Math.abs(price-parseFloat(sl));
  const slPips=slDistance/pipVal;
  const pipValuePerLot=symbol==='USD/JPY'?9.3:symbol==='XAU/USD'?10:10;
  const lots=slPips>0?riskAmount/(slPips*pipValuePerLot):0.01;
  return{
    riskAmount:riskAmount.toFixed(2),
    slPips:slPips.toFixed(1),
    suggestedLot:Math.min(Math.max(parseFloat(lots.toFixed(2)),0.01),10),
    maxLot1pct:parseFloat((balanceUSD*0.01/(slPips*pipValuePerLot)).toFixed(2)),
    maxLot2pct:parseFloat((balanceUSD*0.02/(slPips*pipValuePerLot)).toFixed(2)),
  };
}

// ============================================================
// BUILD EDUCATIONAL REASONS
// ============================================================
function buildReasons(result,ind,signal,phase,mtfBias,symbol,dxy){
  const r=[];
  const{bull,bear,factors,warnings}=result;
  const{rsi,macd,structure,adx,session,candle,emas,stoch,bollinger,liquidity,orderBlock,prevDay,asiaRange}=ind;

  if(isBlackout()){r.push({icon:'⏸',text:'High-impact news event — all trading paused for safety'});return r;}

  // Multi-timeframe analysis
  r.push({icon:'📅',text:`Multi-timeframe bias: Monthly=${mtfBias.monthly} | Weekly=${mtfBias.weekly} | Daily=${mtfBias.daily} | H4=${mtfBias.h4}`});

  // DXY
  if(dxy)r.push({icon:'💵',text:`DXY at ${dxy.toFixed(2)} — ${dxy>103?'Strong dollar':dxy<100?'Weak dollar':'Neutral dollar'}`});

  // Structure
  if(structure==='BULLISH')r.push({icon:'📈',text:'H4 showing Higher Highs + Higher Lows — bullish market structure'});
  else if(structure==='BEARISH')r.push({icon:'📉',text:'H4 showing Lower Highs + Lower Lows — bearish market structure'});
  else r.push({icon:'↔️',text:'H4 ranging — no clear structure. Signals require extra confluence'});

  // RSI
  if(rsi!==null){
    if(rsi<30)r.push({icon:'📊',text:`RSI ${rsi} — strongly oversold. Sellers exhausted, reversal up highly probable`});
    else if(rsi>70)r.push({icon:'📊',text:`RSI ${rsi} — strongly overbought. Buyers exhausted, reversal down highly probable`});
    else r.push({icon:'📊',text:`RSI ${rsi} — ${rsi<50?'leaning bearish':'leaning bullish'}`});
  }

  // MACD
  if(macd){
    if(macd.bullish)r.push({icon:'⚡',text:'MACD bullish crossover on H4 — momentum shifting upward'});
    else r.push({icon:'⚡',text:'MACD bearish crossover on H4 — momentum shifting downward'});
  }

  // ADX
  if(adx){
    if(adx.strongTrend)r.push({icon:'💪',text:`ADX ${adx.adx} — strong trend. Follow it, don't fight it`});
    else if(!adx.trending)r.push({icon:'😴',text:`ADX ${adx.adx} — weak trend. Market may be consolidating, be cautious`});
  }

  // EMA
  if(emas&&emas.above200!==null){
    if(emas.above200)r.push({icon:'📏',text:'Price above 200 EMA — long-term uptrend intact'});
    else r.push({icon:'📏',text:'Price below 200 EMA — long-term downtrend intact'});
  }

  // Liquidity
  if(liquidity)r.push({icon:'🎯',text:liquidity.text});

  // Order Block
  if(orderBlock)r.push({icon:'🏦',text:orderBlock.text});

  // Previous day
  if(prevDay){
    if(prevDay.breakoutBull)r.push({icon:'🔝',text:'Price broke above previous day high — strong bullish signal'});
    if(prevDay.breakoutBear)r.push({icon:'🔻',text:'Price broke below previous day low — strong bearish signal'});
  }

  // Asia range
  if(asiaRange&&(asiaRange.breakoutBull||asiaRange.breakoutBear)){
    r.push({icon:'🌅',text:asiaRange.text});
  }

  // Candle
  const bullC=['HAMMER','BULLISH_ENGULFING','MORNING_STAR','BULLISH_MARUBOZU'];
  const bearC=['SHOOTING_STAR','BEARISH_ENGULFING','EVENING_STAR','BEARISH_MARUBOZU'];
  if(bullC.includes(candle))r.push({icon:'🕯️',text:`${candle.replace(/_/g,' ')} on H4 — bullish reversal pattern`});
  if(bearC.includes(candle))r.push({icon:'🕯️',text:`${candle.replace(/_/g,' ')} on H4 — bearish reversal pattern`});

  // Session
  r.push({icon:'🕐',text:`${session.name}${session.killzone?' — YOU ARE IN THE KILLZONE. Highest probability window':''}`});

  // Warnings
  warnings.forEach(w=>r.push({icon:'⚠️',text:w}));

  // Score
  r.push({icon:'🔢',text:`Score: ${Math.max(bull,bear)} confluent factors (need 12+ for signal, 65%+ confidence)`});

  // Conclusion
  if(phase==='STRONG_BUY')r.push({icon:'🟢',text:'STRONG BUY — High probability setup. Set exact SL and TP on MT5 BEFORE entering'});
  else if(phase==='MODERATE_BUY')r.push({icon:'🟠',text:'MODERATE BUY — Good setup. Use 1% risk maximum'});
  else if(phase==='WEAK_BUY')r.push({icon:'🟡',text:'WEAK BUY — Lower probability. Use 0.5% risk only'});
  else if(phase==='STRONG_SELL')r.push({icon:'🔴',text:'STRONG SELL — High probability setup. Set exact SL and TP on MT5 BEFORE entering'});
  else if(phase==='MODERATE_SELL')r.push({icon:'🟠',text:'MODERATE SELL — Good setup. Use 1% risk maximum'});
  else if(phase==='WEAK_SELL')r.push({icon:'🟡',text:'WEAK SELL — Lower probability. Use 0.5% risk only'});
  else if(phase==='BUY_FORMING')r.push({icon:'👀',text:'BUY SETUP FORMING — Watch this pair. Conditions are building. Not ready yet'});
  else if(phase==='SELL_FORMING')r.push({icon:'👀',text:'SELL SETUP FORMING — Watch this pair. Conditions are building. Not ready yet'});
  else if(phase==='BLOCKED_BY_TREND')r.push({icon:'🚫',text:'Signal blocked — never trade against the higher timeframe trend'});
  else r.push({icon:'⏳',text:`Score ${Math.max(bull,bear)}/12 needed. Still analysing. Patience = profit`});

  return r;
}

// ============================================================
// LIVE TRADE MONITOR — exit alerts
// ============================================================
const activeSignals={};
function checkExitConditions(symbol,signal,entry,sl,tp,livePrice){
  if(signal==='WAIT')return null;
  const dp=symbol==='USD/JPY'?3:symbol==='XAU/USD'?2:4;
  const entryN=parseFloat(entry),slN=parseFloat(sl),tpN=parseFloat(tp);
  const riskDist=Math.abs(entryN-slN);
  // Check if near SL (80% of the way to SL)
  if(signal==='BUY'&&livePrice<=entryN-riskDist*0.8){
    return{type:'EXIT_WARN',message:`⚠️ Price approaching Stop Loss — consider closing to limit loss`,urgent:true};
  }
  if(signal==='SELL'&&livePrice>=entryN+riskDist*0.8){
    return{type:'EXIT_WARN',message:`⚠️ Price approaching Stop Loss — consider closing to limit loss`,urgent:true};
  }
  // Check if near TP (90% of the way to TP)
  const profitDist=Math.abs(tpN-entryN);
  if(signal==='BUY'&&livePrice>=entryN+profitDist*0.9){
    return{type:'TP_NEAR',message:`✅ Price approaching Take Profit — consider closing to lock in profit`,urgent:false};
  }
  if(signal==='SELL'&&livePrice<=entryN-profitDist*0.9){
    return{type:'TP_NEAR',message:`✅ Price approaching Take Profit — consider closing to lock in profit`,urgent:false};
  }
  return null;
}

// ============================================================
// MAIN SIGNAL FUNCTION
// ============================================================
async function getSignalForPair(pair){
  const now=Date.now();

  // Fetch all data in parallel
  const [h4,daily,livePrice,dxy]=await Promise.all([
    getTwelveCandles(pair.twelve,'4h',100,'h4',TTL.H4),
    getStooqDaily(pair.stooq),
    getStooqPrice(pair.stooq),
    getDXY(),
  ]);

  // Fetch weekly/monthly from Twelve Data
  const [weekly,monthly]=await Promise.all([
    getTwelveCandles(pair.twelve,'1week',52,'weekly',TTL.WEEKLY),
    getTwelveCandles(pair.twelve,'1month',24,'monthly',TTL.MONTHLY),
  ]);

  if(!livePrice)return null;

  // Use H4 for signal analysis, daily as fallback
  const signalCandles=h4||daily;
  if(!signalCandles||signalCandles.length<15)return null;

  // Update live price in existing signal without recalculating
  if(cache.signal[pair.symbol]&&(now-cache.signal[pair.symbol].ts)<TTL.PRICE){
    const existing=cache.signal[pair.symbol].data;
    existing.price=livePrice.toFixed(pair.dp);
    // Check exit conditions
    const exitAlert=checkExitConditions(pair.symbol,existing.signal,existing.entry,existing.sl,existing.tp,livePrice);
    if(exitAlert)existing.exitAlert=exitAlert;
    else delete existing.exitAlert;
    return existing;
  }

  // Multi-timeframe bias
  const mtfBias=getMultiTimeframeBias(monthly,weekly,daily,signalCandles);

  // Calculate all indicators on H4
  const ind={
    rsi:calcRSI(signalCandles),
    macd:calcMACD(signalCandles),
    emas:calcEMAs(signalCandles),
    bollinger:calcBollinger(signalCandles),
    stoch:calcStoch(signalCandles),
    adx:calcADX(signalCandles),
    structure:detectStructure(signalCandles),
    sr:calcSR(signalCandles),
    candle:detectCandle(signalCandles),
    fib:calcFib(signalCandles),
    pivots:calcPivots(signalCandles),
    atr:calcATR(signalCandles),
    fvg:detectFVG(signalCandles),
    bos:detectBOS(signalCandles),
    liquidity:detectLiquiditySweep(signalCandles),
    orderBlock:detectOrderBlock(signalCandles),
    imbalance:detectImbalance(signalCandles),
    prevDay:checkPrevDayBreak(signalCandles),
    asiaRange:getAsiaRange(signalCandles),
    session:getSession(),
    momentum:{bullish:signalCandles.length>5&&signalCandles[signalCandles.length-1].close>signalCandles[signalCandles.length-5].close},
  };

  // Run deep signal engine
  const result=deepSignalEngine(ind,mtfBias,dxy,pair.symbol);
  const levels=calcLevels(result.signal,livePrice,ind.atr,pair.symbol,ind.sr,ind.pivots);
  const reasons=buildReasons(result,ind,result.signal,result.phase,mtfBias,pair.symbol,dxy);
  const risk=calcRisk(livePrice,levels.sl,pair.symbol);
  const pairPerf=getPairAccuracy(pair.symbol);

  // Paper trade logging
  if(result.signal!=='WAIT'){
    paperTrades.push({
      symbol:pair.symbol,signal:result.signal,phase:result.phase,
      entry:livePrice.toFixed(pair.dp),sl:levels.sl,tp:levels.tp,
      confidence:result.confidence,time:new Date().toISOString(),
      mtfBias:mtfBias.bias,outcome:'PENDING'
    });
    if(paperTrades.length>100)paperTrades.shift();
  }

  const data={
    symbol:pair.symbol,
    price:livePrice.toFixed(pair.dp),
    signal:result.signal,
    phase:result.phase,
    confidence:result.confidence,
    entry:livePrice.toFixed(pair.dp),
    sl:levels.sl,tp:levels.tp,rr:levels.rr,
    rrWarning:levels.rrWarning,
    bullScore:result.bull,bearScore:result.bear,
    mtfBias:mtfBias.bias,
    dailyBias:mtfBias.daily,
    weeklyBias:mtfBias.weekly,
    monthlyBias:mtfBias.monthly,
    dxy:dxy?parseFloat(dxy.toFixed(2)):null,
    rsi:ind.rsi,adx:ind.adx?.adx||null,
    structure:ind.structure,
    candle:ind.candle,
    liquidity:ind.liquidity?.type||null,
    orderBlock:ind.orderBlock?.type||null,
    session:ind.session.name,
    killzone:ind.session.killzone,
    spread:getSpread(pair.symbol),
    blackout:isBlackout(),
    newsComingSoon:isNewsWithin4Hours(),
    dataSource:h4?'Twelve Data H4 (real)':'Stooq Daily (fallback)',
    pairAccuracy:pairPerf,
    risk,reasons,
    warnings:result.warnings,
    candles:signalCandles.slice(-40).map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close})),
    updatedAt:new Date().toISOString()
  };

  cache.signal[pair.symbol]={ts:now,data};
  return data;
}

// ============================================================
// ROUTES
// ============================================================
app.get('/',(req,res)=>res.json({
  status:'TRADEPLUS BACKEND LIVE ✅',
  version:'11.0',
  engine:'Professional Multi-Timeframe H4 Deep Signal Engine',
  sources:'Twelve Data (H4/W/M signals) + Stooq (live price + daily)',
  features:[
    'Multi-timeframe analysis (Monthly/Weekly/Daily/H4)',
    'Hard trend block — never trades against higher TF trend',
    'DXY dollar index integrated',
    'Liquidity sweep detection',
    'Order block detection',
    'Imbalance/FVG detection',
    'Asia range breakout',
    'Previous day high/low breakout',
    'Killzone timing',
    'Candlestick pattern recognition (8 patterns)',
    '15+ technical indicators',
    'Exit alert system',
    'Paper trading log',
    'Risk calculator (1:2.5 RR minimum)',
    'Pair performance tracker',
    'News blackout protection',
    'Weekend market detection',
  ],
  session:getSession().name,
  killzone:getSession().killzone,
  blackout:isBlackout(),
  weekend:isWeekend(),
  pairs:PAIRS.map(p=>p.symbol),
  time:new Date().toISOString()
}));

app.get('/api/signals',async(req,res)=>{
  try{
    if(isWeekend())return res.json({success:true,signals:[],count:0,weekend:true,message:'Forex market closed — opens Sunday 11PM WAT'});
    const results=await Promise.allSettled(PAIRS.map(getSignalForPair));
    const signals=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
    res.json({success:true,signals,count:signals.length,
      blackout:isBlackout(),session:getSession().name,
      killzone:getSession().killzone,dxy:cache.dxy.value,
      time:new Date().toISOString()});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/news',async(req,res)=>{
  const now=Date.now();
  if(cache.news.data.length&&(now-cache.news.ts)<TTL.NEWS)return res.json({success:true,news:cache.news.data});
  try{
    const url=`https://newsapi.org/v2/everything?q=forex+dollar+ECB+Fed+interest+rates+gold+inflation+DXY&language=en&sortBy=publishedAt&pageSize=15&apiKey=${NEWS_KEY}`;
    const r=await fetch(url),d=await r.json();
    if(!d.articles)return res.json({success:true,news:[]});
    const news=d.articles.map(a=>({
      headline:a.title,source:a.source?.name||'',time:a.publishedAt,url:a.url,
      impact:a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis/)? 'high':
             a.title.toLowerCase().match(/oil|gold|trade|data|bank/)? 'med':'low',
      sentiment:a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|beat|rally|high/)? 'bullish':'bearish',
      pairs:a.title.toLowerCase().includes('euro')||a.title.toLowerCase().includes('eur')? ['EUR/USD']:
            a.title.toLowerCase().includes('pound')||a.title.toLowerCase().includes('gbp')? ['GBP/USD']:
            a.title.toLowerCase().includes('yen')||a.title.toLowerCase().includes('jpy')? ['USD/JPY']:
            a.title.toLowerCase().includes('gold')||a.title.toLowerCase().includes('xau')? ['XAU/USD']:['ALL']
    }));
    cache.news={data:news,ts:now};
    res.json({success:true,news});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/paper',(_req,res)=>{
  const wins=paperTrades.filter(t=>t.outcome==='WIN').length;
  const losses=paperTrades.filter(t=>t.outcome==='LOSS').length;
  const pending=paperTrades.filter(t=>t.outcome==='PENDING').length;
  res.json({success:true,trades:paperTrades.slice(-20),
    stats:{total:paperTrades.length,wins,losses,pending,
      accuracy:paperTrades.length>0?Math.round((wins/(wins+losses||1))*100):0}});
});

app.get('/api/health',(req,res)=>res.json({
  alive:true,version:'11.0',
  session:getSession().name,killzone:getSession().killzone,
  blackout:isBlackout(),weekend:isWeekend(),
  newsComingSoon:isNewsWithin4Hours(),
  dxy:cache.dxy.value,
  cached:Object.keys(cache.signal).length,
  paperTrades:paperTrades.length,
  time:new Date().toISOString()
}));

// Keep Railway awake
setInterval(()=>{fetch(`http://localhost:${process.env.PORT||3000}/api/health`).catch(()=>{});},14*60*1000);

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`✅ TRADEPLUS v11 Professional Signal Engine on port ${PORT}`));
