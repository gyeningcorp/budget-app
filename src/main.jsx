import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

if (
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  window.location &&
  /^https?:$/.test(window.location.protocol) &&
  !/jsdom/i.test(navigator.userAgent || '')
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
