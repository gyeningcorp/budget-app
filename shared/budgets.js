export const DEFAULT_CATEGORIES = ['Income', 'Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Fun', 'Savings', 'Other']
export const PAYCHECK_FREQUENCIES = ['Bi-weekly', 'Weekly', 'Semi-monthly', 'Monthly', 'One-time']
const FREQ_MULTIPLIER = { Weekly: 52 / 12, 'Bi-weekly': 26 / 12, 'Semi-monthly': 2, Monthly: 1, 'One-time': 1 }
const sameKey = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

export function paycheckSummary(state) {
  const paychecks = state?.paychecks || []
  const perCycle = paychecks.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const monthly = paychecks.reduce((s, p) => s + (Number(p.amount) || 0) * (FREQ_MULTIPLIER[p.frequency] || 1), 0)
  const nextDate = [...paychecks].filter((p) => p.date).sort((a, b) => a.date.localeCompare(b.date))[0]?.date || ''
  return { count: paychecks.length, perCycle, monthly, nextDate }
}

export function allCategories(state) {
  const seen = [...DEFAULT_CATEGORIES]
  const add = (c) => {
    const clean = String(c || '').trim()
    if (clean && !seen.some((x) => sameKey(x, clean))) seen.push(clean)
  }
  for (const c of Object.keys(state?.budgets || {})) add(c)
  for (const item of state?.budgetItems || []) add(item?.category)
  for (const t of state?.transactions || []) add(t?.category)
  return seen
}

export function canonicalCategory(state, raw) {
  const clean = String(raw || '').trim()
  if (!clean) return ''
  const match = allCategories(state).find((c) => sameKey(c, clean))
  return match || clean
}

// Effective limit & actuals per category:
// - If a category has line items, its planned total is the sum of those items; otherwise `state.budgets[cat]`.
// - `itemActualSum` sums any typed actuals on the line items; `effectiveActual` uses `Math.max(txSpent, itemActualSum)`
//   when `byCat` is provided so typed line-item actuals and ledger transactions both count.
export function categoryBudgets(state, byCat = {}) {
  const budgets = state?.budgets || {}, items = state?.budgetItems || []
  const byCategory = new Map()
  for (const [cat, limit] of Object.entries(budgets)) {
    byCategory.set(cat, { category: cat, limit: Number(limit) || 0, items: [] })
  }
  for (const item of items) {
    const key = [...byCategory.keys()].find((k) => sameKey(k, item.category)) || item.category
    if (!byCategory.has(key)) byCategory.set(key, { category: key, limit: 0, items: [] })
    byCategory.get(key).items.push(item)
  }
  return [...byCategory.values()].map((entry) => {
    const itemSum = entry.items.reduce((s, x) => s + (Number(x.amount) || 0), 0)
    const itemActualSum = entry.items.reduce((s, x) => s + (Number(x.actual) || 0), 0)
    const hasTypedActual = entry.items.some((x) => typeof x.actual === 'number' && x.actual > 0)
    const txKey = Object.keys(byCat || {}).find((k) => sameKey(k, entry.category))
    const txSpent = txKey ? Number(byCat[txKey]) || 0 : 0
    const effective = entry.items.length > 0 ? itemSum : entry.limit
    const actual = hasTypedActual ? Math.max(txSpent, itemActualSum) : txSpent
    return { ...entry, itemSum, itemActualSum, txSpent, effective, actual }
  })
}
