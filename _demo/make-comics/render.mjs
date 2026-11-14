// Renders pages/<comic>/NN.html to jpg/<comic>/NN.jpg with headless Chromium,
// through playwright-core. Run by build-comics.sh, in a container.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const here = process.argv[2]
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] })
for (const comic of readdirSync(join(here, 'pages')).sort()) {
  mkdirSync(join(here, 'jpg', comic), { recursive: true })
  for (const file of readdirSync(join(here, 'pages', comic)).sort()) {
    const html = readFileSync(join(here, 'pages', comic, file), 'utf8')
    const width = Number(/<svg[^>]* width="(\d+)"/.exec(html)[1])
    const page = await browser.newPage({ viewport: { width, height: 1500 } })
    await page.setContent(html)
    await page.screenshot({ path: join(here, 'jpg', comic, file.replace('.html', '.jpg')), type: 'jpeg', quality: 84 })
    await page.close()
  }
  console.log('rendered', comic)
}
await browser.close()
