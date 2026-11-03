import express from 'express'
import { betterAuth } from 'better-auth'
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node'
import { getMigrations } from 'better-auth/db/migration'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerBilling } from './billing.js'
import { emptyShared, applyOps } from '../shared/sync.js'
const hash = value => createHash('sha256').update(value).digest('hex')
export async function createApp({ databasePath, baseURL, secret, production = false, aiFetch = fetch, billFetch = fetch }) {
  if (!secret || secret.length < 32) throw new Error('A stable AUTH_SECRET of at least 32 characters is required.')
  mkdirSync(dirname(databasePath), { recursive: true })
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
  const encryptionKey = createHash('sha256').update('family-ai-key-v1:' + secret).digest()
  const encryptKey = (key, household) => { const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',encryptionKey,iv); cipher.setAAD(Buffer.from(household)); const data=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]); return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64') }
  const decryptKey = (value, household) => { const blob=Buffer.from(value,'base64'), decipher=createDecipheriv('aes-256-gcm',encryptionKey,blob.subarray(0,12)); decipher.setAAD(Buffer.from(household)); decipher.setAuthTag(blob.subarray(12,28)); return Buffer.concat([decipher.update(blob.subarray(28)),decipher.final()]).toString('utf8') }
  const auth = betterAuth({ appName: 'House of Gyening', baseURL, secret, database: db, emailAndPassword: { enabled: true, minPasswordLength: 12 }, session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 }, trustedOrigins: [baseURL], advanced: { useSecureCookies: production, ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } }, rateLimit: { enabled: true, window: 60, max: 30, storage: 'database' } })
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  db.exec(`CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, household_id TEXT NOT NULL REFERENCES households(id), role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), token_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ai_settings (household_id TEXT PRIMARY KEY REFERENCES households(id), encrypted_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_usage (household_id TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(household_id,day));
    CREATE TABLE IF NOT EXISTS mutations (household_id TEXT NOT NULL, mutation_id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(household_id, mutation_id));`)
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer'); if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); next() })
  app.all('/api/auth/{*any}', toNodeHandler(auth))
  app.use('/api/family/billing/extract', express.json({ limit: '8mb' }))
  app.use(express.json({ limit: '2mb' }))
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'family-hub' }))
  const limits = new Map()
  app.use('/api/family', async (req, res, next) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method) && req.get('origin') !== new URL(baseURL).origin) return res.status(403).json({ error: 'Open the Family Hub to make changes.' })
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
      if (!session) return res.status(401).json({ error: 'Sign in to access your family.' })
      req.user = session.user
      const now = Date.now(), key = req.user.id, prior = limits.get(key)
      const count = prior && prior.until > now ? prior : { count: 0, until: now + 60000 }; count.count++; limits.set(key, count)
      if (limits.size > 10000) for (const [id, record] of limits) if (record.until < now) limits.delete(id)
      if (count.count > 180) return res.status(429).json({ error: 'Please wait a minute before trying again.' })
      req.member = db.prepare('SELECT * FROM members WHERE user_id=?').get(req.user.id)
      next()
    } catch (error) { next(error) }
  })
  const needFamily = (req, res, next) => req.member ? next() : res.status(403).json({ error: 'Create or join a household first.' })
  const needOwner = (req, res, next) => req.member?.role === 'owner' ? next() : res.status(403).json({ error: 'Only the household owner can do this.' })
  const snapshot = id => { const row = db.prepare('SELECT * FROM households WHERE id=?').get(id); return { id: row.id, name: row.name, state: JSON.parse(row.data), revision: row.revision, ai: { configured: !!db.prepare('SELECT 1 FROM ai_settings WHERE household_id=?').get(id), model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6' } } }
  app.get('/api/family', (req, res) => {
    if (!req.member) return res.json({ user: req.user, household: null })
    const family = snapshot(req.member.household_id)
    res.json({ user: req.user, household: { ...family, role: req.member.role }, ai: { configured: !!db.prepare('SELECT 1 FROM ai_settings WHERE household_id=?').get(family.id), model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6' }, members: db.prepare('SELECT u.id,u.name,u.email,m.role FROM members m JOIN user u ON u.id=m.user_id WHERE m.household_id=?').all(family.id), invites: req.member.role === 'owner' ? db.prepare('SELECT id,expires FROM invitations WHERE household_id=? AND used=0 AND expires>?').all(family.id, Date.now()) : [] })
  })
  app.post('/api/family/create', (req, res) => {
    if (req.member) return res.status(409).json({ error: 'You already belong to a household.' })
    const name = String(req.body.name || '').trim().slice(0, 100)
    if (!name) return res.status(400).json({ error: 'Enter a household name.' })
    const id = randomUUID()
    db.exec('BEGIN IMMEDIATE')
    try { db.prepare('INSERT INTO households(id,name,data) VALUES(?,?,?)').run(id, name, JSON.stringify(emptyShared())); db.prepare('INSERT INTO members VALUES(?,?,?)').run(req.user.id, id, 'owner'); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
    res.status(201).json({ ok: true })
  })
  app.post('/api/family/invite', needOwner, (req, res) => {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), expires = Date.now() + 7 * 86400000
    db.prepare('DELETE FROM invitations WHERE expires<? OR used=1').run(Date.now())
    db.prepare('INSERT INTO invitations VALUES(?,?,?,?,0)').run(id, req.member.household_id, hash(token), expires)
    res.json({ id, url: `${baseURL}/#invite=${token}`, expires })
  })
  app.post('/api/family/revoke-invite', needOwner, (req, res) => { db.prepare('DELETE FROM invitations WHERE id=? AND household_id=?').run(String(req.body.id), req.member.household_id); res.json({ ok: true }) })
  app.post('/api/family/join', (req, res) => {
    if (req.member) return res.status(409).json({ error: 'You already belong to a household.' })
    const invite = db.prepare('SELECT * FROM invitations WHERE token_hash=? AND used=0 AND expires>?').get(hash(String(req.body.token)), Date.now())
    if (!invite) return res.status(400).json({ error: 'This invitation expired or was already used. Ask for a new link.' })
    db.exec('BEGIN IMMEDIATE')
    try { const changed = db.prepare('UPDATE invitations SET used=1 WHERE id=? AND used=0').run(invite.id); if (!changed.changes) throw new Error('Invitation already used.'); db.prepare('INSERT INTO members VALUES(?,?,?)').run(req.user.id, invite.household_id, 'member'); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
    res.json({ ok: true })
  })
  app.post('/api/family/remove-member', needOwner, (req, res) => {
    if (req.body.userId === req.user.id) return res.status(400).json({ error: 'The owner cannot be removed.' })
    db.prepare("DELETE FROM members WHERE user_id=? AND household_id=? AND role='member'").run(String(req.body.userId), req.member.household_id); res.json({ ok: true })
  })
  app.post('/api/family/ai-key', needOwner, (req, res) => {
    const raw=String(req.body.key || '').trim().replace(/^Bearer\s+/i, '').trim(), hid=req.member.household_id
    if (!raw) db.prepare('DELETE FROM ai_settings WHERE household_id=?').run(hid)
    else { if (!raw.startsWith('sk-ant-') || raw.length<20 || raw.length>500 || /\s/.test(raw)) return res.status(400).json({error:'Enter a valid Claude subscription token (sk-ant-oat01-…) or Anthropic key (sk-ant-…).'}); db.prepare('INSERT INTO ai_settings VALUES(?,?) ON CONFLICT(household_id) DO UPDATE SET encrypted_key=excluded.encrypted_key').run(hid,encryptKey(raw,hid)) }
    res.json({configured:!!raw, subscription: raw.startsWith('sk-ant-oat')})
  })
  const ALLOWED_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022'])
  async function callClaude(hid, payload) {
    const setting=db.prepare('SELECT encrypted_key FROM ai_settings WHERE household_id=?').get(hid)
    if (!setting) throw Object.assign(new Error('Ask the household owner to connect your Claude subscription token or key in Family settings.'),{status:400})
    const day=new Date().toISOString().slice(0,10), usage=db.prepare('SELECT requests FROM ai_usage WHERE household_id=? AND day=?').get(hid,day)
    if ((usage?.requests || 0)>=100) throw Object.assign(new Error('Your household reached its 100-request daily AI limit. Try again tomorrow.'),{status:429})
    db.prepare('INSERT INTO ai_usage VALUES(?,?,1) ON CONFLICT(household_id,day) DO UPDATE SET requests=requests+1').run(hid,day)
    const token=decryptKey(setting.encrypted_key,hid)
    const isSub=token.startsWith('sk-ant-oat')
    const authHeaders=isSub
      ? {'authorization':`Bearer ${token}`,'anthropic-beta':'claude-code-20250219,oauth-2025-04-20','user-agent':'claude-cli/1.0.0 (external, cli)'}
      : {'x-api-key':token}
    const chosenModel=ALLOWED_MODELS.has(payload.model) ? payload.model : (process.env.CLAUDE_MODEL || 'claude-sonnet-4-6')
    const maxTokens=Math.min(Math.max(Number(payload.max_tokens)||1024,1),2048)
    const buildBody=(m,useSubSystem)=>{
      const sys=useSubSystem
        ? [{type:'text',text:"You are Claude Code, Anthropic's official CLI for Claude."},...(payload.system?[{type:'text',text:String(payload.system)}]:[])]
        : payload.system
      return JSON.stringify({...payload, ...(sys?{system:sys}:{}), model:m, max_tokens:maxTokens})
    }
    let upstream=await aiFetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','anthropic-version':'2023-06-01',...authHeaders},body:buildBody(chosenModel,isSub),signal:AbortSignal.timeout(45000)})
    if (!upstream.ok) {
      const errData=await upstream.json().catch(()=>({}))
      const errMsg=errData?.error?.message || ''
      if ((upstream.status===400 || upstream.status===404) && /model/i.test(errMsg) && chosenModel!=='claude-sonnet-4-20250514') {
        upstream=await aiFetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','anthropic-version':'2023-06-01',...authHeaders},body:buildBody('claude-sonnet-4-20250514',isSub),signal:AbortSignal.timeout(45000)})
        if (upstream.ok) return upstream.json()
      }
      const hint=/credit balance/i.test(errMsg)
        ? 'Your Anthropic Console API key has $0 API credits. To use your Claude Pro/Max subscription instead of buying API credits, run `claude setup-token` and paste your `sk-ant-oat01-…` subscription token in Family settings.'
        : errMsg || 'Check your Claude subscription token or key in Family settings.'
      throw Object.assign(new Error(`Claude could not complete the request (HTTP ${upstream.status}): ${hint}`),{status:upstream.status===401?400:502})
    }
    return upstream.json()
  }
  app.post('/api/family/ai', needFamily, async (req,res) => {
    try {
      const {messages,system,tools,model}=req.body
      if (!Array.isArray(messages) || messages.length<1 || messages.length>60 || JSON.stringify(messages).length>150000 || (system&&typeof system!=='string') || (system&&system.length>30000) || (tools&&(!Array.isArray(tools)||tools.length>40))) return res.status(400).json({error:'The AI conversation is too long. Start a new conversation.'})
      res.json(await callClaude(req.member.household_id,{messages,system,tools,model,max_tokens:req.body.max_tokens}))
    } catch(error) { res.status(error.status||502).json({error:error.status?error.message:'The AI request could not be completed. Please try again.'}) }
  })
  const billing=registerBilling(app,{db,needFamily,needOwner,encryptKey,decryptKey,callClaude,billFetch})
  app.get('/api/family/state', needFamily, (req, res) => res.json(snapshot(req.member.household_id)))
  app.post('/api/family/state', needFamily, (req, res) => {
    const { id, ops } = req.body
    if (typeof id !== 'string' || !/^[\w-]{10,100}$/.test(id)) return res.status(400).json({ error: 'Invalid change identifier.' })
    const hid = req.member.household_id
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!db.prepare('SELECT 1 FROM mutations WHERE household_id=? AND mutation_id=?').get(hid, id)) {
        const current = snapshot(hid), next = applyOps(current.state, ops, true)
        db.prepare('UPDATE households SET data=?,revision=revision+1 WHERE id=?').run(JSON.stringify(next), hid)
        db.prepare('INSERT INTO mutations VALUES(?,?,?)').run(hid, id, Date.now())
      }
      db.exec('COMMIT'); res.json(snapshot(hid))
    } catch (error) { db.exec('ROLLBACK'); res.status(error.code === 'CONFLICT' ? 409 : 400).json({ error: error.message, ...(error.code === 'CONFLICT' ? { latest: snapshot(hid) } : {}) }) }
  })
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }))
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
  app.use(express.static(dist, { index: false, maxAge: '1h' }))
  app.get('/{*any}', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(resolve(dist, 'index.html')) })
  app.use((error, req, res, next) => { console.error('Request failed:', error.code || error.name); res.status(error.status || 500).json({ error: 'The request could not be completed. Please try again.' }) })
  return { app, auth, db, checkDueConnections: billing.checkDueConnections, close: () => db.close() }
}
