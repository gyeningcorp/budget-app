# Budget Sync — Plaid backend (Cloudflare Worker)

This Worker is the secure half of live bank auto-sync. It holds your Plaid secret
(which can **never** live in the browser), stores your bank access token in KV, and
runs the Plaid `transactions/sync` calls. The frontend only ever talks to this Worker.

## One-time setup (~10 minutes)

### 1. Get Plaid keys (free)
- Sign up at https://dashboard.plaid.com/signup
- Your **Sandbox** keys work instantly (fake test banks — great for proving it works).
- Dashboard → **Team Settings → Keys**: copy `client_id` and the **sandbox** `secret`.

### 2. Create the KV store
```bash
cd worker
npx wrangler kv namespace create BUDGET_KV
```
Paste the returned `id` into `wrangler.toml` (replace `REPLACE_WITH_KV_ID`).

### 3. Set secrets
```bash
npx wrangler secret put PLAID_CLIENT_ID    # paste your client_id
npx wrangler secret put PLAID_SECRET       # paste your sandbox secret
npx wrangler secret put APP_SECRET         # any long random string — your app password
```

### 4. Deploy
```bash
npx wrangler deploy
```
Wrangler prints a URL like `https://budget-sync.<you>.workers.dev`.

### 5. Point the app at it
In the app → **Settings → Bank Sync**:
- **Sync server URL** = the workers.dev URL above
- **App secret** = the same `APP_SECRET` you set in step 3

Then **Transactions → Connect bank**. In sandbox, search “**Platypus**” and log in with
`user_good` / `pass_good` to simulate a linked bank. Hit **Sync now** and real Plaid
test transactions flow into your ledger.

## Going to real banks
Once you've tested in sandbox, request **Production** access in the Plaid dashboard
(Plaid reviews your app first). When approved, set `PLAID_ENV = "production"` in
`wrangler.toml`, run `wrangler secret put PLAID_SECRET` with your production secret,
and `wrangler deploy` again. No frontend changes needed.

## Endpoints
All POST, all require header `x-app-secret: <APP_SECRET>`.
- `/api/create_link_token` → `{ link_token }`
- `/api/exchange_public_token` `{ public_token }` → `{ ok }`
- `/api/sync` → `{ added: [...ledger rows], removedIds: [...] }`
- `/api/status` → `{ linked, env }`
- `/api/unlink` → `{ ok }`
