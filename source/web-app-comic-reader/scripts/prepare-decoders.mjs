/**
 * The first step of every build: makes sure the three WebAssembly decoders
 * are there and current, and bundles libarchive.js's worker around ours.
 *
 * No decoder is committed. `npm run build:native` compiles them, in a
 * container: unarr into public/vendor/unarr/, 7-Zip's 7z reader into
 * public/vendor/sevenzip/, libarchive into native/libarchive/out/. This
 * script does the part that needs Node.
 *
 * What "current" means, for each decoder
 * --------------------------------------
 * 1. It was built from the inputs now in the tree: the stamp its build left
 *    in native/<name>/BUILD-STAMP matches the files named in
 *    native/<name>/build-inputs.txt (see build_stamp in scripts/lib/emsdk.sh).
 * 2. It is the build this version of the app expects: the six output files
 *    have the hashes recorded in native/outputs.sha256. The builds are
 *    reproducible with the pinned compiler, so a difference means the files
 *    are not that build. After a deliberate change to a decoder, record the
 *    new hashes there. With another compiler (EMSDK_IMAGE) the hashes will
 *    differ; DECODERS_UNVERIFIED=1 turns the refusal into a warning.
 *
 * Why the worker is bundled here
 * ------------------------------
 * libarchive.js ships a worker bundle with a prebuilt WebAssembly module
 * inside its npm package. That module links OpenSSL 1.0.2, whose licence does
 * not combine with this app's, so it is not used. The worker's own sources
 * are in the same package, though, and they are small and MIT licensed: this
 * bundles them, unchanged, around the loader built from native/libarchive/.
 * The loader and the .wasm are generated as a pair and only work together,
 * which is why the worker cannot be taken prebuilt.
 *
 * Outputs
 *   public/vendor/libarchive/worker-bundle.js   what the app's worker loads
 *   public/vendor/libarchive/libarchive.wasm    resolved relative to it
 *   native/libarchive/out/worker-bundle-node.mjs  the same worker for Node,
 *       used by the verification scripts so they test this build
 *
 * Run: node scripts/prepare-decoders.mjs   (part of `npm run build`)
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const built = resolve(root, 'native', 'libarchive', 'out')
const loader = resolve(built, 'libarchive.js')
const wasm = resolve(built, 'libarchive.wasm')
const workerSources = resolve(root, 'node_modules', 'libarchive.js', 'src', 'webworker')
const vendor = resolve(root, 'public', 'vendor')

function stop(problem) {
  console.error(
    `prepare-decoders: ${problem}\n` +
      'Build the decoders first:  npm run build:native   (needs podman or docker)'
  )
  process.exit(1)
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** `<hash>  <path>` lines, as sha256sum writes and checks them. */
function readSums(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ hash: line.slice(0, 64), path: line.slice(66) }))
}

/** The same value build_stamp in scripts/lib/emsdk.sh prints. */
function expectedStamp(nativeDir) {
  const inputs = readFileSync(resolve(nativeDir, 'build-inputs.txt'), 'utf8').split('\n').filter(Boolean)
  return sha256(inputs.map((path) => `${sha256(readFileSync(resolve(root, path)))}  ${path}\n`).join(''))
}

// 1. Built from the inputs now in the tree. A build made from other sources,
//    another recipe or another pinned compiler would otherwise ship without
//    a word.
const outputs = readSums(resolve(root, 'native', 'outputs.sha256'))
for (const { path } of outputs) {
  if (!existsSync(resolve(root, path))) {
    stop(`${path} is missing.`)
  }
}
for (const name of ['unarr', 'libarchive', 'sevenzip']) {
  const nativeDir = resolve(root, 'native', name)
  const stampPath = resolve(nativeDir, 'BUILD-STAMP')
  const stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : ''
  if (stamp !== expectedStamp(nativeDir)) {
    stop(`the ${name} module was built from different inputs than the ones now in native/${name}/.`)
  }
}
// unarr's stamp covers upstream.sha256, not the vendored files themselves:
// each must be as listed, and there must be no others (a stray header could
// stand in for a system one).
const unarr = resolve(root, 'native', 'unarr')
const listed = readSums(resolve(unarr, 'upstream.sha256'))
for (const { hash, path } of listed) {
  if (!existsSync(resolve(unarr, path)) || sha256(readFileSync(resolve(unarr, path))) !== hash) {
    stop(`native/unarr/${path} does not match native/unarr/upstream.sha256.`)
  }
}
const listedPaths = new Set(listed.map(({ path }) => path)).size
const present = readdirSync(resolve(unarr, 'upstream'), { recursive: true, withFileTypes: true }).filter(
  (item) => !item.isDirectory()
).length
if (present !== listedPaths) {
  stop(`native/unarr/upstream holds ${present} files; native/unarr/upstream.sha256 lists ${listedPaths}.`)
}

// 2. The build this version expects.
const unexpected = outputs.filter(({ hash, path }) => sha256(readFileSync(resolve(root, path))) !== hash)
if (unexpected.length) {
  const problem =
    `not the expected build (native/outputs.sha256): ${unexpected.map(({ path }) => path).join(', ')}.`
  if (process.env.DECODERS_UNVERIFIED !== '1') {
    console.error(
      `prepare-decoders: ${problem}\n` +
        'Rebuild with `npm run build:native`. If a decoder was changed on purpose, record the new\n' +
        'hashes in native/outputs.sha256. If it was built with another compiler, set\n' +
        'DECODERS_UNVERIFIED=1 to use it as it is.'
    )
    process.exit(1)
  }
  console.warn(`prepare-decoders: WARNING, ${problem} Used anyway (DECODERS_UNVERIFIED).`)
}

/**
 * What the worker imports in place of the package's loader: ours, behind a
 * wrapper that fetches libarchive.wasm with the query string the worker
 * itself was loaded with (why: see scripts/lib/vite-plugins.mjs). Outside a browser worker
 * (the Node bundle) the loader finds the file as it always did.
 */
const VERSIONED_LOADER = '\0versioned-libarchive-loader'

/**
 * Swaps the package's prebuilt loader for ours; everything else is theirs.
 *
 * The importer is matched by its last two path segments, not by where
 * node_modules is: the bundler reports real paths, so a symlinked
 * node_modules (pnpm, a linked workspace) would not match a prefix, and the
 * package's loader would be bundled around our .wasm without a word.
 */
let swapped = 0
const useOurLoader = {
  name: 'use-our-libarchive-loader',
  resolveId(source, importer) {
    if (source === './wasm-gen/libarchive.js' && /[\\/]webworker[\\/]wasm-module\.js$/.test(importer ?? '')) {
      swapped++
      return VERSIONED_LOADER
    }
    return null
  },
  load(id) {
    if (id !== VERSIONED_LOADER) {
      return null
    }
    return `import libarchive from ${JSON.stringify(loader)}
export default (module) => {
  const version = typeof WorkerGlobalScope !== 'undefined' && globalThis.location?.search
  if (version) {
    module.locateFile = (file) => new URL(file, import.meta.url).href + version
  }
  return libarchive(module)
}
`
  }
}

/** eval(...), new Function, or a bare Function(...) call. */
const DYNAMIC_CODE = /\beval\s*\(|\bnew\s+Function\b|(?<![.\w])Function\s*\(/

async function bundle(entry, file, platform) {
  const build = await rolldown({
    input: resolve(workerSources, entry),
    platform,
    // The loader's Node branch imports node: modules. In the browser bundle
    // that branch never runs, so they are left as they are.
    external: [/^node:/],
    plugins: [useOurLoader],
    // The package's sources trip a few lint-style warnings; they are not ours.
    logLevel: 'warn'
  })
  await build.write({ file, format: 'es', minify: true })
  await build.close()
  // A bundle that fails either check is removed, so that a later build
  // cannot pick it up from where it was written.
  const reject = (problem) => {
    rmSync(file, { force: true })
    throw new Error(`${file}: ${problem}`)
  }
  if (swapped === 0) {
    reject('bundled without the loader from native/libarchive/out')
  }
  swapped = 0
  // The loader is checked when it is built; this covers the worker around
  // it, which is what the page's Content Security Policy actually meets.
  if (platform === 'browser' && DYNAMIC_CODE.test(readFileSync(file, 'utf8'))) {
    reject('contains dynamic code evaluation')
  }
}

mkdirSync(resolve(vendor, 'libarchive'), { recursive: true })
await bundle('browser-worker.js', resolve(vendor, 'libarchive', 'worker-bundle.js'), 'browser')
copyFileSync(wasm, resolve(vendor, 'libarchive', 'libarchive.wasm'))
await bundle('node-worker.js', resolve(built, 'worker-bundle-node.mjs'), 'node')

console.log('prepare-decoders: decoders present and current; libarchive worker bundled')
