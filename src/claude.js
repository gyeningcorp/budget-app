export const CLAUDE_SUBSCRIPTION_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Pro / Max Subscription Default)' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 (Pro / Max Deep Strategy)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Fast Subscription)' },
]

export function claudeRequest(state, body) {
  const model = state?.claudeModel || body?.model || 'claude-sonnet-4-6'
  const payload = { ...body, model }
  if (state?._sharedAI) {
    return fetch('/api/family/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }
  const token = String(state?.apiKey || '').trim().replace(/^Bearer\s+/i, '').trim()
  const isSubscriptionOAuth = token.startsWith('sk-ant-oat')
  const authHeaders = isSubscriptionOAuth
    ? { Authorization: `Bearer ${token}`, 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' }
    : { 'x-api-key': token }
  const finalBody =
    isSubscriptionOAuth && payload.system && typeof payload.system === 'string'
      ? {
          ...payload,
          system: [
            { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
            { type: 'text', text: payload.system },
          ],
        }
      : payload

  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(finalBody),
  })
}

export async function openInClaudeSubscription(question, snapshotText) {
  const fullPrompt =
    `You are my House of Gyening · Family Hub financial & debt advisor.\n\n` +
    `MY LIVE HOUSEHOLD SNAPSHOT:\n${snapshotText}\n\n` +
    `MY QUESTION / REQUEST:\n${question || 'Review my paychecks, bills, budgets, and debts and give me the best next steps.'}`
  try {
    await navigator.clipboard?.writeText(fullPrompt)
  } catch {
    // Ignore clipboard permission errors in non-interactive environments
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open('https://claude.ai/new', '_blank', 'noopener,noreferrer')
  }
  return fullPrompt
}
