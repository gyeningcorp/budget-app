import { useState } from 'react'
import { Dialog } from './Family.jsx'
import { dateKey } from './family.js'
import { addStaplesToList, sameItem } from '../shared/groceries.js'
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0)
const FREQ_MULTIPLIER = { Weekly: 52 / 12, 'Bi-weekly': 26 / 12, 'Semi-monthly': 2, Monthly: 1, 'One-time': 1 }

export default function HomePlanning({ tab, state, setState }) {
  const [draft, setDraft] = useState(null), [day, setDay] = useState(dateKey())
  const groceries = state.groceries || [], meals = state.meals || [], bills = state.bills || []
  const remove = (field, id) => setState(s => ({ ...s, [field]: (s[field] || []).filter(x => x.id !== id) }))
  return <section className="family-space"><p className="family-eyebrow">A LITTLE LESS TO REMEMBER</p><h2>{tab === 'Groceries' ? 'The family shopping list' : tab === 'Meals' ? 'What’s for dinner?' : 'Plan the next paycheck'}</h2>
    {tab === 'Groceries' && <Groceries state={state} setState={setState} />}
    {tab === 'Meals' && <><form className="family-card" onSubmit={e => { e.preventDefault(); const f = new FormData(e.target); setState(s => ({ ...s, meals: [...(s.meals || []), { id: crypto.randomUUID(), date: day, slot: String(f.get('slot')), title: String(f.get('title')).trim(), ingredients: String(f.get('ingredients')) }] })); e.target.reset() }}><label className="family-field">Meal date<input type="date" required value={day} onChange={e => setDay(e.target.value)} /></label><label className="family-field">Meal<select name="slot">{['Breakfast', 'Lunch', 'Dinner', 'Snack'].map(x => <option key={x}>{x}</option>)}</select></label><label className="family-field">What are we making?<input name="title" required /></label><label className="family-field">Ingredients (one per line)<textarea name="ingredients" placeholder={'Chicken breast\nRice\nBroccoli'} /></label><button className="btn">Save meal</button></form><div className="family-cards">{[...meals].sort((a, b) => a.date.localeCompare(b.date)).map(m => <article className="family-card" key={m.id}><small>{m.date} · {m.slot}</small><h3>{m.title}</h3><p style={{ whiteSpace: 'pre-line' }}>{m.ingredients}</p><div className="family-actions"><button className="btn ghost" onClick={() => setState(s => { const names = m.ingredients.split('\n').map(x => x.trim()).filter(Boolean); return { ...s, groceries: [...(s.groceries || []), ...names.filter(name => !(s.groceries || []).some(g => !g.checked && g.name.toLowerCase() === name.toLowerCase())).map(name => ({ id: crypto.randomUUID(), name, quantity: '', checked: false }))] } })}>Add ingredients to groceries</button><button className="btn ghost" onClick={() => remove('meals', m.id)}>Remove meal</button></div></article>)}</div></>}
    {tab === 'Paychecks' && <Paychecks state={state} setState={setState} bills={bills} setDraft={setDraft} remove={remove} />}
    {draft && <Dialog label="Bill editor" onClose={() => setDraft(null)}><form onSubmit={e => { e.preventDefault(); const item = { ...draft, id: draft.id || crypto.randomUUID() }; setState(s => ({ ...s, bills: [...(s.bills || []).filter(b => b.id !== item.id), item] })); setDraft(null) }}><h3>{draft.id ? 'Edit bill' : 'Add bill'}</h3>{[['title', 'Bill name', 'text'], ['due', 'Due date', 'date'], ['amount', 'Amount ($)', 'number']].map(([key, label, type]) => <label key={key} className="family-field">{label}<input type={type} required min={type === 'number' ? 0 : undefined} step={type === 'number' ? '0.01' : undefined} value={draft[key]} onChange={e => setDraft(s => ({ ...s, [key]: e.target.value }))} /></label>)}<div className="family-actions"><button className="btn">Save bill</button><button type="button" className="btn ghost" onClick={() => setDraft(null)}>Cancel</button></div></form></Dialog>}
  </section>
}

function Paychecks({ state, setState, bills, setDraft, remove }) {
  const [notice, setNotice] = useState('')
  const paychecks = state.paychecks || []
  const perCheckTotal = paychecks.reduce((n, p) => n + (Number(p.amount) || 0), 0)
  const monthlyExpected = paychecks.reduce((n, p) => n + (Number(p.amount) || 0) * (FREQ_MULTIPLIER[p.frequency] || 1), 0)
  const nextCheckDate = [...paychecks].filter(p => p.date).sort((a, b) => a.date.localeCompare(b.date))[0]?.date || ''
  const dueThrough = state.paycheckPlan?.date || ''
  const unpaidThroughPayday = bills.filter(b => !b.paid && (!dueThrough || b.due <= dueThrough)).reduce((n, b) => n + Number(b.amount), 0)
  const availableNow = state.paycheckPlan?.available !== undefined && state.paycheckPlan?.available !== '' ? Number(state.paycheckPlan.available) : perCheckTotal

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
      paycheckPlan: {
        ...(s.paycheckPlan || {}),
        date: s.paycheckPlan?.date || date,
      },
    }))
    e.target.reset()
    setNotice(`Saved paycheck "${name}" (${money(amount)}).`)
  }

  function patchPaycheck(id, patch) {
    setState(s => ({ ...s, paychecks: (s.paychecks || []).map(p => p.id === id ? { ...p, ...patch } : p) }))
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

  return <>
    <div className="grid cols-3" style={{ marginTop: 14 }}>
      <div className="card">
        <h3>Household Paychecks</h3>
        <div className="stat pos">{money(perCheckTotal)}</div>
        <div className="muted">{paychecks.length} paycheck source{paychecks.length === 1 ? '' : 's'} per cycle</div>
      </div>
      <div className="card">
        <h3>Est. Monthly Take-Home</h3>
        <div className="stat pos">{money(monthlyExpected)}</div>
        <div className="muted">based on paycheck frequencies</div>
      </div>
      <div className="card">
        <h3>Remaining After Bills</h3>
        <div className={'stat ' + (availableNow - unpaidThroughPayday >= 0 ? 'pos' : 'neg')}>{money(availableNow - unpaidThroughPayday)}</div>
        <div className="muted">after {money(unpaidThroughPayday)} unpaid due through payday</div>
      </div>
    </div>

    {notice && <p role="status" className="family-notice">{notice}</p>}

    <div className="family-card">
      <h3>What each paycheck is · Household income streams</h3>
      <p>List each paycheck your household receives (who it’s for, net take-home amount, frequency and next payday). Click any cell in the table to update amounts or dates inline.</p>
      <form className="family-toolbar" onSubmit={addPaycheck}>
        <label className="family-field" style={{ flex: 2 }}>Paycheck / source<input name="paycheckName" required placeholder="Chris paycheck, Sarah paycheck, Side gig…" /></label>
        <label className="family-field">Earner<input name="paycheckOwner" placeholder="Chris, Sarah…" /></label>
        <label className="family-field">Net amount ($)<input name="paycheckAmount" type="number" min="0" step="0.01" required placeholder="2400.00" /></label>
        <label className="family-field">Frequency<select name="paycheckFrequency" defaultValue="Bi-weekly">{['Bi-weekly', 'Weekly', 'Semi-monthly', 'Monthly', 'One-time'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="family-field">Next payday<input name="paycheckDate" type="date" defaultValue={dateKey()} /></label>
        <label className="family-field">Notes<input name="paycheckNotes" placeholder="Direct deposit, net after 401k…" /></label>
        <button className="btn" type="submit">+ Add paycheck</button>
      </form>

      {paychecks.length === 0 ? (
        <p>No paychecks saved yet. Add each household paycheck above so you can see exactly what each check brings in.</p>
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
                <th className="num" style={{ width: 130 }}>Net amount ($)</th>
                <th style={{ width: 190 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paychecks.map(p => (
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
                  <td className="rowtools">
                    <button type="button" title="Use this paycheck in planner below" onClick={() => setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), date: p.date || s.paycheckPlan?.date || '', available: String(p.amount) } }))}>Use in plan</button>
                    <button type="button" title="Log paycheck in income ledger" onClick={() => logPaycheckToLedger(p)}>+ Ledger</button>
                    <button type="button" title="Remove paycheck" aria-label={`Remove ${p.name}`} onClick={() => remove('paychecks', p.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5}>
                  Combined per-paycheck total (est. {money(monthlyExpected)} / month)
                  <button type="button" className="btn ghost" style={{ marginLeft: 12, padding: '4px 10px', fontSize: 12 }} onClick={() => setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), date: nextCheckDate || s.paycheckPlan?.date || '', available: String(perCheckTotal) } }))}>
                    Load total ({money(perCheckTotal)}) into planner
                  </button>
                </td>
                <td className="num" style={{ color: 'var(--green)' }}>{money(perCheckTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>

    <div className="family-card">
      <h3>Until the next payday</h3>
      <label className="family-field">Next payday<input type="date" value={state.paycheckPlan?.date || ''} onChange={e => setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), date: e.target.value } }))} /></label>
      <label className="family-field">Money available now ($)<input type="number" min="0" step="0.01" value={state.paycheckPlan?.available ?? ''} placeholder={perCheckTotal ? String(perCheckTotal) : '0.00'} onChange={e => setState(s => ({ ...s, paycheckPlan: { ...(s.paycheckPlan || {}), available: e.target.value } }))} /></label>
      <p>Unpaid bills due through payday: <b>{money(unpaidThroughPayday)}</b></p>
      <h3>Remaining after those bills: {money(availableNow - unpaidThroughPayday)}</h3>
      <p>Based on the balance or paychecks you enter. Paid bills do not create a transaction automatically unless you choose Pay & log in ledger.</p>
    </div>

    <button className="btn" onClick={() => setDraft({ title: '', due: dateKey(), amount: '', paid: false })}>+ Add bill</button>
    <div className="family-cards">{[...bills].sort((a, b) => a.due.localeCompare(b.due)).map(b => <article key={b.id} className="family-card"><small>{b.paid ? 'Paid' : b.due < dateKey() ? 'Overdue' : 'Due'} · {b.due}</small><h3>{b.title} · {money(b.amount)}</h3>{b.providerId && <p>{b.source === 'arcadia' ? 'Connector statement' : b.source === 'statement_import' ? 'Statement imported and reviewed' : 'Entered manually'}{b.statementDate ? ` · statement ${b.statementDate}` : ''}</p>}<div className="family-actions"><button className="btn ghost" onClick={() => setState(s => ({ ...s, bills: s.bills.map(x => x.id === b.id ? { ...x, paid: !x.paid } : x) }))}>{b.paid ? 'Mark unpaid' : 'Mark paid'}</button><button className="btn ghost" onClick={() => setState(s => { const txId = `bill-tx-${b.id}`; const exists = (s.transactions || []).some(t => t.id === txId); const tx = { id: txId, desc: b.title, amount: Number(b.amount) || 0, category: 'Utilities', type: 'expense', date: dateKey() }; return { ...s, bills: s.bills.map(x => x.id === b.id ? { ...x, paid: true } : x), transactions: exists ? s.transactions : [tx, ...(s.transactions || [])] } })}>Pay & log in ledger</button><button className="btn ghost" onClick={() => setDraft(b)}>Edit bill</button><button className="btn ghost" onClick={() => { if (confirm('Delete this bill?')) remove('bills', b.id) }}>Delete</button></div></article>)}</div>
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
