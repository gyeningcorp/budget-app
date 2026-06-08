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
        {['Dashboard', 'Transactions', 'Budgets', 'Advisor', 'Settings'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Dashboard' && <Dashboard totals={totals} transactions={state.transactions} />}
      {tab === 'Transactions' && <Transactions state={state} setState={setState} />}
      {tab === 'Budgets' && <Budgets state={state} update={update} byCat={totals.byCat} />}
      {tab === 'Advisor' && <Advisor state={state} totals={totals} />}
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

function Transactions({ state, setState }) {
  const [form, setForm] = useState({ desc: '', amount: '', category: 'Food', type: 'expense', date: todayISO() })

  const add = (e) => {
    e.preventDefault()
    const amount = parseFloat(form.amount)
    if (!form.desc.trim() || !amount || amount <= 0) return
    const tx = { ...form, id: 't' + Date.now(), amount }
    setState((s) => ({ ...s, transactions: [tx, ...s.transactions] }))
    setForm({ ...form, desc: '', amount: '' })
  }
  const remove = (id) =>
    setState((s) => ({ ...s, transactions: s.transactions.filter((t) => t.id !== id) }))

  const sorted = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <>
      <div className="card" style={{ marginTop: 18 }}>
        <h3>Add transaction</h3>
        <form onSubmit={add}>
          <div className="row">
            <div className="field" style={{ flex: 2 }}>
              <label>Description</label>
              <input value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} placeholder="e.g. Coffee" />
            </div>
            <div className="field">
              <label>Amount</label>
              <input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>
            <div className="field">
              <label>Category</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Date</label>
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </div>
            <button className="btn" type="submit">Add</button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>All transactions ({sorted.length})</h3>
        {sorted.length === 0 && <div className="empty">No transactions yet.</div>}
        <div className="list">
          {sorted.map((t) => (
            <div className="item" key={t.id}>
              <div className="left">
                <span className="desc">{t.desc}</span>
                <span className="meta">
                  <span className="pill">{t.category}</span> · {t.date}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={'amount ' + t.type}>
                  {t.type === 'income' ? '+' : '−'}
                  {fmt(t.amount)}
                </span>
                <button className="btn danger" onClick={() => remove(t.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
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

function Settings({ state, update, setState }) {
  const [key, setKey] = useState(state.apiKey || '')
  const [saved, setSaved] = useState(false)

  const save = () => {
    update({ apiKey: key.trim() })
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
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
