import { useEffect, useMemo, useRef, useState } from 'react'
import Family from './Family.jsx'
import FamilyHQ from './FamilyHQ.jsx'
import useHousehold from './useHousehold'
import Account from './Account'
import DateNights from './DateNights'
import HomePlanning from './HomePlanning'
import BillAccounts from './BillAccounts'
import { CLAUDE_SUBSCRIPTION_MODELS, claudeRequest, openInClaudeSubscription } from './claude'
import { sharedState } from '../shared/sync'
import {
  DEBT_CATEGORIES,
  PAYCHECK_FREQUENCIES,
  allCategories,
  canonicalCategory,
  categoryBudgets,
  debtSummary,
  paycheckSummary,
  realtimeFinancialSnapshot,
  simulateDebtPayoff,
} from '../shared/budgets'
import { dateKey } from './family.js'

const LS_KEY = 'hog-budget-v1'
const CATEGORIES = ['Income', 'Housing', 'Food', 'Transport', 'Utilities', 'Debt', 'Health', 'Fun', 'Savings', 'Other']

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
  debts: [],
  claudeModel: 'claude-sonnet-4-6',
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
  const [installPrompt, setInstallPrompt] = useState(null)
  const [showInstallGuide, setShowInstallGuide] = useState(false)
  const [isStandalone, setIsStandalone] = useState(() =>
    typeof window !== 'undefined' &&
    (Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches) || window.navigator?.standalone === true)
  )
  const sync = useHousehold(loadState, LS_KEY)
  const { state, setState } = sync

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPrompt = (e) => {
      e.preventDefault()
      setInstallPrompt(e)
    }
    const onInstalled = () => {
      setInstallPrompt(null)
      setIsStandalone(true)
      setShowInstallGuide(false)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const handleInstallClick = async () => {
    if (installPrompt && typeof installPrompt.prompt === 'function') {
      try {
        await installPrompt.prompt()
        const choice = await installPrompt.userChoice
        if (choice?.outcome === 'accepted') setInstallPrompt(null)
        return
      } catch {
        // Fall through to manual guide
      }
    }
    setShowInstallGuide((v) => !v)
  }

  const [aiCommandText, setAiCommandText] = useState('')
  const [queuedAiPrompt, setQueuedAiPrompt] = useState('')
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
    const debt = debtSummary(state)
    const avalanche = simulateDebtPayoff(state.debts || [], 0, 'avalanche')
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
      debt,
      avalanche,
      byCat,
    }
  }, [state.transactions, state.paychecks, state.budgets, state.budgetItems, state.debts])

  const triggerAiCommand = (promptStr) => {
    const clean = String(promptStr ?? aiCommandText).trim()
    if (!clean) return
    setAiCommandText('')
    setQueuedAiPrompt(clean + '::' + Date.now())
  }

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
        {!isStandalone && (
          <button type="button" className="btn ghost install-app-btn" onClick={handleInstallClick}>
            {installPrompt ? '📲 Install App' : '📲 Save to Phone'}
          </button>
        )}
      </header>

      {showInstallGuide && (
        <div className="card install-banner" role="region" aria-label="Install app instructions">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, color: 'var(--text)' }}>📲 Save Family Hub as an App on Your Phone</h3>
            <button type="button" className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => setShowInstallGuide(false)}>Close</button>
          </div>
          <div className="grid cols-2" style={{ marginTop: 10 }}>
            <div className="callout">
              <b>iPhone / iPad (Safari):</b> Tap the <b>Share</b> button <span aria-hidden="true">(⬆)</span> at the bottom of Safari, scroll down and tap <b>Add to Home Screen</b>, then tap <b>Add</b>.
            </div>
            <div className="callout">
              <b>Android (Chrome):</b> Tap the <b>⋮ menu</b> in the top-right corner of Chrome and tap <b>Add to Home screen</b> or <b>Install app</b>.
            </div>
          </div>
        </div>
      )}

      <div className="family-connection"><span>{sync.account?.household ? sync.account.household.name : "Your family, in one place"}</span><button className="btn ghost" onClick={() => setTab('Family')}>{sync.account ? 'Family settings' : 'Family sign in'}</button></div>
      {sync.conflict && <p role="alert" className="family-error">A simultaneous edit needs your review. <button className="btn ghost" onClick={() => setTab('Family')}>Review changes</button></p>}
      <nav className="tabs" aria-label="App sections">
        {['Dashboard', 'Family HQ', 'Calendar', 'Date nights', 'Projects', 'Groceries', 'Meals', 'Paychecks', 'Debt', 'Bill accounts', 'Ideas', 'Transactions', 'Budgets', 'Advisor', 'Opportunities', 'Family', 'Settings'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <div className="ai-command-bar" role="region" aria-label="Real-time AI app controller">
        <span className="hud-tag" style={{ whiteSpace: 'nowrap' }}>⚡ AI LIVE CONTROL</span>
        <input
          aria-label="Ask AI to adjust the app"
          value={aiCommandText}
          onChange={(e) => setAiCommandText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && triggerAiCommand()}
          placeholder='Ask AI to adjust anything: "I have a $140 electric bill due 2026-11-18, adjust the app & show what’s left" or "Best steps to pay off my debt"'
        />
        <button type="button" className="btn" onClick={() => triggerAiCommand()}>
          Adjust & Calculate
        </button>
      </div>

      {tab === 'Family HQ' && <FamilyHQ state={state} setState={setState} onNavigate={setTab} />}
      {['Calendar', 'Projects', 'Ideas'].includes(tab) && <Family tab={tab} state={state} setState={setState} onNavigate={setTab} />}
      {tab === 'Family' && <Account sync={sync} />}
      {tab === 'Bill accounts' && <BillAccounts sync={sync} onNavigate={setTab} />}
      {tab === 'Date nights' && <DateNights state={state} setState={setState} />}
      {['Groceries', 'Meals', 'Paychecks'].includes(tab) && <HomePlanning tab={tab} state={state} setState={setState} onNavigate={setTab} />}
      {tab === 'Debt' && <DebtPlanner state={state} setState={setState} totals={totals} onNavigate={setTab} onAskAi={triggerAiCommand} />}
      {tab === 'Dashboard' && <Dashboard state={state} totals={totals} transactions={state.transactions} onNavigate={setTab} />}
      {tab === 'Transactions' && <Transactions state={state} setState={setState} />}
      {tab === 'Budgets' && <Budgets state={state} update={update} byCat={totals.byCat} totals={totals} onNavigate={setTab} />}
      {tab === 'Advisor' && <Advisor state={state} setState={setState} totals={totals} setTab={setTab} />}
      {tab === 'Opportunities' && <Opportunities state={state} totals={totals} update={update} />}
      {tab === 'Settings' && <Settings state={state} update={update} setState={setState} openFamily={() => setTab('Family')} onInstall={handleInstallClick} isStandalone={isStandalone} hasPrompt={!!installPrompt} />}

      <p className="foot">House of Gyening · Family Hub · Your household, together.</p>

      <Assistant state={state} setState={setState} totals={totals} page={tab} setTab={setTab} queuedPrompt={queuedAiPrompt} onConsumePrompt={() => setQueuedAiPrompt('')} />
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
          <p className="muted">Real-time cashflow, itemized budgets, debt payoff trajectory, upcoming utility obligations, and family logistics.</p>
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
          <div className="hud-chip">
            <span>TOTAL DEBT</span>
            <strong className={totals.debt?.totalBalance > 0 ? 'neg' : 'pos'}>{fmt(totals.debt?.totalBalance || 0)}</strong>
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
        <button type="button" className="hud-tile" onClick={() => onNavigate('Debt')}>
          <span className="hud-tile-kicker">DEBT PAYOFF ENGINE</span>
          <strong>
            {totals.debt?.count > 0
              ? `${fmt(totals.debt.totalBalance)} · ${totals.avalanche?.months || 0} mo`
              : '0 active debts'}
          </strong>
          <small>
            {totals.debt?.count > 0
              ? `${fmt(totals.debt.totalMonthlyPayment)}/mo · Avg ${totals.debt.weightedApr.toFixed(1)}% APR`
              : 'Track debt & calculate fastest payoff'}
          </small>
        </button>
        <button type="button" className="hud-tile" onClick={() => onNavigate('Groceries')}>
          <span className="hud-tile-kicker">SUPPLY & GROCERIES</span>
          <strong>{openGroceries} to buy</strong>
          <small>{stapleCount} saved on Always list</small>
        </button>
        <button type="button" className="hud-tile" onClick={() => onNavigate('Date nights')}>
          <span className="hud-tile-kicker">DATE NIGHTS & PROJECTS</span>
          <strong>{upcomingDates.length} dates · {activeProjects} projects</strong>
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
// etc., while updating parent totals live on every keystroke.
function AmountCell({ value, type, onCommit, ariaLabel }) {
  const [raw, setRaw] = useState(value === 0 ? '' : String(value ?? ''))
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) {
      setRaw(value === 0 ? '' : String(value ?? ''))
    }
  }, [value])
  const handleChange = (e) => {
    const v = e.target.value
    setRaw(v)
    if (v === '') {
      onCommit(0)
      return
    }
    const n = parseFloat(v)
    if (!isNaN(n)) onCommit(n)
  }
  const commit = () => {
    focusedRef.current = false
    const n = parseFloat(raw)
    const clean = isNaN(n) ? 0 : n
    onCommit(clean)
    setRaw(clean === 0 ? '' : String(clean))
  }
  return (
    <input
      type="number"
      step="0.01"
      inputMode="decimal"
      placeholder="0.00"
      aria-label={ariaLabel}
      className={'cell-num ' + type}
      value={raw}
      onFocus={() => {
        focusedRef.current = true
      }}
      onChange={handleChange}
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
  const [editingId, setEditingId] = useState(null)
  const [itemCat, setItemCat] = useState('Utilities')
  const [customItemCat, setCustomItemCat] = useState('')
  const [itemName, setItemName] = useState('')
  const [itemAmt, setItemAmt] = useState('')
  const [itemActual, setItemActual] = useState('')
  const [itemNotes, setItemNotes] = useState('')
  const formCardRef = useRef(null)
  const nameInputRef = useRef(null)

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
  const resetLineItemForm = () => {
    setEditingId(null)
    setItemName('')
    setItemAmt('')
    setItemActual('')
    setItemNotes('')
  }
  const startEditLineItem = (it) => {
    setEditingId(it.id)
    setItemCat(it.category || 'Utilities')
    setCustomItemCat('')
    setItemName(it.name || '')
    setItemAmt(String(it.amount ?? 0))
    setItemActual(String(it.actual ?? 0))
    setItemNotes(it.notes || '')
    formCardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    setTimeout(() => nameInputRef.current?.focus?.(), 60)
  }
  const addLineItem = (e) => {
    e.preventDefault()
    const chosen = itemCat === '__custom__' ? canonicalCategory(state, customItemCat) : itemCat
    const name = itemName.trim()
    const v = parseFloat(itemAmt)
    const act = itemActual === '' ? 0 : parseFloat(itemActual)
    if (!chosen || chosen.toLowerCase() === 'income' || !name || isNaN(v) || v < 0 || isNaN(act) || act < 0) return
    if (editingId && items.some((x) => x.id === editingId)) {
      update({
        budgetItems: items.map((x) =>
          x.id === editingId ? { ...x, category: chosen, name, amount: v, actual: act, notes: itemNotes.trim() } : x
        ),
      })
      resetLineItemForm()
    } else {
      const item = { id: crypto.randomUUID(), category: chosen, name, amount: v, actual: act, notes: itemNotes.trim() }
      update({ budgetItems: [...items, item] })
      setItemName('')
      setItemAmt('')
      setItemActual('')
      setItemNotes('')
    }
    if (itemCat === '__custom__') {
      setItemCat(chosen)
      setCustomItemCat('')
    }
  }
  const patchLineItem = (id, patch) => {
    update({ budgetItems: items.map((x) => (x.id === id ? { ...x, ...patch } : x)) })
  }
  const duplicateLineItem = (id) => {
    const src = items.find((x) => x.id === id)
    if (!src) return
    const idx = items.findIndex((x) => x.id === id)
    const copy = { ...src, id: crypto.randomUUID(), name: `${src.name} (copy)` }
    const next = [...items]
    next.splice(idx + 1, 0, copy)
    update({ budgetItems: next })
  }
  const removeLineItem = (id) => {
    if (editingId === id) resetLineItemForm()
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

      <div
        className="card"
        ref={formCardRef}
        style={{
          marginTop: 14,
          borderColor: editingId ? 'var(--cyan)' : undefined,
          boxShadow: editingId ? '0 0 24px rgba(37, 208, 246, 0.18)' : undefined,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>{editingId ? `✏️ Editing budget line item: ${itemName || 'Line item'}` : 'Add or edit a budget line item'}</h3>
          {editingId && (
            <button type="button" className="btn ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={resetLineItemForm}>
              Cancel edit
            </button>
          )}
        </div>
        <p className="muted" style={{ marginTop: 4, marginBottom: 12 }}>
          Add a new line item below, click <b>✏️ Edit</b> on any existing item to load it into this form, or click directly into any box in the table to edit its Category, Name, Notes, Planned ($), or Actual ($) in real time.
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
                ref={nameInputRef}
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
            <button className="btn" type="submit">{editingId ? 'Save line item' : 'Add line item'}</button>
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
        <h3>Budgets vs. actual (edit any category or line item below)</h3>
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
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {catItems.length === 0 && (
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>
                        Monthly limit ($):
                        <span style={{ width: 105, display: 'inline-block' }}>
                          <AmountCell
                            ariaLabel={`${c} monthly limit`}
                            value={limit}
                            type="expense"
                            onCommit={(n) => update({ budgets: { ...state.budgets, [c]: Math.max(0, n) } })}
                          />
                        </span>
                      </label>
                    )}
                    <span className="meta">
                      {fmt(spent)} / {fmt(limit)} · <b style={{ color: limit - spent >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(limit - spent)} {limit - spent >= 0 ? 'left' : 'over'}</b> {over && <b style={{ color: 'var(--red)' }}>over</b>}
                    </span>
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ padding: '6px 10px', fontSize: 12 }}
                      onClick={() => {
                        const created = { id: crypto.randomUUID(), category: c, name: catItems.length === 0 ? `${c} item` : 'New item', amount: catItems.length === 0 ? limit : 0, actual: 0, notes: '' }
                        update({ budgetItems: [...items, created] })
                        startEditLineItem(created)
                      }}
                    >
                      + Add line item in {c}
                    </button>
                    <button className="btn danger" onClick={() => removeBudget(c)}>Remove</button>
                  </div>
                </div>
                <div className="bar">
                  <span className={over ? 'over' : ''} style={{ width: pct + '%' }} />
                </div>
                {catItems.length > 0 && (
                  <div className="sheet-wrap budget-sheet-wrap" style={{ marginTop: 6 }}>
                    <table className="sheet budget-sheet">
                      <thead>
                        <tr>
                          <th style={{ minWidth: 160 }}>Line item name</th>
                          <th style={{ width: 135 }}>Category</th>
                          <th style={{ minWidth: 140 }}>Notes / Due day</th>
                          <th className="num" style={{ width: 120 }}>Planned ($)</th>
                          <th className="num" style={{ width: 120 }}>Actual ($)</th>
                          <th className="num" style={{ width: 105 }}>Diff</th>
                          <th style={{ width: 118, textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {catItems.map((it) => {
                          const act = Number(it.actual) || 0
                          const diff = (Number(it.amount) || 0) - act
                          const isEditingThis = editingId === it.id
                          return (
                            <tr
                              key={it.id}
                              style={isEditingThis ? { background: 'rgba(37, 208, 246, 0.12)' } : undefined}
                            >
                              <td>
                                <input
                                  aria-label={`${c} line item name`}
                                  value={it.name}
                                  placeholder="Line item name…"
                                  onChange={(e) => patchLineItem(it.id, { name: e.target.value })}
                                />
                              </td>
                              <td>
                                <select
                                  aria-label={`${it.name} category`}
                                  value={it.category || c}
                                  onChange={(e) => patchLineItem(it.id, { category: e.target.value })}
                                >
                                  {categories.map((catOpt) => (
                                    <option key={catOpt} value={catOpt}>{catOpt}</option>
                                  ))}
                                </select>
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
                                <AmountCell
                                  ariaLabel={`${it.name} planned amount`}
                                  value={it.amount}
                                  type="expense"
                                  onCommit={(n) => patchLineItem(it.id, { amount: n })}
                                />
                              </td>
                              <td className="num">
                                <AmountCell
                                  ariaLabel={`${it.name} actual amount`}
                                  value={act}
                                  type="expense"
                                  onCommit={(n) => patchLineItem(it.id, { actual: n })}
                                />
                              </td>
                              <td className="num" style={{ padding: '0 8px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: diff >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                {diff >= 0 ? '+' : ''}{fmt(diff)}
                              </td>
                              <td className="rowtools" style={{ textAlign: 'right' }}>
                                <button
                                  type="button"
                                  title="Edit in form"
                                  aria-label={`Edit ${it.name}`}
                                  onClick={() => startEditLineItem(it)}
                                  style={{ color: isEditingThis ? 'var(--cyan)' : 'var(--green)', fontSize: 12, fontWeight: 600 }}
                                >
                                  ✏️ Edit
                                </button>
                                <button
                                  type="button"
                                  title="Duplicate line item"
                                  aria-label={`Duplicate ${it.name}`}
                                  onClick={() => duplicateLineItem(it.id)}
                                >
                                  ⧉
                                </button>
                                <button
                                  type="button"
                                  title="Remove line item"
                                  aria-label={`Remove ${it.name}`}
                                  onClick={() => removeLineItem(it.id)}
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3}>
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

function Advisor({ state, setState, totals, setTab }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const hasKey = !!(state._sharedAI || state.apiKey)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const mutateState = (updater) => {
    const next = typeof updater === 'function' ? updater(stateRef.current) : updater
    stateRef.current = next
    setState(next)
  }

  const buildContext = () => {
    const snap = realtimeFinancialSnapshot(stateRef.current)
    const paychecks = (stateRef.current.paychecks || []).map((p) => `${p.name}${p.owner ? ` (${p.owner})` : ''}: ${fmt(p.amount)} ${p.frequency || 'Bi-weekly'}${p.date ? ` next ${p.date}` : ''}`).join('; ')
    const bills = (stateRef.current.bills || []).map((b) => `${b.id}:${b.title} ${fmt(b.amount)} due ${b.due} (${b.paid ? 'paid' : 'unpaid'})`).join('; ')
    const debts = (stateRef.current.debts || []).map((d) => `${d.id}:${d.name} (${d.category || 'Debt'}) balance ${fmt(d.balance)} @ ${d.apr}% APR, min ${fmt(d.minPayment)}/mo, extra ${fmt(d.extraPayment || 0)}/mo${d.due ? ` due ${d.due}` : ''}`).join('; ')
    const lines = [
      `Monthly household income (from paychecks/ledger): ${fmt(snap.monthlyIncome)} (unbudgeted: ${fmt(snap.unbudgetedMonthlyIncome)})`,
      `Next paycheck cash available: ${fmt(snap.availableOnNextPaycheck)} | Unpaid bills due through payday (${snap.nextPayday || 'unset'}): ${fmt(snap.unpaidBillsThroughPayday)} | Remaining after payday bills: ${fmt(snap.remainingAfterPaydayBills)}`,
      `Paychecks: ${paychecks || '(none configured yet)'}`,
      `Bills: ${bills || '(none)'}`,
      `Debts: ${debts || '(none)'}`,
      `Avalanche debt payoff: ${snap.avalanche.months} months (${snap.avalanche.debtFreeDate}), total interest ${fmt(snap.avalanche.totalInterest)}, saves ${fmt(snap.avalanche.interestSaved)}`,
      `Expense total: ${fmt(totals.expense)} | Net: ${fmt(totals.net)}`,
      'Budgets: ' +
        categoryBudgets(stateRef.current)
          .map(({ category, effective, items }) => `${category} ${fmt(effective)}${items.length ? ` (${items.map((i) => `${i.name} ${fmt(i.amount)}`).join(', ')})` : ''}`)
          .join('; '),
    ]
    return lines.join('\n')
  }

  const send = async (overrideText) => {
    const text = String(overrideText ?? input).trim()
    if (!text || busy) return
    setError('')
    setInput('')
    if (!hasKey) {
      const reply = runLocalAssistantFallback(text, mutateState, stateRef, setTab)
      setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: reply }])
      return
    }
    let convo = [...messages, { role: 'user', content: text }]
    setMessages(convo)
    setBusy(true)
    try {
      for (let step = 0; step < 10; step++) {
        const res = await claudeRequest(stateRef.current, {
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system:
            'You are the full-app AI Financial Controller & Debt Strategist for "House of Gyening · Family Hub". ' +
            'You can directly adjust ANY part of the app in real time using your tools: bills, paychecks, budgets, budget line items, debts, transactions, groceries, meals, and calendar events. ' +
            'When the user says they have a bill due on a certain day or asks to adjust the app to reflect what is left, call `upsert_bill` (which also syncs to Budgets) and report the exact real-time remaining balance on their next paycheck and monthly budget. ' +
            'When the user asks how to pay off debt or for best steps, call `calculate_debt_payoff` (and `upsert_debt` if they mention a debt) and give clear numbered steps comparing Avalanche vs. Snowball.\n\nLIVE HOUSEHOLD SNAPSHOT:\n' +
            buildContext(),
          tools: AI_TOOLS,
          messages: convo,
        })
        if (!res.ok) {
          const body = await res.text()
          throw new Error(`API ${res.status}: ${body.slice(0, 300)}`)
        }
        const data = await res.json()
        const blocks = data?.content || []
        convo = [...convo, { role: 'assistant', content: blocks }]
        setMessages(convo)
        const toolUses = blocks.filter((b) => b.type === 'tool_use')
        if (data.stop_reason === 'tool_use' && toolUses.length) {
          const results = toolUses.map((tu) => ({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: runAiTool(tu.name, tu.input, mutateState, stateRef, setTab),
          }))
          convo = [...convo, { role: 'user', content: results }]
          setMessages(convo)
          continue
        }
        break
      }
    } catch (e) {
      const fallbackReply = runLocalAssistantFallback(text, mutateState, stateRef, setTab)
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          content:
            fallbackReply +
            `\n\n(Note: Switched to built-in Smart Controller because the saved key returned an API error — to use your Claude Pro/Max subscription directly, run \`claude setup-token\` and paste your \`sk-ant-oat01-…\` subscription token in Family settings, or click "💬 Talk in Claude.ai Subscription ↗" above.)`,
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  const renderRows = []
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string') renderRows.push({ kind: 'user', text: m.content })
    else if (m.role === 'assistant' && typeof m.content === 'string') renderRows.push({ kind: 'ai', text: m.content })
    else if (m.role === 'assistant' && Array.isArray(m.content)) {
      const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (t.trim()) renderRows.push({ kind: 'ai', text: t })
      for (const b of m.content) if (b.type === 'tool_use') renderRows.push({ kind: 'tool', text: b.name })
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 style={{ margin: 0 }}>AI Money Advisor & Real-Time Controller · {state.claudeModel || 'claude-sonnet-4-6'}</h3>
        <div className="row" style={{ gap: 8 }}>
          <select
            aria-label="Claude subscription model"
            value={state.claudeModel || 'claude-sonnet-4-6'}
            onChange={(e) => mutateState((s) => ({ ...s, claudeModel: e.target.value }))}
            style={{ width: 'auto', padding: '6px 10px', fontSize: 12.5 }}
          >
            {CLAUDE_SUBSCRIPTION_MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn ghost"
            onClick={() => openInClaudeSubscription(input, buildContext())}
            title="Copies your live household snapshot + question and opens your Claude.ai Pro/Max subscription"
          >
            💬 Talk in Claude.ai Subscription ↗
          </button>
        </div>
      </div>
      {!hasKey && (
        <div className="callout" style={{ marginBottom: 12, marginTop: 10 }}>
          <b>Claude Subscription Support + Instant Local Control:</b> Connect your <b>Claude Pro / Max subscription token</b> (run <code>claude setup-token</code> to get <code>sk-ant-oat01-…</code>) in <b>Family settings</b> or <b>Settings</b>—or click <b>💬 Talk in Claude.ai Subscription ↗</b> above to chat in your Claude subscription with your live household numbers pre-copied!
        </div>
      )}

      <div className="row" style={{ gap: 8, marginBottom: 12, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost" onClick={() => send('What is left on my next paycheck and monthly budget right now?')}>
          📊 What’s left right now?
        </button>
        <button type="button" className="btn ghost" onClick={() => send('Give me the best step-by-step plan to pay off my debt fastest.')}>
          🎯 Best steps to pay off debt
        </button>
        <button type="button" className="btn ghost" onClick={() => send('I have a $125 electric bill due on ' + todayISO() + ', adjust the app to reflect real-time what is left.')}>
          ⚡ Test real-time bill adjustment
        </button>
      </div>

      <div className="chat">
        {renderRows.length === 0 && (
          <div className="empty">
            Try: “I have a $140 electric bill due on 2026-11-18, can we adjust the app to reflect real-time what’s left?” or “Give me the best steps to pay off my debt.”
          </div>
        )}
        {renderRows.map((m, i) =>
          m.kind === 'tool' ? (
            <div key={i} className="ai-toolchip">🔧 Adjusted via {m.text}</div>
          ) : (
            <div key={i} className={'bubble ' + (m.kind === 'user' ? 'user' : 'ai')}>
              {m.text}
            </div>
          )
        )}
        {busy && <div className="bubble ai">Adjusting app & calculating…</div>}
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
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Tell the advisor about a bill due date, paycheck, budget change, or debt payoff goal…"
          />
        </div>
        <button className="btn" disabled={busy} onClick={() => send()}>
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

function Settings({ state, update, setState, openFamily, onInstall, isStandalone, hasPrompt }) {
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
        <h3>📲 Save as App on Your Phone</h3>
        {isStandalone ? (
          <div className="callout">
            <b>Installed ✓</b> — You are running Family Hub as a standalone home-screen app.
          </div>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 10 }}>
              Install House of Gyening · Family Hub on your iPhone or Android home screen for full-screen, one-tap access.
            </p>
            <div className="row" style={{ marginBottom: 10 }}>
              <button type="button" className="btn" onClick={onInstall}>
                {hasPrompt ? '📲 Install App Now' : '📲 Show Phone Install Steps'}
              </button>
            </div>
            <div className="grid cols-2">
              <div className="callout">
                <b>iPhone / iPad (Safari):</b> Tap <b>Share (⬆)</b> → <b>Add to Home Screen</b> → <b>Add</b>.
              </div>
              <div className="callout">
                <b>Android (Chrome):</b> Tap <b>⋮ Menu</b> → <b>Install app</b> (or <b>Add to Home screen</b>).
              </div>
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>{state._cloud ? 'Shared Claude Subscription & Model' : 'Claude Subscription Model & Token'}</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor="settings-claude-model">Claude Subscription Model</label>
            <select
              id="settings-claude-model"
              value={state.claudeModel || 'claude-sonnet-4-6'}
              onChange={(e) => update({ claudeModel: e.target.value })}
            >
              {CLAUDE_SUBSCRIPTION_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>
        {state._cloud ? <><p>Configure your shared Claude Pro / Max subscription token (<code>sk-ant-oat01-…</code> from <code>claude setup-token</code>) or key for everyone in your household under Family settings.</p><button className="btn" onClick={openFamily}>Open family AI settings</button></> : <>
        <div className="callout" style={{ marginBottom: 12 }}>
          <b>Use your Claude Pro / Max Subscription:</b> Run <code>claude setup-token</code> in your terminal to generate your subscription OAuth token (<code>sk-ant-oat01-…</code>) and paste it below so the app talks through your Claude subscription (or paste a standard <code>sk-ant-…</code> key). Stored only in <b>this browser</b>.
        </div>
        <div className="row">
          <div className="field" style={{ flex: 3 }}>
            <label>Claude Subscription Token or Key (sk-ant-oat01-… / sk-ant-…)</label>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-oat01-..." />
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

function DebtPlanner({ state, setState, totals, onNavigate, onAskAi }) {
  const [strategy, setStrategy] = useState('avalanche')
  const [extraMonthly, setExtraMonthly] = useState(0)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('Credit Card')
  const [balance, setBalance] = useState('')
  const [apr, setApr] = useState('')
  const [minPayment, setMinPayment] = useState('')
  const [extraPayment, setExtraPayment] = useState('')
  const [due, setDue] = useState(todayISO())
  const [notes, setNotes] = useState('')
  const [syncBillBudget, setSyncBillBudget] = useState(true)
  const [notice, setNotice] = useState('')

  const debts = state.debts || []
  const summary = debtSummary(state)
  const plan = simulateDebtPayoff(debts, extraMonthly, strategy)
  const altPlan = simulateDebtPayoff(debts, extraMonthly, strategy === 'avalanche' ? 'snowball' : 'avalanche')
  const rankMap = new Map(plan.order.map((o) => [o.id, o]))
  const snap = realtimeFinancialSnapshot(state)
  const suggestedExtra = Math.max(0, Math.round(Math.max(0, snap.unbudgetedMonthlyIncome) * 0.5))

  const syncDebtToBillAndBudget = (debtItem, s) => {
    const monthlyPay = (Number(debtItem.minPayment) || 0) + (Number(debtItem.extraPayment) || 0)
    const billId = `debt-bill-${debtItem.id}`
    const budgetItemId = `debt-budget-${debtItem.id}`
    const nextBills =
      monthlyPay > 0 && debtItem.due
        ? [
            ...(s.bills || []).filter((b) => b.id !== billId && b.title.toLowerCase() !== debtItem.name.toLowerCase()),
            { id: billId, title: `${debtItem.name} (Debt Payment)`, amount: monthlyPay, due: debtItem.due, paid: false },
          ]
        : s.bills || []
    const nextBudgetItems =
      monthlyPay > 0
        ? [
            ...(s.budgetItems || []).filter((x) => x.id !== budgetItemId && !(x.category === 'Debt' && x.name.toLowerCase() === debtItem.name.toLowerCase())),
            {
              id: budgetItemId,
              category: 'Debt',
              name: debtItem.name,
              amount: monthlyPay,
              actual: 0,
              notes: `${debtItem.apr}% APR · Balance ${fmt(debtItem.balance)}${debtItem.due ? ` · Due ${debtItem.due}` : ''}`,
            },
          ]
        : s.budgetItems || []
    return { ...s, bills: nextBills, budgetItems: nextBudgetItems }
  }

  const addDebt = (e) => {
    e.preventDefault()
    const cleanName = name.trim()
    const bal = parseFloat(balance)
    const rate = parseFloat(apr)
    const min = parseFloat(minPayment)
    const extra = extraPayment === '' ? 0 : parseFloat(extraPayment)
    if (!cleanName || isNaN(bal) || bal < 0) return
    const item = {
      id: crypto.randomUUID(),
      name: cleanName,
      category,
      balance: Math.max(0, bal),
      apr: isNaN(rate) ? 0 : Math.max(0, rate),
      minPayment: isNaN(min) ? 0 : Math.max(0, min),
      extraPayment: isNaN(extra) ? 0 : Math.max(0, extra),
      due: due || '',
      notes: notes.trim(),
    }
    setState((s) => {
      const withDebt = { ...s, debts: [...(s.debts || []), item] }
      return syncBillBudget ? syncDebtToBillAndBudget(item, withDebt) : withDebt
    })
    setName('')
    setBalance('')
    setApr('')
    setMinPayment('')
    setExtraPayment('')
    setNotes('')
    setNotice(
      `Added "${item.name}" (${fmt(item.balance)} @ ${item.apr}% APR)${syncBillBudget ? ' and synced its payment to Bills & Budgets.' : '.'}`
    )
  }

  const patchDebt = (id, patch) => {
    setState((s) => ({
      ...s,
      debts: (s.debts || []).map((d) => (d.id === id ? { ...d, ...patch } : d)),
    }))
  }

  const removeDebt = (id) => {
    setState((s) => ({
      ...s,
      debts: (s.debts || []).filter((d) => d.id !== id),
      bills: (s.bills || []).filter((b) => b.id !== `debt-bill-${id}`),
      budgetItems: (s.budgetItems || []).filter((x) => x.id !== `debt-budget-${id}`),
    }))
  }

  const payDebtNow = (d) => {
    const payAmt = (Number(d.minPayment) || 0) + (Number(d.extraPayment) || 0) || Math.min(100, Number(d.balance) || 0)
    if (payAmt <= 0) return
    const nextBal = Math.max(0, (Number(d.balance) || 0) - payAmt)
    const tx = {
      id: `debt-tx-${d.id}-${Date.now()}`,
      desc: `Debt payment · ${d.name}`,
      amount: payAmt,
      category: 'Debt',
      type: 'expense',
      date: todayISO(),
    }
    setState((s) => ({
      ...s,
      debts: (s.debts || []).map((x) => (x.id === d.id ? { ...x, balance: nextBal } : x)),
      bills: (s.bills || []).map((b) => (b.id === `debt-bill-${d.id}` || b.title.toLowerCase().includes(d.name.toLowerCase()) ? { ...b, paid: true } : b)),
      transactions: [tx, ...(s.transactions || [])],
    }))
    setNotice(`Logged ${fmt(payAmt)} payment toward ${d.name}. New balance: ${fmt(nextBal)}.`)
  }

  return (
    <section className="family-space">
      <p className="family-eyebrow">DEBT ELIMINATION & PAYOFF CALCULATOR</p>
      <h2>Household Debt Ledger & Payoff Strategy</h2>

      <div className="grid cols-4" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Total Debt Balance</h3>
          <div className={'stat ' + (summary.totalBalance > 0 ? 'neg' : 'pos')}>{fmt(summary.totalBalance)}</div>
          <div className="muted">{summary.count} active debt account{summary.count === 1 ? '' : 's'}</div>
        </div>
        <div className="card">
          <h3>Monthly Debt Payments</h3>
          <div className="stat">{fmt(summary.totalMonthlyPayment + Number(extraMonthly || 0))}</div>
          <div className="muted">{fmt(summary.totalMinPayment)} minimums + {fmt(summary.totalExtraPayment + Number(extraMonthly || 0))} extra</div>
        </div>
        <div className="card">
          <h3>Monthly Interest Burn</h3>
          <div className="stat neg">{fmt(summary.monthlyInterest)}/mo</div>
          <div className="muted">Weighted avg {summary.weightedApr.toFixed(2)}% APR</div>
        </div>
        <div className="card">
          <h3>Debt-Free Countdown</h3>
          <div className="stat pos">{plan.months === 0 ? 'Debt-Free!' : `${plan.months} mo`}</div>
          <div className="muted">
            {plan.months > 0 ? `Est. ${plan.debtFreeDate} · saves ${fmt(plan.interestSaved)} interest` : 'Add your debts below to calculate'}
          </div>
        </div>
      </div>

      {notice && <p role="status" className="family-notice">{notice}</p>}

      <div className="family-card">
        <span className="hud-tag">STEP 1 · DEBT COLUMN & ACCOUNTS</span>
        <h3 style={{ marginTop: 6 }}>1. Add & Track Your Debts</h3>
        <p>Enter credit cards, auto loans, student loans, personal loans, or medical balances. Edit any cell inline below, or sync payments directly into Bills and Budgets so your whole app reflects what’s left in real time.</p>
        <form onSubmit={addDebt}>
          <div className="row">
            <div className="field" style={{ flex: 2 }}>
              <label htmlFor="debt-name">Debt / Account name</label>
              <input id="debt-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chase Sapphire, Auto Loan, Student Loan" required />
            </div>
            <div className="field">
              <label htmlFor="debt-cat">Type</label>
              <select id="debt-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                {DEBT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="debt-bal">Balance ($)</label>
              <input id="debt-bal" type="number" min="0" step="0.01" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="4200.00" required />
            </div>
            <div className="field">
              <label htmlFor="debt-apr">APR (%)</label>
              <input id="debt-apr" type="number" min="0" step="0.01" value={apr} onChange={(e) => setApr(e.target.value)} placeholder="22.99" required />
            </div>
            <div className="field">
              <label htmlFor="debt-min">Min Payment ($/mo)</label>
              <input id="debt-min" type="number" min="0" step="0.01" value={minPayment} onChange={(e) => setMinPayment(e.target.value)} placeholder="110.00" required />
            </div>
            <div className="field">
              <label htmlFor="debt-extra">Extra ($/mo)</label>
              <input id="debt-extra" type="number" min="0" step="0.01" value={extraPayment} onChange={(e) => setExtraPayment(e.target.value)} placeholder="0.00" />
            </div>
            <div className="field">
              <label htmlFor="debt-due">Next Due Date</label>
              <input id="debt-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="debt-notes">Notes</label>
              <input id="debt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="0% promo ends…" />
            </div>
            <button className="btn" type="submit">+ Add debt</button>
          </div>
          <label className="family-task" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={syncBillBudget} onChange={(e) => setSyncBillBudget(e.target.checked)} />
            <span>Also sync this debt’s monthly payment to upcoming <b>Bills</b> & <b>Budgets</b> so Paychecks & Dashboard reflect it automatically</span>
          </label>
        </form>

        {debts.length === 0 ? (
          <div className="callout" style={{ marginTop: 12 }}>
            <b>No debts entered yet.</b> Add your credit cards or loans above (or tell the AI bar at the top: <i>“Add a $3,500 Visa at 24% APR with $95 min payment due 2026-11-18 and show me how to pay it off”</i>).
          </div>
        ) : (
          <div className="sheet-wrap" style={{ marginTop: 12 }}>
            <table className="sheet">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Order</th>
                  <th>Debt / Account</th>
                  <th style={{ width: 135 }}>Type</th>
                  <th className="num" style={{ width: 120 }}>Balance ($)</th>
                  <th className="num" style={{ width: 95 }}>APR (%)</th>
                  <th className="num" style={{ width: 115 }}>Min ($/mo)</th>
                  <th className="num" style={{ width: 115 }}>Extra ($/mo)</th>
                  <th style={{ width: 135 }}>Next Due</th>
                  <th className="num" style={{ width: 120 }}>Est. Payoff</th>
                  <th style={{ width: 195 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {debts.map((d) => {
                  const info = rankMap.get(d.id)
                  return (
                    <tr key={d.id}>
                      <td style={{ padding: '8px 10px', fontWeight: 800, color: info?.rank === 1 ? 'var(--green)' : 'var(--muted)' }}>
                        {info ? `#${info.rank}` : 'Paid'}
                      </td>
                      <td>
                        <input aria-label={`${d.name} name`} value={d.name} onChange={(e) => patchDebt(d.id, { name: e.target.value })} />
                      </td>
                      <td>
                        <select aria-label={`${d.name} type`} value={d.category || 'Credit Card'} onChange={(e) => patchDebt(d.id, { category: e.target.value })}>
                          {DEBT_CATEGORIES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </td>
                      <td className="num">
                        <input
                          aria-label={`${d.name} balance`}
                          type="number"
                          min="0"
                          step="0.01"
                          className="cell-num expense"
                          value={d.balance}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            patchDebt(d.id, { balance: isNaN(v) ? 0 : Math.max(0, v) })
                          }}
                        />
                      </td>
                      <td className="num">
                        <input
                          aria-label={`${d.name} apr`}
                          type="number"
                          min="0"
                          step="0.01"
                          className="cell-num"
                          value={d.apr}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            patchDebt(d.id, { apr: isNaN(v) ? 0 : Math.max(0, v) })
                          }}
                        />
                      </td>
                      <td className="num">
                        <input
                          aria-label={`${d.name} min payment`}
                          type="number"
                          min="0"
                          step="0.01"
                          className="cell-num"
                          value={d.minPayment}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            patchDebt(d.id, { minPayment: isNaN(v) ? 0 : Math.max(0, v) })
                          }}
                        />
                      </td>
                      <td className="num">
                        <input
                          aria-label={`${d.name} extra payment`}
                          type="number"
                          min="0"
                          step="0.01"
                          className="cell-num income"
                          value={d.extraPayment ?? 0}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            patchDebt(d.id, { extraPayment: isNaN(v) ? 0 : Math.max(0, v) })
                          }}
                        />
                      </td>
                      <td>
                        <input aria-label={`${d.name} due date`} type="date" value={d.due || ''} onChange={(e) => patchDebt(d.id, { due: e.target.value })} />
                      </td>
                      <td className="num" style={{ padding: '8px 10px', fontSize: 12, color: 'var(--cyan)' }}>
                        {info ? `${info.payoffMonth} mo (${info.payoffDate})` : 'Done'}
                      </td>
                      <td className="rowtools">
                        <button type="button" title="Log payment & reduce debt balance" onClick={() => payDebtNow(d)}>Pay & log</button>
                        <button
                          type="button"
                          title="Sync payment to Bills & Budgets"
                          onClick={() => {
                            setState((s) => syncDebtToBillAndBudget(d, s))
                            setNotice(`Synced ${d.name} to Bills and Debt Budget.`)
                          }}
                        >
                          Sync app
                        </button>
                        <button type="button" title="Delete debt" aria-label={`Remove ${d.name}`} onClick={() => removeDebt(d.id)}>✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Total Debt & Monthly Commitments</td>
                  <td className="num" style={{ color: 'var(--red)' }}>{fmt(summary.totalBalance)}</td>
                  <td className="num">{summary.weightedApr.toFixed(1)}% avg</td>
                  <td className="num">{fmt(summary.totalMinPayment)}/mo</td>
                  <td className="num" style={{ color: 'var(--green)' }}>{fmt(summary.totalExtraPayment)}/mo</td>
                  <td colSpan={3} className="num" style={{ color: 'var(--cyan)' }}>
                    Est. total interest: {fmt(plan.totalInterest)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="family-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <span className="hud-tag">STEP 2 · PAYOFF CALCULATOR & AI STRATEGY</span>
            <h3 style={{ marginTop: 6 }}>2. Best Steps on How to Pay Off Your Debt</h3>
            <p>Compare <b>Avalanche</b> (highest interest rate first — saves the most money) vs. <b>Snowball</b> (smallest balance first — fastest wins), and see how adding extra cash from your paychecks accelerates your debt-free date.</p>
          </div>
          <div className="family-actions" style={{ marginTop: 0 }}>
            <button type="button" className={'btn ' + (strategy === 'avalanche' ? '' : 'ghost')} onClick={() => setStrategy('avalanche')}>
              🔥 Avalanche (Highest APR First)
            </button>
            <button type="button" className={'btn ' + (strategy === 'snowball' ? '' : 'ghost')} onClick={() => setStrategy('snowball')}>
              ⚡ Snowball (Smallest Balance First)
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => onAskAi('Analyze my debts, paychecks, and bills and give me the best step-by-step plan to pay off my debt fastest.')}
            >
              ✨ Ask AI for Custom Debt Plan
            </button>
          </div>
        </div>

        <div className="family-toolbar" style={{ marginTop: 12 }}>
          <label className="family-field" style={{ maxWidth: 260 }}>
            Extra monthly pool toward #1 priority debt ($)
            <input
              type="number"
              min="0"
              step="10"
              value={extraMonthly}
              onChange={(e) => setExtraMonthly(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <div className="family-actions" style={{ margin: 0 }}>
            <button type="button" className="btn ghost" onClick={() => setExtraMonthly(0)}>+$0/mo</button>
            <button type="button" className="btn ghost" onClick={() => setExtraMonthly(100)}>+$100/mo</button>
            <button type="button" className="btn ghost" onClick={() => setExtraMonthly(250)}>+$250/mo</button>
            <button type="button" className="btn ghost" onClick={() => setExtraMonthly(500)}>+$500/mo</button>
            {suggestedExtra > 0 && (
              <button type="button" className="btn ghost" onClick={() => setExtraMonthly(suggestedExtra)}>
                Use 50% of unbudgeted cashflow (+{fmt(suggestedExtra)}/mo)
              </button>
            )}
          </div>
        </div>

        {plan.order.length > 0 && (
          <>
            <div className="grid cols-2" style={{ marginTop: 10 }}>
              <div className="callout">
                <b>Selected: {strategy === 'avalanche' ? '🔥 Avalanche Method' : '⚡ Snowball Method'}</b>
                <div style={{ marginTop: 6 }}>
                  Debt-free in <b>{plan.months} months</b> ({plan.debtFreeDate}) · Total interest: <b>{fmt(plan.totalInterest)}</b> · Saves <b>{fmt(plan.interestSaved)}</b> and <b>{plan.monthsSaved} months</b> vs. minimum payments.
                </div>
              </div>
              <div className="callout">
                <b>Comparison: {strategy === 'avalanche' ? '⚡ Snowball Method' : '🔥 Avalanche Method'}</b>
                <div style={{ marginTop: 6 }}>
                  Debt-free in <b>{altPlan.months} months</b> ({altPlan.debtFreeDate}) · Total interest: <b>{fmt(altPlan.totalInterest)}</b> · First knockout: <b>{altPlan.order[0]?.name}</b> in <b>{altPlan.order[0]?.payoffMonth} mo</b>.
                </div>
              </div>
            </div>

            <div className="paycheck-waterfall" style={{ marginTop: 14 }}>
              {plan.steps.map((stepText, idx) => (
                <div key={idx} className="waterfall-row">
                  <div>
                    <strong>{stepText}</strong>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}

// --- In-app AI assistant (talks + edits your data across the ENTIRE app) ---
const PAGES = ['Dashboard', 'Family HQ', 'Calendar', 'Date nights', 'Projects', 'Groceries', 'Meals', 'Paychecks', 'Debt', 'Bill accounts', 'Ideas', 'Transactions', 'Budgets', 'Advisor', 'Opportunities', 'Family', 'Settings']

// Tools the model can call to mutate any part of the household app in real time.
const AI_TOOLS = [
  {
    name: 'upsert_bill',
    description: 'Add a new bill or update an existing bill (by id or title) due on a specific date. Also optionally syncs the bill to the Utilities/category budget line items and returns the real-time remaining balance on the next paycheck and monthly budget.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string', description: 'Bill name, e.g. "Electric", "Columbia Gas", "Water", "Internet"' },
        amount: { type: 'number', description: 'Bill amount in dollars, >= 0' },
        due: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
        paid: { type: 'boolean', description: 'Whether the bill is already paid (default false)' },
        category: { type: 'string', description: 'Budget category to sync with (default Utilities)' },
        syncToBudget: { type: 'boolean', description: 'Also add/update this bill in Budgets line items (default true)' },
      },
      required: ['title', 'amount', 'due'],
    },
  },
  {
    name: 'delete_bill',
    description: 'Remove a bill by id or title and recalculate real-time remaining cashflow.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
      },
    },
  },
  {
    name: 'pay_bill',
    description: 'Mark a bill paid (by id or title) and log the payment to the transaction ledger.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
      },
    },
  },
  {
    name: 'upsert_paycheck',
    description: 'Add or update a household paycheck stream (name, earner, net amount, frequency, next payday YYYY-MM-DD) so all app income, Paychecks waterfall, and Budgets flow off of it in real time.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string', description: 'Paycheck label, e.g. "Chris paycheck" or "Primary paycheck"' },
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
    description: 'Remove a saved paycheck by its id or name.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'set_paycheck_plan',
    description: 'Adjust the next payday cutoff date (YYYY-MM-DD) or starting cash available override in the Paychecks planner.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Next payday cutoff date YYYY-MM-DD' },
        available: { type: 'string', description: 'Custom cash available override in dollars, or empty string "" to use saved paychecks automatically' },
      },
    },
  },
  {
    name: 'upsert_debt',
    description: 'Add or update a debt account (credit card, auto loan, student loan, personal loan, medical, mortgage, etc.) with balance, APR %, minimum payment, extra payment, and due date. Syncs to Bills & Budgets and calculates best payoff steps.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string', description: 'Debt name, e.g. "Chase Visa", "Auto Loan", "Student Loan"' },
        category: { type: 'string', enum: DEBT_CATEGORIES },
        balance: { type: 'number', description: 'Current balance owed in dollars, >= 0' },
        apr: { type: 'number', description: 'Annual Percentage Rate (APR %), e.g. 22.99' },
        minPayment: { type: 'number', description: 'Minimum monthly payment in dollars, >= 0' },
        extraPayment: { type: 'number', description: 'Extra monthly payment toward this debt in dollars, >= 0' },
        due: { type: 'string', description: 'Next due date YYYY-MM-DD' },
        notes: { type: 'string' },
        syncToBillAndBudget: { type: 'boolean', description: 'Sync monthly payment to Bills and Debt Budget (default true)' },
      },
      required: ['name', 'balance', 'apr', 'minPayment'],
    },
  },
  {
    name: 'delete_debt',
    description: 'Remove a debt account by id or name.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'record_debt_payment',
    description: 'Record a payment toward a debt (by id or name), reducing its balance in real time and logging the transaction.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        amount: { type: 'number', description: 'Payment amount in dollars' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'calculate_debt_payoff',
    description: 'Calculate the optimal debt payoff plan (Avalanche vs. Snowball), exact payoff months/dates, total interest saved, and step-by-step action plan.',
    input_schema: {
      type: 'object',
      properties: {
        extraMonthly: { type: 'number', description: 'Additional monthly dollar amount to throw at the #1 priority debt' },
        strategy: { type: 'string', enum: ['avalanche', 'snowball'] },
      },
    },
  },
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
    description: 'Edit fields of an existing transaction by its id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        desc: { type: 'string' },
        amount: { type: 'number' },
        type: { type: 'string', enum: ['income', 'expense'] },
        category: { type: 'string' },
        date: { type: 'string' },
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
        category: { type: 'string', description: 'Category name, e.g. Food, Utilities, Debt, Subscriptions' },
        limit: { type: 'number', description: 'Monthly limit in dollars, > 0' },
      },
      required: ['category', 'limit'],
    },
  },
  {
    name: 'add_budget_item',
    description: 'Add or update a line item inside a budget category (for example Utilities -> Columbia Gas planned $90, actual $85.42).',
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
    description: 'Remove a budget line item by its id or name.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
  },
  {
    name: 'remove_budget',
    description: 'Remove the budget for a category.',
    input_schema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
  },
  {
    name: 'manage_groceries',
    description: 'Add an item to the shopping list or always list, or load all always-list staples into groceries.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'add_staple', 'load_staples'] },
        name: { type: 'string' },
        quantity: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_calendar_event',
    description: 'Add a family calendar event or date night on a specific date.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['event', 'date_night'] },
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        budget: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['title', 'date'],
    },
  },
  {
    name: 'navigate',
    description: 'Switch the app to a different page/tab.',
    input_schema: { type: 'object', properties: { page: { type: 'string', enum: PAGES } }, required: ['page'] },
  },
]

const newId = () => 't' + Date.now() + '-' + Math.floor(Math.random() * 1e4)
const cleanDate = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : todayISO())

function formatLiveRemaining(s) {
  const snap = realtimeFinancialSnapshot(s)
  return (
    `REAL-TIME SNAPSHOT → Next paycheck cash available: ${fmt(snap.availableOnNextPaycheck)} | ` +
    `Unpaid bills due through ${snap.nextPayday || 'payday'}: ${fmt(snap.unpaidBillsThroughPayday)} (${snap.billsDueThroughPayday.length} bill${snap.billsDueThroughPayday.length === 1 ? '' : 's'}) | ` +
    `Remaining after payday bills: ${fmt(snap.remainingAfterPaydayBills)} | ` +
    `Monthly income: ${fmt(snap.monthlyIncome)} | Planned monthly budget: ${fmt(snap.totalPlannedBudget)} | ` +
    `Unbudgeted monthly income left: ${fmt(snap.unbudgetedMonthlyIncome)}.`
  )
}

// Execute one tool call against state. `applyState` updates both `stateRef.current` synchronously
// and React state so multiple tools in a single turn compose cleanly.
function runAiTool(name, input, applyState, stateRef, setTab) {
  const mutate = (fn) => {
    const next = fn(stateRef.current)
    stateRef.current = next
    applyState(next)
    return next
  }

  switch (name) {
    case 'upsert_bill': {
      const title = String(input.title || '').trim()
      const amount = Math.max(0, Number(input.amount) || 0)
      const due = cleanDate(input.due)
      const paid = Boolean(input.paid)
      if (!title) return 'Bill title is required.'
      const cat = canonicalCategory(
        stateRef.current,
        input.category || (guessCategory(title) === 'Other' ? 'Utilities' : guessCategory(title))
      )
      const syncToBudget = input.syncToBudget !== false
      let savedBill = null
      const nextState = mutate((s) => {
        const bills = s.bills || []
        const existing = bills.find((b) => (input.id && b.id === input.id) || b.title.toLowerCase() === title.toLowerCase())
        savedBill = existing
          ? { ...existing, title, amount, due, paid }
          : { id: crypto.randomUUID(), title, amount, due, paid }
        const nextBills = existing
          ? bills.map((b) => (b.id === existing.id ? savedBill : b))
          : [...bills, savedBill]

        let nextBudgetItems = s.budgetItems || []
        if (syncToBudget && cat && cat.toLowerCase() !== 'income') {
          const existingItem = nextBudgetItems.find(
            (x) => x.name.toLowerCase() === title.toLowerCase() && x.category.toLowerCase() === cat.toLowerCase()
          )
          if (existingItem) {
            nextBudgetItems = nextBudgetItems.map((x) =>
              x.id === existingItem.id ? { ...x, amount, notes: `Due ${due}` } : x
            )
          } else {
            nextBudgetItems = [
              ...nextBudgetItems,
              { id: crypto.randomUUID(), category: cat, name: title, amount, actual: paid ? amount : 0, notes: `Due ${due}` },
            ]
          }
        }
        const currentPlanDate = s.paycheckPlan?.date || ''
        const nextPlanDate = !currentPlanDate || currentPlanDate < due ? due : currentPlanDate
        return {
          ...s,
          bills: nextBills,
          budgetItems: nextBudgetItems,
          paycheckPlan: { ...(s.paycheckPlan || {}), date: s.paychecks?.length ? currentPlanDate : nextPlanDate },
        }
      })
      return `Saved bill "${savedBill.title}" (${fmt(savedBill.amount)} due ${savedBill.due}, ${savedBill.paid ? 'paid' : 'unpaid'})${syncToBudget ? ` and synced to ${cat} budget` : ''}. ${formatLiveRemaining(nextState)}`
    }
    case 'delete_bill': {
      const target = (stateRef.current.bills || []).find(
        (b) => (input.id && b.id === input.id) || (input.title && b.title.toLowerCase() === String(input.title).toLowerCase())
      )
      if (!target) return `No matching bill found.`
      const nextState = mutate((s) => ({
        ...s,
        bills: (s.bills || []).filter((b) => b.id !== target.id),
      }))
      return `Removed bill "${target.title}" (${fmt(target.amount)}). ${formatLiveRemaining(nextState)}`
    }
    case 'pay_bill': {
      const target = (stateRef.current.bills || []).find(
        (b) => (input.id && b.id === input.id) || (input.title && b.title.toLowerCase().includes(String(input.title).toLowerCase()))
      )
      if (!target) return `No matching bill found to mark paid.`
      const nextState = mutate((s) => {
        const txId = `bill-tx-${target.id}`
        const exists = (s.transactions || []).some((t) => t.id === txId)
        const tx = {
          id: txId,
          desc: target.title,
          amount: Number(target.amount) || 0,
          category: 'Utilities',
          type: 'expense',
          date: todayISO(),
        }
        return {
          ...s,
          bills: (s.bills || []).map((b) => (b.id === target.id ? { ...b, paid: true } : b)),
          transactions: exists ? s.transactions : [tx, ...(s.transactions || [])],
        }
      })
      return `Marked "${target.title}" (${fmt(target.amount)}) paid and logged in ledger. ${formatLiveRemaining(nextState)}`
    }
    case 'upsert_paycheck':
    case 'add_paycheck': {
      const nameStr = String(input.name || '').trim()
      const amount = Math.max(0, Number(input.amount) || 0)
      const frequency = PAYCHECK_FREQUENCIES.includes(input.frequency) ? input.frequency : 'Bi-weekly'
      const date = input.date ? cleanDate(input.date) : todayISO()
      const owner = input.owner ? String(input.owner).trim() : ''
      const notes = input.notes ? String(input.notes).trim() : ''
      if (!nameStr) return `Invalid paycheck name.`
      let saved = null
      const nextState = mutate((s) => {
        const list = s.paychecks || []
        const existing = list.find((p) => (input.id && p.id === input.id) || p.name.toLowerCase() === nameStr.toLowerCase())
        saved = existing
          ? { ...existing, name: nameStr, amount, frequency, date, owner: owner || existing.owner || '', notes: notes || existing.notes || '' }
          : { id: crypto.randomUUID(), name: nameStr, amount, frequency, date, owner, notes }
        return {
          ...s,
          paychecks: existing ? list.map((p) => (p.id === existing.id ? saved : p)) : [...list, saved],
          paycheckPlan: { ...(s.paycheckPlan || {}), date: date || s.paycheckPlan?.date || '', available: '' },
        }
      })
      return `Saved paycheck "${saved.name}" (${fmt(saved.amount)} ${saved.frequency}, next payday ${saved.date}). ${formatLiveRemaining(nextState)}`
    }
    case 'remove_paycheck': {
      const cur = (stateRef.current.paychecks || []).find(
        (x) => (input.id && x.id === input.id) || (input.name && x.name.toLowerCase() === String(input.name).toLowerCase())
      )
      if (!cur) return `No matching paycheck found.`
      const nextState = mutate((s) => ({ ...s, paychecks: (s.paychecks || []).filter((x) => x.id !== cur.id) }))
      return `Removed paycheck "${cur.name}". ${formatLiveRemaining(nextState)}`
    }
    case 'set_paycheck_plan': {
      const nextState = mutate((s) => ({
        ...s,
        paycheckPlan: {
          ...(s.paycheckPlan || {}),
          ...(input.date !== undefined ? { date: input.date ? cleanDate(input.date) : '' } : {}),
          ...(input.available !== undefined ? { available: String(input.available) } : {}),
        },
      }))
      return `Updated paycheck planner window. ${formatLiveRemaining(nextState)}`
    }
    case 'upsert_debt': {
      const debtName = String(input.name || '').trim()
      const balance = Math.max(0, Number(input.balance) || 0)
      const apr = Math.max(0, Number(input.apr) || 0)
      const minPayment = Math.max(0, Number(input.minPayment) || 0)
      const extraPayment = Math.max(0, Number(input.extraPayment) || 0)
      const category = DEBT_CATEGORIES.includes(input.category) ? input.category : 'Credit Card'
      const due = input.due ? cleanDate(input.due) : ''
      const notes = input.notes ? String(input.notes).trim() : ''
      if (!debtName) return 'Debt name is required.'
      let savedDebt = null
      const nextState = mutate((s) => {
        const list = s.debts || []
        const existing = list.find((d) => (input.id && d.id === input.id) || d.name.toLowerCase() === debtName.toLowerCase())
        savedDebt = existing
          ? { ...existing, name: debtName, category, balance, apr, minPayment, extraPayment, due: due || existing.due || '', notes: notes || existing.notes || '' }
          : { id: crypto.randomUUID(), name: debtName, category, balance, apr, minPayment, extraPayment, due, notes }
        const nextDebts = existing ? list.map((d) => (d.id === existing.id ? savedDebt : d)) : [...list, savedDebt]
        const monthlyPay = minPayment + extraPayment
        const billId = `debt-bill-${savedDebt.id}`
        const budgetItemId = `debt-budget-${savedDebt.id}`
        const sync = input.syncToBillAndBudget !== false
        const nextBills =
          sync && monthlyPay > 0 && savedDebt.due
            ? [
                ...(s.bills || []).filter((b) => b.id !== billId && b.title.toLowerCase() !== `${savedDebt.name} (debt payment)`.toLowerCase()),
                { id: billId, title: `${savedDebt.name} (Debt Payment)`, amount: monthlyPay, due: savedDebt.due, paid: false },
              ]
            : s.bills || []
        const nextBudgetItems =
          sync && monthlyPay > 0
            ? [
                ...(s.budgetItems || []).filter((x) => x.id !== budgetItemId && !(x.category === 'Debt' && x.name.toLowerCase() === savedDebt.name.toLowerCase())),
                { id: budgetItemId, category: 'Debt', name: savedDebt.name, amount: monthlyPay, actual: 0, notes: `${apr}% APR · Balance ${fmt(balance)}` },
              ]
            : s.budgetItems || []
        return { ...s, debts: nextDebts, bills: nextBills, budgetItems: nextBudgetItems }
      })
      const plan = simulateDebtPayoff(nextState.debts, 0, 'avalanche')
      return `Saved debt "${savedDebt.name}" (balance ${fmt(savedDebt.balance)} @ ${savedDebt.apr}% APR, min ${fmt(savedDebt.minPayment)}/mo). Avalanche payoff: ${plan.months} months (${plan.debtFreeDate}), total interest ${fmt(plan.totalInterest)}. ${formatLiveRemaining(nextState)}`
    }
    case 'delete_debt': {
      const target = (stateRef.current.debts || []).find(
        (d) => (input.id && d.id === input.id) || (input.name && d.name.toLowerCase() === String(input.name).toLowerCase())
      )
      if (!target) return `No matching debt found.`
      const nextState = mutate((s) => ({
        ...s,
        debts: (s.debts || []).filter((d) => d.id !== target.id),
        bills: (s.bills || []).filter((b) => b.id !== `debt-bill-${target.id}`),
        budgetItems: (s.budgetItems || []).filter((x) => x.id !== `debt-budget-${target.id}`),
      }))
      return `Removed debt "${target.name}". ${formatLiveRemaining(nextState)}`
    }
    case 'record_debt_payment': {
      const target = (stateRef.current.debts || []).find(
        (d) => (input.id && d.id === input.id) || (input.name && d.name.toLowerCase().includes(String(input.name).toLowerCase()))
      )
      if (!target) return `No matching debt found.`
      const payAmt = Math.max(0, Number(input.amount) || 0)
      const nextBal = Math.max(0, (Number(target.balance) || 0) - payAmt)
      const dayStr = input.date ? cleanDate(input.date) : todayISO()
      const nextState = mutate((s) => ({
        ...s,
        debts: (s.debts || []).map((d) => (d.id === target.id ? { ...d, balance: nextBal } : d)),
        bills: (s.bills || []).map((b) => (b.id === `debt-bill-${target.id}` ? { ...b, paid: true } : b)),
        transactions: [
          { id: newId(), desc: `Debt payment · ${target.name}`, amount: payAmt, category: 'Debt', type: 'expense', date: dayStr },
          ...(s.transactions || []),
        ],
      }))
      return `Recorded ${fmt(payAmt)} payment on "${target.name}" (new balance ${fmt(nextBal)}). ${formatLiveRemaining(nextState)}`
    }
    case 'calculate_debt_payoff': {
      const extra = Math.max(0, Number(input.extraMonthly) || 0)
      const strat = input.strategy === 'snowball' ? 'snowball' : 'avalanche'
      const av = simulateDebtPayoff(stateRef.current.debts || [], extra, 'avalanche')
      const sn = simulateDebtPayoff(stateRef.current.debts || [], extra, 'snowball')
      const chosen = strat === 'snowball' ? sn : av
      if (chosen.order.length === 0) return 'No active debts with a positive balance are currently entered.'
      return (
        `DEBT PAYOFF CALCULATION (extra ${fmt(extra)}/mo):\n` +
        `- Avalanche (Highest APR First): ${av.months} months (${av.debtFreeDate}), total interest ${fmt(av.totalInterest)}, saves ${fmt(av.interestSaved)} and ${av.monthsSaved} months.\n` +
        `- Snowball (Smallest Balance First): ${sn.months} months (${sn.debtFreeDate}), total interest ${fmt(sn.totalInterest)}, #1 knockout "${sn.order[0]?.name}" in ${sn.order[0]?.payoffMonth} months.\n` +
        `Payoff Order (${strat}): ${chosen.order.map((o) => `#${o.rank} ${o.name} (${fmt(o.balance)} @ ${o.apr}% APR, pay ${fmt(o.firstMonthTargetPayment)}/mo -> paid off in ${o.payoffMonth} mo / ${o.payoffDate})`).join(' | ')}\n` +
        `Best Steps:\n${chosen.steps.join('\n')}`
      )
    }
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
      const nextState = mutate((s) => ({ ...s, transactions: [tx, ...s.transactions] }))
      return `Added ${tx.type} "${tx.desc}" ${fmt(tx.amount)} in ${tx.category} on ${tx.date} (id ${tx.id}). ${formatLiveRemaining(nextState)}`
    }
    case 'update_transaction': {
      const cur = stateRef.current.transactions.find((t) => t.id === input.id)
      if (!cur) return `No transaction with id ${input.id}.`
      const patch = {}
      for (const k of ['desc', 'category', 'date']) if (input[k] != null) patch[k] = k === 'date' ? cleanDate(input[k]) : input[k]
      if (input.amount != null) patch.amount = Math.abs(Number(input.amount) || 0)
      if (input.type != null) patch.type = input.type === 'income' ? 'income' : 'expense'
      const nextState = mutate((s) => ({ ...s, transactions: s.transactions.map((t) => (t.id === input.id ? { ...t, ...patch } : t)) }))
      return `Updated ${input.id}: ${JSON.stringify(patch)}. ${formatLiveRemaining(nextState)}`
    }
    case 'delete_transaction': {
      const cur = stateRef.current.transactions.find((t) => t.id === input.id)
      if (!cur) return `No transaction with id ${input.id}.`
      if (!confirm(`Delete "${cur.desc}" ${fmt(cur.amount)} (${cur.date})?`))
        return `User declined — "${cur.desc}" was NOT deleted.`
      const nextState = mutate((s) => ({ ...s, transactions: s.transactions.filter((t) => t.id !== input.id) }))
      return `Deleted ${input.id} ("${cur.desc}" ${fmt(cur.amount)}). ${formatLiveRemaining(nextState)}`
    }
    case 'set_budget': {
      const c = canonicalCategory(stateRef.current, input.category)
      if (!c || c.toLowerCase() === 'income') return `Invalid category "${input.category}".`
      const v = Number(input.limit)
      if (!(v > 0)) return `Limit must be greater than 0.`
      const nextState = mutate((s) => ({ ...s, budgets: { ...s.budgets, [c]: v } }))
      return `Set ${c} budget to ${fmt(v)}. ${formatLiveRemaining(nextState)}`
    }
    case 'add_budget_item': {
      const c = canonicalCategory(stateRef.current, input.category)
      const itemName = String(input.name || '').trim()
      const amount = Number(input.amount)
      const actual = input.actual != null ? Math.max(0, Number(input.actual) || 0) : 0
      const notes = input.notes ? String(input.notes).trim() : ''
      if (!c || c.toLowerCase() === 'income' || !itemName || !(amount >= 0)) return `Invalid budget line item.`
      let savedItem = null
      const nextState = mutate((s) => {
        const list = s.budgetItems || []
        const existing = list.find((x) => x.category.toLowerCase() === c.toLowerCase() && x.name.toLowerCase() === itemName.toLowerCase())
        savedItem = existing
          ? { ...existing, amount, actual: input.actual != null ? actual : existing.actual, notes: notes || existing.notes || '' }
          : { id: crypto.randomUUID(), category: c, name: itemName, amount, actual, notes }
        return {
          ...s,
          budgetItems: existing ? list.map((x) => (x.id === existing.id ? savedItem : x)) : [...list, savedItem],
        }
      })
      return `Saved budget line item "${savedItem.name}" (planned ${fmt(savedItem.amount)}, actual ${fmt(savedItem.actual)}) under ${c}. ${formatLiveRemaining(nextState)}`
    }
    case 'remove_budget_item': {
      const cur = (stateRef.current.budgetItems || []).find(
        (x) => (input.id && x.id === input.id) || (input.name && x.name.toLowerCase() === String(input.name).toLowerCase())
      )
      if (!cur) return `No matching budget line item found.`
      const nextState = mutate((s) => ({ ...s, budgetItems: (s.budgetItems || []).filter((x) => x.id !== cur.id) }))
      return `Removed budget line item "${cur.name}" from ${cur.category}. ${formatLiveRemaining(nextState)}`
    }
    case 'remove_budget': {
      const c = canonicalCategory(stateRef.current, input.category)
      const hasLimit = stateRef.current.budgets[c] != null
      const hasItems = (stateRef.current.budgetItems || []).some((x) => x.category.toLowerCase() === c.toLowerCase())
      if (!hasLimit && !hasItems) return `No budget set for "${c}".`
      if (!confirm(`Remove the ${c} budget?`))
        return `User declined — ${c} budget was NOT removed.`
      const nextState = mutate((s) => {
        const next = { ...s.budgets }
        delete next[c]
        return { ...s, budgets: next, budgetItems: (s.budgetItems || []).filter((x) => x.category.toLowerCase() !== c.toLowerCase()) }
      })
      return `Removed ${c} budget. ${formatLiveRemaining(nextState)}`
    }
    case 'manage_groceries': {
      if (input.action === 'load_staples') {
        mutate((s) => {
          const current = s.groceries || []
          const staples = s.groceryStaples || []
          const fresh = staples.filter((st) => !current.some((g) => !g.checked && g.name.toLowerCase() === st.name.toLowerCase()))
          return { ...s, groceries: [...current, ...fresh.map((st) => ({ id: crypto.randomUUID(), name: st.name, quantity: st.quantity || '', checked: false }))] }
        })
        return 'Loaded always-list staples into the active grocery list.'
      }
      const itemName = String(input.name || '').trim()
      if (!itemName) return 'Grocery item name is required.'
      if (input.action === 'add_staple') {
        mutate((s) => ({
          ...s,
          groceryStaples: [...(s.groceryStaples || []), { id: crypto.randomUUID(), name: itemName, quantity: String(input.quantity || '') }],
        }))
        return `Added "${itemName}" to the household Always grocery list.`
      }
      mutate((s) => ({
        ...s,
        groceries: [...(s.groceries || []), { id: crypto.randomUUID(), name: itemName, quantity: String(input.quantity || ''), checked: false }],
      }))
      return `Added "${itemName}" to the shopping list.`
    }
    case 'manage_calendar_event': {
      const title = String(input.title || '').trim()
      const date = cleanDate(input.date)
      if (!title) return 'Title is required.'
      if (input.kind === 'date_night') {
        mutate((s) => ({
          ...s,
          dateNights: [
            ...(s.dateNights || []),
            { id: crypto.randomUUID(), title, date, budget: Math.max(0, Number(input.budget) || 0), spent: 0, childcare: '', status: 'Planned', notes: String(input.notes || '') },
          ],
        }))
        return `Planned date night "${title}" on ${date}.`
      }
      mutate((s) => ({
        ...s,
        familyEvents: [
          ...(s.familyEvents || []),
          { id: crypto.randomUUID(), title, date, time: '', endTime: '', member: 'Everyone', category: 'Family', repeat: 'None', until: '', notes: String(input.notes || ''), exceptions: [] },
        ],
      }))
      return `Added calendar event "${title}" on ${date}.`
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

function parseSpokenDate(text) {
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)
  if (iso) return iso[1]
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (slash) {
    const yr = slash[3] ? (slash[3].length === 2 ? '20' + slash[3] : slash[3]) : String(new Date().getFullYear())
    return `${yr}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`
  }
  const ordinal = text.match(/\b(?:on\s+the\s+|due\s+the\s+|due\s+on\s+the\s+|the\s+)(\d{1,2})(?:st|nd|rd|th)\b/i)
  if (ordinal) {
    const base = todayISO().slice(0, 8)
    return `${base}${ordinal[1].padStart(2, '0')}`
  }
  if (/\btomorrow\b/i.test(text)) {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  return todayISO()
}

function runLocalAssistantFallback(text, applyState, stateRef, setTab) {
  const lower = text.toLowerCase().trim()
  const dueDate = parseSpokenDate(text)

  // 0. Friendly greeting / help
  if (/^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|howdy|help|what\s*can\s*you\s*do)\b[!.?]*$/i.test(lower)) {
    const snap = realtimeFinancialSnapshot(stateRef.current)
    return (
      `👋 Hey there! I'm Rory, your real-time AI Financial Controller for House of Gyening.\n\n` +
      `📊 ${formatLiveRemaining(stateRef.current)}\n\n` +
      `Here is what I can adjust across the entire app right now:\n` +
      `• Bills & What's Left: "I have a $140 electric bill due on 2026-11-18, adjust the app to reflect what's left"\n` +
      `• Debt Payoff Strategy: "Add debt Chase Visa $4,200 at 22.9% APR min $110 and give me best steps to pay it off"\n` +
      `• Paychecks & Income: "Set my bi-weekly paycheck to $2,600 on 2026-11-15"` +
      (snap.debtCount > 0 ? `\n\n💡 You currently have ${snap.debtCount} tracked debt(s) totaling ${fmt(snap.totalDebtBalance)} — ask me "How do I pay off my debt?" anytime!` : '')
    )
  }

  // 1. Debt addition or Debt Payoff Strategy request
  if (/\bdebt|pay\s*off|avalanche|snowball|apr|credit\s*card|loan\b/i.test(text)) {
    const aprMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:apr|interest)?/i)
    const balMatch = text.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/)
    const minMatch = text.match(/min(?:imum)?\s*(?:payment)?\s*(?:of\s*)?\$?\s*(\d+(?:\.\d+)?)/i)
    if (balMatch && (aprMatch || /\badd\b/i.test(text))) {
      const bal = parseFloat(balMatch[1].replace(/,/g, ''))
      const apr = aprMatch ? parseFloat(aprMatch[1]) : 19.99
      const min = minMatch ? parseFloat(minMatch[1]) : Math.max(35, Math.round(bal * 0.025))
      const nameClean =
        text
          .replace(/\$[\d,.]+/g, '')
          .replace(/\d+(?:\.\d+)?\s*%\s*(?:apr|interest)?/gi, '')
          .replace(/\b(add|my|debt|credit card|loan|at|with|min|minimum|payment|due|on|20\d{2}-\d{2}-\d{2}|and|show|how|to|pay|it|off)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim() || 'Credit Card / Debt'
      const msg = runAiTool(
        'upsert_debt',
        { name: nameClean, balance: bal, apr, minPayment: min, due: dueDate, syncToBillAndBudget: true },
        applyState,
        stateRef,
        setTab
      )
      setTab('Debt')
      const calc = runAiTool('calculate_debt_payoff', { strategy: 'avalanche', extraMonthly: 0 }, applyState, stateRef, setTab)
      return `✅ Adjusted app with your debt and synced it to Bills & Budgets:\n${msg}\n\n${calc}`
    }

    setTab('Debt')
    const snap = realtimeFinancialSnapshot(stateRef.current)
    const suggestedExtra = Math.max(0, Math.round(Math.max(0, snap.unbudgetedMonthlyIncome) * 0.5))
    const calc = runAiTool('calculate_debt_payoff', { strategy: 'avalanche', extraMonthly: suggestedExtra }, applyState, stateRef, setTab)
    return `📊 Here is your real-time Debt Payoff Analysis (using ${fmt(suggestedExtra)}/mo from your unbudgeted cashflow):\n\n${calc}`
  }

  // 2. Bill due on a specific day / "adjust the app to reflect real time what's left"
  if (/\bbill\b|\bdue\b|\belectric\b|\bwater\b|\bgas\b|\binternet\b|\brent\b|\bmortgage\b|\binsurance\b|\bt-mobile\b|\bcolumbia\b|\bpalmetto\b/i.test(text)) {
    const amtMatch =
      text.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/) ||
      text.match(/\b(\d+(?:\.\d+)?)\s*dollars?\b/i) ||
      text.match(/\bfor\s+(\d+(?:,\d{3})*(?:\.\d+)?)\b/i)
    if (amtMatch) {
      const amount = parseFloat(amtMatch[1].replace(/,/g, ''))
      let title = 'Utility Bill'
      const known = ['Columbia Gas', 'American Water', 'Palmetto', 'T-Mobile', 'Electric', 'Water', 'Gas', 'Internet', 'Rent', 'Mortgage', 'Car Insurance', 'Phone', 'Trash', 'Daycare']
      const matchedKnown = known.find((k) => lower.includes(k.toLowerCase()))
      if (matchedKnown) title = matchedKnown
      else {
        const beforeBill = text.match(/(?:have\s+a\s+|have\s+an\s+|this\s+|my\s+)([a-zA-Z][a-zA-Z0-9\s]{1,24}?)\s+bill/i)
        if (beforeBill) title = beforeBill[1].trim()
      }
      const resMsg = runAiTool(
        'upsert_bill',
        { title, amount, due: dueDate, paid: false, syncToBudget: true },
        applyState,
        stateRef,
        setTab
      )
      setTab('Paychecks')
      return `✅ Added/updated your "${title}" bill (${fmt(amount)} due ${dueDate}), synced it to your Budgets & Calendar, and recalculated your real-time balances:\n\n${resMsg}`
    }
  }

  // 3. Paycheck update
  if (/\bpaycheck\b|\bpaid\b|\bsalary\b|\btake-home\b/i.test(text)) {
    const amtMatch = text.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/)
    if (amtMatch) {
      const amount = parseFloat(amtMatch[1].replace(/,/g, ''))
      const freq = /weekly/i.test(text) && !/bi/i.test(text) ? 'Weekly' : /semi/i.test(text) ? 'Semi-monthly' : /month/i.test(text) ? 'Monthly' : 'Bi-weekly'
      const resMsg = runAiTool('upsert_paycheck', { name: 'Household Paycheck', amount, frequency: freq, date: dueDate }, applyState, stateRef, setTab)
      setTab('Paychecks')
      return `✅ Updated your paycheck and recalculated the entire app:\n\n${resMsg}`
    }
  }

  // Default: return complete real-time household & debt status
  return `📊 ${formatLiveRemaining(stateRef.current)}\n\nTip: You can say things like:\n• "I have a $140 electric bill due on 2026-11-18, adjust the app to reflect what's left"\n• "Add debt Chase Visa $4,200 at 22.9% APR min $110 and give me best steps to pay it off"`
}

function Assistant({ state, setState, totals, page, setTab, queuedPrompt, onConsumePrompt }) {
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

  const applyState = (next) => {
    stateRef.current = next
    setState(next)
  }

  const scrollRef = useRef(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [convo, busy, open])

  const systemPrompt = () => {
    const current = stateRef.current
    const snap = realtimeFinancialSnapshot(current)
    const tx = (current.transactions || [])
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 40)
      .map((t) => `${t.id} | ${t.date} | ${t.type} | ${t.category} | ${fmt(t.amount)} | ${t.desc}`)
      .join('\n')
    const bills = (current.bills || [])
      .map((b) => `${b.id} | due ${b.due} | ${b.paid ? 'paid' : 'unpaid'} | ${fmt(b.amount)} | ${b.title}`)
      .join('\n')
    const debts = (current.debts || [])
      .map((d) => `${d.id} | ${d.name} (${d.category || 'Debt'}) | balance ${fmt(d.balance)} | ${d.apr}% APR | min ${fmt(d.minPayment)}/mo | extra ${fmt(d.extraPayment || 0)}/mo | due ${d.due || 'unset'}`)
      .join('\n')
    return (
      'You are Rory, the built-in AI Financial Controller & Debt Strategist for "House of Gyening · Family Hub". ' +
      'You can answer money questions AND directly adjust ANY part of the app in real time using the provided tools ' +
      '(upsert/delete/pay bills, upsert/remove paychecks, set paycheck planner dates, upsert/delete/pay debts, calculate debt payoff, add/update/delete transactions, set/remove budgets & budget line items, manage groceries & calendar events, and navigate tabs). ' +
      'IMPORTANT RULES:\n' +
      '1. When the user says they have a bill due on a certain day or asks to adjust the app to reflect real-time what is left, IMMEDIATELY call `upsert_bill` (with `syncToBudget: true`) and optionally `navigate` to "Paychecks", then report the exact real-time numbers from the tool result (Remaining on next paycheck after bills, and Unbudgeted monthly income left).\n' +
      '2. When the user asks how to pay off debt or for best steps on paying off debt, call `calculate_debt_payoff` (and `upsert_debt` if they mention a new debt) and give a clear, numbered step-by-step plan comparing Avalanche vs. Snowball.\n' +
      '3. Always act with tools first—do not just describe what the user could do manually.\n\n' +
      `Today is ${todayISO()}. The user is currently on the "${page}" page.\n` +
      `Valid categories: ${allCategories(current).join(', ')} (or any new custom category).\n\n` +
      'REAL-TIME HOUSEHOLD SNAPSHOT:\n' +
      `Monthly Income ${fmt(snap.monthlyIncome)} (Paychecks per cycle ${fmt(snap.paycheckPerCycle)} · Unbudgeted monthly ${fmt(snap.unbudgetedMonthlyIncome)}) · Spending ${fmt(snap.monthlyExpense)} · Net ${fmt(snap.netMonthlyCashflow)}\n` +
      `Next Paycheck Available: ${fmt(snap.availableOnNextPaycheck)} | Unpaid Bills Due Through Payday (${snap.nextPayday || 'unset'}): ${fmt(snap.unpaidBillsThroughPayday)} | Remaining After Payday Bills: ${fmt(snap.remainingAfterPaydayBills)}\n` +
      'Paychecks: ' +
      ((current.paychecks || []).map((p) => `${p.id}:${p.name}=${fmt(p.amount)} (${p.frequency || 'Bi-weekly'}, next ${p.date || 'unset'})`).join(', ') || '(none)') +
      '\nBudgets: ' +
      (categoryBudgets(current).map(({ category, effective, items }) => `${category} ${fmt(effective)}${items.length ? ` [${items.map((i) => `${i.id}:${i.name}=${fmt(i.amount)}`).join(', ')}]` : ''}`).join(', ') || '(none)') +
      '\n\nBills (id | due | status | amount | title):\n' +
      (bills || '(none)') +
      '\n\nDebts (id | name | balance | APR | min | extra | due):\n' +
      (debts || '(none)') +
      '\n\nRecent transactions (id | date | type | category | amount | desc):\n' +
      (tx || '(none)')
    )
  }

  const sendText = async (rawText) => {
    const text = String(rawText ?? input).trim()
    if (!text || busy) return
    setError('')
    setInput('')
    setOpen(true)

    if (!hasKey) {
      const reply = runLocalAssistantFallback(text, applyState, stateRef, setTab)
      setConvo((prev) => [
        ...prev,
        { role: 'user', content: text },
        { role: 'assistant', content: [{ type: 'text', text: reply }] },
      ])
      return
    }

    let messages = [...convo, { role: 'user', content: text }]
    setConvo(messages)
    setBusy(true)
    try {
      for (let step = 0; step < 10; step++) {
        const res = await claudeRequest(stateRef.current, {
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
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
            content: runAiTool(tu.name, tu.input, applyState, stateRef, setTab),
          }))
          messages = [...messages, { role: 'user', content: results }]
          setConvo(messages)
          continue
        }
        break
      }
    } catch (e) {
      const fallbackReply = runLocalAssistantFallback(text, applyState, stateRef, setTab)
      setConvo((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text:
                fallbackReply +
                `\n\n(Note: Answered with built-in Rory Smart Controller because the saved key returned an API error — to use your Claude Pro/Max subscription directly, paste your \`sk-ant-oat01-…\` subscription token from \`claude setup-token\` in Family settings, or click "💬 Claude.ai ↗" at the top of this window.)`,
            },
          ],
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!queuedPrompt) return
    const clean = queuedPrompt.split('::')[0]
    onConsumePrompt?.()
    if (clean) sendText(clean)
  }, [queuedPrompt])

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
  }

  return (
    <div className="ai-dock">
      {open && (
        <div className="ai-panel">
          <div className="ai-head">
            <span>📚 Ask Rory · {state.claudeModel || 'claude-sonnet-4-6'}</span>
            <div className="ai-head-tools">
              <button
                className="ai-x"
                title="Open in Claude.ai Subscription with your live household snapshot"
                onClick={() => openInClaudeSubscription(input, systemPrompt())}
              >
                💬 Claude.ai ↗
              </button>
              {convo.length > 0 && (
                <button className="ai-x" title="Clear chat" onClick={() => setConvo([])}>⟲</button>
              )}
              <button className="ai-x" title="Close" onClick={() => setOpen(false)}>✕</button>
            </div>
          </div>

          {!hasKey && (
            <div className="callout" style={{ margin: 10 }}>
              <b>Claude Subscription + Instant Control:</b> Connect your <b>Claude Pro / Max subscription token</b> (<code>sk-ant-oat01-…</code> from <code>claude setup-token</code>) in <b>Family settings</b> or <b>Settings</b>, click <b>💬 Claude.ai ↗</b> above, or type below for instant smart app adjustments!
            </div>
          )}

          <div className="ai-body" ref={scrollRef}>
            {rows.length === 0 && (
              <div className="empty" style={{ padding: '8px 4px' }}>
                Try: “I have a $140 electric bill due on 2026-11-18, adjust the app to reflect what’s left” or “Give me best steps to pay off my debt.”
              </div>
            )}
            {rows.map((r, i) =>
              r.kind === 'tool' ? (
                <div key={i} className="ai-toolchip">🔧 {r.text}</div>
              ) : (
                <div key={i} className={'bubble ' + (r.kind === 'user' ? 'user' : 'ai')}>{r.text}</div>
              )
            )}
            {busy && <div className="bubble ai">Adjusting app & calculating…</div>}
            {error && <div className="callout" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>}
          </div>

          <div className="ai-input">
            <input
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendText()}
              placeholder="Tell Rory to add a bill due date, adjust budgets, or plan debt payoff…"
            />
            <button className="btn" disabled={busy} onClick={() => sendText()}>Send</button>
          </div>
        </div>
      )}

      <button className="ai-fab" onClick={() => setOpen((o) => !o)} title="AI assistant">
        {open ? '✕' : '📚'}
      </button>
    </div>
  )
}


