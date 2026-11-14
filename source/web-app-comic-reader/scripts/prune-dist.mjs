/**
 * Finishes a release build: checks that dist/ holds the decoders the app
 * uses and not the one it must not, copies the licence and changelog in,
 * and stamps the manifest with a build id.
 *
 * The one it must not hold is `assets/worker-bundle-*.js`: the worker
 * prebuilt inside the libarchive.js npm package, made for that package's
 * own WebAssembly module (which links OpenSSL and is not shipped). The
 * library refers to it as a fallback URL, so Vite would emit it; the plugin
 * in scripts/lib/vite-plugins.mjs drops it from every build. This script fails if it is
 * there all the same, under any name containing `worker-bundle`, so that a
 * change in how Vite names or places it is noticed.
 */

import { copyFileSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

if (!existsSync(dist)) {
  console.error('prune-dist: no dist/ directory; run the build first')
  process.exit(1)
}

// The copy the app actually uses must be present and complete.
const required = [
  'vendor/libarchive/worker-bundle.js',
  'vendor/libarchive/libarchive.wasm',
  'vendor/unarr/unarr-worker.mjs',
  'vendor/unarr/unarr-extract.mjs',
  'vendor/unarr/unarr-rar.mjs',
  'vendor/unarr/unarr-rar.wasm',
  'vendor/sevenzip/sevenzip-worker.mjs',
  'vendor/sevenzip/sevenzip-extract.mjs',
  'vendor/sevenzip/decrypt-common.mjs',
  'vendor/sevenzip/decrypt-rar.mjs',
  'vendor/sevenzip/decrypt-zip.mjs',
  'vendor/sevenzip/sevenzip.mjs',
  'vendor/sevenzip/sevenzip.wasm'
]
const missing = required.filter((file) => !existsSync(join(dist, file)))
if (missing.length) {
  console.error(`prune-dist: dist/ is incomplete, missing ${missing.join(', ')}`)
  process.exit(1)
}

// Each worker has to pass the `?v=` it was loaded with on to whatever it
// loads (see scripts/lib/vite-plugins.mjs). Nothing else would notice a load that does not:
// it works, and brings back decoders cached from another build.
const read = (file) => readFileSync(join(dist, file), 'utf8')
const staticImports = required
  .filter((file) => file.endsWith('.mjs'))
  .filter((file) =>
    // After a line start, `;`, `}` or a comment: the generated loaders are minified.
    /(^|[;}]|\*\/)\s*(import(?![\w$])\s*[\w$*{'"]|export\s*(\*|\{[^}]*\})[^;'"\n]*\bfrom\s*['"])/m.test(
      read(file)
    )
  )
if (staticImports.length) {
  console.error(
    `prune-dist: ${staticImports.join(', ')} has a static import, which is loaded without ?v=`
  )
  process.exit(1)
}
if (!/location\?\.search/.test(read('vendor/libarchive/worker-bundle.js'))) {
  console.error('prune-dist: the libarchive worker does not pass ?v= on to its .wasm')
  process.exit(1)
}

// Looser than the plugin's own pattern on purpose: anywhere in dist/, under
// any name that still says what it is.
const ours = join('vendor', 'libarchive', 'worker-bundle.js')
const prebuilt = readdirSync(dist, { recursive: true }).filter(
  (path) => path !== ours && path.includes('worker-bundle')
)
if (prebuilt.length) {
  console.error(
    `prune-dist: dist/ contains libarchive.js's prebuilt worker (${prebuilt.join(', ')}); ` +
      'the plugin in scripts/lib/vite-plugins.mjs should have dropped it'
  )
  process.exit(1)
}

// The licence and changelog live once, at the package root, and are copied
// into the build so the installed folder carries them too.
for (const name of ['LICENSE', 'CHANGELOG.md']) {
  copyFileSync(resolve(dist, '..', name), join(dist, name))
}

// Stamp the manifest. Every build so far has reported the same version, which
// made "is the deployed copy current?" answerable only by comparing hashed
// chunk filenames. The build id makes it readable at a glance:
//   docker compose exec opencloud cat .../comic-reader/manifest.json
const manifestPath = join(dist, 'manifest.json')
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entryHash = (manifest.entrypoint || '').match(/-([\w-]+)\.mjs$/)?.[1] ?? 'unknown'
  manifest.build = `${new Date().toISOString().slice(0, 10)}+${entryHash}`
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`prune-dist: stamped build ${manifest.build}`)
}
