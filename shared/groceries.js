export const sameItem = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
// Adds always-list items to the shopping list. Items already waiting on the list are skipped;
// items checked off on a previous trip are reused and unchecked instead of duplicated.
export function addStaplesToList(groceries, staples, newId = () => crypto.randomUUID()) {
  let added = 0, skipped = 0
  const next = [...groceries]
  for (const staple of staples) {
    const index = next.findIndex(g => sameItem(g.name, staple.name))
    if (index >= 0 && !next[index].checked) { skipped++; continue }
    if (index >= 0) next[index] = { ...next[index], checked: false, quantity: staple.quantity || next[index].quantity || '' }
    else next.push({ id: newId(), name: staple.name, quantity: staple.quantity || '', checked: false })
    added++
  }
  return { groceries: next, added, skipped }
}
