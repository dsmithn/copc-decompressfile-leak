const { chromium } = require('playwright')

const N = process.argv[2] || '3000'

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
  await page.goto(`http://127.0.0.1:8791/leakrepro/index.html?n=${N}`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__done != null, null, { timeout: 300000 })
  const out = await page.evaluate(() => document.getElementById('out').textContent)
  const done = await page.evaluate(() => window.__done)
  console.log(out)
  console.log('\n--- raw ---')
  console.log(JSON.stringify(done, null, 2))
  await browser.close()
})().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
