export const DEFAULT_CATEGORIES = ['Income', 'Housing', 'Food', 'Transport', 'Utilities', 'Debt', 'Health', 'Fun', 'Savings', 'Other']
export const PAYCHECK_FREQUENCIES = ['Bi-weekly', 'Weekly', 'Semi-monthly', 'Monthly', 'One-time']
export const DEBT_CATEGORIES = ['Credit Card', 'Auto Loan', 'Student Loan', 'Personal Loan', 'Medical', 'Mortgage', 'Other']
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

export function debtSummary(state) {
  const debts = (state?.debts || []).map((d) => ({
    ...d,
    balance: Math.max(0, Number(d.balance) || 0),
    apr: Math.max(0, Number(d.apr) || 0),
    minPayment: Math.max(0, Number(d.minPayment) || 0),
    extraPayment: Math.max(0, Number(d.extraPayment) || 0),
  }))
  const active = debts.filter((d) => d.balance > 0)
  const totalBalance = active.reduce((s, d) => s + d.balance, 0)
  const totalMinPayment = active.reduce((s, d) => s + d.minPayment, 0)
  const totalExtraPayment = active.reduce((s, d) => s + d.extraPayment, 0)
  const totalMonthlyPayment = totalMinPayment + totalExtraPayment
  const monthlyInterest = active.reduce((s, d) => s + d.balance * (d.apr / 100 / 12), 0)
  const weightedApr = totalBalance > 0 ? active.reduce((s, d) => s + d.balance * d.apr, 0) / totalBalance : 0
  return {
    count: active.length,
    totalCount: debts.length,
    totalBalance,
    totalMinPayment,
    totalExtraPayment,
    totalMonthlyPayment,
    monthlyInterest,
    weightedApr,
    debts,
  }
}

function addMonthsISO(monthsAhead, fromDate = new Date()) {
  const d = new Date(fromDate.getFullYear(), fromDate.getMonth() + monthsAhead, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function runPayoffSim(rawDebts, extraMonthly = 0, strategy = 'avalanche', rollover = true) {
  const active = (rawDebts || [])
    .map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category || 'Credit Card',
      balance: Math.max(0, Number(d.balance) || 0),
      apr: Math.max(0, Number(d.apr) || 0),
      minPayment: Math.max(0, Number(d.minPayment) || 0),
      extraPayment: Math.max(0, Number(d.extraPayment) || 0),
      due: d.due || '',
      notes: d.notes || '',
    }))
    .filter((d) => d.balance > 0.005)

  if (active.length === 0) {
    return { months: 0, debtFreeDate: addMonthsISO(0), totalInterest: 0, order: [] }
  }

  const comparator =
    strategy === 'snowball'
      ? (a, b) => a.balance - b.balance || b.apr - a.apr
      : (a, b) => b.apr - a.apr || a.balance - b.balance

  const ordered = [...active].sort(comparator)
  const sim = ordered.map((d) => ({
    ...d,
    rem: d.balance,
    interestPaid: 0,
    payoffMonth: null,
    effectiveMin: d.minPayment > 0 ? d.minPayment : Math.max(25, d.balance * 0.02),
  }))

  const itemExtraTotal = sim.reduce((s, d) => s + d.extraPayment, 0)
  const totalBaseBudget =
    sim.reduce((s, d) => s + d.effectiveMin, 0) + itemExtraTotal + Math.max(0, Number(extraMonthly) || 0)

  let months = 0
  let totalInterest = 0
  const MAX_MONTHS = 600

  while (sim.some((d) => d.rem > 0.005) && months < MAX_MONTHS) {
    months++
    // 1. Accrue monthly interest
    for (const d of sim) {
      if (d.rem <= 0.005) continue
      const interest = d.rem * (d.apr / 100 / 12)
      d.rem += interest
      d.interestPaid += interest
      totalInterest += interest
    }

    // 2. Pay minimums first
    let budgetLeft = totalBaseBudget
    for (const d of sim) {
      if (d.rem <= 0.005) continue
      const pay = Math.min(d.rem, d.effectiveMin)
      d.rem -= pay
      budgetLeft -= pay
      if (d.rem <= 0.005 && d.payoffMonth === null) {
        d.rem = 0
        d.payoffMonth = months
      }
    }

    // 3. Apply remaining snowball/avalanche pool in priority order
    if (rollover && budgetLeft > 0.005) {
      for (const d of sim) {
        if (d.rem <= 0.005 || budgetLeft <= 0.005) continue
        const pay = Math.min(d.rem, budgetLeft)
        d.rem -= pay
        budgetLeft -= pay
        if (d.rem <= 0.005 && d.payoffMonth === null) {
          d.rem = 0
          d.payoffMonth = months
        }
      }
    }
  }

  const firstTargetId = sim[0]?.id
  const firstExtra = itemExtraTotal + Math.max(0, Number(extraMonthly) || 0)
  const order = sim.map((d, idx) => ({
    rank: idx + 1,
    id: d.id,
    name: d.name,
    category: d.category,
    balance: d.balance,
    apr: d.apr,
    minPayment: d.minPayment,
    extraPayment: d.extraPayment,
    firstMonthTargetPayment: d.id === firstTargetId ? d.effectiveMin + firstExtra : d.effectiveMin,
    payoffMonth: d.payoffMonth ?? MAX_MONTHS,
    payoffDate: addMonthsISO(d.payoffMonth ?? MAX_MONTHS),
    interestPaid: d.interestPaid,
  }))

  return {
    months,
    debtFreeDate: addMonthsISO(months),
    totalInterest,
    order,
  }
}

export function simulateDebtPayoff(debts, extraMonthly = 0, strategy = 'avalanche') {
  const plan = runPayoffSim(debts, extraMonthly, strategy, true)
  const minOnly = runPayoffSim(
    (debts || []).map((d) => ({ ...d, extraPayment: 0 })),
    0,
    strategy,
    false
  )
  const interestSaved = Math.max(0, minOnly.totalInterest - plan.totalInterest)
  const monthsSaved = Math.max(0, minOnly.months - plan.months)

  const steps = []
  if (plan.order.length > 0) {
    const first = plan.order[0]
    const totalMin = plan.order.reduce((s, d) => s + (d.minPayment || 0), 0)
    steps.push(
      `Step 1 — Lock in all minimum payments ($${totalMin.toFixed(2)}/mo across ${plan.order.length} debt${plan.order.length === 1 ? '' : 's'}) on autopay so you never incur late fees or penalty APRs.`
    )
    steps.push(
      `Step 2 — Focus 100% of your extra debt payment on #1 ${first.name} (${first.apr}% APR, $${first.balance.toFixed(2)} balance): pay $${first.firstMonthTargetPayment.toFixed(2)}/mo total until it hits $0 in ~${first.payoffMonth} month${first.payoffMonth === 1 ? '' : 's'} (${first.payoffDate}).`
    )
    if (plan.order.length > 1) {
      const second = plan.order[1]
      steps.push(
        `Step 3 — Rollover ("${strategy === 'avalanche' ? 'Avalanche' : 'Snowball'}"): the moment ${first.name} is paid off, roll its entire $${first.firstMonthTargetPayment.toFixed(2)}/mo payment into #2 ${second.name} (${second.apr}% APR) until paid off by ${second.payoffDate}.`
      )
    }
    if (interestSaved > 1 || monthsSaved > 0) {
      steps.push(
        `Step 4 — Stay the course to be 100% debt-free by ${plan.debtFreeDate} (${plan.months} months), saving $${interestSaved.toFixed(2)} in interest and ${monthsSaved} month${monthsSaved === 1 ? '' : 's'} compared to minimum payments.`
      )
    }
  }

  return {
    ...plan,
    strategy,
    extraMonthly: Math.max(0, Number(extraMonthly) || 0),
    baselineMonths: minOnly.months,
    baselineInterest: minOnly.totalInterest,
    interestSaved,
    monthsSaved,
    steps,
  }
}

export function realtimeFinancialSnapshot(state) {
  const pay = paycheckSummary(state)
  let loggedIncome = 0,
    txExpense = 0
  const byCat = {}
  for (const t of state?.transactions || []) {
    if (t.type === 'income') loggedIncome += Number(t.amount) || 0
    else {
      txExpense += Number(t.amount) || 0
      byCat[t.category] = (byCat[t.category] || 0) + (Number(t.amount) || 0)
    }
  }
  const budgets = categoryBudgets(state, byCat)
  const totalPlannedBudget = budgets.reduce((s, b) => s + b.effective, 0)
  const totalActualSpent = budgets.reduce((s, b) => s + b.actual, 0)
  const monthlyIncome = pay.count > 0 ? Math.max(pay.monthly, loggedIncome) : loggedIncome
  const monthlyExpense = Math.max(txExpense, totalActualSpent)

  const dueThrough = state?.paycheckPlan?.date || pay.nextDate || ''
  const hasManualAvailable = state?.paycheckPlan?.available !== undefined && state?.paycheckPlan?.available !== ''
  const availableOnNextPaycheck = hasManualAvailable ? Number(state.paycheckPlan.available) || 0 : pay.perCycle
  const unpaidBills = (state?.bills || []).filter((b) => !b.paid).sort((a, b) => a.due.localeCompare(b.due))
  const billsDueThroughPayday = unpaidBills.filter((b) => !dueThrough || b.due <= dueThrough)
  const unpaidBillsThroughPayday = billsDueThroughPayday.reduce((s, b) => s + (Number(b.amount) || 0), 0)
  const remainingAfterPaydayBills = availableOnNextPaycheck - unpaidBillsThroughPayday

  const debt = debtSummary(state)
  const avalanche = simulateDebtPayoff(state?.debts || [], 0, 'avalanche')
  const snowball = simulateDebtPayoff(state?.debts || [], 0, 'snowball')

  return {
    paycheckPerCycle: pay.perCycle,
    paycheckMonthly: pay.monthly,
    paycheckCount: pay.count,
    nextPayday: dueThrough,
    availableOnNextPaycheck,
    unpaidBillsThroughPayday,
    billsDueThroughPayday,
    remainingAfterPaydayBills,
    totalUnpaidBills: unpaidBills.reduce((s, b) => s + (Number(b.amount) || 0), 0),
    unpaidBillsCount: unpaidBills.length,
    monthlyIncome,
    monthlyExpense,
    netMonthlyCashflow: monthlyIncome - monthlyExpense,
    totalPlannedBudget,
    unbudgetedMonthlyIncome: monthlyIncome - totalPlannedBudget,
    debt,
    avalanche,
    snowball,
  }
}
