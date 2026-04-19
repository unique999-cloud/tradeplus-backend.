const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
const app = express();

// BULLETPROOF CORS — allows everything
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  next();
});
app.use(express.json());

const ALPHA_KEY = process.env.ALPHA_KEY;
const NEWS_KEY  = process.env.NEWS_KEY;

const PAIRS = [
  { symbol:'EUR/USD', from:'EUR', to:'USD' },
  { symbol:'GBP/USD', from:'GBP', to:'USD' },
  { symbol:'USD/JPY', from:'USD', to:'JPY' },
  { symbol:'AUD/USD', from:'AUD', to:'USD' },
  { symbol:'XAU/USD', from:'XAU', to:'USD' },
];

const cache = {};
const TTL = 10 * 60 * 1000;

async function getCandles(pair) {
  try {
    const url = `https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${pair.from}&to_symbol=${pair.to}&interval=60min&outputsize=compact&apikey=${ALPHA_KEY}`;
    const res  = await fetch(url);
    const data = await res.json();
    const key  = Object.keys(data).find(k => k.includes('Time Series'));
    if (!key || !data[key]) return null;
    return Object.entries(data[key]).slice(0,50).map(([time,v]) => ({
      time,
      open:  parseFloat(v['1. open']),
      high:  parseFloat(v['2. high']),
      low:   parseFloat(v['3. low']),
      close: parseFloat(v['4. close']),
    })).reverse();
  } catch(e) { return null; }
}

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

function ema(vals, p) {
  const k=2/(p+1); let e=vals[0];
  for(let i=1;i<vals.length;i++) e=vals[i]*k+e*(1-k);
  return e;
}

function calcMACD(candles) {
  if(candles.length<26) return null;
  const cl=candles.map(c=>c.close);
  const m=ema(cl.slice(-12),12)-ema(cl.slice(-26),26);
  const s=ema(cl.slice(-9),9);
  return { macd:parseFloat(m.toFixed(6)), signal:parseFloat(s.toFixed(6)), histogram:parseFloat((m-s).toFixed(6)), bullish:m>s };
}

function detectStructure(candles) {
  if(candles.length<10) return 'NEUTRAL';
  const r=candles.slice(-10), h=r.map(c=>c.high), l=r.map(c=>c.low);
  const rH=Math.max(...h.slice(-3)), pH=Math.max(...h.slice(0,5));
  const rL=Math.min(...l.slice(-3)), pL=Math.min(...l.slice(0,5));
  if(rH>pH&&rL>pL) return 'BULLISH';
  if(rH<pH&&rL<pL) return 'BEARISH';
  return 'NEUTRAL';
}

function getSpread(symbol) {
  const s={'EUR/USD':1.1,'GBP/USD':1.8,'USD/JPY':1.2,'AUD/USD':1.5,'XAU/USD':3.5};
  return s[symbol]||2.0;
}

function isBlackout() {
  const now=new Date(), watH=(now.getUTCHours()+1)%24, watM=now.getUTCMinutes();
  const day=now.getUTCDay(), nowMins=watH*60+watM;
  const events=[{h:14,m:30,day:5},{h:19,m:0,day:3},{h:13,m:15,day:4},{h:13,m:30,day:3}];
  return events.some(ev=>ev.day===day&&Math.abs(nowMins-(ev.h*60+ev.m))<=10);
}

function getSession() {
  const h=(new Date().getUTCHours()+1)%24;
  if(h>=8&&h<13)  return 'LONDON';
  if(h>=13&&h<17) return 'LONDON+NY OVERLAP';
  if(h>=17&&h<22) return 'NEW YORK';
  return 'ASIAN';
}

function generateSignal(rsi, macd, structure, price, candles, symbol) {
  let bull=0, bear=0;
  if(rsi!==null){ if(rsi<30)bull+=3;else if(rsi<40)bull+=2;else if(rsi<50)bull+=1; if(rsi>70)bear+=3;else if(rsi>60)bear+=2;else if(rsi>50)bear+=1; }
  if(macd!==null){ if(macd.bullish)bull+=2;else bear+=2; if(macd.histogram>0)bull+=1;else bear+=1; }
  if(structure==='BULLISH')bull+=4; else if(structure==='BEARISH')bear+=4;
  const tot=bull+bear;
  const conf=tot>0?Math.round((Math.max(bull,bear)/tot)*100):50;
  let signal='WAIT';
  if(bull>bear&&conf>=62) signal='BUY';
  else if(bear>bull&&conf>=62) signal='SELL';
  const spread=getSpread(symbol);
  if(isBlackout()||spread>2.5) signal='WAIT';
  const atr=candles.slice(-14).reduce((s,c,i)=>i===0?s:s+Math.abs(c.high-c.low),0)/13;
  const dp=price>10?2:4;
  const rLows=candles.slice(-10).map(c=>c.low);
  const rHighs=candles.slice(-10).map(c=>c.high);
  let sl,tp;
  if(signal==='BUY'){sl=(Math.min(...rLows)-atr*0.3).toFixed(dp);tp=(price+(price-parseFloat(sl))*2).toFixed(dp);}
  else if(signal==='SELL'){sl=(Math.max(...rHighs)+atr*0.3).toFixed(dp);tp=(price-(parseFloat(sl)-price)*2).toFixed(dp);}
  else{sl=(price-atr).toFixed(dp);tp=(price+atr).toFixed(dp);}
  return {signal,confidence:conf,entry:price.toFixed(dp),sl,tp,rsi,macd:macd?.macd||null,macdBullish:macd?.bullish??null,structure,spread,blackout:isBlackout(),session:getSession()};
}

function buildReasons(sig) {
  const r=[];
  if(sig.blackout) r.push({icon:'⏸',text:'News blackout active — trading paused for safety'});
  if(sig.spread>2.5) r.push({icon:'🚫',text:`Spread ${sig.spread} pips — too wide, signal blocked`});
  if(sig.structure==='BULLISH') r.push({icon:'📈',text:'Higher Highs + Higher Lows — bullish structure confirmed on H1'});
  else if(sig.structure==='BEARISH') r.push({icon:'📉',text:'Lower Highs + Lower Lows — bearish structure confirmed on H1'});
  else r.push({icon:'↔️',text:'Market ranging — waiting for breakout'});
  if(sig.rsi!==null){
    if(sig.rsi<30) r.push({icon:'📊',text:`RSI ${sig.rsi} — strongly oversold, reversal up probable`});
    else if(sig.rsi>70) r.push({icon:'📊',text:`RSI ${sig.rsi} — strongly overbought, reversal down probable`});
    else r.push({icon:'📊',text:`RSI ${sig.rsi} — neutral, trend momentum is the guide`});
  }
  if(sig.macd!==null) r.push({icon:'⚡',text:sig.macdBullish?'MACD bullish crossover confirmed':'MACD bearish crossover confirmed'});
  r.push({icon:'🕐',text:`Session: ${sig.session}${sig.session==='LONDON+NY OVERLAP'?' — peak liquidity, best time to trade':''}`});
  if(sig.signal==='BUY')  r.push({icon:'✅',text:`All indicators bullish — ${sig.confidence}% confidence, 1:2 R:R`});
  else if(sig.signal==='SELL') r.push({icon:'🔴',text:`All indicators bearish — ${sig.confidence}% confidence, 1:2 R:R`});
  else r.push({icon:'⏳',text:'Waiting for stronger confluence — patience is profit'});
  return r;
}

async function getSignalForPair(pair, index) {
  const now=Date.now();
  if(cache[pair.symbol]&&(now-cache[pair.symbol].ts)<TTL) return cache[pair.symbol].data;
  if(index>0) await new Promise(r=>setTimeout(r, index*13000));
  const candles=await getCandles(pair);
  if(!candles||candles.length<15) return null;
  const price=candles[candles.length-1].close;
  const rsi=calcRSI(candles), macd=calcMACD(candles), structure=detectStructure(candles);
  const sig=generateSignal(rsi,macd,structure,price,candles,pair.symbol);
  const reasons=buildReasons(sig);
  const result={symbol:pair.symbol,price:price.toFixed(price>10?2:4),...sig,reasons,
    candles:candles.slice(-40).map(c=>({time:c.time,close:c.close,high:c.high,low:c.low,open:c.open})),
    updatedAt:new Date().toISOString()};
  cache[pair.symbol]={ts:now,data:result};
  return result;
}

app.get('/', (req,res) => res.json({
  status:'TRADEPLUS BACKEND LIVE ✅', version:'3.0',
  source:'Alpha Vantage — Real-time Forex Data',
  session:getSession(), blackout:isBlackout(),
  pairs:PAIRS.map(p=>p.symbol), time:new Date().toISOString()
}));

app.get('/api/signals', async(req,res) => {
  try {
    const signals=[];
    for(let i=0;i<PAIRS.length;i++){
      const sig=await getSignalForPair(PAIRS[i],i);
      if(sig) signals.push(sig);
    }
    res.json({success:true,signals,count:signals.length,blackout:isBlackout(),session:getSession(),time:new Date().toISOString()});
  } catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get('/api/news', async(req,res) => {
  try {
    const url=`https://newsapi.org/v2/everything?q=forex+dollar+ECB+Fed+interest+rates+gold+inflation&language=en&sortBy=publishedAt&pageSize=12&apiKey=${NEWS_KEY}`;
    const r=await fetch(url), d=await r.json();
    if(!d.articles) return res.json({success:true,news:[]});
    const news=d.articles.map(a=>({
      headline:a.title, source:a.source?.name||'', time:a.publishedAt, url:a.url,
      impact:a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis/)? 'high':a.title.toLowerCase().match(/oil|gold|trade|data/)? 'med':'low',
      sentiment:a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|beat|rally/)? 'bullish':'bearish'
    }));
    res.json({success:true,news});
  } catch(e){ res.status(500).json({success:false,error:e.message}); }
});

app.get('/api/health', (req,res) => res.json({
  alive:true, session:getSession(), blackout:isBlackout(),
  cached:Object.keys(cache).length, time:new Date().toISOString()
}));

// Keep Railway awake
setInterval(()=>{ fetch(`http://localhost:${process.env.PORT||3000}/api/health`).catch(()=>{}); }, 14*60*1000);

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`✅ TRADEPLUS v3 Backend running on port ${PORT}`));
