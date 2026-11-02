export const BILL_PROVIDERS = [
  { id: 'palmetto', name: 'Palmetto', kind: 'Solar / energy', portal: 'https://home.palmetto.com/', note: 'Use the Palmetto homeowner account shown on your statement.' },
  { id: 'columbia-gas', name: 'Columbia Gas', kind: 'Natural gas', portal: 'https://myaccount.columbiagaspa.com/', note: 'Pennsylvania portal. Select the provider and state shown on your statement.' },
  { id: 'american-water', name: 'American Water', kind: 'Water / wastewater', portal: 'https://login.amwater.com/', note: 'Use MyWater to view or download the statement for your account.' },
  { id: 't-mobile', name: 'T-Mobile', kind: 'Phone / internet', portal: 'https://account.t-mobile.com/', note: 'Use T-Life or your T-Mobile account to download a detailed bill.' },
]
export const providerById = id => BILL_PROVIDERS.find(p => p.id === id)
const normalized = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
export function matchesProvider(id, name) { const needle = { palmetto: 'palmetto', 'columbia-gas': 'columbiagas', 'american-water': 'americanwater', 't-mobile': 'tmobile' }[id]; return !!needle && normalized(name).includes(needle) }
export function validDay(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(value + 'T12:00:00Z'); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value }
export function statementFields(input) {
  const result = { providerName: typeof input.providerName === 'string' ? input.providerName.slice(0, 100) : '', amount: typeof input.amount === 'number' && Number.isFinite(input.amount) && input.amount >= 0 ? input.amount : null, due: validDay(input.due) ? input.due : '', statementDate: validDay(input.statementDate) ? input.statementDate : '', accountLast4: typeof input.accountLast4 === 'string' && /^[a-zA-Z0-9]{4}$/.test(input.accountLast4) ? input.accountLast4 : '', notes: typeof input.notes === 'string' ? input.notes.slice(0, 1000) : '' }
  return result
}
export function approvedConnectURL(value) { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'platform-connect.arcadia.com' && !u.username && !u.password && !u.port } catch { return false } }
