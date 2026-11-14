/**
 * Verifies the assumptions `libarchiveAdapter.ts` makes about libarchive.js.
 *
 * The adapter cannot be unit tested under happy-dom: it needs a real worker
 * and the WASM build. The Node distribution of libarchive.js uses
 * `worker_threads` instead of `Worker`, which lets the same library be driven
 * here against a real 7z archive. The API surface is identical, so what this
 * proves is that the shapes the adapter depends on are the shapes the library
 * actually returns.
 *
 * Run with: node scripts/verify-libarchive.mjs
 */

import { crc32 } from 'node:zlib'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../tests/fixtures')

const { Archive } = await import('./lib/libarchive-node.mjs')

let failures = 0
let verified = 0

function check(label, condition, detail = '') {
  const status = condition ? 'ok  ' : 'FAIL'
  if (!condition) {
    failures++
  }
  console.log(`  ${status} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function verify(fixtureName) {
  const path = resolve(fixtures, fixtureName)
  if (!existsSync(path)) {
    console.log(`\n${fixtureName}: not present, skipping`)
    return
  }

  console.log(`\n${fixtureName}`)
  verified++
  const bytes = readFileSync(path)
  const file = new File([bytes], fixtureName, { type: 'application/octet-stream' })

  const reader = await Archive.open(file)
  await reader.open()

  // 1. Encryption probe. The adapter calls this before listing and treats a
  //    thrown error or null as "cannot tell", not as encrypted.
  let encrypted = null
  try {
    encrypted = await reader.hasEncryptedData()
  } catch (error) {
    encrypted = `threw: ${error.message}`
  }
  check('hasEncryptedData() is false or indeterminate', encrypted === false || encrypted === null, String(encrypted))

  // 2. The worker's own listing, which the adapter uses in place of the
  //    library's getFilesArray(): a flat array, one item per entry, with the
  //    entry's full path, its size and its type.
  const worker = reader.client
  const listing = await worker.listFiles()
  check('client.listFiles() returns a flat array', Array.isArray(listing) && listing.length > 0, `${listing.length} entries`)
  const files = listing.filter((entry) => entry.type === 'FILE')
  const sample = files.find((entry) => entry.path?.endsWith('.png'))
  check('a file entry has .path with its directories', sample?.path === 'Chapter 1/page1.png', sample?.path)
  check('a file entry has a numeric .size', typeof sample?.size === 'number', String(sample?.size))
  check('a directory is not listed as a file', !files.some((entry) => entry.path.replace(/\/$/, '') === 'Chapter 1'))
  check('junk members are present and must be filtered by us', files.some((entry) => entry.path.startsWith('__MACOSX/')))

  // 3. Single-file extraction by path, which is what readEntry uses.
  const extracted = await reader.extractSingleFile(sample.path)
  const buffer = new Uint8Array(await extracted.arrayBuffer())
  check('extractSingleFile(path) yields a File', extracted instanceof File && buffer.byteLength === sample.size, `${buffer.byteLength} bytes`)
  check(
    'extracted bytes are a valid PNG',
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  )

  // 4. A second extraction still works, i.e. the reader is not spent by one
  //    read. The adapter's lazy mode depends on this.
  const second = files.find((entry) => entry.path.endsWith('page2.PNG'))
  if (second) {
    const again = await reader.extractSingleFile(second.path)
    check('a second extraction still succeeds', again.size > 0, `${again.size} bytes`)
  }

  // 5. Bulk extraction through the worker: the same entries in the same
  //    order, each file now carrying its bytes. The adapter matches them to
  //    its listing by position.
  const unpacked = (await worker.extractFiles()).filter((entry) => entry.type === 'FILE')
  check(
    'client.extractFiles() returns the listing\'s files, in its order',
    unpacked.length === files.length && unpacked.every((entry, index) => entry.path === files[index].path)
  )
  check(
    'each carries its bytes as .fileData',
    unpacked.every((entry) => entry.fileData?.byteLength === entry.size)
  )

  // 6. The adapter closes the reader after a bulk pass. A read issued after
  //    that is refused at once, not left hanging.
  await reader.close()
  const afterClose = await Promise.race([
    reader.extractSingleFile(sample.path).then(() => 'resolved', (error) => `rejected: ${error.message}`),
    new Promise((resolve) => setTimeout(() => resolve('never settled'), 1500))
  ])
  check('a read after close() is rejected', afterClose.startsWith('rejected'), afterClose)

  await reader.close().catch(() => {})
}

/**
 * A zip of stored entries, built by hand so names can be anything. `mode` is
 * a unix file mode, for entries that are not regular files.
 */
function storedZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, data, mode } of entries) {
    const nameBytes = Buffer.from(name)
    const body = Buffer.from(data)
    const crc = crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(mode ? (3 << 8) | 20 : 20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(body.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(mode ? (mode << 16) >>> 0 : 0, 38)
    header.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    central.push(header, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/**
 * Why the adapter does not use the library's getFilesArray(): it folds the
 * listing into an object keyed by path segment. This archive has two entries
 * of one name and one under `__proto__`; the worker's flat listing must show
 * all three as they are, and reading it must leave Object.prototype alone.
 */
async function verifyHostileListing() {
  console.log('\nentries sharing a name, and a __proto__ directory')
  verified++
  const archive = storedZip([
    { name: '001.png', data: 'first' },
    { name: '001.png', data: 'next' },
    { name: '__proto__/polluted.png', data: 'x' }
  ])
  const reader = await Archive.open(new File([archive], 'hostile.cbz'))
  await reader.open()
  const files = (await reader.client.listFiles()).filter((entry) => entry.type === 'FILE')
  check(
    'client.listFiles() keeps both entries of one name, with their own sizes',
    files.filter((entry) => entry.path === '001.png').map((entry) => entry.size).join() === '5,4',
    files.map((entry) => `${entry.path}:${entry.size}`).join(', ')
  )
  check('the first of them is the one a read returns', (await reader.extractSingleFile('001.png')).size === 5)
  const unpacked = (await reader.client.extractFiles()).filter((entry) => entry.type === 'FILE')
  check('client.extractFiles() keeps both too', unpacked.filter((entry) => entry.path === '001.png').length === 2)
  check(
    'and returns them in the listing\'s order',
    unpacked.map((entry) => entry.fileData.byteLength).join() === '5,4,1'
  )
  check('Object.prototype is untouched', !('polluted.png' in {}))
  await reader.close()

  // An entry that is not a regular file can carry a file's path and data.
  // The adapter relies on seeing it in the listing, typed as what it is,
  // ahead of the file it shadows.
  console.log('\na socket that shares a page\'s path')
  const shadowed = storedZip([
    { name: 'a.png', data: 'socket data', mode: 0o140644 },
    { name: 'a.png', data: 'image' }
  ])
  const second = await Archive.open(new File([shadowed], 'shadowed.cbz'))
  await second.open()
  const all = await second.client.listFiles()
  check(
    'client.listFiles() lists both, the socket first and not as a file',
    all.length === 2 && all[0].type !== 'FILE' && all[1].type === 'FILE' && all[0].path === all[1].path,
    all.map((entry) => `${entry.path}:${entry.type}:${entry.size}`).join(', ')
  )
  check(
    'a read by that path returns the socket\'s data, which is why the adapter refuses it',
    (await second.extractSingleFile('a.png')).size === all[0].size
  )
  await second.close()
}

/**
 * A damaged entry must fail to read, and not come back as if it were sound.
 * libarchive compares an entry's checksum on the read that reaches its end,
 * which the C wrapper has to make: see native/libarchive/README.md.
 */
async function verifyDamageIsReported(fixtureName, pathOf) {
  const path = resolve(fixtures, fixtureName)
  if (!existsSync(path)) {
    return
  }
  verified++
  console.log(`\na damaged entry of ${fixtureName}`)
  const bytes = new Uint8Array(readFileSync(path))
  // The first stored PNG: one bit, well inside its data.
  const at = bytes.findIndex(
    (byte, index) => byte === 0x89 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x4e && bytes[index + 3] === 0x47
  )
  bytes[at + 30] ^= 1
  const reader = await Archive.open(new File([bytes], fixtureName))
  await reader.open()
  const files = (await reader.client.listFiles()).filter((entry) => entry.type === 'FILE')
  const damaged = pathOf(files)
  const outcome = await reader.extractSingleFile(damaged).then(
    (file) => `read ${file.size} bytes`,
    (error) => `rejected: ${error?.message ?? error}`
  )
  check('reading it is rejected', outcome.startsWith('rejected'), outcome)
  const other = files.find((entry) => entry.path !== damaged && /\.png$/i.test(entry.path))
  check('the entries around it still read', (await reader.extractSingleFile(other.path)).size === other.size)
  await reader.close()
}

/**
 * The one-pass unpack must get through an archive that has directory
 * entries: reading "to the end" of one is an error in the RAR5 reader.
 */
async function verifyBulkWithDirectories(fixtureName) {
  const path = resolve(fixtures, fixtureName)
  if (!existsSync(path)) {
    return
  }
  verified++
  console.log(`\none pass over ${fixtureName}, which has a directory entry`)
  const reader = await Archive.open(new File([readFileSync(path)], fixtureName))
  await reader.open()
  const listing = await reader.client.listFiles()
  check('the listing has an entry that is not a file', listing.some((entry) => entry.type !== 'FILE'))
  const outcome = await reader.client.extractFiles().then(
    (unpacked) => `unpacked ${unpacked.length}`,
    (error) => `rejected: ${error?.message ?? error}`
  )
  check('client.extractFiles() unpacks it', outcome.startsWith('unpacked'), outcome)
  await reader.close()
}

console.log('Verifying libarchive.js assumptions made by libarchiveAdapter.ts')

for (const name of ['sample.cb7', 'sample.c7z', 'sample.cbr']) {
  await verify(name)
}

await verifyHostileListing()
await verifyBulkWithDirectories('rar/rar5-plain.cbr')
await verifyBulkWithDirectories('rar/rar5-solid.cbr')
// sample.cbr holds its files stored, in the order it lists them.
await verifyDamageIsReported('sample.cbr', (files) => files.find((entry) => /\.png$/i.test(entry.path)).path)

if (!verified) {
  // A run that looked at nothing must not read as a pass.
  console.log(`\nNo fixtures found in ${fixtures}`)
  process.exit(1)
}
console.log(failures ? `\n${failures} assumption(s) did not hold` : '\nAll assumptions hold')
// Terminated workers can leave the loop with nothing to do but not yet empty.
process.exit(failures ? 1 : 0)
