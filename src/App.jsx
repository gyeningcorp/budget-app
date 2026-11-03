import { useEffect, useMemo, useRef, useState } from 'react'
import Family from './Family.jsx'
import useHousehold from './useHousehold'
import Account from './Account'
import DateNights from './DateNights'
import HomePlanning from './HomePlanning'
import BillAccounts from './BillAccounts'
import { claudeRequest } from './claude'
import { sharedState } from '../shared/sync'
import { PAYCHECK_FREQUENCIES, allCategories, canonicalCategory, categoryBudgets, paycheckSummary } from '../shared/budgets'
import { dateKey } from './family.js'

const LS_KEY = 'hog-budget-v1'
const CATEGORIES = ['Income', 'Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Fun', 'Savings', 'Other']

const todayISO = dateKey
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
  budgetItems: [],
  familyEvents: [],
  familyProjects: [],
  dateNights: [],
  groceries: [],
  groceryStaples: [],
  meals: [],
  bills: [],
  billAccounts: [],
  paychecks: [],
  paycheckPlan: {},
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
  const [tab, setTab] = useState(() => location.hash.includes('invite=') ? 'Family' : 'Dashboard')
  const sync = useHousehold(loadState, LS_KEY)
  const { state, setState } = sync

  const update = (patch) => setState((s) => ({ ...s, ...patch }))

  const totals = useMemo(() => {
    let loggedIncome = 0,
      txExpense = 0
    const byCat = {}
    for (const t of state.transactions) {
      if (t.type === 'income') loggedIncome += t.amount
      else {
        txExpense += t.amount
        byCat[t.category] = (byCat[t.category] || 0) + t.amount
      }
    }
    const pay = paycheckSummary(state)
    const budgetSummary = categoryBudgets(state, byCat)
    const totalPlanned = budgetSummary.reduce((s, b) => s + b.effective, 0)
    const totalActualSpent = budgetSummary.reduce((s, b) => s + b.actual, 0)
    // Primary household income flows from Paychecks when paychecks are defined (or whichever is higher with logged income).
    const income = pay.count > 0 ? Math.max(pay.monthly, loggedIncome) : loggedIncome
    const expense = Math.max(txExpense, totalActualSpent)
    const unbudgetedIncome = income - totalPlanned
    return {
      income,
      loggedIncome,
      paycheckMonthly: pay.monthly,
      paycheckPerCycle: pay.perCycle,
      paycheckCount: pay.count,
      nextPayday: pay.nextDate,
      expense,
      txExpense,
      net: income - expense,
      totalPlanned,
      unbudgetedIncome,
      byCat,
    }
  }, [state.transactions, state.paychecks, state.budgets, state.budgetItems])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="mark">G</div>
          <div>
            <h1>House of Gyening · Family Hub</h1>
            <span>{sync.status}</span>
          </div>
        </div>
      </header>

      <div className="family-connection"><span>{sync.account?.household ? sync.account.household.name : "Your family, in one place"}</span><button className="btn ghost" onClick={() => setTab('Family')}>{sync.account ? 'Family settings' : 'Family sign in'}</button></div>
      {sync.conflict && <p role="alert" className="family-error">A simultaneous edit needs your review. <button className="btn ghost" onClick={() => setTab('Family')}>Review changes</button></p>}
      <nav className="tabs" aria-label="App sections">
        {['Dashboard', 'Calendar', 'Date nights', 'Projects', 'Groceries', 'Meals', 'Paychecks', 'Bill accounts', 'Ideas', 'Transactions', 'Budgets', 'Advisor', 'Opportunities', 'Family', 'Settings'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      {['Calendar', 'Projects', 'Ideas'].includes(tab) && <Family tab={tab} state={state} setState={setState} onNavigate={setTab} />}
      {tab === 'Family' && <Account sync={sync} />}
      {tab === 'Bill accounts' && <BillAccounts sync={sync} onNavigate={setTab} />}
      {tab === 'Date nights' && <DateNights state={state} setState={setState} />}
      {['Groceries', 'Meals', 'Paychecks'].includes(tab) && <HomePlanning tab={tab} state={state} setState={setState} />}
      {tab === 'Dashboard' && <Dashboard state={state} totals={totals} transactions={state.transactions} onNavigate={setTab} />}
      {tab === 'Transactions' && <Transactions state={state} setState={setState} />}
      {tab === 'Budgets' && <Budgets state={state} update={update} byCat={totals.byCat} totals={totals} onNavigate={setTab} />}
      {tab === 'Advisor' && <Advisor state={state} totals={totals} />}
      {tab === 'Opportunities' && <Opportunities state={state} totals={totals} update={update} />}
      {tab === 'Settings' && <Settings state={state} update={update} setState={setState} openFamily={() => setTab('Family')} />}

      <p className="foot">House of Gyening · Family Hub · Your household, together.</p>

      <Assistant state={state} setState={setState} totals={totals} page={tab} setTab={setTab} />
    </div>
  )
}

function Dashboard({ state, totals, transactions, onNavigate }) {
  const recent = [...transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6)
  const cats = Object.entries(totals.byCat).sort((a, b) => b[1] - a[1])
  const budgetSummary = categoryBudgets(state, totals.byCat)
  const totalBudgeted = budgetSummary.reduce((s, b) => s + b.effective, 0)
  const totalBudgetSpent = budgetSummary.reduce((s, b) => s + b.actual, 0)
  const budgetPct = totalBudgeted > 0 ? Math.min(100, Math.round((totalBudgetSpent / totalBudgeted) * 100)) : 0
  const savingsRate = totals.income > 0 ? Math.round(((totals.income - totals.expense) / totals.income) * 100) : 0
  const unpaidBills = (state.bills || []).filter((b) => !b.paid).sort((a, b) => a.due.localeCompare(b.due))
  const unpaidTotal = unpaidBills.reduce((s, b) => s + (Number(b.amount) || 0), 0)
  const openGroceries = (state.groceries || []).filter((g) => !g.checked).length
  const stapleCount = (state.groceryStaples || []).length
  const activeProjects = (state.familyProjects || []).filter((p) => p.status !== 'Done').length
  const upcomingDates = (state.dateNights || []).filter((d) => d.status === 'Planned' && d.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date))

  return (
    <>
      <div className="hud-banner">
        <div className="hud-banner-left">
          <span className="hud-tag">LIVE HOUSEHOLD TELEMETRY</span>
          <h2>Command Overview</h2>
          <p className="muted">Real-time cashflow, itemized budgets, upcoming utility obligations, and family logistics.</p>
        </div>
        <div className="hud-metrics">
          <div className="hud-chip">
            <span>SAVINGS RATE</span>
            <strong className={savingsRate >= 20 ? 'pos' : savingsRate >= 0 ? '' : 'neg'}>{savingsRate}%</strong>
          </div>
          <div className="hud-chip">
            <span>BUDGET UTILIZATION</span>
            <strong className={budgetPct > 100 ? 'neg' : 'pos'}>{budgetPct}%</strong>
          </div>
          <div className="hud-chip">
            <span>UNPAID BILLS</span>
            <strong>{unpaidBills.length} · {fmt(unpaidTotal)}</strong>
          </div>
        </div>
      </div>

      <div className="grid cols-4">
        <div className="card">
          <h3>Household Income</h3>
          <div className="stat pos">{fmt(totals.income)}</div>
          <div className="muted">
            {totals.paycheckCount > 0
              ? `${totals.paycheckCount} paycheck${totals.paycheckCount === 1 ? '' : 's'} (${fmt(totals.paycheckPerCycle)}/cycle)`
              : `${transactions.filter((t) => t.type === 'income').length} inflow entries`}
          </div>
        </div>
        <div className="card">
          <h3>Spending</h3>
          <div className="stat neg">{fmt(totals.expense)}</div>
          <div className="muted">{transactions.filter((t) => t.type === 'expense').length} expense entries</div>
        </div>
        <div className="card">
          <h3>Net Cashflow</h3>
          <div className={'stat ' + (totals.net >= 0 ? 'pos' : 'neg')}>{fmt(totals.net)}</div>
          <div className="muted">{totals.net >= 0 ? `${savingsRate}% of income retained` : 'deficit alert'}</div>
        </div>
        <div className="card">
          <h3>Unbudgeted Income</h3>
          <div className={'stat ' + (totals.unbudgetedIncome >= 0 ? 'pos' : 'neg')}>{fmt(totals.unbudgetedIncome)}</div>
          <div className="muted">{fmt(totalBudgeted)} planned across {budgetSummary.length} categories</div>
        </div>
      </div>

      <div className="grid cols-4 hud-ops">
        <button type="button" className="hud-tile" onClick={() => onNavigate('Paychecks')}>
          <span className="hud-tile-kicker">PAYCHECKS & BILLS</span>
          <strong>
            {totals.paycheckCount > 0
              ? `${fmt(totals.paycheckPerCycle)}/check · ${unpaidBills.length} bills`
              : unpaidBills.length
              ? `${unpaidBills.length} due · ${fmt(unpaidTotal)}`
              : 'Set up paychecks'}
          </strong>
          <small>
            {unpaidBills[0]
              ? `Next bill: ${unpaidBills[0].title} (${unpaidBills[0].due})`
              : totals.nextPayday
              ? `Next payday: ${totals.nextPayday}`
              : 'Tap to enter what each paycheck is'}
          </small>
        </button>
        <button type="button" className="hud-tile" onClick={() => onNavigate('Groceries')}>
          <span className="hud-tile-kicker">SUPPLY & GROCERIES</span>
          <strong>{openGroceries} to buy</strong>
          <small>{stapleCount} saved on Always list</small>
        </button>
        <button type="button" className="hud-tile" onClick={() => onNavigate('Projects')}>
          <span className="hud-tile-kicker">HOME PROJECTS</span>
          <strong>{activeProjects} active</strong>
          <small>{(state.familyProjects || []).length} total tracked</small>
        </button>
        <button type="button" className="hud-tile" onClick={() => onNavigate('Date nights')}>
          <span className="hud-tile-kicker">DATE NIGHTS</span>
          <strong>{upcomingDates.length} planned</strong>
          <small>{upcomingDates[0] ? `Next: ${upcomingDates[0].title} (${upcomingDates[0].date})` : 'Tap to plan your next night out'}</small>
        </button>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Spending by category</h3>
          {cats.length === 0 && <div className="empty">No expenses yet.</div>}
          <div className="list">
            {cats.map(([c, v]) => {
              const share = totals.expense > 0 ? Math.round((v / totals.expense) * 100) : 0
              const limit = budgetSummary.find((b) => b.category.toLowerCase() === c.toLowerCase())?.effective || 0
              const pct = limit > 0 ? Math.min(100, (v / limit) * 100) : share
              const over = limit > 0 && v > limit
              return (
                <div className="item" key={c} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="left">
                      <span className="desc">{c}</span>
                      <span className="meta">{share}% of total spending{limit > 0 ? ` · budget ${fmt(limit)}` : ''}</span>
                    </div>
                    <span className="amount expense">{fmt(v)}</span>
                  </div>
                  <div className="bar">
                    <span className={over ? 'over' : ''} style={{ width: pct + '%' }} />
                  </div>
                </div>
              )
            })}
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
                    {allCategories(state).map((c) => (
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

function Budgets({ state, update, byCat, totals, onNavigate }) {
  const [cat, setCat] = useState('Food')
  const [customCat, setCustomCat] = useState('')
  const [amt, setAmt] = useState('')
  const [itemCat, setItemCat] = useState('Utilities')
  const [customItemCat, setCustomItemCat] = useState('')
  const [itemName, setItemName] = useState('')
  const [itemAmt, setItemAmt] = useState('')
  const [itemActual, setItemActual] = useState('')
  const [itemNotes, setItemNotes] = useState('')

  const categories = allCategories(state).filter((c) => c.toLowerCase() !== 'income')
  const entries = categoryBudgets(state, byCat)
  const items = state.budgetItems || []
  const totalPlanned = entries.reduce((s, e) => s + e.effective, 0)
  const totalActual = entries.reduce((s, e) => s + e.actual, 0)
  const totalVariance = totalPlanned - totalActual
  const monthlyIncome = totals?.income || 0
  const unbudgeted = monthlyIncome - totalPlanned
  const leftAfterActual = monthlyIncome - totalActual

  const setBudget = (e) => {
    e.preventDefault()
    const chosen = cat === '__custom__' ? canonicalCategory(state, customCat) : cat
    const v = parseFloat(amt)
    if (!chosen || chosen.toLowerCase() === 'income' || !v || v <= 0) return
    update({ budgets: { ...state.budgets, [chosen]: v } })
    setAmt('')
    if (cat === '__custom__') {
      setCat(chosen)
      setCustomCat('')
    }
  }
  const removeBudget = (c) => {
    const next = { ...state.budgets }
    delete next[c]
    const nextItems = (state.budgetItems || []).filter((x) => x.category.toLowerCase() !== c.toLowerCase())
    update({ budgets: next, budgetItems: nextItems })
  }
  const addLineItem = (e) => {
    e.preventDefault()
    const chosen = itemCat === '__custom__' ? canonicalCategory(state, customItemCat) : itemCat
    const name = itemName.trim()
    const v = parseFloat(itemAmt)
    const act = itemActual === '' ? 0 : parseFloat(itemActual)
    if (!chosen || chosen.toLowerCase() === 'income' || !name || isNaN(v) || v < 0 || isNaN(act) || act < 0) return
    const item = { id: crypto.randomUUID(), category: chosen, name, amount: v, actual: act, notes: itemNotes.trim() }
    update({ budgetItems: [...items, item] })
    setItemName('')
    setItemAmt('')
    setItemActual('')
    setItemNotes('')
    if (itemCat === '__custom__') {
      setItemCat(chosen)
      setCustomItemCat('')
    }
  }
  const patchLineItem = (id, patch) => {
    update({ budgetItems: items.map((x) => (x.id === id ? { ...x, ...patch } : x)) })
  }
  const removeLineItem = (id) => {
    update({ budgetItems: items.filter((x) => x.id !== id) })
  }

  return (
    <>
      <div className="grid cols-4" style={{ marginTop: 18 }}>
        <div className="card">
          <h3>Paycheck Income / Mo</h3>
          <div className="stat pos">{fmt(monthlyIncome)}</div>
          <div className="muted">
            {totals?.paycheckCount > 0 ? (
              <>{totals.paycheckCount} paycheck{totals.paycheckCount === 1 ? '' : 's'} ({fmt(totals.paycheckPerCycle)}/cycle)</>
            ) : (
              <button type="button" className="btn ghost" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => onNavigate && onNavigate('Paychecks')}>
                + Set paychecks →
              </button>
            )}
          </div>
        </div>
        <div className="card">
          <h3>Total Planned</h3>
          <div className="stat">{fmt(totalPlanned)}</div>
          <div className="muted">{entries.length} categories · {items.length} line items</div>
        </div>
        <div className="card">
          <h3>Unbudgeted Income</h3>
          <div className={'stat ' + (unbudgeted >= 0 ? 'pos' : 'neg')}>{fmt(unbudgeted)}</div>
          <div className="muted">{unbudgeted >= 0 ? 'income left to assign' : 'planned exceeds income'}</div>
        </div>
        <div className="card">
          <h3>Income Left After Actuals</h3>
          <div className={'stat ' + (leftAfterActual >= 0 ? 'pos' : 'neg')}>{fmt(leftAfterActual)}</div>
          <div className="muted">{fmt(totalActual)} spent · {fmt(totalVariance)} vs plan</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Add a budget line item</h3>
        <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
          Type each line item directly into your budget (for example Utilities → Columbia Gas, American Water, T-Mobile) with both a planned and actual amount, or edit any cell inline in the table below.
        </p>
        <form onSubmit={addLineItem}>
          <div className="row">
            <div className="field">
              <label htmlFor="budget-item-cat">Line item category</label>
              <select id="budget-item-cat" value={itemCat} onChange={(e) => setItemCat(e.target.value)}>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
                <option value="__custom__">+ New category…</option>
              </select>
            </div>
            {itemCat === '__custom__' && (
              <div className="field">
                <label htmlFor="budget-item-custom-cat">New category name</label>
                <input
                  id="budget-item-custom-cat"
                  value={customItemCat}
                  onChange={(e) => setCustomItemCat(e.target.value)}
                  placeholder="e.g. Subscriptions, Kids, Pets"
                  required
                />
              </div>
            )}
            <div className="field" style={{ flex: 2 }}>
              <label htmlFor="budget-item-name">Line item</label>
              <input
                id="budget-item-name"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="e.g. Columbia Gas, Netflix, Daycare"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="budget-item-amt">Planned ($)</label>
              <input
                id="budget-item-amt"
                type="number"
                step="0.01"
                min="0"
                value={itemAmt}
                onChange={(e) => setItemAmt(e.target.value)}
                placeholder="0.00"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="budget-item-actual">Actual ($)</label>
              <input
                id="budget-item-actual"
                type="number"
                step="0.01"
                min="0"
                value={itemActual}
                onChange={(e) => setItemActual(e.target.value)}
                placeholder="0.00 (optional)"
              />
            </div>
            <div className="field">
              <label htmlFor="budget-item-notes">Notes</label>
              <input
                id="budget-item-notes"
                value={itemNotes}
                onChange={(e) => setItemNotes(e.target.value)}
                placeholder="Due 15th, autopay…"
              />
            </div>
            <button className="btn" type="submit">Add line item</button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Set a category monthly limit</h3>
        <form onSubmit={setBudget}>
          <div className="row">
            <div className="field">
              <label htmlFor="budget-cat">Category</label>
              <select id="budget-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
                <option value="__custom__">+ New category…</option>
              </select>
            </div>
            {cat === '__custom__' && (
              <div className="field">
                <label htmlFor="budget-custom-cat">Category name</label>
                <input
                  id="budget-custom-cat"
                  value={customCat}
                  onChange={(e) => setCustomCat(e.target.value)}
                  placeholder="e.g. Giving, Childcare"
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="budget-limit">Limit</label>
              <input id="budget-limit" type="number" step="0.01" min="0" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
            </div>
            <button className="btn" type="submit">Save</button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Budgets vs. actual</h3>
        {entries.length === 0 && <div className="empty">No budgets set yet.</div>}
        <div className="list">
          {entries.map(({ category: c, effective: limit, actual: spent, txSpent, itemActualSum, items: catItems }) => {
            const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : spent > 0 ? 100 : 0
            const over = limit > 0 && spent > limit
            return (
              <div className="item budget-category-block" key={c} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <span className="desc">
                    {c}{' '}
                    {catItems.length > 0 && (
                      <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
                        ({catItems.length} line {catItems.length === 1 ? 'item' : 'items'})
                      </span>
                    )}
                  </span>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span className="meta">
                      {fmt(spent)} / {fmt(limit)} · <b style={{ color: limit - spent >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(limit - spent)} {limit - spent >= 0 ? 'left' : 'over'}</b> {over && <b style={{ color: 'var(--red)' }}>over</b>}
                    </span>
                    <button className="btn danger" onClick={() => removeBudget(c)}>Remove</button>
                  </div>
                </div>
                <div className="bar">
                  <span className={over ? 'over' : ''} style={{ width: pct + '%' }} />
                </div>
                {catItems.length === 0 && (
                  <div style={{ marginTop: 4 }}>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ padding: '6px 11px', fontSize: 12 }}
                      onClick={() => update({ budgetItems: [...items, { id: crypto.randomUUID(), category: c, name: 'New item', amount: 0, actual: 0, notes: '' }] })}
                    >
                      + Add line item row in {c}
                    </button>
                  </div>
                )}
                {catItems.length > 0 && (
                  <div className="sheet-wrap budget-sheet-wrap" style={{ marginTop: 6 }}>
                    <table className="sheet budget-sheet">
                      <thead>
                        <tr>
                          <th>Line item (click to type)</th>
                          <th>Notes</th>
                          <th className="num" style={{ width: 120 }}>Planned ($)</th>
                          <th className="num" style={{ width: 120 }}>Actual ($)</th>
                          <th className="num" style={{ width: 110 }}>Diff</th>
                          <th style={{ width: 44 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {catItems.map((it) => {
                          const act = Number(it.actual) || 0
                          const diff = (Number(it.amount) || 0) - act
                          return (
                            <tr key={it.id}>
                              <td>
                                <input
                                  aria-label={`${c} line item name`}
                                  value={it.name}
                                  placeholder="Line item name…"
                                  onChange={(e) => patchLineItem(it.id, { name: e.target.value })}
                                />
                              </td>
                              <td>
                                <input
                                  aria-label={`${it.name} notes`}
                                  value={it.notes || ''}
                                  placeholder="notes / due day…"
                                  onChange={(e) => patchLineItem(it.id, { notes: e.target.value })}
                                />
                              </td>
                              <td className="num">
                                <AmountCell value={it.amount} type="expense" onCommit={(n) => patchLineItem(it.id, { amount: n })} />
                              </td>
                              <td className="num">
                                <AmountCell value={act} type="expense" onCommit={(n) => patchLineItem(it.id, { actual: n })} />
                              </td>
                              <td className="num" style={{ padding: '0 8px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: diff >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                {diff >= 0 ? '+' : ''}{fmt(diff)}
                              </td>
                              <td className="rowtools">
                                <button title="Remove line item" aria-label={`Remove ${it.name}`} onClick={() => removeLineItem(it.id)}>✕</button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={2}>
                            <button
                              type="button"
                              className="btn ghost"
                              style={{ padding: '5px 10px', fontSize: 12, marginRight: 10 }}
                              onClick={() => update({ budgetItems: [...items, { id: crypto.randomUUID(), category: c, name: 'New item', amount: 0, actual: 0, notes: '' }] })}
                            >
                              + Add row
                            </button>
                            {c} line-item total {txSpent > 0 ? `(ledger transactions in ${c}: ${fmt(txSpent)})` : ''}
                          </td>
                          <td className="num">{fmt(limit)}</td>
                          <td className="num">{fmt(itemActualSum)}</td>
                          <td className="num" style={{ color: limit - itemActualSum >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {fmt(limit - itemActualSum)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
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

  const hasKey = !!(state._sharedAI || state.apiKey)

  const buildContext = () => {
    const paychecks = (state.paychecks || []).map((p) => `${p.name}${p.owner ? ` (${p.owner})` : ''}: ${fmt(p.amount)} ${p.frequency || 'Bi-weekly'}${p.date ? ` next ${p.date}` : ''}`).join('; ')
    const lines = [
      `Monthly household income (from paychecks/ledger): ${fmt(totals.income)} (unbudgeted: ${fmt(totals.unbudgetedIncome)})`,
      `Paychecks: ${paychecks || '(none configured yet)'}`,
      `Expense total: ${fmt(totals.expense)}`,
      `Net: ${fmt(totals.net)}`,
      'Spending by category: ' +
        Object.entries(totals.byCat)
          .map(([c, v]) => `${c} ${fmt(v)}`)
          .join(', '),
      'Budgets: ' +
        categoryBudgets(state)
          .map(({ category, effective, items }) => `${category} ${fmt(effective)}${items.length ? ` (${items.map((i) => `${i.name} ${fmt(i.amount)}`).join(', ')})` : ''}`)
          .join('; '),
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
      const res = await claudeRequest(state, {
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system:
            'You are a sharp, practical personal-finance advisor inside a budgeting app. ' +
            'Be concise and specific. Use the user\'s real numbers below. Give actionable suggestions, ' +
            'flag overspending, and never invent transactions.\n\nUSER FINANCIAL SNAPSHOT:\n' +
            buildContext(),
          messages: next.map((m) => ({ role: m.role, content: m.content })),
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
          Add your <b>Anthropic API key</b> in <b>Family settings</b> (shared app) or <b>Settings</b> (device app) to enable the advisor. The shared app stores your household key encrypted on the server and sends AI requests to Anthropic. Device-only keys are saved in this browser.
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
  const hasKey = !!(state._sharedAI || state.apiKey)

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

      const res = await claudeRequest(state, {
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
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
            Add your <b>Anthropic API key</b> in <b>Family settings</b> (shared app) or <b>Settings</b> (device app) to generate ideas.
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

function Settings({ state, update, setState, openFamily }) {
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
    const blob = new Blob([JSON.stringify(sharedState(state), null, 2)], { type: 'application/json' })
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
        <h3>{state._cloud ? 'Shared Claude API key' : 'Anthropic API key'}</h3>
        {state._cloud ? <><p>Configure one key for everyone in your household under Family settings.</p><button className="btn" onClick={openFamily}>Open family AI settings</button></> : <>
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
        </div></>}
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
          <button className="btn danger" onClick={reset}>Clear this device</button>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          {state._cloud ? 'Household data is stored on the family server. Clearing this device does not delete the shared household. Exports contain shared plans and budget records; API keys are excluded.' : 'Data is stored on this device until you import it into a family account.'}
        </p>
      </div>
    </>
  )
}

// --- In-app AI assistant (talks + edits your data) -------------------------
const PAGES = ['Dashboard', 'Calendar', 'Date nights', 'Projects', 'Groceries', 'Meals', 'Paychecks', 'Bill accounts', 'Ideas', 'Transactions', 'Budgets', 'Advisor', 'Opportunities', 'Family', 'Settings']

// Tools the model can call to mutate the ledger / budgets / navigate.
const AI_TOOLS = [
  {
    name: 'add_transaction',
    description: 'Add a new income or expense transaction to the ledger.',
    input_schema: {
      type: 'object',
      properties: {
        desc: { type: 'string', description: 'Short description, e.g. "Groceries"' },
        amount: { type: 'number', description: 'Positive dollar amount' },
        type: { type: 'string', enum: ['income', 'expense'] },
        category: { type: 'string', description: 'Spending or income category (default or custom)' },
        date: { type: 'string', description: 'YYYY-MM-DD; defaults to today if omitted' },
      },
      required: ['desc', 'amount', 'type'],
    },
  },
  {
    name: 'update_transaction',
    description: 'Edit fields of an existing transaction by its id. Only pass fields you want to change.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        desc: { type: 'string' },
        amount: { type: 'number' },
        type: { type: 'string', enum: ['income', 'expense'] },
        category: { type: 'string', description: 'Spending or income category (default or custom)' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_transaction',
    description: 'Delete a transaction by its id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'set_budget',
    description: 'Create or update a monthly budget limit for a spending category (default or custom).',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category name, e.g. Food, Utilities, Subscriptions' },
        limit: { type: 'number', description: 'Monthly limit in dollars, > 0' },
      },
      required: ['category', 'limit'],
    },
  },
  {
    name: 'add_budget_item',
    description: 'Add a line item inside a budget category (for example Utilities -> Columbia Gas planned $90, actual $85.42).',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category name (existing or new custom category)' },
        name: { type: 'string', description: 'Line item name, e.g. Columbia Gas, Netflix, Daycare' },
        amount: { type: 'number', description: 'Planned monthly amount in dollars, >= 0' },
        actual: { type: 'number', description: 'Optional actual dollar amount spent on this line item, >= 0' },
        notes: { type: 'string', description: 'Optional note or due day' },
      },
      required: ['category', 'name', 'amount'],
    },
  },
  {
    name: 'remove_budget_item',
    description: 'Remove a budget line item by its id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'add_paycheck',
    description: 'Add or define a household paycheck stream (what the paycheck is, earner, net amount, frequency, next payday) so the rest of the app flows off of that income.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Paycheck label, e.g. "Chris paycheck" or "Sarah paycheck"' },
        owner: { type: 'string', description: 'Household member / earner name' },
        amount: { type: 'number', description: 'Net take-home dollar amount per paycheck, >= 0' },
        frequency: { type: 'string', enum: PAYCHECK_FREQUENCIES },
        date: { type: 'string', description: 'Next payday YYYY-MM-DD' },
        notes: { type: 'string' },
      },
      required: ['name', 'amount'],
    },
  },
  {
    name: 'remove_paycheck',
    description: 'Remove a saved paycheck by its id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'remove_budget',
    description: 'Remove the budget for a category.',
    input_schema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
  },
  {
    name: 'navigate',
    description: 'Switch the app to a different page/tab.',
    input_schema: { type: 'object', properties: { page: { type: 'string', enum: PAGES } }, required: ['page'] },
  },
]

const newId = () => 't' + Date.now() + '-' + Math.floor(Math.random() * 1e4)
const cleanDate = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : todayISO())

// Execute one tool call against state. `stateRef` gives a live read of current
// state (setState is batched), and we return a short string result for the model.
function runAiTool(name, input, setState, stateRef, setTab) {
  switch (name) {
    case 'add_transaction': {
      const type = input.type === 'income' ? 'income' : 'expense'
      const category = input.category && String(input.category).trim()
        ? canonicalCategory(stateRef.current, input.category)
        : type === 'income'
        ? 'Income'
        : guessCategory(input.desc)
      const tx = {
        id: newId(),
        desc: input.desc || '',
        amount: Math.abs(Number(input.amount) || 0),
        type,
        category,
        date: cleanDate(input.date),
      }
      setState((s) => ({ ...s, transactions: [tx, ...s.transactions] }))
      return `Added ${tx.type} "${tx.desc}" ${fmt(tx.amount)} in ${tx.category} on ${tx.date} (id ${tx.id}).`
    }
    case 'update_transaction': {
      const cur = stateRef.current.transactions.find((t) => t.id === input.id)
      if (!cur) return `No transaction with id ${input.id}.`
      const patch = {}
      for (const k of ['desc', 'category', 'date']) if (input[k] != null) patch[k] = k === 'date' ? cleanDate(input[k]) : input[k]
      if (input.amount != null) patch.amount = Math.abs(Number(input.amount) || 0)
      if (input.type != null) patch.type = input.type === 'income' ? 'income' : 'expense'
      setState((s) => ({ ...s, transactions: s.transactions.map((t) => (t.id === input.id ? { ...t, ...patch } : t)) }))
      return `Updated ${input.id}: ${JSON.stringify(patch)}.`
    }
    case 'delete_transaction': {
      const cur = stateRef.current.transactions.find((t) => t.id === input.id)
      if (!cur) return `No transaction with id ${input.id}.`
      if (!confirm(`Delete "${cur.desc}" ${fmt(cur.amount)} (${cur.date})?`))
        return `User declined — "${cur.desc}" was NOT deleted.`
      setState((s) => ({ ...s, transactions: s.transactions.filter((t) => t.id !== input.id) }))
      return `Deleted ${input.id} ("${cur.desc}" ${fmt(cur.amount)}).`
    }
    case 'set_budget': {
      const c = canonicalCategory(stateRef.current, input.category)
      if (!c || c.toLowerCase() === 'income') return `Invalid category "${input.category}".`
      const v = Number(input.limit)
      if (!(v > 0)) return `Limit must be greater than 0.`
      setState((s) => ({ ...s, budgets: { ...s.budgets, [c]: v } }))
      return `Set ${c} budget to ${fmt(v)}.`
    }
    case 'add_budget_item': {
      const c = canonicalCategory(stateRef.current, input.category)
      const name = String(input.name || '').trim()
      const amount = Number(input.amount)
      const actual = input.actual != null ? Math.max(0, Number(input.actual) || 0) : 0
      const notes = input.notes ? String(input.notes).trim() : ''
      if (!c || c.toLowerCase() === 'income' || !name || !(amount >= 0)) return `Invalid budget line item.`
      const item = { id: crypto.randomUUID(), category: c, name, amount, actual, notes }
      setState((s) => ({ ...s, budgetItems: [...(s.budgetItems || []), item] }))
      return `Added budget line item "${name}" (planned ${fmt(amount)}, actual ${fmt(actual)}) under ${c} (id ${item.id}).`
    }
    case 'remove_budget_item': {
      const cur = (stateRef.current.budgetItems || []).find((x) => x.id === input.id)
      if (!cur) return `No budget line item with id ${input.id}.`
      setState((s) => ({ ...s, budgetItems: (s.budgetItems || []).filter((x) => x.id !== input.id) }))
      return `Removed budget line item "${cur.name}" from ${cur.category}.`
    }
    case 'add_paycheck': {
      const name = String(input.name || '').trim()
      const amount = Number(input.amount)
      const frequency = PAYCHECK_FREQUENCIES.includes(input.frequency) ? input.frequency : 'Bi-weekly'
      const date = input.date ? cleanDate(input.date) : todayISO()
      const owner = input.owner ? String(input.owner).trim() : ''
      const notes = input.notes ? String(input.notes).trim() : ''
      if (!name || !(amount >= 0)) return `Invalid paycheck.`
      const item = { id: crypto.randomUUID(), name, amount, frequency, date, owner, notes }
      setState((s) => ({ ...s, paychecks: [...(s.paychecks || []), item] }))
      return `Added paycheck "${name}" (${fmt(amount)} ${frequency}) (id ${item.id}).`
    }
    case 'remove_paycheck': {
      const cur = (stateRef.current.paychecks || []).find((x) => x.id === input.id)
      if (!cur) return `No paycheck with id ${input.id}.`
      setState((s) => ({ ...s, paychecks: (s.paychecks || []).filter((x) => x.id !== input.id) }))
      return `Removed paycheck "${cur.name}".`
    }
    case 'remove_budget': {
      const c = canonicalCategory(stateRef.current, input.category)
      const hasLimit = stateRef.current.budgets[c] != null
      const hasItems = (stateRef.current.budgetItems || []).some((x) => x.category.toLowerCase() === c.toLowerCase())
      if (!hasLimit && !hasItems) return `No budget set for "${c}".`
      if (!confirm(`Remove the ${c} budget?`))
        return `User declined — ${c} budget was NOT removed.`
      setState((s) => {
        const next = { ...s.budgets }
        delete next[c]
        return { ...s, budgets: next, budgetItems: (s.budgetItems || []).filter((x) => x.category.toLowerCase() !== c.toLowerCase()) }
      })
      return `Removed ${c} budget.`
    }
    case 'navigate': {
      if (!PAGES.includes(input.page)) return `Unknown page "${input.page}".`
      setTab(input.page)
      return `Switched to ${input.page}.`
    }
    default:
      return `Unknown tool "${name}".`
  }
}

function Assistant({ state, setState, totals, page, setTab }) {
  const [open, setOpen] = useState(false)
  const [convo, setConvo] = useState([]) // Anthropic-format messages (string or block[] content)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hasKey = !!(state._sharedAI || state.apiKey)

  // Live snapshot so tool executors read the latest state during the agent loop.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [convo, busy, open])

  const systemPrompt = () => {
    const tx = state.transactions
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 50)
      .map((t) => `${t.id} | ${t.date} | ${t.type} | ${t.category} | ${fmt(t.amount)} | ${t.desc}`)
      .join('\n')
    return (
      'You are the built-in assistant for the "House of Gyening · Budget" app. ' +
      'You can answer money questions AND directly change the user\'s data using the provided tools ' +
      '(add/update/delete transactions, set/remove budgets, navigate pages). ' +
      'When the user asks to add, log, change, fix, categorize, budget, or remove something, DO IT with a tool — do not just describe it. ' +
      'To edit or delete a specific transaction, use its id from the list below. ' +
      'After acting, confirm what you changed in one short sentence. Be concise and never invent transactions you weren\'t asked to add.\n\n' +
      `Today is ${todayISO()}. The user is currently on the "${page}" page.\n` +
      `Valid categories: ${allCategories(state).join(', ')} (or any new custom category).\n\n` +
      'SNAPSHOT:\n' +
      `Income ${fmt(totals.income)} (Paychecks per cycle ${fmt(totals.paycheckPerCycle)} · Unbudgeted ${fmt(totals.unbudgetedIncome)}) · Spending ${fmt(totals.expense)} · Net ${fmt(totals.net)}\n` +
      'Paychecks: ' +
      ((state.paychecks || []).map((p) => `${p.id}:${p.name}=${fmt(p.amount)} (${p.frequency || 'Bi-weekly'}, next ${p.date || 'unset'})`).join(', ') || '(none)') +
      '\nBudgets: ' +
      (categoryBudgets(state).map(({ category, effective, items }) => `${category} ${fmt(effective)}${items.length ? ` [${items.map((i) => `${i.id}:${i.name}=${fmt(i.amount)}`).join(', ')}]` : ''}`).join(', ') || '(none)') +
      '\n\nRecent transactions (id | date | type | category | amount | desc):\n' +
      (tx || '(none)')
    )
  }

  const send = async () => {
    const text = input.trim()
    if (!text || busy || !hasKey) return
    setError('')
    setInput('')
    let messages = [...convo, { role: 'user', content: text }]
    setConvo(messages)
    setBusy(true)
    try {
      for (let step = 0; step < 8; step++) {
        const res = await claudeRequest(state, {
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: systemPrompt(),
            tools: AI_TOOLS,
            messages,
          })
        if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`)
        const data = await res.json()
        const blocks = data.content || []
        messages = [...messages, { role: 'assistant', content: blocks }]
        setConvo(messages)

        const toolUses = blocks.filter((b) => b.type === 'tool_use')
        if (data.stop_reason === 'tool_use' && toolUses.length) {
          const results = toolUses.map((tu) => ({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: runAiTool(tu.name, tu.input, setState, stateRef, setTab),
          }))
          messages = [...messages, { role: 'user', content: results }]
          setConvo(messages)
          continue
        }
        break
      }
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // Flatten the API conversation into renderable rows.
  const rows = []
  for (const m of convo) {
    if (m.role === 'user' && typeof m.content === 'string') {
      rows.push({ kind: 'user', text: m.content })
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (text.trim()) rows.push({ kind: 'ai', text })
      for (const b of m.content) if (b.type === 'tool_use') rows.push({ kind: 'tool', text: b.name })
    }
    // tool_result messages are represented by their tool chip above — skip.
  }

  return (
    <div className="ai-dock">
      {open && (
        <div className="ai-panel">
          <div className="ai-head">
            <span>📚 Ask Rory · {page}</span>
            <div className="ai-head-tools">
              {convo.length > 0 && (
                <button className="ai-x" title="Clear chat" onClick={() => setConvo([])}>⟲</button>
              )}
              <button className="ai-x" title="Close" onClick={() => setOpen(false)}>✕</button>
            </div>
          </div>

          {!hasKey && (
            <div className="callout" style={{ margin: 10 }}>
              Add your <b>Anthropic API key</b> in <b>Family settings</b> (shared app) or <b>Settings</b> (device app) to use the assistant.
            </div>
          )}

          <div className="ai-body" ref={scrollRef}>
            {rows.length === 0 && (
              <div className="empty" style={{ padding: '8px 4px' }}>
                Try “add $40 groceries today”, “set Fun budget to $150”, or “where am I overspending?”
              </div>
            )}
            {rows.map((r, i) =>
              r.kind === 'tool' ? (
                <div key={i} className="ai-toolchip">🔧 {r.text}</div>
              ) : (
                <div key={i} className={'bubble ' + (r.kind === 'user' ? 'user' : 'ai')}>{r.text}</div>
              )
            )}
            {busy && <div className="bubble ai">Thinking…</div>}
            {error && <div className="callout" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}
          </div>

          <div className="ai-input">
            <input
              value={input}
              disabled={!hasKey || busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder={hasKey ? 'Talk to your budget…' : 'Add an API key in Settings'}
            />
            <button className="btn" disabled={!hasKey || busy} onClick={send}>Send</button>
          </div>
        </div>
      )}

      <button className="ai-fab" onClick={() => setOpen((o) => !o)} title="AI assistant">
        {open ? '✕' : '📚'}
      </button>
    </div>
  )
}

