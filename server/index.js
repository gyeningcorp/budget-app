import { createApp } from './app.js'
const port = Number(process.env.PORT || 3000)
const baseURL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${port}`)
const { app, close, checkDueConnections } = await createApp({ databasePath: `${process.env.DATA_DIR || './data'}/family.sqlite`, baseURL, secret: process.env.AUTH_SECRET, production: process.env.NODE_ENV === 'production' })
const billingTimer=setInterval(()=>checkDueConnections().catch(()=>{}),30*60*1000)
billingTimer.unref()
const server = app.listen(port, '0.0.0.0', () => console.log(`Family Hub listening on ${port}`))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { clearInterval(billingTimer); close(); process.exit(0) }))
