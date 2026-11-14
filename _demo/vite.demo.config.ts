/**
 * Builds the live demo (demo/) into demo-dist/: the reader on a mock file
 * list, as a static site, with the comics in demo/comics/.
 *
 *   npm run build:demo
 *
 * It is the app's own source, built as an ordinary single page instead of an
 * OpenCloud extension. What OpenCloud would supply is supplied here: Vue and
 * OpenCloud's design system are bundled, and `@opencloud-eu/web-pkg` points
 * at four stand-ins (demo/web-pkg.ts). The decoders and the licence notices
 * come from public/, as in the app.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineVendorVersion, dropPrebuiltLibarchiveWorker } from './scripts/lib/vite-plugins.mjs'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const comicsDir = here('./demo/comics')
const iconsDir = here('./node_modules/@opencloud-eu/design-system/dist/icons')

const comics = readdirSync(comicsDir)
  .filter((name) => /\.(cbz|cbr|cb7)$/i.test(name))
  .sort()
  .map((name) => ({ name, size: statSync(join(comicsDir, name)).size }))

/**
 * Copies the comics into the site, and the icons the reader and the demo
 * name. The design system has some 3,000 icons (12 MB); the ones used are
 * found by looking for their names, quoted, in the source.
 */
function demoFiles(): Plugin {
  return {
    name: 'demo-files',
    generateBundle() {
      for (const { name } of comics) {
        this.emitFile({ type: 'asset', fileName: `comics/${name}`, source: readFileSync(join(comicsDir, name)) })
      }
      const sources = [here('./src'), here('./demo')]
        .flatMap((dir) =>
          (readdirSync(dir, { recursive: true }) as string[])
            .filter((path) => /\.(vue|ts)$/.test(path))
            .map((path) => readFileSync(join(dir, path), 'utf8'))
        )
        .join('\n')
      const quoted = new Set(sources.match(/(?<=['"])[a-z0-9]+(?:-[a-z0-9]+)*(?=['"])/g) ?? [])
      for (const file of readdirSync(iconsDir)) {
        if (quoted.has(file.replace(/-(line|fill)\.svg$/, ''))) {
          this.emitFile({ type: 'asset', fileName: `icons/${file}`, source: readFileSync(join(iconsDir, file)) })
        }
      }
    }
  }
}

export default defineConfig({
  root: here('./demo'),
  base: './',
  publicDir: here('./public'),
  plugins: [vue(), tailwindcss(), dropPrebuiltLibarchiveWorker, defineVendorVersion, demoFiles()],
  define: { __DEMO_COMICS__: JSON.stringify(comics) },
  resolve: {
    alias: { '@opencloud-eu/web-pkg': here('./demo/web-pkg.ts') }
  },
  build: {
    outDir: here('./demo-dist'),
    emptyOutDir: true
  }
})
