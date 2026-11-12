const CACHE_NAME = 'gyening-family-hub-v1'

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(['./', './manifest.webmanifest', './icon.svg'])).catch(() => {})
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.includes('/api/')) return

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {})
        }
        return response
      })
      .catch(() => caches.match(request).then(cached => cached || caches.match('./')))
  )
})

self.addEventListener('push', event => {
 const data=event.data?.json()||{}
 event.waitUntil(self.registration.showNotification(data.title||'Family Hub reminder',{body:data.body||'You have an upcoming event',icon:'/icon.svg',badge:'/icon.svg',data:{url:data.url||'/'}}))
})
self.addEventListener('notificationclick',event=>{
 event.notification.close()
 event.waitUntil(clients.openWindow(event.notification.data?.url||'/'))
})
