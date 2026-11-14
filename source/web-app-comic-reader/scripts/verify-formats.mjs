/**
 * Decodes every archive in testcomics/formats page by page, through the back
 * end the reader uses for it: zip.js for zips (with the libarchive fallback
 * for methods zip.js lacks), the libarchive WASM build for everything else,
 * and unarr for the RAR archives libarchive cannot read in full (solid RAR4).
 *
 * Every page is decoded, not just the first: in a solid archive a later entry
 * is the one that fails, so checking the cover proves very little.
 *
 * Archives with "encrypted" in their name are password protected (password
 * "comic", or FORMATS_PASSWORD). For each the check is first that the reader
 * would notice, by whichever route it learns that. Each must then decode in
 * full with the password, through what the reader uses for it, and be
 * refused with a wrong one:
 *   zip   zip.js; libarchive with the password for the old encryption in a
 *         method zip.js lacks; for AES in such a method, decrypted first
 *         and then libarchive
 *   7z    7-Zip's 7z reader
 *   RAR   decrypted first, then unarr (RAR4) or libarchive (RAR5)
 *
 * Run: node scripts/verify-formats.mjs [directory]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = process.argv[2] ?? resolve(here, '..', 'testcomics', 'formats')

if (!existsSync(dir)) {
  console.error(`No such directory: ${dir}\nRun scripts/make-format-matrix.py first.`)
  process.exit(1)
}

/** Every archive in the matrix holds the same six labelled pages. */
const EXPECTED_PAGES = 6
/** What scripts/make-format-matrix.py protects the encrypted variants with. */
const PASSWORD = process.env.FORMATS_PASSWORD || 'comic'

const ARCHIVE_EXT = new Set(['.cbz', '.cbr', '.cb7', '.c7z', '.rar', '.7z', '.zip'])
// Simplified copies of the rules in src/archive/pageSort.ts, which is the
// source of truth for what the reader treats as a page.
const PAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp', 'avif']
const IMAGE = new RegExp(`\\.(${PAGE_EXTENSIONS.join('|')})$`, 'i')
const isJunk = (name) =>
  name.split('/').some((part) => part === '__MACOSX') || name.split('/').pop().startsWith('._')
const isPage = (name) => IMAGE.test(name) && !isJunk(name)
/** The fixtures hold PNG and JPEG pages only. */
const looksLikeImage = (data) =>
  (data[0] === 0x89 && data[1] === 0x50) || (data[0] === 0xff && data[1] === 0xd8)

const { Archive, fileEntries } = await import('./lib/libarchive-node.mjs')
const zip = await import('@zip.js/zip.js')
zip.configure({ useWebWorkers: false })

// The very pattern the app's libarchive adapter uses to recognise a read
// refused because the entry is encrypted, so this checks that pattern, not a
// copy of it, against what the real decoder says.
const encryptionMessages = JSON.parse(
  readFileSync(resolve(here, '..', 'src', 'archive', 'encryptionMessages.json'), 'utf8')
)
const ENCRYPTION_MESSAGE = new RegExp(encryptionMessages.pattern, encryptionMessages.flags)

/**
 * Zip archives go through zip.js first, not libarchive, because that is the
 * back end the reader actually uses for them. Checking a .cbz with libarchive
 * alone would report a pass for a file whose zip.js path is broken.
 */
async function decodeZip(buffer, name, password) {
  const reader = new zip.ZipReader(new zip.BlobReader(new Blob([buffer])), { password })
  const entries = await reader.getEntries()
  let pages = 0
  let bytes = 0
  let malformed = 0
  for (const entry of entries) {
    if (entry.directory || !isPage(entry.filename)) {
      continue
    }
    pages++
    try {
      const data = await entry.getData(new zip.Uint8ArrayWriter())
      if (!looksLikeImage(data)) {
        malformed++
      }
      bytes += data.byteLength
    } catch {
      malformed++
    }
  }
  await reader.close()

  // Mirrors the reader: a zip whose pages zip.js cannot decode is handed to
  // libarchive. Checking only zip.js would report a failure for a file that
  // opens perfectly well in the app. With a password the reader does that
  // only for the old zip encryption, which is all libarchive can undo; an
  // AES zip stays with zip.js, and comes back from here unreadable.
  const handOver =
    password === undefined || entries.every((entry) => !entry.encrypted || entry.zipCrypto === true)
  if (malformed > 0 && pages > 0 && handOver) {
    const viaLibarchive = await decodeWithLibarchive(buffer, name, password)
    if (viaLibarchive.pages === pages && viaLibarchive.malformed === 0) {
      return { ...viaLibarchive, note: 'via libarchive fallback' }
    }
  }
  return { pages, bytes, malformed }
}

async function decodeWithLibarchive(buffer, name, password, uncheckedZip = false) {
  const reader = await Archive.open(new File([buffer], name))
  try {
    if (password !== undefined) {
      await reader.usePassword(password)
    }
    if (uncheckedZip) {
      // As src/archive/libarchiveAdapter.ts does for a zip the app decrypted.
      await reader.setLocale('en_US.UTF-8@zip-unchecked')
    }
    await reader.open()
    let pages = 0
    let bytes = 0
    let malformed = 0
    for (const { name: entryName, file } of await fileEntries(reader)) {
      if (!isPage(entryName)) {
        continue
      }
      pages++
      const data = new Uint8Array(await (await file.extract()).arrayBuffer())
      if (!looksLikeImage(data)) {
        malformed++
      }
      bytes += data.byteLength
    }
    return { pages, bytes, malformed }
  } finally {
    await reader.close().catch(() => {})
  }
}

const vendor = (...path) => resolve(here, '..', 'public', 'vendor', ...path)
const importVendor = (...path) => import(pathToFileURL(vendor(...path)).href)

/**
 * One of the reader's two one-pass decoders over an archive: unarr (RAR) or
 * 7-Zip's 7z reader (password-protected 7z). Runs the same extraction module
 * its worker runs, with limits shaped like the ones src/archive/unarrAdapter.ts
 * builds from the default configuration (64 MB per page, 5000 pages x 4
 * entries, 4x expansion). Returns the page counts and, from 7-Zip, the
 * module's own verdict on the password.
 */
async function decodeInOnePass(
  { loader, extractor, extract, archiveArguments },
  buffer,
  hooks = {},
  moreLimits = {}
) {
  const { default: createModule } = await importVendor(...loader)
  const loop = await importVendor(...extractor)
  const Module = await createModule({ printErr: () => {} })
  const bytes = new Uint8Array(buffer)
  const result = loop[extract](
    Module,
    ...archiveArguments(loop, Module, bytes),
    {
      maxEntryBytes: 64 * 1024 * 1024,
      maxEntries: 5000 * 4,
      maxTotalBytes: bytes.byteLength * 4,
      maxRetainedBytes: 256 * 1024 * 1024 * 4,
      solid: true,
      keepExtensions: PAGE_EXTENSIONS,
      keepNames: ['comicinfo.xml'],
      ...moreLimits
    },
    hooks
  )
  const pageEntries = result.entries.filter((entry) => isPage(entry.name))
  return {
    password: result.password,
    pages: pageEntries.length,
    bytes: pageEntries.reduce((total, entry) => total + (entry.data?.byteLength ?? 0), 0),
    malformed: pageEntries.filter((entry) => !entry.data || !looksLikeImage(entry.data)).length
  }
}

const decodeWithUnarr = (buffer, decrypted = false) =>
  decodeInOnePass(
    {
      loader: ['unarr', 'unarr-rar.mjs'],
      extractor: ['unarr', 'unarr-extract.mjs'],
      extract: 'extractRar',
      // unarr is given the archive in its own memory.
      archiveArguments: (loop, Module, bytes) => [loop.copyToHeap(Module, bytes), bytes.byteLength]
    },
    buffer,
    {},
    { decrypted }
  )

const decodeWithSevenZip = (buffer, password) =>
  decodeInOnePass(
    {
      loader: ['sevenzip', 'sevenzip.mjs'],
      extractor: ['sevenzip', 'sevenzip-extract.mjs'],
      extract: 'extractSevenZip',
      // 7-Zip reads it from a source as it goes.
      archiveArguments: (loop, _Module, bytes) => [loop.sourceFromBytes(bytes)]
    },
    buffer,
    { password }
  )

/** Copy of SUPPORTED_COMPRESSION_METHODS in src/archive/zipAdapter.ts: what zip.js decodes. */
const ZIP_JS_METHODS = [0, 8, 9]

/**
 * Whether this password is turned away, the way the reader finds that out:
 * zip.js is asked about an encrypted entry it can decode; where there is
 * none, libarchive finds out on the first page it is asked to read.
 */
async function zipRefuses(buffer, name, password) {
  const reader = new zip.ZipReader(new zip.BlobReader(new Blob([buffer])))
  let checkable
  try {
    checkable = (await reader.getEntries()).find(
      (entry) =>
        entry.encrypted && !entry.directory && ZIP_JS_METHODS.includes(entry.compressionMethod)
    )
    if (checkable) {
      await checkable.getData(new zip.Uint8ArrayWriter(), { password, checkPasswordOnly: true })
      return false
    }
  } catch (error) {
    return error.message === zip.ERR_INVALID_PASSWORD
  } finally {
    await reader.close()
  }
  try {
    await decodeWithLibarchive(buffer, name, password)
    return false
  } catch (error) {
    return ENCRYPTION_MESSAGE.test(error.message)
  }
}

/**
 * Decrypts a RAR, or the AES entries of a zip, with the module and the
 * routine the reader's worker uses. Returns the routine's status, whether it
 * confirmed the password, and the decrypted archive's bytes.
 */
async function decrypt(buffer, format, password) {
  const { default: createModule } = await importVendor('sevenzip', 'sevenzip.mjs')
  const { sourceFromBytes } = await importVendor('sevenzip', 'sevenzip-extract.mjs')
  const common = await importVendor('sevenzip', 'decrypt-common.mjs')
  const { decryptRar } = await importVendor('sevenzip', 'decrypt-rar.mjs')
  const { decryptZip } = await importVendor('sevenzip', 'decrypt-zip.mjs')
  const Module = await createModule({ printErr: () => {} })
  const { status, proven, unchecked, archive } = (format === 'zip' ? decryptZip : decryptRar)(
    common,
    Module,
    sourceFromBytes(new Uint8Array(buffer)),
    password
  )
  return {
    status,
    proven,
    unchecked,
    bytes: archive ? Buffer.from(await archive.arrayBuffer()) : null
  }
}

/** Whether every page of this zip is AES-encrypted in a method only libarchive decodes. */
async function isAesInUndecodableMethod(buffer) {
  const reader = new zip.ZipReader(new zip.BlobReader(new Blob([buffer])))
  try {
    const pageEntries = (await reader.getEntries()).filter(
      (entry) => !entry.directory && isPage(entry.filename)
    )
    return (
      pageEntries.length > 0 &&
      pageEntries.every(
        (entry) =>
          entry.encrypted && !entry.zipCrypto && !ZIP_JS_METHODS.includes(entry.compressionMethod)
      )
    )
  } finally {
    await reader.close()
  }
}

/**
 * A password-protected RAR, opened the way the reader opens one: decrypted
 * first, then read by the decoder it would use for the result. RAR before
 * version 5 keeps nothing to check a password by, so there a wrong password
 * shows as an archive none of whose pages decode.
 */
async function unlockRar(buffer, name) {
  const wrong = await decrypt(buffer, 'rar', `${PASSWORD} but wrong`)
  if (wrong.status === 'decrypted') {
    if (wrong.proven) {
      return { problem: 'a wrong password was taken as confirmed' }
    }
    const decoded = await decodeWithUnarr(wrong.bytes, true)
    if (decoded.pages - decoded.malformed > 0) {
      return { problem: 'pages decoded with a wrong password' }
    }
  } else if (wrong.status !== 'wrong-password') {
    return { problem: `a wrong password gave "${wrong.status}"` }
  }
  const right = await decrypt(buffer, 'rar', PASSWORD)
  if (right.status !== 'decrypted') {
    return { problem: `the right password gave "${right.status}"` }
  }
  // A decrypted RAR4 goes to unarr; RAR5 to libarchive.
  const isRar5 = right.bytes[6] === 1
  const result = isRar5
    ? await decodeWithLibarchive(right.bytes, name)
    : await decodeWithUnarr(right.bytes, true)
  return { result, by: `decrypted, then ${isRar5 ? 'libarchive' : 'unarr'}` }
}

/**
 * A password-protected zip or 7z, opened the way the reader opens one once
 * it has been given the password. Returns `{ problem }` when something is
 * wrong, and otherwise `{ result, by }`: the decode's figures and which
 * decoder gave them.
 */
async function unlock(buffer, name, isZip) {
  const wrong = `${PASSWORD} but wrong`
  if (isZip) {
    if (await isAesInUndecodableMethod(buffer)) {
      // Neither decoder reads this as it is: zip.js lacks the method and
      // libarchive cannot undo AES. The entries are decrypted first.
      if ((await decrypt(buffer, 'zip', wrong)).status !== 'wrong-password') {
        return { problem: 'decrypting accepted a wrong password' }
      }
      const plain = await decrypt(buffer, 'zip', PASSWORD)
      if (plain.status !== 'decrypted') {
        return { problem: `decrypting gave "${plain.status}"` }
      }
      return {
        result: await decodeWithLibarchive(plain.bytes, name, undefined, plain.unchecked),
        by: 'decrypted, then libarchive'
      }
    }
    // Two wrong ones: the old zip scheme checks a single byte, so any one
    // wrong password has a 1 in 256 chance of passing for a given file.
    if (
      !(await zipRefuses(buffer, name, wrong)) &&
      !(await zipRefuses(buffer, name, `${wrong} again`))
    ) {
      return { problem: 'a wrong password was not refused' }
    }
    const result = await decodeZip(buffer, name, PASSWORD)
    return { result, by: result.note ? 'libarchive, with the password' : 'zip.js' }
  }
  if ((await decodeWithSevenZip(buffer, undefined)).password !== 'needed') {
    return { problem: '7-Zip did not ask for a password' }
  }
  if ((await decodeWithSevenZip(buffer, wrong)).password !== 'wrong') {
    return { problem: 'a wrong password was not refused' }
  }
  return { result: await decodeWithSevenZip(buffer, PASSWORD), by: '7-Zip' }
}

/**
 * RAR through whichever decoder reads it. The reader picks one up front from
 * the container's headers (solid RAR4 goes to unarr); this script gets to the
 * same place by trying libarchive first, and unarr when that comes up short,
 * which is what a solid RAR4 produces there.
 */
async function decodeRar(buffer, name) {
  let viaLibarchive = { pages: 0, bytes: 0, malformed: 0 }
  try {
    viaLibarchive = await decodeWithLibarchive(buffer, name)
  } catch {
    // libarchive may reject a solid RAR outright; unarr gets its turn below.
  }
  if (viaLibarchive.pages === EXPECTED_PAGES && viaLibarchive.malformed === 0) {
    return viaLibarchive
  }
  const viaUnarr = await decodeWithUnarr(buffer)
  return viaUnarr.pages > viaLibarchive.pages
    ? { ...viaUnarr, note: 'via unarr fallback' }
    : viaLibarchive
}

/**
 * Whether the reader would report this archive as password protected, checked
 * the way the reader finds out: zip.js flags encrypted entries; libarchive is
 * asked at open; and where that says no, the first page read is refused with
 * a message about encryption.
 */
async function reportsEncrypted(buffer, name, isZip) {
  if (isZip) {
    const reader = new zip.ZipReader(new zip.BlobReader(new Blob([buffer])))
    const entries = await reader.getEntries()
    await reader.close()
    return entries.some((entry) => entry.encrypted) ? 'zip.js flags its entries' : null
  }
  const reader = await Archive.open(new File([buffer], name))
  try {
    await reader.open()
    if ((await reader.hasEncryptedData()) === true) {
      return 'libarchive says so at open'
    }
    const page = (await fileEntries(reader)).find((entry) => isPage(entry.name))
    try {
      await page?.file.extract()
    } catch (error) {
      return ENCRYPTION_MESSAGE.test(error.message) ? 'libarchive refuses the first page read' : null
    }
    return null
  } finally {
    await reader.close().catch(() => {})
  }
}

let failures = 0
let checked = 0

for (const file of readdirSync(dir).sort()) {
  const extension = extname(file).toLowerCase()
  if (!ARCHIVE_EXT.has(extension)) {
    continue
  }
  checked++
  const started = Date.now()
  try {
    const buffer = readFileSync(resolve(dir, file))
    const isZip = extension === '.cbz' || extension === '.zip'
    const isRar = extension === '.cbr' || extension === '.rar'

    // A password-protected archive must first be recognised as one: that is
    // what makes the reader ask for the password. It must then open with
    // the password, and not with another.
    if (/encrypted/i.test(file)) {
      const how = await reportsEncrypted(buffer, file, isZip)
      let outcome = how
        ? `reported as password protected (${how})`
        : 'NOT reported as password protected'
      let ok = Boolean(how)
      if (ok) {
        const { problem, result, by } = isRar
          ? await unlockRar(buffer, file)
          : await unlock(buffer, file, isZip)
        ok = !problem && result.pages === EXPECTED_PAGES && result.malformed === 0
        outcome += problem
          ? `; ${problem}`
          : `; with the password: pages=${result.pages} ` +
            `decoded=${(result.bytes / 1024).toFixed(0)}KB malformed=${result.malformed} (${by})`
      }
      if (!ok) {
        failures++
      }
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${file.padEnd(30)} ${outcome} ${Date.now() - started}ms`)
      continue
    }
    const { pages, bytes, malformed, note } = isZip
      ? await decodeZip(buffer, file)
      : isRar
        ? await decodeRar(buffer, file)
        : await decodeWithLibarchive(buffer, file)

    const ok = pages === EXPECTED_PAGES && malformed === 0
    if (!ok) {
      failures++
    }
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${file.padEnd(30)} pages=${pages} ` +
        `decoded=${(bytes / 1024).toFixed(0)}KB malformed=${malformed}` +
        `${note ? ` (${note})` : ''} ${Date.now() - started}ms`
    )
  } catch (error) {
    failures++
    console.log(`FAIL ${file.padEnd(30)} ${error.message}`)
  }
}

/**
 * Decrypts an archive as the reader would and has libarchive, which the
 * reader hands the result to, decode it: `pages` pages, all of them images.
 */
async function checkDecrypted(name, bytes, format, file, pages) {
  checked++
  try {
    const plain = await decrypt(bytes, format, PASSWORD)
    const result =
      plain.status === 'decrypted'
        ? await decodeWithLibarchive(plain.bytes, file, undefined, plain.unchecked)
        : null
    const ok = result?.pages === pages && result.malformed === 0
    failures += ok ? 0 : 1
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} ` +
        (result
          ? `pages=${result.pages} malformed=${result.malformed} (decrypted, then libarchive)`
          : `decrypting gave "${plain.status}"`)
    )
  } catch (error) {
    failures++
    console.log(`FAIL ${name.padEnd(30)} ${error.message}`)
  }
}

if (checked) {
  // One made here, since no archiver at hand writes it on request: a zip64
  // archive with AES entries must come out as a zip64 archive libarchive
  // reads. (zip.js reading it back is covered by the unit tests.)
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), {
    password: PASSWORD,
    encryptionStrength: 3,
    zip64: true
  })
  for (let page = 1; page <= EXPECTED_PAGES; page++) {
    await writer.add(`pages/${page}.png`, new zip.Uint8ArrayReader(PNG), { level: page % 2 ? 0 : 6 })
  }
  await checkDecrypted('zip64, AES-256 (made here)', await writer.close(), 'zip', 'zip64.cbz', EXPECTED_PAGES)

  // And the password-protected RAR5 fixtures of the unit tests, which
  // include a solid one (the format matrix has none). Encryption pads every
  // entry, and libarchive's solid decoder does not get past padding, so
  // this is what checks that it has been cut off. Three pages in each.
  const fixtures = resolve(here, '..', 'tests', 'fixtures', 'rar-encrypted')
  for (const file of readdirSync(fixtures).filter((name) => name.startsWith('rar5')).sort()) {
    await checkDecrypted(`fixture ${file}`, readFileSync(resolve(fixtures, file)), 'rar', file, 3)
  }
}

// A damaged page must fail to read, and not be handed over as if it were
// sound. One bit is flipped a third of the way into each of these (inside
// a page's data, in all of them): that page, and no other, must be refused.
// libarchive needed two changes for this; see native/libarchive/README.md.
for (const file of ['rar4-store.cbr', 'rar4-compressed.cbr', 'rar5-store.cbr', 'rar5-compressed.cbr']) {
  if (!existsSync(resolve(dir, file))) {
    continue
  }
  const name = `damaged ${file}`
  checked++
  try {
    const bytes = new Uint8Array(readFileSync(resolve(dir, file)))
    bytes[Math.floor(bytes.length * 0.3)] ^= 1
    const reader = await Archive.open(new File([bytes], file))
    let read = 0
    let refused = 0
    try {
      await reader.open()
      for (const { name: entryName, file: entry } of await fileEntries(reader)) {
        if (isPage(entryName)) {
          await entry.extract().then(
            () => read++,
            () => refused++
          )
        }
      }
    } finally {
      await reader.close()
    }
    const ok = refused === 1 && read === EXPECTED_PAGES - 1
    failures += ok ? 0 : 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} pages read=${read} refused=${refused}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name.padEnd(30)} ${error.message}`)
  }
}

await zip.terminateWorkers().catch(() => {})
if (!checked) {
  // A run that looked at nothing must not read as a pass.
  console.log(`\nNo archives found in ${dir}`)
  process.exit(1)
}
console.log(
  failures
    ? `\n${failures} of ${checked} archive(s) behaved unexpectedly`
    : `\nAll ${checked} archives behaved as expected`
)
process.exit(failures ? 1 : 0)
