// SecurityAI service worker: shows phone notifications (push) and opens the
// gym page when one is tapped. It caches nothing, so the page is always
// the live one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = { title: 'SecurityAI', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'SecurityAI', {
    body: m.body || '', tag: m.tag || 'securityai', renotify: true, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { url: m.url || '/activity.html' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/activity.html', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (new URL(c.url).origin === self.location.origin && 'focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
