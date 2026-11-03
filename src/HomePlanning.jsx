import { useState } from 'react'
import { Dialog } from './Family.jsx'
import { dateKey } from './family.js'
import { addStaplesToList, sameItem } from '../shared/groceries.js'
import { categoryBudgets } from '../shared/budgets.js'

const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0)
const FREQ_MULTIPLIER = { Weekly: 52 / 12, 'Bi-weekly': 26 / 12, 'Semi-monthly': 2, Monthly: 1, 'One-time': 1 }

function advancePayday(isoDate, frequency) {
  const base = isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? new Date(isoDate + 'T12:00:00') : new Date()
  if (frequency === 'Weekly') base.setDate(base.getDate() + 7)
  else if (frequency === 'Bi-weekly') base.setDate(base.getDate() + 14)
  else if (frequency === 'Semi-monthly') base.setDate(base.getDate() + 15)
  else if (frequency === 'Monthly') base.setMonth(base.getMonth() + 1)
  else base.setDate(base.getDate() + 14)
  return base.toISOString().slice(0, 10)
}

export default function HomePlanning({ tab, state, setState }) {
  const [draft, setDraft] = useState(null), [day, setDay] = useState(dateKey())
  const groceries = state.groceries || [], meals = state.meals || [], bills = state.bills || []
  const remove = (field, id) => setState(s => ({ ...s, [field]: (s[field] || []).filter(x => x.id !== id) }))
  return <section className="family-space"><p className="family-eyebrow">{tab === 'Paychecks' ? 'HOUSEHOLD INCOME & BILL COVERAGE' : 'A LITTLE LESS TO REMEMBER'}</p><h2>{tab === 'Groceries' ? 'The family shopping list' : tab === 'Meals' ? 'What’s for dinner?' : 'Household Paychecks & Payday Breakdown'}</h2>
    {tab === 'Groceries' && <Groceries state={state} setState={setState} />}
    {tab === 'Meals' && <><form className="family-card" onSubmit={e => { e.preventDefault(); const f = new FormData(e.target); setState(s => ({ ...s, meals: [...(s.meals || []), { id: crypto.randomUUID(), date: day, slot: String(f.get('slot')), title: String(f.get('title')).trim(), ingredients: String(f.get('ingredients')) }] })); e.target.reset() }}><label className="family-field">Meal date<input type="date" required value={day} onChange={e => setDay(e.target.value)} /></label><label className="family-field">Meal<select name="slot">{['Breakfast', 'Lunch', 'Dinner', 'Snack'].map(x => <option key={x}>{x}</option>)}</select></label><label className="family-field">What are we making?<input name="title" required /></label><label className="family-field">Ingredients (one per line)<textarea name="ingredients" placeholder={'Chicken breast\nRice\nBroccoli'} /></label><button className="btn">Save meal</button></form><div className="family-cards">{[...meals].sort((a, b) => a.date.localeCompare(b.date)).map(m => <article className="family-card" key={m.id}><small>{m.date} · {m.slot}</small><h3>{m.title}</h3><p style={{ whiteSpace: 'pre-line' }}>{m.ingredients}</p><div className="family-actions"><button className="btn ghost" onClick={() => setState(s => { const names = m.ingredients.split('\n').map(x => x.trim()).filter(Boolean); return { ...s, groceries: [...(s.groceries || []), ...names.filter(name => !(s.groceries || []).some(g => !g.checked && g.name.toLowerCase() === name.toLowerCase())).map(name => ({ id: crypto.randomUUID(), name, quantity: '', checked: false }))] } })}>Add ingredients to groceries</button><button className="btn ghost" onClick={() => remove('meals', m.id)}>Remove meal</button></div></article>)}</div></>}
    {tab === 'Paychecks' && <Paychecks state={state} setState={setState} bills={bills} setDraft={setDraft} remove={remove} />}
    {draft && <Dialog label="Bill editor" onClose={() => setDraft(null)}><form onSubmit={e => { e.preventDefault(); const item = { ...draft, id: draft.id || crypto.randomUUID() }; setState(s => ({ ...s, bills: [...(s.bills || []).filter(b => b.id !== item.id), item] })); setDraft(null) }}><h3>{draft.id ? 'Edit bill' : 'Add bill'}</h3>{[['title', 'Bill name', 'text'], ['due', 'Due date', 'date'], ['amount', 'Amount ($)', 'number']].map(([key, label, type]) => <label key={key} className="family-field">{label}<input type={type} required min={type === 'number' ? 0 : undefined} step={type === 'number' ? '0.01' : undefined} value={draft[key]} onChange={e => setDraft(s => ({ ...s, [key]: e.target.value }))} /></label>)}<div className="family-actions"><button className="btn">Save bill</button><button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button></div></form></Dialog>}
  </section>
}

function Paychecks({ state, setState, bills, setDraft, remove }) {
  const [notice, setNotice] = useState('')
  const [selectedCheckId, setSelectedCheckId] = useState('all')
  const paychecks = state.paychecks || []
  const perCheckTotal = paychecks.reduce((n, p) => n + (Number(p.amount) || 0), 0)
  const monthlyExpected = paychecks.reduce((n, p) => n + (Number(p.amount) || 0) * (FREQ_MULTIPLIER[p.frequency] || 1), 0)
  const nextCheckDate = [...paychecks].filter(p => p.date).sort((a, b) => a.date.localeCompare(b.date))[0]?.date || ''

  const focusedCheck = selectedCheckId !== 'all' ? paychecks.find(p => p.id === selectedCheckId) : null
  const defaultAvailable = focusedCheck ? Number(focusedCheck.amount) || 0 : perCheckTotal
  const hasManualOverride = state.paycheckPlan?.available !== undefined && state.paycheckPlan?.available !== ''
  const availableNow = hasManualOverride ? Number(state.paycheckPlan.available) : defaultAvailable
  const dueThrough = state.paycheckPlan?.date || focusedCheck?.date || nextCheckDate || ''

  const unpaidBills = bills.filter(b => !b.paid)
  const billsDueThroughPayday = unpaidBills.filter(b => !dueThrough || b.due <= dueThrough).sort((a, b) => a.due.localeCompare(b.due))
  const unpaidThroughPayday = billsDueThroughPayday.reduce((n, b) => n + (Number(b.amount) || 0), 0)
  const remainingAfterBills = availableNow - unpaidThroughPayday

  const totalMonthlyBudget = categoryBudgets(state).reduce((s, b) => s + b.effective, 0)
  const avgChecksPerMonth = perCheckTotal > 0 ? Math.max(1, monthlyExpected / perCheckTotal) : 2
  const perCycleBudgetShare = totalMonthlyBudget > 0 ? totalMonthlyBudget / avgChecksPerMonth : 0
  const remainingAfterBudgets = remainingAfterBills - perCycleBudgetShare

  function addPaycheck(e) {
    e.preventDefault()
    const f = new FormData(e.target)
    const name = String(f.get('paycheckName') || '').trim()
    const amount = Number(f.get('paycheckAmount'))
    const date = String(f.get('paycheckDate') || '')
    const frequency = String(f.get('paycheckFrequency') || 'Bi-weekly')
    const owner = String(f.get('paycheckOwner') || '').trim()
    const notes = String(f.get('paycheckNotes') || '').trim()
    if (!name || isNaN(amount) || amount < 0) return
    const item = { id: crypto.randomUUID(), name, amount, date, frequency, owner, notes }
    setState(s => ({
      ...s,
      paychecks: [...(s.paychecks || []), item],
      // Automatically sync the planner cutoff date and clear any stale manual cash override so the new paycheck drives the math immediately
      paycheckPlan: {
        ...(s.paycheckPlan || {}),
        date: date || s.paycheckPlan?.date || '',
        available: '',
      },
    }))
    e.target.reset()
    setNotice(`Added "${name}" (${money(amount)} ${frequency.toLowerCase()}). Your paycheck breakdown and app-wide income updated automatically.`)
  }

  function patchPaycheck(id, patch) {
    setState(s => ({
      ...s,
      paychecks: (s.paychecks || []).map(p => p.id === id ? { ...p, ...patch } : p),
    }))
  }

  function bumpPaycheckDate(p) {
    const nextDate = advancePayday(p.date, p.frequency)
    patchPaycheck(p.id, { date: nextDate })
    setState(s => ({
      ...s,
      paycheckPlan: { ...(s.paycheckPlan || {}), date: nextDate },
    }))
    setNotice(`Advanced ${p.name} next payday to ${nextDate}.`)
  }

  function logPaycheckToLedger(p) {
    const dayStr = p.date || dateKey()
    const txId = `paycheck-tx-${p.id}-${dayStr}`
    setState(s => {
      const exists = (s.transactions || []).some(t => t.id === txId)
      if (exists) return s
      const tx = { id: txId, desc: p.owner ? `${p.name} (${p.owner})` : p.name, amount: Number(p.amount) || 0, category: 'Income', type: 'income', date: dayStr }
      return { ...s, transactions: [tx, ...(s.transactions || [])] }
    })
    setNotice(`Logged ${p.name} (${money(p.amount)}) to income ledger.`)
  }

  const activeSourceLabel = hasManualOverride
    ? 'Custom starting amount'
    : focusedCheck
    ? `${focusedCheck.name} (${focusedCheck.frequency || 'Bi-weekly'})`
    : paychecks.length > 0
    ? `All ${paychecks.length} paycheck${paychecks.length === 1 ? '' : 's'} combined`
    : 'No paycheck entered yet'

  return <>
    <div className="grid cols-4" style={{ marginTop: 14 }}>
      <div className="card">
        <h3>Per-Paycheck Take-Home</h3>
        <div className="stat pos">{money(perCheckTotal)}</div>
        <div className="muted">{paychecks.length} paycheck source{paychecks.length === 1 ? '' : 's'}</div>
      </div>
      <div className="card">
        <h3>Monthly Take-Home</h3>
        <div className="stat pos">{money(monthlyExpected)}</div>
        <div className="muted">flows to Dashboard & Budgets</div>
      </div>
      <div className="card">
        <h3>Bills Due Before Payday</h3>
        <div className={'stat ' + (unpaidThroughPayday > 0 ? 'neg' : '')}>{money(unpaidThroughPayday)}</div>
        <div className="muted">{billsDueThroughPayday.length} unpaid bill{billsDueThroughPayday.length === 1 ? '' : 's'} {dueThrough ? `through ${dueThrough}` : 'due'}</div>
      </div>
      <div className="card">
        <h3>Left After Bills</h3>
        <div className={'stat ' + (remainingAfterBills >= 0 ? 'pos' : 'neg')}>{money(remainingAfterBills)}</div>
        <div className="muted">from {money(availableNow)} available</div>
      </div>
    </div>

    {notice && <p role="status" className="family-notice">{notice}</p>}

    <div className="family-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <span className="hud-tag">STEP 1 · INCOME STREAMS</span>
          <h3 style={{ marginTop: 6 }}>1. What Each Paycheck Is</h3>
          <p>Enter each paycheck your household receives (take-home amount after taxes/deductions, how often it arrives, and the next payday). Click any cell in the table below to edit inline.</p>
        </div>
      </div>

      <form className="family-toolbar" onSubmit={addPaycheck}>
        <label className="family-field" style={{ flex: 2 }}>Paycheck / source<input name="paycheckName" required placeholder="e.g. Chris Paycheck, Spouse Paycheck, Bonus…" /></label>
        <label className="family-field">Earner<input name="paycheckOwner" placeholder="Chris, Partner…" /></label>
        <label className="family-field">Net amount ($)<input name="paycheckAmount" type="number" min="0" step="0.01" required placeholder="2400.00" /></label>
        <label className="family-field">Frequency<select name="paycheckFrequency" defaultValue="Bi-weekly">{['Bi-weekly', 'Weekly', 'Semi-monthly', 'Monthly', 'One-time'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="family-field">Next payday<input name="paycheckDate" type="date" defaultValue={dateKey()} /></label>
        <label className="family-field">Notes<input name="paycheckNotes" placeholder="Direct deposit, after 401k…" /></label>
        <button className="btn" type="submit">+ Add paycheck</button>
      </form>

      {paychecks.length === 0 ? (
        <div className="callout" style={{ marginTop: 10 }}>
          <b>Start here:</b> Add your first paycheck above (for example, <i>Chris Paycheck · $2,400 · Bi-weekly</i>). Once added, Step 2 below will automatically subtract your upcoming bills from your paycheck.
        </div>
      ) : (
        <div className="sheet-wrap" style={{ marginTop: 10 }}>
          <table className="sheet">
            <thead>
              <tr>
                <th>Paycheck / source</th>
                <th>Earner</th>
                <th>Frequency</th>
                <th>Next payday</th>
                <th>Notes</th>
                <th className="num" style={{ width: 125 }}>Per Check ($)</th>
                <th className="num" style={{ width: 120 }}>Monthly Est.</th>
                <th style={{ width: 220 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paychecks.map(p => {
                const monthlyEq = (Number(p.amount) || 0) * (FREQ_MULTIPLIER[p.frequency] || 1)
                return (
                  <tr key={p.id} className="r-income">
                    <td>
                      <input aria-label={`${p.name} source`} value={p.name} onChange={e => patchPaycheck(p.id, { name: e.target.value })} />
                    </td>
                    <td>
                      <input aria-label={`${p.name} earner`} value={p.owner || ''} placeholder="Earner…" onChange={e => patchPaycheck(p.id, { owner: e.target.value })} />
                    </td>
                    <td>
                      <select aria-label={`${p.name} frequency`} value={p.frequency || 'Bi-weekly'} onChange={e => patchPaycheck(p.id, { frequency: e.target.value })}>
                        {['Bi-weekly', 'Weekly', 'Semi-monthly', 'Monthly', 'One-time'].map(x => <option key={x}>{x}</option>)}
                      </select>
                    </td>
                    <td>
                      <input aria-label={`${p.name} next payday`} type="date" value={p.date || ''} onChange={e => patchPaycheck(p.id, { date: e.target.value })} />
                    </td>
                    <td>
                      <input aria-label={`${p.name} notes`} value={p.notes || ''} placeholder="notes…" onChange={e => patchPaycheck(p.id, { notes: e.target.value })} />
                    </td>
                    <td className="num">
                      <input
                        aria-label={`${p.name} net amount`}
                        type="number"
                        step="0.01"
                        min="0"
                        className="cell-num income"
                        value={p.amount}
                        onChange={e => { const v = parseFloat(e.target.value); patchPaycheck(p.id, { amount: isNaN(v) ? 0 : v }) }}
                      />
                    </td>
                    <td className="num" style={{ padding: '8px 10px', color: 'var(--muted)', fontSize: 12 }}>
                      {money(monthlyEq)}/mo
                    </td>
                    <td className="rowtools">
                      <button
                        type="button"
                        title="See how this single paycheck covers bills below"
                        onClick={() => {
                          setSelectedCheckId(p.id)
                          setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), date: p.date || s.paycheckPlan?.date || '', available: '' } }))
                        }}
                      >
                        Focus check
                      </button>
                      <button type="button" title="Advance to the next payday date" onClick={() => bumpPaycheckDate(p)}>⏭ Next date</button>
                      <button type="button" title="Log paycheck in income ledger" onClick={() => logPaycheckToLedger(p)}>+ Ledger</button>
                      <button type="button" title="Remove paycheck" aria-label={`Remove ${p.name}`} onClick={() => remove('paychecks', p.id)}>✕</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>
                  Total household paychecks
                </td>
                <td className="num" style={{ color: 'var(--green)' }}>{money(perCheckTotal)}/cycle</td>
                <td className="num" style={{ color: 'var(--cyan)' }}>{money(monthlyExpected)}/mo</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>

    <div className="family-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <span className="hud-tag">STEP 2 · PAYCHECK WATERFALL</span>
          <h3 style={{ marginTop: 6 }}>2. How Your Paycheck Covers Upcoming Bills</h3>
          <p>See exactly how much of your paycheck goes to unpaid bills due by your payday—and how much cash is left over.</p>
        </div>
        {paychecks.length > 0 && (
          <div className="family-actions" style={{ marginTop: 0 }}>
            <button
              type="button"
              className={'btn ' + (selectedCheckId === 'all' && !hasManualOverride ? '' : 'ghost')}
              onClick={() => {
                setSelectedCheckId('all')
                setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), date: nextCheckDate || s.paycheckPlan?.date || '', available: '' } }))
              }}
            >
              All paychecks ({money(perCheckTotal)})
            </button>
            {paychecks.map(p => (
              <button
                key={p.id}
                type="button"
                className={'btn ' + (selectedCheckId === p.id && !hasManualOverride ? '' : 'ghost')}
                onClick={() => {
                  setSelectedCheckId(p.id)
                  setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), date: p.date || s.paycheckPlan?.date || '', available: '' } }))
                }}
              >
                {p.name} ({money(p.amount)})
              </button>
            ))}
          </div>
        )}
      </div>

      {hasManualOverride && paychecks.length > 0 && (
        <div className="callout" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span>
            Showing a custom starting cash amount (<b>{money(availableNow)}</b>) instead of your saved paycheck total (<b>{money(defaultAvailable)}</b>).
          </span>
          <button
            type="button"
            className="btn ghost"
            onClick={() => setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), available: '' } }))}
          >
            Use paycheck amount ({money(defaultAvailable)})
          </button>
        </div>
      )}

      <div className="paycheck-waterfall">
        <div className="waterfall-row">
          <div>
            <strong>Starting Paycheck / Cash Available</strong>
            <div className="muted">{activeSourceLabel}</div>
          </div>
          <div className="waterfall-amt pos">{money(availableNow)}</div>
        </div>

        <div className="waterfall-row">
          <div>
            <strong>− Unpaid Bills Due {dueThrough ? `Through ${dueThrough}` : 'Now'}</strong>
            <div className="muted">
              {billsDueThroughPayday.length === 0
                ? 'No unpaid bills due on or before this payday'
                : billsDueThroughPayday.map(b => `${b.title} (${money(b.amount)} · due ${b.due})`).join(' · ')}
            </div>
          </div>
          <div className="waterfall-amt neg">−{money(unpaidThroughPayday)}</div>
        </div>

        <div className="waterfall-row waterfall-total">
          <div>
            <strong>= Remaining After Those Bills: {money(remainingAfterBills)}</strong>
            <div className="muted">Money left over after paying every bill due through {dueThrough || 'payday'}</div>
          </div>
          <div className={'waterfall-amt ' + (remainingAfterBills >= 0 ? 'pos' : 'neg')}>{money(remainingAfterBills)}</div>
        </div>

        {totalMonthlyBudget > 0 && (
          <div className="waterfall-row" style={{ borderTop: '1px dashed var(--border)' }}>
            <div>
              <strong>− Per-Paycheck Share of Monthly Budgets (Optional Reference)</strong>
              <div className="muted">1 pay cycle share of your {money(totalMonthlyBudget)}/mo planned budgets → leaves <b>{money(remainingAfterBudgets)}</b> unallocated</div>
            </div>
            <div className="waterfall-amt" style={{ color: 'var(--cyan)' }}>−{money(perCycleBudgetShare)}</div>
          </div>
        )}
      </div>

      <div className="family-toolbar" style={{ marginTop: 10 }}>
        <label className="family-field">
          Next payday
          <input
            type="date"
            value={state.paycheckPlan?.date || nextCheckDate || ''}
            onChange={e => setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), date: e.target.value } }))}
          />
          <small style={{ color: 'var(--muted)' }}>Bills due on or before this date are subtracted above</small>
        </label>
        <label className="family-field">
          Money available now ($)
          <input
            type="number"
            min="0"
            step="0.01"
            value={state.paycheckPlan?.available ?? ''}
            placeholder={defaultAvailable ? `${defaultAvailable.toFixed(2)} (auto from paycheck)` : '0.00'}
            onChange={e => setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), available: e.target.value } }))}
          />
          <small style={{ color: 'var(--muted)' }}>Leave blank to use your paycheck amount ({money(defaultAvailable)}) automatically</small>
        </label>
      </div>
    </div>

    <div className="family-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <span className="hud-tag">STEP 3 · OBLIGATIONS</span>
          <h3 style={{ marginTop: 6 }}>3. Bills & Utilities ({unpaidBills.length} unpaid)</h3>
          <p>Add your recurring bills here (or connect them in Bill accounts). Any unpaid bill due on or before your Next payday is subtracted in Step 2 above.</p>
        </div>
        <button className="btn" onClick={() => setDraft({ title: '', due: dateKey(), amount: '', paid: false })}>+ Add bill</button>
      </div>

      {bills.length === 0 ? (
        <p className="muted" style={{ marginTop: 8 }}>No bills added yet. Tap <b>+ Add bill</b> to add rent, mortgage, electric, gas, water, internet, or phone bills.</p>
      ) : (
        <div className="family-cards" style={{ marginTop: 10 }}>
          {[...bills].sort((a, b) => a.due.localeCompare(b.due)).map(b => {
            const inPaydayWindow = !b.paid && (!dueThrough || b.due <= dueThrough)
            return (
              <article key={b.id} className="family-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <small>{b.paid ? '✓ Paid' : b.due < dateKey() ? '⚠ Overdue' : 'Due'} · {b.due}</small>
                  {inPaydayWindow && <span className="badge income">In this paycheck</span>}
                </div>
                <h3>{b.title} · {money(b.amount)}</h3>
                {b.providerId && <p>{b.source === 'arcadia' ? 'Connector statement' : b.source === 'statement_import' ? 'Statement imported and reviewed' : 'Entered manually'}{b.statementDate ? ` · statement ${b.statementDate}` : ''}</p>}
                <div className="family-actions">
                  <button className="btn ghost" onClick={() => setState(s => ({ ...s, bills: s.bills.map(x => x.id === b.id ? { ...x, paid: !x.paid } : x) }))}>{b.paid ? 'Mark unpaid' : 'Mark paid'}</button>
                  <button className="btn ghost" onClick={() => setState(s => { const txId = `bill-tx-${b.id}`; const exists = (s.transactions || []).some(t => t.id === txId); const tx = { id: txId, desc: b.title, amount: Number(b.amount) || 0, category: 'Utilities', type: 'expense', date: dateKey() }; return { ...s, bills: s.bills.map(x => x.id === b.id ? { ...x, paid: true } : x), transactions: exists ? s.transactions : [tx, ...(s.transactions || [])] } })}>Pay & log in ledger</button>
                  <button className="btn ghost" onClick={() => setDraft(b)}>Edit bill</button>
                  <button className="btn ghost" onClick={() => { if (confirm('Delete this bill?')) remove('bills', b.id) }}>Delete</button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  </>
}

function Groceries({ state, setState }) {
  const [notice, setNotice] = useState('')
  const groceries = state.groceries || [], staples = state.groceryStaples || []
  const isStaple = name => staples.some(s => sameItem(s.name, name))
  const checkedCount = groceries.filter(g => g.checked).length
  const saveStaples = items => setState(s => {
    const current = s.groceryStaples || [], fresh = items.filter((item, i) => !current.some(c => sameItem(c.name, item.name)) && items.findIndex(x => sameItem(x.name, item.name)) === i)
    return { ...s, groceryStaples: [...current, ...fresh.map(item => ({ id: crypto.randomUUID(), name: item.name.trim(), quantity: item.quantity || '' }))] }
  })
  function loadStaples() {
    const { added, skipped } = addStaplesToList(groceries, staples)
    setState(s => ({ ...s, groceries: addStaplesToList(s.groceries || [], s.groceryStaples || []).groceries }))
    setNotice(added ? `Added ${added} always-list item${added === 1 ? '' : 's'} to the shopping list${skipped ? ` (${skipped} already on it)` : ''}.` : 'Everything on the always list is already on the shopping list.')
  }
  return <>
    <form className="family-toolbar" onSubmit={e => { e.preventDefault(); const f = new FormData(e.target); setState(s => ({ ...s, groceries: [...(s.groceries || []), { id: crypto.randomUUID(), name: String(f.get('name')).trim(), quantity: String(f.get('quantity')), checked: false }] })); e.target.reset() }}><label className="family-field">Item<input name="name" required placeholder="Bread, milk, chicken…" /></label><label className="family-field">Quantity<input name="quantity" placeholder="2 loaves" /></label><button className="btn">Add item</button></form>
    <div className="family-actions">
      <button className="btn" disabled={!staples.length} onClick={loadStaples}>Add always list to groceries ({staples.length})</button>
      {checkedCount > 0 && <button className="btn ghost" onClick={() => { setState(s => ({ ...s, groceries: (s.groceries || []).filter(g => !g.checked) })); setNotice(`Cleared ${checkedCount} checked item${checkedCount === 1 ? '' : 's'}.`) }}>Clear checked items ({checkedCount})</button>}
      {groceries.some(g => !isStaple(g.name)) && <button className="btn ghost" onClick={() => { saveStaples(groceries); setNotice('Saved the current list items to the always list.') }}>Save whole list as always list</button>}
    </div>
    {notice && <p role="status" className="family-notice">{notice}</p>}
    <div className="family-card">{!groceries.length && <p>Your list is clear. Add the next thing you need{staples.length ? ', or add your always list' : ''}.</p>}{groceries.map(item => <div key={item.id} className="family-agenda"><label className="family-task"><input type="checkbox" checked={item.checked} onChange={() => setState(s => ({ ...s, groceries: s.groceries.map(x => x.id === item.id ? { ...x, checked: !x.checked } : x) }))} /><span style={{ textDecoration: item.checked ? 'line-through' : 'none' }}>{item.name}{item.quantity ? ` · ${item.quantity}` : ''}</span></label><div className="family-actions grocery-item-actions">{isStaple(item.name) ? <small className="grocery-staple-tag">★ Always list</small> : <button className="btn ghost" aria-label={`Save ${item.name} to always list`} onClick={() => saveStaples([item])}>☆ Always</button>}<button className="btn ghost" aria-label={`Remove ${item.name}`} onClick={() => setState(s => ({ ...s, groceries: (s.groceries || []).filter(x => x.id !== item.id) }))}>Remove</button></div></div>)}</div>
    <section className="grocery-staples">
      <h3>Always list</h3>
      <p>The things your family buys every trip. Save them once, then add them all to the shopping list with one tap. Shared with everyone in the household.</p>
      <form className="family-toolbar" onSubmit={e => { e.preventDefault(); const f = new FormData(e.target), name = String(f.get('stapleName')).trim(); if (!name) return; if (isStaple(name)) { setNotice(`${name} is already on the always list.`); return } saveStaples([{ name, quantity: String(f.get('stapleQuantity')) }]); e.target.reset() }}><label className="family-field">Always-list item<input name="stapleName" required placeholder="Milk, eggs, bananas…" /></label><label className="family-field">Usual quantity<input name="stapleQuantity" placeholder="1 gallon" /></label><button className="btn ghost">Save to always list</button></form>
      {!staples.length && <p>Nothing saved yet. Add items here or tap ☆ Always next to anything on the shopping list.</p>}
      {staples.map(s => <div key={s.id} className="family-agenda"><span>{s.name}{s.quantity ? ` · ${s.quantity}` : ''}</span><button className="btn ghost" aria-label={`Remove ${s.name} from always list`} onClick={() => setState(st => ({ ...st, groceryStaples: (st.groceryStaples || []).filter(x => x.id !== s.id) }))}>Remove</button></div>)}
    </section>
  </>
}
