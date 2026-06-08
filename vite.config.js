import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base is set for GitHub Pages project-site hosting: https://<user>.github.io/budget-app/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/budget-app/',
})
