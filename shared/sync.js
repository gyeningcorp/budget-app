export const ARRAY_FIELDS = ['transactions', 'familyEvents', 'familyProjects', 'dateNights', 'groceries', 'meals', 'bills', 'billAccounts']
export const MAP_FIELDS = ['budgets', 'paycheckPlan']
export const SHARED_FIELDS = [...ARRAY_FIELDS, ...MAP_FIELDS]
const unsafe = key => ['__proto__', 'constructor', 'prototype'].includes(key)
export const emptyShared = () => Object.fromEntries(SHARED_FIELDS.map(k => [k, ARRAY_FIELDS.includes(k) ? [] : {}]))
export const sharedState = state => Object.fromEntries(SHARED_FIELDS.map(k => [k, state[k] ?? (ARRAY_FIELDS.includes(k) ? [] : {})]))
export const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
export function differences(before, after) {
  const ops = []
  for (const field of ARRAY_FIELDS) {
    const old = new Map((before[field] || []).map(x => [x.id, x])), next = new Map((after[field] || []).map(x => [x.id, x]))
    for (const id of new Set([...old.keys(), ...next.keys()])) if (!equal(old.get(id), next.get(id))) ops.push({ field, id, before: old.get(id) ?? null, value: next.get(id) ?? null })
  }
  for (const field of MAP_FIELDS) for (const id of new Set([...Object.keys(before[field] || {}), ...Object.keys(after[field] || {})])) {
    const a = before[field]?.[id] ?? null, b = after[field]?.[id] ?? null
    if (!equal(a, b)) ops.push({ field, id, before: a, value: b })
  }
  return ops
}
export function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length > 5000) throw new Error('Too many changes. Import a smaller file.')
  for (const op of ops) {
    if (!op || !SHARED_FIELDS.includes(op.field) || typeof op.id !== 'string' || !op.id || op.id.length > 200 || unsafe(op.id)) throw new Error('Invalid change')
    if (ARRAY_FIELDS.includes(op.field) && op.value !== null && (!op.value || Array.isArray(op.value) || op.value.id !== op.id)) throw new Error('Invalid record')
    validateRecord(op.field, op.value)
    if (JSON.stringify(op).length > 50000) throw new Error('Record too large')
  }
}
export function applyOps(state, ops, checkConflicts = false) {
  validateOps(ops)
  const next = structuredClone(sharedState(state))
  for (const op of ops) {
    const list = ARRAY_FIELDS.includes(op.field), current = list ? next[op.field].find(x => x.id === op.id) ?? null : next[op.field][op.id] ?? null
    if (checkConflicts && !equal(current, op.before) && !equal(current, op.value)) {
      const error = new Error('Someone changed the same item. Review the latest version before retrying.'); error.code = 'CONFLICT'; throw error
    }
    if (list) { const index = next[op.field].findIndex(x => x.id === op.id); if (op.value === null) next[op.field] = next[op.field].filter(x => x.id !== op.id); else if (index < 0) next[op.field].push(op.value); else next[op.field][index] = op.value }
    else if (op.value === null) delete next[op.field][op.id]
    else next[op.field][op.id] = op.value
  }
  if (JSON.stringify(next).length > 1000000 || ARRAY_FIELDS.some(k => next[k].length > 5000)) throw new Error('Household storage limit reached. Export and archive older records.')
  return next
}
export function validateRecord(field, value) {
  if (value === null) return
  const text = key => typeof value[key] === 'string' && value[key].length <= 10000
  const day = key => text(key) && /^\d{4}-\d{2}-\d{2}$/.test(value[key]) && !Number.isNaN(Date.parse(value[key] + 'T12:00:00Z'))
  const amount = key => value[key] === '' || (['number', 'string'].includes(typeof value[key]) && Number.isFinite(Number(value[key])) && Number(value[key]) >= 0)
  let valid = true
  if (field === 'transactions') valid = text('desc') && day('date') && amount('amount') && ['income', 'expense'].includes(value.type) && text('category')
  if (field === 'familyEvents') valid = text('title') && day('date')
  if (field === 'familyProjects') valid = text('title') && Array.isArray(value.tasks) && value.tasks.length <= 500 && value.tasks.every(t => t && typeof t.id === 'string' && typeof t.text === 'string' && typeof t.done === 'boolean')
  if (field === 'dateNights') valid = text('title') && day('date') && amount('budget') && amount('spent') && text('notes') && ['Idea', 'Planned', 'Done', 'Cancelled'].includes(value.status)
  if (field === 'groceries') valid = text('name') && typeof value.checked === 'boolean'
  if (field === 'meals') valid = text('title') && day('date') && text('slot') && text('ingredients')
  if (field === 'billAccounts') valid = text('providerId') && text('nickname') && (value.accountLast4 === '' || /^[a-zA-Z0-9]{4}$/.test(value.accountLast4)) && text('notes')
  if (field === 'bills') valid = text('title') && day('due') && amount('amount') && typeof value.paid === 'boolean'
  if (field === 'budgets') valid = typeof value === 'number' && Number.isFinite(value) && value >= 0
  if (!valid) throw new Error(`Invalid ${field} record. Check the imported data.`)
}
