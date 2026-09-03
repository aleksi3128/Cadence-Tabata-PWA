/* ═══════════════════════════════════════
   SERVICE WORKER — offline shell
   Bump VERSION on every release: it names the caches, so a new value
   drops the old ones on activate.
   ═══════════════════════════════════════ */
'use strict';

const VERSION      = '20260903-ed4d192';
const SHELL_CACHE  = `tabata-shell-${VERSION}`;
const ASSET_CACHE  = `tabata-assets-${VERSION}`;
const FONT_CACHE   = `tabata-fonts-${VERSION}`;
const OWN_CACHES   = [SHELL_CACHE, ASSET_CACHE, FONT_CACHE];

// Everything the timer needs to boot and run a session with no network.
// The exercise catalogue is in — 128 kB, and without it the rest picker and
// the preview card have nothing to look up. Its media are deliberately out:
// 136 MB is far too much to precache, so each thumbnail and GIF is cached
// the first time it is shown.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './llms.txt',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './locales/fr.json',
  './locales/en.json',
  './sounds/countdown.wav',
  './sounds/go.wav',
  './sounds/work.wav',
  './sounds/rest.wav',
  './sounds/round_rest.wav',
  './sounds/complete.wav',
  './sounds/mark_30.wav',
  './sounds/mark_20.wav',
  './sounds/mark_10.wav',
  './exercise-db/catalog.json',
  './exercises/index.json',
  './icons/favicon.ico',
  './icons/icon-180x180.png',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll() is all-or-nothing; add individually so one missing optional
    // file can't fail the whole install.
    await Promise.all(SHELL.map(url => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('tabata-') && !OWN_CACHES.includes(n))
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // A shared ?w= link is just index.html with a query string — serve the
  // cached shell for any navigation and let the app read the URL itself.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstDoc(request));
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }

  // Anything else off-origin (Spotify, Nextcloud metrics) goes straight to
  // the network and is never stored.
  if (url.origin !== self.location.origin) return;

  // Immutable media: serve from cache, fall back to network, keep a copy.
  if (/\.(wav|mp3|png|jpe?g|gif|svg|webp|ico)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // Code, styles and data: instant from cache, refreshed in the background so
  // a deploy lands on the next visit without needing a VERSION bump.
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function networkFirstDoc(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put('./index.html', fresh.clone());
    return fresh;
  } catch (_) {
    return (await caches.match('./index.html')) ||
           (await caches.match('./')) ||
           new Response('Hors ligne', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    if (fresh.ok) (await caches.open(cacheName)).put(request, fresh.clone());
    return fresh;
  } catch (_) {
    return new Response('', { status: 504 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);

  const network = fetch(request).then(async res => {
    if (res.ok || res.type === 'opaque') {
      (await caches.open(cacheName)).put(request, res.clone());
    }
    return res;
  }).catch(() => null);

  return cached || (await network) || new Response('', { status: 504 });
}
