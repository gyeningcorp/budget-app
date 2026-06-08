# House of Gyening · Budget

A private, **local-first** budgeting app with an AI money advisor. Built with React + Vite. No backend — all your data lives in your browser's `localStorage`, and AI requests go **directly from your browser to Anthropic** using a key you provide.

## Features

- **Dashboard** — income, spending, net, spend-by-category, recent activity
- **Transactions** — add/delete income & expenses with categories
- **Budgets** — set per-category limits with budget-vs-actual progress bars
- **Advisor** — chat with an AI advisor that sees your real numbers (Claude)
- **Ask Rory (every page)** — a floating AI assistant on every tab that not only answers questions but *makes changes* for you: "add $40 groceries today", "set Fun budget to $150", "delete that gas charge", "take me to Budgets". It uses Claude tool-calling to edit your ledger and budgets directly.
- **Settings** — store your API key locally, export your data as JSON, or wipe everything

Your data never touches a server we control. The API key is stored only in this browser.

## Run it locally

```bash
npm install
npm run dev
```

Then open the printed URL (default http://localhost:5173). For a production build:

```bash
npm run build
npm run preview
```

> Note: the dev/preview server is local to your machine. The live hosted version is on GitHub Pages (see the repo's Pages URL).

## AI advisor setup

1. Get an API key at https://console.anthropic.com
2. Open **Settings** → paste your key (`sk-ant-...`) → Save
3. Go to **Advisor** and ask away

The app calls the Anthropic Messages API with `anthropic-dangerous-direct-browser-access`, so the key never leaves your browser except to reach Anthropic directly.

## Tech

React 18 · Vite 5 · zero runtime dependencies beyond React. Deployed via GitHub Actions → GitHub Pages.
