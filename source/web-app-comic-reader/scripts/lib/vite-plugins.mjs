import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Plugins shared by vite.config.ts and the live demo's build (on the
// gh-pages branch, which builds the reader from this source).

// The decoders in public/vendor/ keep fixed file names (a worker has to find
// its .wasm next to itself), unlike the app's own chunks, whose names carry a
// content hash. A browser that cached them from an earlier install would go
// on using the old decoder with the new app, and the two do not speak the
// same protocol. So the app asks for them with `?v=<hash of public/vendor>`,
// which changes exactly when any of those files does. src/helpers/assetUrl.ts
// appends it; the workers pass it on to what they load themselves.
//
// The hash is taken once, when Vite starts. A watch build (`build:w`) has to
// be restarted after the decoders change, or it keeps asking for the old one.
const vendorDir = fileURLToPath(new URL('../../public/vendor', import.meta.url))
function vendorVersion() {
  const hash = createHash('sha256')
  const files = existsSync(vendorDir)
    ? readdirSync(vendorDir, { recursive: true })
        .filter((path) => statSync(join(vendorDir, path)).isFile())
        // The same names, and so the same order and hash, on every platform.
        .map((path) => path.replaceAll('\\', '/'))
        .sort()
    : []
  for (const path of files) {
    hash.update(path).update('\0').update(readFileSync(join(vendorDir, path))).update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}
export const defineVendorVersion = {
  name: 'define-vendor-version',
  config: () => ({ define: { __VENDOR_VERSION__: JSON.stringify(vendorVersion()) } })
}

// libarchive.js refers to the worker prebuilt inside its npm package as a
// fallback URL. Vite treats that reference as an asset rather than an import,
// so it cannot be suppressed with `rollupOptions.external`, and emits the file
// as `assets/worker-bundle-*.js`. That is not the worker the app uses (ours is
// bundled around our own libarchive build, see scripts/prepare-decoders.mjs):
// it belongs to the package's WebAssembly module, which is not shipped, and it
// is unreachable, because the adapter always supplies its own `getWorker`.
//
// It is dropped here, as the bundle is written, so that no kind of build
// (`build`, `build:w`) leaves it in dist/. `scripts/prune-dist.mjs` checks
// after a release build that it is really gone.
export const dropPrebuiltLibarchiveWorker = {
  name: 'drop-prebuilt-libarchive-worker',
  generateBundle(_options, bundle) {
    for (const fileName of Object.keys(bundle)) {
      if (/(^|\/)worker-bundle-[\w-]+\.js$/.test(fileName)) {
        delete bundle[fileName]
      }
    }
  }
}
