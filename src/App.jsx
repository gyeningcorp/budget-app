import { useEffect, useMemo, useState } from 'react'

const LS_KEY = 'hog-budget-v1'
const CATEGORIES = ['Income', 'Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Fun', 'Savings', 'Other']

const todayISO = () => new Date().toISOString().slice(0, 10)
const fmt = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n || 0)

const SEED = {
  transactions: [
    { id: 't1', desc: 'Paycheck', amount: 3200, category: 'Income', type: 'income', date: todayISO() },
    { id: 't2', desc: 'Rent', amount: 1250, category: 'Housing', type: 'expense', date: todayISO() },
    { id: 't3', desc: 'Groceries', amount: 184.32, category: 'Food', type: 'expense', date: todayISO() },
    { id: 't4', desc: 'Gas', amount: 52.1, category: 'Transport', type: 'expense', date: todayISO() },
  ],
  budgets: { Food: 600, Transport: 250, Fun: 200, Utilities: 300 },
  apiKey: '',
  bank: { url: '', secret: '' },
}

// --- CSV helpers -----------------------------------------------------------
function csvField(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function splitCSVLine(line) {
  const out = []
  let cur = '',
    inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') inQ = false
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function normalizeDate(s) {
  if (!s) return todayISO()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/) // MM/DD/YYYY
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3]
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  return todayISO()
}

function guessCategory(desc) {
  const d = (desc || '').toLowerCase()
  const map = [
    ['Food', /grocery|market|coffee|restaurant|cafe|food|pizza|doordash|uber eats|mcdonald|starbuck/],
    ['Transport', /gas|fuel|uber|lyft|parking|transit|shell|exxon|chevron/],
    ['Housing', /rent|mortgage|landlord|hoa/],
    ['Utilities', /electric|water|internet|comcast|verizon|at&t|gas company|utility|phone/],
    ['Health', /pharmacy|doctor|clinic|gym|cvs|walgreens|medical|dental/],
    ['Fun', /netflix|spotify|hulu|disney|steam|cinema|movie|bar|game/],
    ['Income', /payroll|paycheck|deposit|salary|direct dep/],
  ]
  for (const [cat, re] of map) if (re.test(d)) return cat
  return 'Other'
}

// Detect common bank-export columns and build transactions.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return []
  const header = splitCSVLine(lines[0]).map((h) => h.toLowerCase())
  const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)))
  const iDate = find('date', 'posted')
  // Exclude the date column and any "...date" header so "Transaction Date" doesn't win the desc slot.
  const iDesc = header.findIndex(
    (h, idx) => idx !== iDate && !h.includes('date') && /description|memo|payee|details|name|transaction/.test(h)
  )
  const iAmt = find('amount', 'value')
  const iType = find('type', 'debit/credit', 'cr/dr')
  const iCat = find('category')
  const iDebit = find('debit', 'withdrawal')
  const iCredit = find('credit', 'deposit')

  const out = []
  for (let r = 1; r < lines.length; r++) {
    const c = splitCSVLine(lines[r])
    const desc = (iDesc >= 0 ? c[iDesc] : '') || 'Imported'
    let amount = 0
    let type = 'expense'

    if (iAmt >= 0) {
      const n = parseFloat((c[iAmt] || '').replace(/[$,]/g, ''))
      if (!isNaN(n)) {
        type = n < 0 ? 'expense' : 'income'
        amount = Math.abs(n)
      }
    } else if (iDebit >= 0 || iCredit >= 0) {
      const deb = parseFloat((c[iDebit] || '').replace(/[$,]/g, ''))
      const cred = parseFloat((c[iCredit] || '').replace(/[$,]/g, ''))
      if (!isNaN(cred) && cred > 0) {
        type = 'income'
        amount = cred
      } else if (!isNaN(deb) && deb > 0) {
        type = 'expense'
        amount = deb
      }
    }

    if (iType >= 0 && c[iType]) {
      const tv = c[iType].toLowerCase()
      if (/credit|income|deposit|cr/.test(tv)) type = 'income'
      else if (/debit|expense|withdraw|dr/.test(tv)) type = 'expense'
    }

    if (amount === 0 && !desc) continue
    const category =
      type === 'income' ? 'Income' : iCat >= 0 && c[iCat] ? c[iCat] : guessCategory(desc)

    out.push({
      id: 't' + Date.now() + '-' + r,
      desc,
      amount,
      type,
      category: CATEGORIES.includes(category) ? category : guessCategory(desc),
      date: normalizeDate(iDate >= 0 ? c[iDate] : ''),
    })
  }
  return out
}

// --- Bank live-sync (Plaid via the Cloudflare Worker) ----------------------
function loadPlaid() {
  return new Promise((resolve, reject) => {
    if (window.Plaid) return resolve(window.Plaid)
    const s = document.createElement('script')
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    s.onload = () => resolve(window.Plaid)
    s.onerror = () => reject(new Error('Could not load Plaid Link'))
    document.head.appendChild(s)
  })
}

function makeApi(bank) {
  const base = (bank?.url || '').replace(/\/$/, '')
  return async (path, body) => {
    if (!base) throw new Error('Set your Sync server URL in Settings → Bank Sync')
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-secret': bank.secret || '' },
      body: JSON.stringify(body || {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Server ${res.status}`)
    return data
  }
}

// Merge synced rows into the ledger: upsert by plaidId, drop removed ones.
function mergeSynced(transactions, added, removedIds) {
  const removed = new Set(removedIds || [])
  const byKey = new Map(transactions.map((t) => [t.plaidId || t.id, t]))
  for (const tx of added || []) byKey.set(tx.plaidId, tx)
  return [...byKey.values()].filter((t) => !(t.plaidId && removed.has(t.plaidId)))
}

function BankBar({ state, setState }) {
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const bank = state.bank || { url: '', secret: '' }
  const configured = !!bank.url
  const api = makeApi(bank)

  const doSync = async () => {
    setBusy('sync')
    setMsg('')
    try {
      const { added, removedIds } = await api('/api/sync')
      setState((s) => ({ ...s, transactions: mergeSynced(s.transactions, added, removedIds), bank: { ...bank, linked: true } }))
      setMsg(`Synced — ${added?.length || 0} transaction${added?.length === 1 ? '' : 's'} updated.`)
    } catch (e) {
      setMsg('Sync failed — ' + e.message)
    } finally {
      setBusy('')
    }
  }

  const connect = async () => {
    setBusy('connect')
    setMsg('')
    try {
      const { link_token } = await api('/api/create_link_token')
      const Plaid = await loadPlaid()
      const handler = Plaid.create({
        token: link_token,
        onSuccess: async (public_token) => {
          try {
            await api('/api/exchange_public_token', { public_token })
            setState((s) => ({ ...s, bank: { ...bank, linked: true } }))
            setMsg('Bank linked — syncing…')
            await doSync()
          } catch (e) {
            setMsg('Link exchange failed — ' + e.message)
          }
        },
        onExit: (err) => {
          if (err) setMsg('Link cancelled — ' + (err.error_message || err.error_code || ''))
          setBusy('')
        },
      })
      handler.open()
    } catch (e) {
      setMsg('Could not start bank link — ' + e.message)
      setBusy('')
    }
  }

  if (!configured) {
    return (
      <div className="callout" style={{ marginTop: 10 }}>
        <b>Live bank sync is ready to connect.</b> Add your Sync server URL + app secret in{' '}
        <b>Settings → Bank Sync</b>, then come back here to link your bank.
      </div>
    )
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" disabled={!!busy} onClick={connect}>
          {busy === 'connect' ? 'Opening…' : bank.linked ? '🔗 Relink bank' : '🔗 Connect bank'}
        </button>
        <button className="btn ghost" disabled={!!busy} onClick={doSync}>
          {busy === 'sync' ? 'Syncing…' : '↻ Sync now'}
        </button>
      </div>
      {msg && <div className="callout" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  )
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return SEED
    const parsed = JSON.parse(raw)
    return { ...SEED, ...parsed }
  } catch {
    return SEED
  }
}

export default function App() {
  const [tab, setTab] = useState('Dashboard')
  const [state, setState] = useState(loadState)

  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
  }, [state])

  const update = (patch) => setState((s) => ({ ...s, ...patch }))

  const totals = useMemo(() => {
    let income = 0,
      expense = 0
    const byCat = {}
    for (const t of state.transactions) {
      if (t.type === 'income') income += t.amount
      else {
        expense += t.amount
        byCat[t.category] = (byCat[t.category] || 0) + t.amount
      }
    }
    return { income, expense, net: income - expense, byCat }
  }, [state.transactions])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="mark">G</div>
          <div>
            <h1>House of Gyening · Budget</h1>
            <span>Local-first · your data never leaves your browser</span>
          </div>
        </div>
      </header>

      <nav className="tabs">
        {['Dashboard', 'Transactions', 'Budgets', 'Advisor', 'Opportunities', 'Settings'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Dashboard' && <Dashboard totals={totals} transactions={state.transactions} />}
      {tab === 'Transactions' && <Transactions state={state} setState={setState} />}
      {tab === 'Budgets' && <Budgets state={state} update={update} byCat={totals.byCat} />}
      {tab === 'Advisor' && <Advisor state={state} totals={totals} />}
      {tab === 'Opportunities' && <Opportunities state={state} totals={totals} update={update} />}
      {tab === 'Settings' && <Settings state={state} update={update} setState={setState} />}

      <p className="foot">House of Gyening · Budget — built with React + Vite. No server, no tracking.</p>
    </div>
  )
}

function Dashboard({ totals, transactions }) {
  const recent = [...transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6)
  const cats = Object.entries(totals.byCat).sort((a, b) => b[1] - a[1])
  return (
    <>
      <div className="grid cols-3">
        <div className="card">
          <h3>Income</h3>
          <div className="stat pos">{fmt(totals.income)}</div>
          <div className="muted">all recorded</div>
        </div>
        <div className="card">
          <h3>Spending</h3>
          <div className="stat neg">{fmt(totals.expense)}</div>
          <div className="muted">all recorded</div>
        </div>
        <div className="card">
          <h3>Net</h3>
          <div className={'stat ' + (totals.net >= 0 ? 'pos' : 'neg')}>{fmt(totals.net)}</div>
          <div className="muted">{totals.net >= 0 ? 'in the green' : 'overspending'}</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Spending by category</h3>
          {cats.length === 0 && <div className="empty">No expenses yet.</div>}
          <div className="list">
            {cats.map(([c, v]) => (
              <div className="item" key={c}>
                <div className="left">
                  <span className="desc">{c}</span>
                </div>
                <span className="amount expense">{fmt(v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>Recent activity</h3>
          {recent.length === 0 && <div className="empty">Nothing yet.</div>}
          <div className="list">
            {recent.map((t) => (
              <div className="item" key={t.id}>
                <div className="left">
                  <span className="desc">{t.desc}</span>
                  <span className="meta">
                    {t.category} · {t.date}
                  </span>
                </div>
                <span className={'amount ' + t.type}>
                  {t.type === 'income' ? '+' : '−'}
                  {fmt(t.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

// Amount cell with its own typing buffer so you can freely type "12.", clear it,
// etc., while the parent always stores a clean number.
function AmountCell({ value, type, onCommit }) {
  const [raw, setRaw] = useState(String(value ?? ''))
  useEffect(() => {
    setRaw(value === 0 ? '' : String(value))
  }, [value])
  const commit = () => {
    const n = parseFloat(raw)
    onCommit(isNaN(n) ? 0 : n)
  }
  return (
    <input
      type="number"
      step="0.01"
      inputMode="decimal"
      placeholder="0.00"
      className={'cell-num ' + type}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

function Transactions({ state, setState }) {
  const rows = state.transactions
  const [importMsg, setImportMsg] = useState('')

  // Edit a single cell of a row, in place (spreadsheet-style).
  const editCell = (id, field, value) =>
    setState((s) => ({
      ...s,
      transactions: s.transactions.map((t) => (t.id === id ? { ...t, [field]: value } : t)),
    }))

  const importCSV = async (file) => {
    if (!file) return
    try {
      const text = await file.text()
      const imported = parseCSV(text)
      if (!imported.length) {
        setImportMsg('No rows found — expected columns like date, description, amount.')
        return
      }
      setState((s) => ({ ...s, transactions: [...imported, ...s.transactions] }))
      setImportMsg(`Imported ${imported.length} transaction${imported.length === 1 ? '' : 's'}.`)
    } catch (e) {
      setImportMsg('Import failed — ' + (e.message || String(e)))
    }
  }

  const exportCSV = () => {
    const head = 'date,description,type,category,amount'
    const body = rows
      .map((t) => [t.date, csvField(t.desc), t.type, t.category, t.amount].join(','))
      .join('\n')
    downloadFile('budget-transactions.csv', head + '\n' + body, 'text/csv')
  }

  const addRow = () =>
    setState((s) => ({
      ...s,
      transactions: [
        { id: 't' + Date.now(), desc: '', amount: 0, category: 'Other', type: 'expense', date: todayISO() },
        ...s.transactions,
      ],
    }))

  const remove = (id) =>
    setState((s) => ({ ...s, transactions: s.transactions.filter((t) => t.id !== id) }))

  const duplicate = (id) =>
    setState((s) => {
      const src = s.transactions.find((t) => t.id === id)
      if (!src) return s
      const i = s.transactions.findIndex((t) => t.id === id)
      const copy = { ...src, id: 't' + Date.now() }
      const next = [...s.transactions]
      next.splice(i + 1, 0, copy)
      return { ...s, transactions: next }
    })

  const sorted = [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  const totalIn = rows.filter((t) => t.type === 'income').reduce((a, t) => a + (t.amount || 0), 0)
  const totalOut = rows.filter((t) => t.type === 'expense').reduce((a, t) => a + (t.amount || 0), 0)

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ margin: 0 }}>Ledger ({rows.length})</h3>
        <div className="row" style={{ gap: 8 }}>
          <label className="btn ghost" style={{ cursor: 'pointer', margin: 0 }}>
            Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                importCSV(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
          <button className="btn ghost" onClick={exportCSV}>Export CSV</button>
          <button className="btn" onClick={addRow}>+ Add row</button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Click any cell to edit — like a spreadsheet. Press <b>Tab</b> to move across, <b>Enter</b> to confirm an amount. Changes save instantly.
      </p>
      <p className="muted" style={{ marginTop: 2 }}>
        <b>Link your bank:</b> download your transactions as CSV from your bank’s website, then <b>Import CSV</b> above. Columns like <i>date, description, amount</i> are detected automatically.
      </p>
      {importMsg && <div className="callout" style={{ marginTop: 8 }}>{importMsg}</div>}
      <BankBar state={state} setState={setState} />

      <div className="sheet-wrap">
        <table className="sheet">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Type</th>
              <th>Category</th>
              <th className="num">Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">No rows yet. Hit “+ Add row”.</td>
              </tr>
            )}
            {sorted.map((t) => (
              <tr key={t.id} className={t.type === 'income' ? 'r-income' : ''}>
                <td>
                  <input type="date" value={t.date} onChange={(e) => editCell(t.id, 'date', e.target.value)} />
                </td>
                <td>
                  <input value={t.desc} placeholder="describe…" onChange={(e) => editCell(t.id, 'desc', e.target.value)} />
                </td>
                <td>
                  <select value={t.type} onChange={(e) => editCell(t.id, 'type', e.target.value)}>
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                </td>
                <td>
                  <select value={t.category} onChange={(e) => editCell(t.id, 'category', e.target.value)}>
                    {CATEGORIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td className="num">
                  <AmountCell value={t.amount} type={t.type} onCommit={(n) => editCell(t.id, 'amount', n)} />
                </td>
                <td className="rowtools">
                  <button title="Duplicate" onClick={() => duplicate(t.id)}>⧉</button>
                  <button title="Delete" onClick={() => remove(t.id)}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ textAlign: 'right', color: 'var(--text-dim)' }}>Totals</td>
              <td className="num">
                <span className="amount income">+{fmt(totalIn)}</span>{' '}
                <span className="amount expense">−{fmt(totalOut)}</span>
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

function Budgets({ state, update, byCat }) {
  const [cat, setCat] = useState('Food')
  const [amt, setAmt] = useState('')

  const setBudget = (e) => {
    e.preventDefault()
    const v = parseFloat(amt)
    if (!v || v <= 0) return
    update({ budgets: { ...state.budgets, [cat]: v } })
    setAmt('')
  }
  const removeBudget = (c) => {
    const next = { ...state.budgets }
    delete next[c]
    update({ budgets: next })
  }

  const entries = Object.entries(state.budgets)
  return (
    <>
      <div className="card" style={{ marginTop: 18 }}>
        <h3>Set a monthly budget</h3>
        <form onSubmit={setBudget}>
          <div className="row">
            <div className="field">
              <label>Category</label>
              <select value={cat} onChange={(e) => setCat(e.target.value)}>
                {CATEGORIES.filter((c) => c !== 'Income').map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Limit</label>
              <input type="number" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
            </div>
            <button className="btn" type="submit">Save</button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Budgets vs. actual</h3>
        {entries.length === 0 && <div className="empty">No budgets set yet.</div>}
        <div className="list">
          {entries.map(([c, limit]) => {
            const spent = byCat[c] || 0
            const pct = Math.min(100, (spent / limit) * 100)
            const over = spent > limit
            return (
              <div className="item" key={c} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="desc">{c}</span>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span className="meta">
                      {fmt(spent)} / {fmt(limit)} {over && <b style={{ color: 'var(--red)' }}>over</b>}
                    </span>
                    <button className="btn danger" onClick={() => removeBudget(c)}>Remove</button>
                  </div>
                </div>
                <div className="bar">
                  <span className={over ? 'over' : ''} style={{ width: pct + '%' }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

function Advisor({ state, totals }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const hasKey = !!state.apiKey

  const buildContext = () => {
    const lines = [
      `Income total: ${fmt(totals.income)}`,
      `Expense total: ${fmt(totals.expense)}`,
      `Net: ${fmt(totals.net)}`,
      'Spending by category: ' +
        Object.entries(totals.byCat)
          .map(([c, v]) => `${c} ${fmt(v)}`)
          .join(', '),
      'Budgets: ' +
        Object.entries(state.budgets)
          .map(([c, v]) => `${c} ${fmt(v)}`)
          .join(', '),
    ]
    return lines.join('\n')
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setError('')
    const next = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': state.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system:
            'You are a sharp, practical personal-finance advisor inside a budgeting app. ' +
            'Be concise and specific. Use the user\'s real numbers below. Give actionable suggestions, ' +
            'flag overspending, and never invent transactions.\n\nUSER FINANCIAL SNAPSHOT:\n' +
            buildContext(),
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`API ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = await res.json()
      const reply = data?.content?.map((b) => b.text).join('') || '(no response)'
      setMessages((m) => [...m, { role: 'assistant', content: reply }])
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3>AI money advisor</h3>
      {!hasKey && (
        <div className="callout" style={{ marginBottom: 12 }}>
          Add your <b>Anthropic API key</b> in <b>Settings</b> to enable the advisor. Your key is stored only in this
          browser (localStorage) and sent directly to Anthropic — never to any server of ours.
        </div>
      )}

      <div className="chat">
        {messages.length === 0 && (
          <div className="empty">
            Ask things like “Where am I overspending?” or “How much can I save this month?”
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={'bubble ' + (m.role === 'user' ? 'user' : 'ai')}>
            {m.content}
          </div>
        ))}
        {busy && <div className="bubble ai">Thinking…</div>}
      </div>

      {error && (
        <div className="callout" style={{ marginTop: 12, color: 'var(--red)' }}>
          {error}
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <div className="field" style={{ flex: 3 }}>
          <input
            value={input}
            disabled={!hasKey || busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={hasKey ? 'Ask your advisor…' : 'Add an API key in Settings first'}
          />
        </div>
        <button className="btn" disabled={!hasKey || busy} onClick={send}>
          Send
        </button>
      </div>
    </div>
  )
}

function Opportunities({ state, totals, update }) {
  const saved = state.opportunities || { profile: { skills: '', hours: '10', budget: '0', location: '' }, ideas: [] }
  const [profile, setProfile] = useState(saved.profile)
  const [ideas, setIdeas] = useState(saved.ideas)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hasKey = !!state.apiKey

  const persist = (nextIdeas, nextProfile) =>
    update({ opportunities: { profile: nextProfile ?? profile, ideas: nextIdeas ?? ideas } })

  const setP = (patch) => {
    const next = { ...profile, ...patch }
    setProfile(next)
    persist(undefined, next)
  }

  const generate = async () => {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      const prompt =
        `Generate 6 concrete, realistic money-making opportunities for this person. ` +
        `Mix side hustles and online/internet income. Prioritize ones that fit their skills, time, and budget.\n\n` +
        `PROFILE:\n` +
        `- Skills/interests: ${profile.skills || 'general, open to anything'}\n` +
        `- Time available: ${profile.hours || '?'} hours/week\n` +
        `- Startup budget: $${profile.budget || '0'}\n` +
        `- Location: ${profile.location || 'unspecified'}\n` +
        `- Current monthly net: ${fmt(totals.net)}\n\n` +
        `Return ONLY a JSON array, no prose. Each item must be an object with exactly these keys: ` +
        `"title" (string), "type" ("side hustle" or "online"), "potential" (realistic monthly $ range as a string e.g. "$300-800"), ` +
        `"effort" ("low"|"medium"|"high"), "startup" (string, e.g. "$0" or "$50 + a laptop"), ` +
        `"why" (one sentence on why it fits this person), ` +
        `"steps" (array of 3-5 short string steps to start this week).`

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': state.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const data = await res.json()
      const raw = data?.content?.map((b) => b.text).join('') || '[]'
      const match = raw.match(/\[[\s\S]*\]/)
      const parsed = JSON.parse(match ? match[0] : raw)
      setIdeas(parsed)
      persist(parsed)
    } catch (e) {
      setError('Could not parse ideas — ' + (e.message || String(e)))
    } finally {
      setBusy(false)
    }
  }

  const effortColor = (e) => (e === 'low' ? 'var(--green)' : e === 'high' ? 'var(--red)' : 'var(--amber)')

  return (
    <>
      <div className="card" style={{ marginTop: 18 }}>
        <h3>Find money-making opportunities</h3>
        {!hasKey && (
          <div className="callout" style={{ marginBottom: 12 }}>
            Add your <b>Anthropic API key</b> in <b>Settings</b> to generate ideas.
          </div>
        )}
        <div className="row">
          <div className="field" style={{ flex: 3, minWidth: 200 }}>
            <label>Your skills / interests</label>
            <input value={profile.skills} onChange={(e) => setP({ skills: e.target.value })} placeholder="e.g. driving, writing, Excel, video editing, lawn care" />
          </div>
          <div className="field">
            <label>Hours / week</label>
            <input type="number" value={profile.hours} onChange={(e) => setP({ hours: e.target.value })} />
          </div>
          <div className="field">
            <label>Startup budget ($)</label>
            <input type="number" value={profile.budget} onChange={(e) => setP({ budget: e.target.value })} />
          </div>
          <div className="field">
            <label>Location</label>
            <input value={profile.location} onChange={(e) => setP({ location: e.target.value })} placeholder="e.g. Pittsburgh, PA" />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={!hasKey || busy} onClick={generate}>
            {busy ? 'Finding opportunities…' : ideas.length ? 'Regenerate ideas' : 'Generate ideas'}
          </button>
        </div>
        {error && <div className="callout" style={{ marginTop: 12, color: 'var(--red)' }}>{error}</div>}
      </div>

      {ideas.length > 0 && (
        <div className="grid cols-2">
          {ideas.map((idea, i) => (
            <div className="card" key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <span className="desc" style={{ fontSize: 16, fontWeight: 700 }}>{idea.title}</span>
                <span className="pill">{idea.type}</span>
              </div>
              <div style={{ display: 'flex', gap: 14, margin: '10px 0', flexWrap: 'wrap' }}>
                <span className="muted">💵 <b style={{ color: 'var(--green)' }}>{idea.potential}</b>/mo</span>
                <span className="muted">⚡ effort <b style={{ color: effortColor(idea.effort) }}>{idea.effort}</b></span>
                <span className="muted">🏁 {idea.startup}</span>
              </div>
              <p className="muted" style={{ fontStyle: 'italic', marginTop: 0 }}>{idea.why}</p>
              <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6 }}>
                {(idea.steps || []).map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function Settings({ state, update, setState }) {
  const [key, setKey] = useState(state.apiKey || '')
  const [saved, setSaved] = useState(false)
  const [bank, setBank] = useState(state.bank || { url: '', secret: '' })
  const [bankSaved, setBankSaved] = useState(false)

  const save = () => {
    update({ apiKey: key.trim() })
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  const saveBank = () => {
    update({ bank: { ...(state.bank || {}), url: bank.url.trim(), secret: bank.secret.trim() } })
    setBankSaved(true)
    setTimeout(() => setBankSaved(false), 1800)
  }

  const exportData = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'hog-budget-export.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const reset = () => {
    if (confirm('Erase all transactions, budgets, and your saved key from this browser?')) {
      localStorage.removeItem(LS_KEY)
      location.reload()
    }
  }

  return (
    <>
      <div className="card" style={{ marginTop: 18 }}>
        <h3>Anthropic API key</h3>
        <div className="callout" style={{ marginBottom: 12 }}>
          Stored only in <b>this browser</b>. Requests go straight from your browser to Anthropic. Get a key at{' '}
          <b>console.anthropic.com</b>.
        </div>
        <div className="row">
          <div className="field" style={{ flex: 3 }}>
            <label>Key (sk-ant-…)</label>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-..." />
          </div>
          <button className="btn" onClick={save}>{saved ? 'Saved ✓' : 'Save key'}</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Bank Sync (live auto-sync)</h3>
        <div className="callout" style={{ marginBottom: 12 }}>
          Live bank linking runs through your own <b>Cloudflare Worker</b> (Plaid backend) so your bank
          credentials and secret keys never touch this page. Setup steps are in <b>worker/README.md</b> in the repo.
          Paste the Worker URL and the app secret you chose, then link your bank under <b>Transactions</b>.
        </div>
        <div className="row">
          <div className="field" style={{ flex: 3, minWidth: 220 }}>
            <label>Sync server URL</label>
            <input
              value={bank.url}
              onChange={(e) => setBank({ ...bank, url: e.target.value })}
              placeholder="https://budget-sync.you.workers.dev"
            />
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>App secret</label>
            <input
              type="password"
              value={bank.secret}
              onChange={(e) => setBank({ ...bank, secret: e.target.value })}
              placeholder="the APP_SECRET you set"
            />
          </div>
          <button className="btn" onClick={saveBank}>{bankSaved ? 'Saved ✓' : 'Save'}</button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Your data</h3>
        <div className="row">
          <button className="btn ghost" onClick={exportData}>Export JSON</button>
          <button className="btn danger" onClick={reset}>Erase everything</button>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Everything lives in your browser’s localStorage. Clearing browser data removes it.
        </p>
      </div>
    </>
  )
}
