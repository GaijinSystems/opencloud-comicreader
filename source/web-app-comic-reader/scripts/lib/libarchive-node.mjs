/**
 * libarchive.js for the verification scripts, wired to OUR build of the
 * worker (native/libarchive/out/worker-bundle-node.mjs) instead of the one
 * prebuilt inside the npm package. What these scripts exercise is therefore
 * the same WebAssembly module the app ships.
 *
 * `npm run verify:*` runs scripts/prepare-decoders.mjs first, which is what
 * produces that worker and checks it is current.
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { Archive } from 'libarchive.js/dist/libarchive-node.mjs'

const worker = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'native',
  'libarchive',
  'out',
  'worker-bundle-node.mjs'
)

if (!existsSync(worker)) {
  console.error(
    'The libarchive worker has not been bundled.\n' +
      'Run:  npm run build:native && node scripts/prepare-decoders.mjs'
  )
  process.exit(1)
}

// Only the worker is replaced. The package's Node entry point has already
// configured how to talk to a worker thread, with its own bundled copy of
// Comlink; a second copy here would not recognise the first one's proxies.
Archive.init({ ...Archive._options, getWorker: () => new Worker(worker) })

/**
 * The file members of an open archive, each with its full path and a way to
 * read it. Taken from the worker's flat listing, as the app's adapter does;
 * see WorkerEntry in src/archive/libarchiveAdapter.ts for why.
 */
export async function fileEntries(reader) {
  return (await reader.client.listFiles())
    .filter((entry) => entry.type === 'FILE')
    .map((entry) => ({
      name: entry.path,
      file: { size: entry.size, extract: () => reader.extractSingleFile(entry.path) }
    }))
}

export { Archive }
