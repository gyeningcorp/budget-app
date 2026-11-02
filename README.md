# House of Gyening · Family Hub

A family budget, calendar, date-night planner and household organizer. React/Vite frontend with an Express backend, Better Auth accounts and SQLite on a persistent Railway volume.

## Start using it

Shared app: https://family-hub-production-03e4.up.railway.app/

1. Open **Family**, create your account (12-character minimum password), then create a household.
2. Create an invitation link and share it privately with a household member. They create their own account and accept the invitation. Links expire in 7 days, work once and can be revoked. Only the owner can invite or remove members.
3. In **Family**, import data from this browser or select a JSON export from the old GitHub Pages app. API keys and bank secrets are excluded. Existing matching records are kept.
4. The owner can save an Anthropic API key under **Family → Claude for the whole family**. It powers the Advisor, Ask Rory, opportunity ideas and personalized date-night suggestions. API usage is billed separately by Anthropic. A household limit of 100 AI requests per UTC day and a response token cap reduce accidental usage; this is not a guaranteed dollar spending cap.

The existing GitHub Pages app remains usable on a single device. Open **Family** there to export data without secrets and get the shared-app link. Browser storage cannot be read across the two sites, so that transfer is explicit.

## Features

- Budget transactions, CSV import/export, category limits and Ask Rory tools.
- Family calendar with annual birthdays/anniversaries, all 11 US federal holidays and observed dates, common occasions and selected Christian observances. Holiday rules: https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/. School, state/local and other religious calendars vary; add yearly events for your family.
- Projects with owners, due dates, planned costs, status and checklists.
- Date nights with ideas, dates, time, childcare, booking notes, planned/actual costs and memories. Claude suggestions are estimates, not verified live listings or bookings.
- Shared groceries, meal plans and ingredient-to-shopping-list actions.
- Bill accounts for Palmetto, Columbia Gas (Pennsylvania), American Water and T-Mobile. Provider sign-in links are shortcuts, not data connections. Upload a PDF/photo or paste a bill summary, approve sending it to Anthropic, and review the extracted facts before saving. Missing dates/amounts remain blank. A second import for the same provider, account ending and due date updates that bill instead of duplicating it.
- Optional Arcadia connector: owner-supplied API credentials are validated and encrypted. The owner checks coverage, authorizes ongoing imports and completes Arcadia Connect on its secure site. The app verifies statements by both an opaque household correlation ID and provider name, then imports the latest USD statement per account. It does not declare a connection complete when a URL is generated. Actual provider coverage, pricing and product activation require the user's live Arcadia account; these are not verified by mocked tests. No Arcadia subscription is created or purchased by the app.
- Connected statement checks run every 30 minutes for connections last checked at least 6 hours earlier. Connections can be paused in the app; pausing does not revoke credentials or delete retained data in Arcadia. Manage vendor permissions separately there. Only current statements are imported, not historical balances as unpaid bills. Payment status is entered manually.
- Paycheck planner showing unpaid bills due through the next payday and remaining entered funds. Bill payments and date expenses do not automatically create ledger transactions.
- Calendar links for projects, date nights, meals and bills; `.ics` exports use all-day entries with times in descriptions.

## How sharing works

Authentication uses secure, HTTP-only cookies in production. Every family route derives the household from the current user's membership. The browser never chooses which household an API request reads or writes.

Changes to different records merge independently. A simultaneous edit to the same record pauses the queue and asks the user to keep their changes or use the latest family version. Pending writes persist in this browser under the signed-in user and household. Repeated requests are idempotent. Connected clients check for updates every 8 seconds and on focus/reconnection.

The old device data is preserved separately. Bank connection settings and device-only API keys are not included in household sync or shared exports. The shared Anthropic key is encrypted with AES-256-GCM using the stable server secret and household context; it is decrypted only when proxying a request to Anthropic. The key is never returned from the API. Keep `AUTH_SECRET` stable and backed up; rotating it without migrating encrypted keys requires owners to re-enter their keys and invalidates existing sessions.

Email delivery and forgotten-password recovery are not configured. Save account passwords securely. Email ownership is not used to grant household access; membership requires an explicit one-use invitation token. No email, SMS or push reminder delivery is implemented.

## Development and verification

Requires Node 24.15+.

```bash
npm ci
npm test
VITE_BASE=/ npm run build
AUTH_SECRET='<random stable secret at least 32 characters>' npm start
```

The server defaults to http://127.0.0.1:3000 and `./data/family.sqlite`. For frontend-only development, `npm run dev` starts Vite; family accounts require the backend.

Tests cover real authentication and cookie sessions, household isolation, invitation expiry/revocation/reuse, member removal, independent edits, conflict detection, idempotent retries, server restarts, encrypted key handling and AI rate limits. The UI integration uses two separate browser DOMs and an actual temporary backend, including date plans, groceries, meals and paycheck math. Billing tests additionally cover consent, file validation, encrypted connector secrets, coverage responses, approved authorization hosts, cross-household filtering, latest-statement selection, paused connections and duplicate statement imports. API calls in tests use fake credentials and a mocked upstream, so they never incur API charges.

## Deployment

Railway builds the Dockerfile, serves the frontend and backend on the same origin, and mounts a persistent volume at `/data`. Use one replica for this SQLite deployment. Required environment variables:

- `AUTH_SECRET`: random, stable, at least 32 characters; never commit it.
- `PUBLIC_URL`: exact HTTPS app origin, also used for trusted-origin checks and invitation links.
- `DATA_DIR=/data`, `PORT=3000`, `NODE_ENV=production`.
- `CLAUDE_MODEL=claude-sonnet-4-6` (optional; defaults to this model).

`GET /api/health` is the deployment health check. Export household data periodically and manage Railway volume backups for recovery. Never expose the SQLite file or `/data` through static hosting. GitHub Pages builds only the frontend at `/budget-app/` and keeps its original device-only storage behavior.
