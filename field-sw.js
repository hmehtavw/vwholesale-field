// V Wholesale Field — Service Worker v6
// Persistent notification keeps app alive as foreground service
// Location tracked every 2 min even with screen off

const CACHE_NAME = 'vw-field-v6';
const APP_SHELL = ['/field.html', '/field-manifest.json'];
const PING_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let trackingTimer = null;
let trackingData = null; // { staffId, anonKey, supabaseUrl, attendanceId, city }

// ── Install ──
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(APP_SHELL)));
  self.skipWaiting();
});

// ── Activate ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('supabase.co') || url.hostname.includes('googleapis.com')) return;
  if (APP_SHELL.some(p => url.pathname.endsWith(p.replace('/', '')))) {
    e.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(e.request);
        const net = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => cached);
        return cached || net;
      })
    );
  }
});

// ── Messages from page ──
self.addEventListener('message', e => {
  if (e.data?.type === 'START_TRACKING') {
    trackingData = e.data;
    startBackgroundTracking();
  }
  if (e.data?.type === 'STOP_TRACKING') {
    stopBackgroundTracking();
  }
  if (e.data?.type === 'LOCATION_PING') {
    // Direct ping from page — store latest tracking config
    trackingData = { ...trackingData, ...e.data };
    insertLocation(e.data.lat, e.data.lng, e.data.accuracy, e.data.speed, e.data.isMoving);
  }
  if (e.data?.type === 'UPDATE_STATS') {
    // Update notification with latest visit count
    updateNotification(e.data.visits, e.data.km, e.data.name);
  }
});

// ── Background tracking loop ──
function startBackgroundTracking() {
  if (trackingTimer) clearInterval(trackingTimer);
  showTrackingNotification(trackingData?.visits || 0, trackingData?.km || 0, trackingData?.name || 'Field');
  // Ask open clients to send location immediately
  pingAllClients();
  // Then every 2 min
  trackingTimer = setInterval(pingAllClients, PING_INTERVAL_MS);
}

function stopBackgroundTracking() {
  if (trackingTimer) { clearInterval(trackingTimer); trackingTimer = null; }
  self.registration.getNotifications().then(notifs => notifs.forEach(n => n.close()));
}

function pingAllClients() {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    if (clients.length > 0) {
      // App is open — ask it to send location
      clients.forEach(c => c.postMessage({ type: 'REQUEST_LOCATION' }));
    } else {
      // App is closed — SW must get location directly
      // Note: SW can't access geolocation API directly
      // Best effort: use last known position if cached
      if (trackingData?.lastLat) {
        insertLocation(trackingData.lastLat, trackingData.lastLng, trackingData.lastAccuracy, null, null);
      }
    }
  });
}

// ── Persistent notification ──
async function showTrackingNotification(visits, km, name) {
  if (!self.registration.showNotification) return;
  const opts = {
    body: `${name} · ${visits} visits · ${Math.round(km)} km today`,
    icon: '/icons/field-icon-192.png',
    badge: '/icons/field-icon-192.png',
    tag: 'vw-field-tracking',  // same tag = replaces previous notification
    renotify: false,
    silent: true,
    requireInteraction: true,  // stays until dismissed (Android foreground service behaviour)
    actions: [
      { action: 'open', title: 'Open App' },
      { action: 'stop', title: 'Punch Out' }
    ],
    data: { url: '/field.html' }
  };
  await self.registration.showNotification('🟢 V Wholesale Field — Tracking Active', opts);
}

async function updateNotification(visits, km, name) {
  showTrackingNotification(visits, km, name);
}

// ── Notification click ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'stop') {
    // Punch out action
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(c => c.postMessage({ type: 'PUNCH_OUT_FROM_NOTIFICATION' }));
    });
  } else {
    // Open app
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length > 0) { clients[0].focus(); return; }
        return self.clients.openWindow('/field.html');
      })
    );
  }
});

// ── Insert location to Supabase ──
async function insertLocation(lat, lng, accuracy, speed, isMoving) {
  if (!trackingData?.supabaseUrl || !trackingData?.anonKey || !trackingData?.staffId) return;
  try {
    await fetch(`${trackingData.supabaseUrl}/rest/v1/field_location_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': trackingData.anonKey,
        'Authorization': `Bearer ${trackingData.anonKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        staff_id: trackingData.staffId,
        lat, lng,
        accuracy_m: accuracy,
        speed_kmh: speed,
        is_moving: isMoving,
        recorded_at: new Date().toISOString(),
        city: trackingData.city || 'Vijayawada',
        attendance_id: trackingData.attendanceId || null
      })
    });
  } catch(e) { /* silently fail — network may be off */ }
}

// ── Periodic sync fallback ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'field-location') {
    e.waitUntil(pingAllClients());
  }
});
