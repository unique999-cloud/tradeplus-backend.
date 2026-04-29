const CACHE_NAME = 'tradeplus-v11';
const ASSETS = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Background push notifications
self.addEventListener('push', e => {
  const data = e.data?.json() || { title:'TradeP lus', body:'New signal available' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      data: { url: '/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({type:'window'}).then(list => {
      if (list.length > 0) { list[0].focus(); return; }
      clients.openWindow('/');
    })
  );
});

// Background sync — check signals every 5 minutes
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-signals') {
    e.waitUntil(checkSignalsInBackground());
  }
});

async function checkSignalsInBackground() {
  try {
    const r = await fetch('https://tradeplus-backend-production.up.railway.app/api/signals');
    const d = await r.json();
    if (!d.signals) return;
    const strongSignals = d.signals.filter(s =>
      s.phase === 'STRONG_BUY' || s.phase === 'STRONG_SELL'
    );
    for (const sig of strongSignals) {
      await self.registration.showNotification(`TradeP lus — ${sig.phase.replace(/_/g,' ')}`, {
        body: `${sig.symbol} | ${sig.confidence}% confidence\nEntry: ${sig.entry} | TP: ${sig.tp}`,
        vibrate: [300, 100, 300],
        requireInteraction: true,
      });
    }
  } catch(e) {}
}
