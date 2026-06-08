// Budget Sync — Cloudflare Worker backend for Plaid live bank sync.
//
// Holds the Plaid secret (never exposed to the browser), stores the per-user
// access token + sync cursor in KV, and proxies the three Plaid calls the app
// needs: create_link_token, exchange_public_token, transactions/sync.
//
// Secrets (set with `wrangler secret put <NAME>`):
//   PLAID_CLIENT_ID, PLAID_SECRET, APP_SECRET
// Vars (wrangler.toml [vars]): PLAID_ENV = "sandbox" | "development" | "production"
// KV binding: BUDGET_KV

const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
}

const json = (data, status, origin) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json', ...cors(origin) },
  })

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-app-secret',
    'access-control-max-age': '86400',
  }
}

async function plaid(env, path, body) {
  const host = PLAID_HOSTS[env.PLAID_ENV || 'sandbox']
  const res = await fetch(host + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error_message || data.error_code || `Plaid ${res.status}`)
  return data
}

// Map a Plaid transaction to the app's ledger shape.
// Plaid convention: positive amount = money leaving the account (expense).
const CATS = ['Income', 'Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Fun', 'Savings', 'Other']
function mapCategory(pfc) {
  const p = (pfc?.primary || '').toUpperCase()
  const m = {
    INCOME: 'Income',
    TRANSFER_IN: 'Income',
    RENT_AND_UTILITIES: 'Utilities',
    FOOD_AND_DRINK: 'Food',
    TRANSPORTATION: 'Transport',
    TRAVEL: 'Transport',
    MEDICAL: 'Health',
    ENTERTAINMENT: 'Fun',
    PERSONAL_CARE: 'Health',
    HOME_IMPROVEMENT: 'Housing',
    LOAN_PAYMENTS: 'Housing',
    GENERAL_MERCHANDISE: 'Other',
  }
  return m[p] || 'Other'
}
function mapTxn(t) {
  const type = t.amount > 0 ? 'expense' : 'income'
  return {
    id: 'plaid-' + t.transaction_id,
    plaidId: t.transaction_id,
    desc: t.merchant_name || t.name || 'Transaction',
    amount: Math.abs(t.amount),
    type,
    category: type === 'income' ? 'Income' : mapCategory(t.personal_finance_category),
    date: (t.date || '').slice(0, 10),
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '*'
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) })
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, origin)

    const url = new URL(request.url)

    // Simple shared-secret auth so the public endpoint isn't open to the world.
    if (request.headers.get('x-app-secret') !== env.APP_SECRET) {
      return json({ error: 'unauthorized' }, 401, origin)
    }
    const userKey = 'user:' + env.APP_SECRET // single-user personal app

    try {
      if (url.pathname === '/api/create_link_token') {
        const data = await plaid(env, '/link/token/create', {
          client_name: 'House of Gyening Budget',
          country_codes: ['US'],
          language: 'en',
          user: { client_user_id: userKey },
          products: ['transactions'],
        })
        return json({ link_token: data.link_token }, 200, origin)
      }

      if (url.pathname === '/api/exchange_public_token') {
        const { public_token } = await request.json()
        const data = await plaid(env, '/item/public_token/exchange', { public_token })
        await env.BUDGET_KV.put(userKey, JSON.stringify({ access_token: data.access_token, cursor: null }))
        return json({ ok: true, item_id: data.item_id }, 200, origin)
      }

      if (url.pathname === '/api/sync') {
        const stored = await env.BUDGET_KV.get(userKey, 'json')
        if (!stored?.access_token) return json({ error: 'no bank linked' }, 400, origin)

        let cursor = stored.cursor
        const added = []
        const removed = []
        let hasMore = true
        while (hasMore) {
          const data = await plaid(env, '/transactions/sync', {
            access_token: stored.access_token,
            cursor: cursor || undefined,
            count: 250,
          })
          added.push(...data.added, ...data.modified)
          removed.push(...data.removed.map((r) => r.transaction_id))
          cursor = data.next_cursor
          hasMore = data.has_more
        }
        await env.BUDGET_KV.put(userKey, JSON.stringify({ access_token: stored.access_token, cursor }))
        return json({ added: added.map(mapTxn), removedIds: removed }, 200, origin)
      }

      if (url.pathname === '/api/status') {
        const stored = await env.BUDGET_KV.get(userKey, 'json')
        return json({ linked: !!stored?.access_token, env: env.PLAID_ENV || 'sandbox' }, 200, origin)
      }

      if (url.pathname === '/api/unlink') {
        await env.BUDGET_KV.delete(userKey)
        return json({ ok: true }, 200, origin)
      }

      return json({ error: 'not found' }, 404, origin)
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, origin)
    }
  },
}
