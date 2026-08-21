// Bumped whenever the caching strategy below changes. The app itself no longer
// needs a bump: HTML is network-first, so a new index.html reaches visitors on
// their next load instead of being pinned to whatever they saw first.
const CACHE = 'gbyrish-v3';
const PRECACHE = [
  '/',
  '/index.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(()=>{}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never touch the Helpish endpoint or any other request that is not a plain GET.
  // /api/helpish streams its reply, and cloning a stream into the cache both buffers
  // the whole response and rejects (the Cache API refuses non-GET requests), so the
  // handler has no business intercepting it at all.
  if(e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  const sameOrigin = url.origin === self.location.origin;

  // The entire app lives in index.html, so treating it as a cacheable asset means a
  // returning visitor is pinned to whichever build they happened to load first —
  // new features simply never arrive. Navigations and HTML go to the network first
  // and only fall back to the cache when the network is genuinely unavailable.
  const isDocument = e.request.mode === 'navigate'
    || e.request.destination === 'document'
    || (sameOrigin && /\/$|\.html$/.test(url.pathname));

  if(isDocument){
    e.respondWith(
      fetch(e.request).then(resp => {
        if(resp && resp.status === 200){
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
        }
        return resp;
      }).catch(() =>
        // Offline: serve the last good copy, falling back to the shell for any route.
        caches.match(e.request).then(hit => hit || caches.match('/index.html'))
      )
    );
    return;
  }

  // Cache-first for genuinely static same-origin and CDN assets
  if(sameOrigin || url.hostname.includes('gstatic.com') || url.hostname.includes('firebaseapp.com') || url.hostname.includes('googleapis.com')){
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(resp => {
          if(resp && resp.status === 200){
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone)).catch(()=>{});
          }
          return resp;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  }
});
