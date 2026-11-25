// Service Worker:接收瀏覽器推播並顯示通知(不快取任何內容)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { /* ignore */ }
  event.waitUntil(self.registration.showNotification(d.title || '北護校園二手書', {
    body: d.body || '你有新訊息',
    tag: d.tag || 'chat',        // 同一串聊聊的通知會合併,不會洗版
    renotify: true,
    icon: 'icon-192.png',
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
