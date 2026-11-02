import { useCallback, useEffect, useRef, useState } from 'react'
import { applyOps, differences, sharedState } from '../shared/sync.js'
export async function familyAPI(path, body) {
  const response = await fetch(`/api/family${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json().catch(() => ({ error: 'The family server is unavailable.' }))
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: response.status, data })
  return data
}
export default function useHousehold(loadState, localKey) {
  const [state, renderState] = useState(loadState), [account, setAccount] = useState(null), [status, setStatus] = useState('Checking family connection…'), [available, setAvailable] = useState(false), [pendingCount, setPendingCount] = useState(0), [conflict, setConflict] = useState(null), [needsLogin, setNeedsLogin] = useState(false)
  const current = useRef(state), context = useRef(null), queue = useRef([]), running = useRef(false), paused = useRef(false), flushRef = useRef(null)
  const storePending = () => { if (context.current) localStorage.setItem(context.current.cacheKey, JSON.stringify(queue.current)); setPendingCount(queue.current.length) }
  const display = value => { current.current = value; renderState(value) }
  const privateSettings = () => { try { return JSON.parse(localStorage.getItem('hog-device-settings-v1') || '{}') } catch { return {} } }
  const showRemote = (remote, info = account) => { let next = remote; for (const change of queue.current) next = applyOps(next, change.ops); display({ ...loadState(), ...privateSettings(), ...next, _sharedAI: !!info?.ai?.configured, _cloud: true }) }
  const refresh = useCallback(async () => {
    try {
      const health = await fetch('/api/health'); if (!health.ok || !(await health.json()).ok) throw new Error('Unavailable')
      setAvailable(true)
      let info
      try { info = await familyAPI('') } catch (e) { if (e.status !== 401) throw e; info = null }
      setAccount(info); setNeedsLogin(false)
      if (info?.household) {
        const cacheKey = `hog-family-pending-${info.user.id}-${info.household.id}`
        if (context.current?.cacheKey !== cacheKey) { try { queue.current = JSON.parse(localStorage.getItem(cacheKey) || '[]') } catch { queue.current = [] } }
        context.current = { cacheKey, householdId: info.household.id }; paused.current = false; setConflict(null)
        showRemote(info.household.state, info); storePending(); setStatus(queue.current.length ? 'Waiting to sync…' : 'Family is up to date'); setTimeout(() => flushRef.current?.(), 0)
      } else { context.current = null; queue.current = []; display(loadState()); setPendingCount(0); setStatus(info ? 'Create or join your household' : 'Device only · sign in to sync') }
      return info
    } catch { setStatus('Device only · family connection unavailable'); return null }
  }, [])
  useEffect(() => { let active = true; fetch('/api/health').then(r => r.ok ? r.json() : null).then(data => { if (active && data?.ok) refresh(); else if (active) setStatus('Device only') }).catch(() => active && setStatus('Device only')); return () => { active = false } }, [refresh])
  async function flush() {
    if (running.current || paused.current || !context.current || !queue.current.length) return
    running.current = true
    const captured = context.current
    try {
      while (queue.current.length && context.current === captured) {
        setStatus('Saving family changes…')
        const next = await familyAPI('/state', queue.current[0])
        if (context.current !== captured) break
        queue.current.shift(); storePending(); showRemote(next.state, next.ai ? { ...account, ai: next.ai } : account)
      }
      setStatus('Family is up to date')
    } catch (error) {
      if (error.status === 409) { paused.current = true; setConflict(error.data.latest); setStatus('Review a change made on another device') }
      else if (error.status === 401 || error.status === 403) { paused.current = true; setNeedsLogin(true); setStatus('Sign in again to continue syncing') }
      else setStatus(`Saved on this device · waiting to sync${error.status === 400 ? ': '+error.message : ''}`)
    } finally { running.current = false }
  }
  flushRef.current = flush
  useEffect(() => {
    const check = async () => {
      if (!context.current || document.hidden || running.current || paused.current) return
      if (queue.current.length) return flushRef.current()
      const captured = context.current
      try { const next = await familyAPI('/state'); if (context.current === captured && !queue.current.length) { if (next.ai && next.ai.configured !== account?.ai?.configured) setAccount(a => a ? { ...a, ai: next.ai } : a); showRemote(next.state, next.ai ? { ...account, ai: next.ai } : account); setStatus('Family is up to date') } } catch (e) { if (e.status === 401 || e.status === 403) { paused.current = true; setNeedsLogin(true) } setStatus(e.status === 401 || e.status === 403 ? 'Sign in again to continue syncing' : 'Offline · will reconnect') }
    }
    const timer = setInterval(check, 8000); window.addEventListener('online', check); window.addEventListener('focus', check)
    return () => { clearInterval(timer); window.removeEventListener('online', check); window.removeEventListener('focus', check) }
  }, [account])
  const setState = useCallback(updater => {
    const before = current.current, after = typeof updater === 'function' ? updater(before) : updater
    display(after)
    if (context.current) {
      localStorage.setItem('hog-device-settings-v1', JSON.stringify({ apiKey: after.apiKey || '', bank: after.bank || {} }))
      const ops = differences(sharedState(before), sharedState(after))
      if (ops.length) { queue.current.push({ id: crypto.randomUUID(), ops }); storePending(); setTimeout(() => flushRef.current?.(), 0) }
    } else localStorage.setItem(localKey, JSON.stringify(after))
  }, [])
  function resolveConflict(keepMine) {
    if (!conflict) return
    const desired = keepMine ? queue.current.reduce((s, m) => applyOps(s, m.ops), conflict.state) : conflict.state
    queue.current = keepMine ? [{ id: crypto.randomUUID(), ops: differences(conflict.state, desired) }] : []
    paused.current = false; setConflict(null); storePending(); showRemote(conflict.state); setStatus('Family is up to date'); flushRef.current()
  }
  return { state, setState, account, status, available, pendingCount, conflict, needsLogin, refresh, resolveConflict, loadDevice: loadState }
}
