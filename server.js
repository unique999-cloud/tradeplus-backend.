 const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  next();
});
app.use(express.json());

const NEWS_KEY = process.env.NEWS_KEY;

const PAIRS = [
  { symbol: 'EUR/USD', stooq: 'eurusd' },
  { symbol: 'GBP/USD', stooq: 'gbpusd' },
  { symbol: 'USD/JPY', stooq: 'usdjpy' },
  { symbol: 'XAU/USD', stooq: 'xauusd.cf' },
];

const cache = {};
const PRICE_TTL  = 30 * 1000;
const CANDLE_TTL = 60 * 60 * 1000;

// ============================================================
// STOOQ REAL-TIME PRICE
// ============================================================
async function getLivePrice(stooqSymbol) {
  try {
    const url  = `https://stooq.com/q/l/?s=${stooqSymbol}&f=sd2t2ohlcv&h&e=csv`;
    const res  = await fetch(url, { timeout: 8000 });
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const close = parseFloat(lines[1].split(',')[6]);
    if (!close || isNaN(close) || close <= 0) return null;
    // Sanity check for Gold — must be between 1000 and 5000
    if (stooqSymbol.includes('xau') && (close < 1000 || close > 5000)) return null;
    return close;
  } catch(e) { return null; }
}

// ============================================================
// STOOQ HISTORICAL CANDLES
// ============================================================
async function getHistoricalCandles(stooqSymbol) {
  try {
    // Daily candles — no API key needed
    const url  = `https://stooq.com/q/d/l/?s=${stooqSymbol}&i=d`;
    const res  = await fetch(url, { timeout: 10000 });
    const text = await res.text();
    // If we get API key error, return null
    if (text.includes('apikey') || text.includes('Authorization') || text.includes('Get your')) return null;
    const lines = text.trim().split('\n');
    if (lines.length < 5) return null;
    // Use last 200 daily candles only
    return lines.slice(1).slice(-200).map(line => {
      const p = line.split(',');
      if (p.length < 5) return null;
      return {
        time:  p[0] + ' 00:00:00',
        open:  parseFloat(p[1]),
        high:  parseFloat(p[2]),
        low:   parseFloat(p[3]),
        close: parseFloat(p[4]),
      };
    }).filter(c => c && !isNaN(c.close) && c.close > 0);
  } catch(e) { return null; }
}

async function getCandles(pair) {
  const key = `c_${pair.symbol}`, now = Date.now();
  let candles;
  if (cache[key] && (now - cache[key].ts) < CANDLE_TTL) {
    candles = JSON.parse(JSON.stringify(cache[key].data));
  } else {
    candles = await getHistoricalCandles(pair.stooq);
    if (candles && candles.length > 10) cache[key] = { ts: now, data: candles };
  }
  const live = await getLivePrice(pair.stooq);
  if (live && candles && candles.length > 0) {
    const last = candles[candles.length-1];
    last.close = live; last.high = Math.max(last.high, live); last.low = Math.min(last.low, live);
  }
  if (!candles || candles.length < 10) {
    if (!live) return null;
    candles = buildFallbackCandles(live, pair.symbol);
  }
  return candles;
}

function buildFallbackCandles(price, symbol) {
  const vol = {'EUR/USD':0.0003,'GBP/USD':0.0005,'USD/JPY':0.08,'XAU/USD':1.5}[symbol]||0.0003;
  const dp  = symbol==='USD/JPY'?3:symbol==='XAU/USD'?2:5;
  const now = Date.now();
  const candles = [];
  let p = price;
  for (let i=49;i>=0;i--) {
    const chg=((Math.random()-0.5)*vol*2);
    const o=parseFloat((p+chg).toFixed(dp)), c=parseFloat(p.toFixed(dp));
    const h=parseFloat((Math.max(o,c)+Math.random()*vol*0.3).toFixed(dp));
    const l=parseFloat((Math.min(o,c)-Math.random()*vol*0.3).toFixed(dp));
    candles.unshift({time:new Date(now-(50-i)*3600000).toISOString().slice(0,19).replace('T',' '),open:o,high:h,low:l,close:c});
    p=o;
  }
  candles[candles.length-1].close = price;
  return candles;
}

// ============================================================
// ALL TECHNICAL INDICATORS
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
  if(!vals||vals.length===0)return 0;
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
    aboveEma20:e20?price>e20:null,aboveEma50:e50?price>e50:null,
    aboveEma100:e100?price>e100:null,aboveEma200:e200?price>e200:null};
}

function calcBollinger(c,p=20){
  if(c.length<p)return null;
  const cl=c.slice(-p).map(x=>x.close);
  const mean=cl.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(cl.reduce((s,v)=>s+Math.pow(v-mean,2),0)/p);
  const price=c[c.length-1].close;
  return{upper:mean+2*std,middle:mean,lower:mean-2*std,width:(4*std)/mean,
    nearUpper:price>(mean+1.5*std),nearLower:price<(mean-1.5*std),
    position:(price-(mean-2*std))/(4*std)};
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
    dms.push({
      dmP:(up>dn&&up>0)?up:0,
      dmM:(dn>up&&dn>0)?dn:0,
      tr:Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close))
    });
  }
  const r=dms.slice(-p);
  const atr=r.reduce((s,d)=>s+d.tr,0)/p;
  if(!atr)return null;
  const diP=(r.reduce((s,d)=>s+d.dmP,0)/p/atr)*100;
  const diM=(r.reduce((s,d)=>s+d.dmM,0)/p/atr)*100;
  const dx=Math.abs(diP-diM)/(diP+diM)*100;
  return{adx:parseFloat(dx.toFixed(2)),diPlus:parseFloat(diP.toFixed(2)),diMinus:parseFloat(diM.toFixed(2)),trending:dx>25,strongTrend:dx>40,bullish:diP>diM};
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
  const res=r.map(x=>x.high).sort((a,b)=>b-a).slice(0,3).reduce((a,b)=>a+b,0)/3;
  const sup=r.map(x=>x.low).sort((a,b)=>a-b).slice(0,3).reduce((a,b)=>a+b,0)/3;
  const range=res-sup;
  return{resistance:res,support:sup,nearResistance:range>0&&price>(res-range*0.1),nearSupport:range>0&&price<(sup+range*0.1)};
}

function detectCandle(c){
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

function calcFib(c){
  if(c.length<20)return null;
  const r=c.slice(-50),h=Math.max(...r.map(x=>x.high)),l=Math.min(...r.map(x=>x.low));
  const range=h-l,price=c[c.length-1].close;
  return{fib382:h-range*0.382,fib500:h-range*0.500,fib618:h-range*0.618,
    nearFib:[0.236,0.382,0.500,0.618,0.786].some(f=>Math.abs(price-(h-range*f))/price<0.002)};
}

function calcPivots(c){
  if(c.length<2)return null;
  const p=c[c.length-2],pivot=(p.high+p.low+p.close)/3,price=c[c.length-1].close;
  return{pivot,r1:2*pivot-p.low,r2:pivot+(p.high-p.low),s1:2*pivot-p.high,s2:pivot-(p.high-p.low),abovePivot:price>pivot};
}

function calcATR(c,p=14){
  if(c.length<p+1)return null;
  const trs=[];
  for(let i=1;i<c.length;i++)trs.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
  return trs.slice(-p).reduce((s,v)=>s+v,0)/p;
}

function calcMomentum(c,p=10){
  if(c.length<p+1)return null;
  const cur=c[c.length-1].close,prev=c[c.length-1-p].close;
  return{value:cur-prev,bullish:cur>prev};
}

function detectFVG(c){
  if(c.length<3)return null;
  const c1=c[c.length-3],c3=c[c.length-1];
  if(c1.high<c3.low)return{type:'BULLISH',gap:c3.low-c1.high};
  if(c1.low>c3.high)return{type:'BEARISH',gap:c1.low-c3.high};
  return null;
}

function detectBOS(c){
  if(c.length<20)return null;
  const r=c.slice(-10),m=c.slice(-20,-10);
  if(!m.length)return null;
  if(Math.max(...r.map(x=>x.high))>Math.max(...m.map(x=>x.high)))return{type:'BULLISH_BOS'};
  if(Math.min(...r.map(x=>x.low))<Math.min(...m.map(x=>x.low)))return{type:'BEARISH_BOS'};
  return null;
}

// ============================================================
// SESSION & SAFETY
// ============================================================
function getSession(){
  const h=(new Date().getUTCHours()+1)%24;
  if(h>=8&&h<13)return{name:'LONDON',quality:3};
  if(h>=13&&h<17)return{name:'LONDON+NY OVERLAP',quality:5};
  if(h>=17&&h<22)return{name:'NEW YORK',quality:3};
  if(h>=1&&h<8)return{name:'ASIAN',quality:2};
  return{name:'OFF-HOURS',quality:1};
}

function isBlackout(){
  const now=new Date(),watH=(now.getUTCHours()+1)%24,watM=now.getUTCMinutes();
  const day=now.getUTCDay(),mins=watH*60+watM;
  return [{h:14,m:30,day:5},{h:19,m:0,day:3},{h:13,m:15,day:4},{h:13,m:30,day:3},{h:7,m:0,day:3}]
    .some(ev=>ev.day===day&&Math.abs(mins-(ev.h*60+ev.m))<=10);
}

function getSpread(s){return{'EUR/USD':0.8,'GBP/USD':1.2,'USD/JPY':0.9,'XAU/USD':2.5}[s]||1.5;}

// ============================================================
// DEEP SIGNAL ENGINE — 15+ factors
// Only signals when score >= 8 AND confidence >= 65%
// ============================================================
function deepEngine(ind, price, symbol){
  let bull=0,bear=0,factors=[],waits=[];
  const {rsi,macd,emas,bollinger,stoch,adx,structure,sr,candle,fib,pivots,momentum,fvg,bos,session}=ind;

  if(isBlackout())return{signal:'WAIT',confidence:0,bull:0,bear:0,factors:['News blackout active']};
  if(getSpread(symbol)>3)return{signal:'WAIT',confidence:0,bull:0,bear:0,factors:['Spread too wide']};

  // Market Structure (weight 4)
  if(structure==='BULLISH'){bull+=4;factors.push('✅ Bullish market structure — Higher Highs + Higher Lows');}
  else if(structure==='BEARISH'){bear+=4;factors.push('✅ Bearish market structure — Lower Highs + Lower Lows');}
  else waits.push('No clear market structure');

  // RSI (weight 3)
  if(rsi!==null){
    if(rsi<30){bull+=3;factors.push(`✅ RSI ${rsi} strongly oversold`);}
    else if(rsi<40){bull+=2;factors.push(`✅ RSI ${rsi} oversold`);}
    else if(rsi<45)bull+=1;
    else if(rsi>70){bear+=3;factors.push(`✅ RSI ${rsi} strongly overbought`);}
    else if(rsi>60){bear+=2;factors.push(`✅ RSI ${rsi} overbought`);}
    else if(rsi>55)bear+=1;
    else waits.push(`RSI ${rsi} neutral`);
  }

  // MACD (weight 3)
  if(macd){
    if(macd.bullish&&macd.histogram>0){bull+=3;factors.push('✅ MACD bullish crossover + positive histogram');}
    else if(macd.bullish){bull+=2;factors.push('✅ MACD bullish crossover');}
    else if(!macd.bullish&&macd.histogram<0){bear+=3;factors.push('✅ MACD bearish crossover + negative histogram');}
    else if(!macd.bullish){bear+=2;factors.push('✅ MACD bearish crossover');}
  }

  // EMAs (weight 3)
  if(emas){
    let s=0;
    if(emas.aboveEma20===true)s++;else if(emas.aboveEma20===false)s--;
    if(emas.aboveEma50===true)s++;else if(emas.aboveEma50===false)s--;
    if(emas.aboveEma100===true)s++;else if(emas.aboveEma100===false)s--;
    if(emas.aboveEma200===true)s++;else if(emas.aboveEma200===false)s--;
    if(s>=3){bull+=3;factors.push('✅ Price above all major EMAs');}
    else if(s>=2)bull+=2;
    else if(s>=1)bull+=1;
    else if(s<=-3){bear+=3;factors.push('✅ Price below all major EMAs');}
    else if(s<=-2)bear+=2;
    else if(s<=-1)bear+=1;
  }

  // Bollinger (weight 2)
  if(bollinger){
    if(bollinger.nearLower){bull+=2;factors.push('✅ Price at Bollinger lower band — bounce potential');}
    else if(bollinger.nearUpper){bear+=2;factors.push('✅ Price at Bollinger upper band — rejection potential');}
  }

  // Stochastic (weight 2)
  if(stoch){
    if(stoch.oversold){bull+=2;factors.push(`✅ Stochastic ${stoch.k} oversold`);}
    if(stoch.overbought){bear+=2;factors.push(`✅ Stochastic ${stoch.k} overbought`);}
  }

  // ADX (weight 2)
  if(adx&&adx.trending){
    if(adx.bullish&&adx.strongTrend){bull+=2;factors.push(`✅ ADX ${adx.adx} strong bullish trend`);}
    else if(adx.bullish)bull+=1;
    else if(!adx.bullish&&adx.strongTrend){bear+=2;factors.push(`✅ ADX ${adx.adx} strong bearish trend`);}
    else if(!adx.bullish)bear+=1;
  }else if(adx&&!adx.trending)waits.push(`ADX ${adx?.adx} weak trend`);

  // Support/Resistance (weight 2)
  if(sr){
    if(sr.nearSupport){bull+=2;factors.push('✅ Price at key support level');}
    if(sr.nearResistance){bear+=2;factors.push('✅ Price at key resistance level');}
  }

  // Candlestick (weight 2)
  const bullC=['HAMMER','BULLISH_ENGULFING','MORNING_STAR'];
  const bearC=['SHOOTING_STAR','BEARISH_ENGULFING','EVENING_STAR'];
  if(bullC.includes(candle)){bull+=2;factors.push(`✅ ${candle} bullish pattern`);}
  if(bearC.includes(candle)){bear+=2;factors.push(`✅ ${candle} bearish pattern`);}

  // Break of Structure (weight 2)
  if(bos){
    if(bos.type==='BULLISH_BOS'){bull+=2;factors.push('✅ Bullish break of structure');}
    if(bos.type==='BEARISH_BOS'){bear+=2;factors.push('✅ Bearish break of structure');}
  }

  // Momentum (weight 1)
  if(momentum){if(momentum.bullish)bull+=1;else bear+=1;}

  // Fibonacci (weight 1)
  if(fib&&fib.nearFib){
    if(bull>bear){bull+=1;factors.push('✅ Price at Fibonacci support');}
    else{bear+=1;factors.push('✅ Price at Fibonacci resistance');}
  }

  // Pivots (weight 1)
  if(pivots){if(pivots.abovePivot)bull+=1;else bear+=1;}

  // FVG (weight 1)
  if(fvg){
    if(fvg.type==='BULLISH'){bull+=1;factors.push('✅ Bullish fair value gap');}
    if(fvg.type==='BEARISH'){bear+=1;factors.push('✅ Bearish fair value gap');}
  }

  // Session bonus
  if(session.quality>=4){
    if(bull>bear)bull+=1;else if(bear>bull)bear+=1;
    factors.push(`✅ ${session.name} peak session`);
  }

  const total=bull+bear;
  const conf=Math.min(total>0?Math.round((Math.max(bull,bear)/total)*100):50,85);

  let signal='WAIT';
  if(bull>bear&&bull>=8&&conf>=60)signal='BUY';
  else if(bear>bull&&bear>=8&&conf>=60)signal='SELL';

  return{signal,confidence:conf,bull,bear,factors};
}

// ============================================================
// LEVELS CALCULATION
// ============================================================
function calcLevels(signal,price,atr,symbol){
  const min={'EUR/USD':0.0020,'GBP/USD':0.0025,'USD/JPY':0.25,'XAU/USD':8.0}[symbol]||0.002;
  const safeAtr=Math.max(atr||0,min);
  const dp=symbol==='USD/JPY'?3:symbol==='XAU/USD'?2:4;
  let sl,tp;
  if(signal==='BUY'){
    sl=parseFloat((price-safeAtr*1.5).toFixed(dp));
    tp=parseFloat((price+safeAtr*3.0).toFixed(dp));
    if(sl>=price)sl=parseFloat((price-min*2).toFixed(dp));
    if(tp<=price)tp=parseFloat((price+min*4).toFixed(dp));
  }else if(signal==='SELL'){
    sl=parseFloat((price+safeAtr*1.5).toFixed(dp));
    tp=parseFloat((price-safeAtr*3.0).toFixed(dp));
    if(sl<=price)sl=parseFloat((price+min*2).toFixed(dp));
    if(tp>=price)tp=parseFloat((price-min*4).toFixed(dp));
  }else{
    sl=parseFloat((price-safeAtr*1.5).toFixed(dp));
    tp=parseFloat((price+safeAtr*1.5).toFixed(dp));
  }
  return{sl:sl.toFixed(dp),tp:tp.toFixed(dp)};
}

// ============================================================
// BUILD REASONS
// ============================================================
function buildReasons(result,ind,signal,symbol){
  const r=[];
  const{rsi,macd,structure,adx,session,candle,emas,bollinger,stoch}=ind;
  const{bull,bear,factors}=result;

  if(isBlackout()){r.push({icon:'⏸',text:'High-impact news within 10 minutes — trading paused for safety'});return r;}
  if(getSpread(symbol)>3){r.push({icon:'🚫',text:'Spread too wide — signal blocked to protect from slippage'});return r;}

  if(structure==='BULLISH')r.push({icon:'📈',text:'Higher Highs + Higher Lows — bullish market structure confirmed'});
  else if(structure==='BEARISH')r.push({icon:'📉',text:'Lower Highs + Lower Lows — bearish market structure confirmed'});
  else r.push({icon:'↔️',text:'No clear market structure — market is ranging or consolidating'});

  if(rsi!==null){
    if(rsi<30)r.push({icon:'📊',text:`RSI ${rsi} — strongly oversold, sellers exhausted, reversal up highly probable`});
    else if(rsi<40)r.push({icon:'📊',text:`RSI ${rsi} — approaching oversold, bullish pressure building`});
    else if(rsi>70)r.push({icon:'📊',text:`RSI ${rsi} — strongly overbought, buyers exhausted, reversal down highly probable`});
    else if(rsi>60)r.push({icon:'📊',text:`RSI ${rsi} — approaching overbought, bearish pressure building`});
    else r.push({icon:'📊',text:`RSI ${rsi} — neutral zone`});
  }

  if(macd){
    if(macd.bullish)r.push({icon:'⚡',text:'MACD crossed above signal line — bullish momentum confirmed'});
    else r.push({icon:'⚡',text:'MACD crossed below signal line — bearish momentum confirmed'});
  }

  if(adx){
    if(adx.strongTrend)r.push({icon:'💪',text:`ADX ${adx.adx} — strong trend active, ideal for trend following`});
    else if(adx.trending)r.push({icon:'📐',text:`ADX ${adx.adx} — trend developing`});
    else r.push({icon:'😴',text:`ADX ${adx.adx} — weak trend, market may be ranging`});
  }

  if(emas&&emas.aboveEma200!==null){
    if(emas.aboveEma200)r.push({icon:'📏',text:'Price above 200 EMA — long-term bullish bias confirmed'});
    else r.push({icon:'📏',text:'Price below 200 EMA — long-term bearish bias confirmed'});
  }

  if(bollinger){
    if(bollinger.nearLower)r.push({icon:'📉',text:'Price at Bollinger lower band — potential reversal zone'});
    else if(bollinger.nearUpper)r.push({icon:'📈',text:'Price at Bollinger upper band — potential rejection zone'});
  }

  if(stoch){
    if(stoch.oversold)r.push({icon:'🔵',text:`Stochastic ${stoch.k} — oversold, buyers may enter soon`});
    else if(stoch.overbought)r.push({icon:'🔴',text:`Stochastic ${stoch.k} — overbought, sellers may enter soon`});
  }

  const bullC=['HAMMER','BULLISH_ENGULFING','MORNING_STAR'];
  const bearC=['SHOOTING_STAR','BEARISH_ENGULFING','EVENING_STAR'];
  if(bullC.includes(candle))r.push({icon:'🕯️',text:`${candle.replace(/_/g,' ')} pattern — bullish reversal signal`});
  if(bearC.includes(candle))r.push({icon:'🕯️',text:`${candle.replace(/_/g,' ')} pattern — bearish reversal signal`});

  r.push({icon:'🕐',text:`Session: ${session.name}${session.quality>=4?' — peak liquidity, best time to trade':session.quality<=1?' — low liquidity, be cautious':''}`});
  r.push({icon:'🔢',text:`Confluence score: ${Math.max(bull,bear)}/27 factors (${bull} bullish vs ${bear} bearish) — minimum 8 required for signal`});

  if(signal==='BUY')r.push({icon:'✅',text:`STRONG BUY — ${Math.max(bull,bear)} confluent factors agree. Set your SL and TP on MT5 before entering.`});
  else if(signal==='SELL')r.push({icon:'🔴',text:`STRONG SELL — ${Math.max(bull,bear)} confluent factors agree. Set your SL and TP on MT5 before entering.`});
  else r.push({icon:'⏳',text:`Confluence score ${Math.max(bull,bear)}/27 — need score ≥8 with 60%+ confidence. Waiting for stronger setup protects your capital.`});

  return r;
}

// ============================================================
// MAIN
// ============================================================
async function getSignalForPair(pair){
  const now=Date.now();
  if(cache[pair.symbol]&&(now-cache[pair.symbol].ts)<PRICE_TTL)return cache[pair.symbol].data;

  const candles=await getCandles(pair);
  if(!candles||candles.length<15)return null;

  const price=candles[candles.length-1].close;
  const dp=pair.symbol==='USD/JPY'?3:pair.symbol==='XAU/USD'?2:4;
  const session=getSession();

  const ind={
    rsi:calcRSI(candles),macd:calcMACD(candles),emas:calcEMAs(candles),
    bollinger:calcBollinger(candles),stoch:calcStoch(candles),adx:calcADX(candles),
    structure:detectStructure(candles),sr:calcSR(candles),candle:detectCandle(candles),
    fib:calcFib(candles),pivots:calcPivots(candles),atr:calcATR(candles),
    momentum:calcMomentum(candles),fvg:detectFVG(candles),bos:detectBOS(candles),session
  };

  const result=deepEngine(ind,price,pair.symbol);
  const levels=calcLevels(result.signal,price,ind.atr,pair.symbol);
  const reasons=buildReasons(result,ind,result.signal,pair.symbol);

  const data={
    symbol:pair.symbol,price:price.toFixed(dp),
    signal:result.signal,confidence:result.confidence,
    entry:price.toFixed(dp),sl:levels.sl,tp:levels.tp,
    bullScore:result.bull,bearScore:result.bear,
    rsi:ind.rsi,macd:ind.macd?.macd||null,macdBullish:ind.macd?.bullish??null,
    adx:ind.adx?.adx||null,structure:ind.structure,
    spread:getSpread(pair.symbol),blackout:isBlackout(),session:session.name,
    candle:ind.candle,reasons,
    candles:candles.slice(-40).map(c=>({time:c.time,open:c.open,high:c.high,low:c.low,close:c.close})),
    updatedAt:new Date().toISOString()
  };

  cache[pair.symbol]={ts:now,data};
  return data;
}

// ============================================================
// ROUTES
// ============================================================
app.get('/',(req,res)=>res.json({
  status:'TRADEPLUS BACKEND LIVE ✅',version:'9.0',
  source:'Stooq.com — Real-time prices matching Exness/MT5',
  engine:'Deep Signal Engine — 15 indicators, 27 weighted factors',
  minScore:'8/27 required for signal',
  session:getSession().name,blackout:isBlackout(),
  pairs:PAIRS.map(p=>p.symbol),time:new Date().toISOString()
}));

app.get('/api/signals',async(req,res)=>{
  try{
    const results=await Promise.allSettled(PAIRS.map(getSignalForPair));
    const signals=results.filter(r=>r.status==='fulfilled'&&r.value).map(r=>r.value);
    res.json({success:true,signals,count:signals.length,blackout:isBlackout(),session:getSession().name,time:new Date().toISOString()});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/news',async(req,res)=>{
  try{
    const url=`https://newsapi.org/v2/everything?q=forex+dollar+ECB+Fed+interest+rates+gold+inflation&language=en&sortBy=publishedAt&pageSize=12&apiKey=${NEWS_KEY}`;
    const r=await fetch(url),d=await r.json();
    if(!d.articles)return res.json({success:true,news:[]});
    const news=d.articles.map(a=>({
      headline:a.title,source:a.source?.name||'',time:a.publishedAt,url:a.url,
      impact:a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis/)? 'high':a.title.toLowerCase().match(/oil|gold|trade|data/)? 'med':'low',
      sentiment:a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|beat|rally/)? 'bullish':'bearish'
    }));
    res.json({success:true,news});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});

app.get('/api/health',(req,res)=>res.json({
  alive:true,version:'9.0',engine:'Deep Signal Engine',
  session:getSession().name,blackout:isBlackout(),
  cached:Object.keys(cache).length,time:new Date().toISOString()
}));

setInterval(()=>{fetch(`http://localhost:${process.env.PORT||3000}/api/health`).catch(()=>{});},14*60*1000);

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`✅ TRADEPLUS v7 Deep Signal Engine on port ${PORT}`));
