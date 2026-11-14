import { Archive } from 'libarchive.js'
import type { ArchiveReader } from 'libarchive.js/dist/build/compiled/archive-reader'

import {
  ComicReaderError,
  type ArchiveAdapter,
  type ArchiveEntry,
  type ArchiveSource,
  type ComicFormat,
  type DroppedEntries,
  encryptedError,
  isEncryptedError
} from './types'
import { findEntryByName, mimeTypeForImage } from './pageSort'
import { resolveVendorAssetUrl } from '../helpers/assetUrl'
import { crc32 } from '../helpers/crc32'
import type { Rar4Inspection } from './rar4'
import { checkWasmAllowed, withTimeout, WorkerTimeoutError } from '../helpers/wasm'
import { DEFAULT_CONFIG, EXPANSION_LIMIT, MAX_TEXT_BYTES, MB } from '../config'
import encryptionMessages from './encryptionMessages.json'

/**
 * Budgets for worker calls. Generous on purpose: these exist so a dead worker
 * surfaces as an error instead of an endless spinner, not to cap slow work.
 */
const OPEN_TIMEOUT_MS = 30_000
const READ_TIMEOUT_MS = 120_000
const BULK_TIMEOUT_MS = 600_000

/**
 * A single-page read slower than this suggests a solid archive, where each
 * read re-decompresses everything before it. That triggers one bulk pass.
 */
const SOLID_DETECT_MS = 1200

let initialised = false

/**
 * Points libarchive.js at the worker bundle we ship in `public/vendor/`.
 *
 * It must be loaded from a real URL rather than a blob, because the worker
 * resolves `libarchive.wasm` relative to its own location.
 */
function initLibArchive() {
  if (initialised) {
    return
  }
  const workerUrl = resolveVendorAssetUrl('libarchive/worker-bundle.js')
  Archive.init({
    getWorker: () => new Worker(workerUrl, { type: 'module', name: 'comic-reader-libarchive' })
  })
  initialised = true
}

/** libarchive.js's default locale, with the marker main.c looks for. */
const UNCHECKED_ZIP_LOCALE = 'en_US.UTF-8@zip-unchecked'

/**
 * Starts a decoder on the archive and opens it, with the password if there
 * is one. A decoder that fails to open is closed again: its worker would
 * otherwise be left running.
 */
async function startReader(
  file: File,
  password: string | undefined,
  uncheckedZip = false
): Promise<ArchiveReader> {
  let reader: ArchiveReader
  try {
    reader = await withTimeout(Archive.open(file), OPEN_TIMEOUT_MS, 'Archive.open')
  } catch (error) {
    throw toOpenError(error)
  }
  try {
    if (password !== undefined) {
      await withTimeout(reader.usePassword(password), OPEN_TIMEOUT_MS, 'usePassword')
    }
    if (uncheckedZip) {
      // The one channel the library offers for an option: the wrapper in
      // native/libarchive/libarchivejs/main.c reads this off the locale.
      await withTimeout(reader.setLocale(UNCHECKED_ZIP_LOCALE), OPEN_TIMEOUT_MS, 'setLocale')
    }
    await withTimeout(reader.open(), OPEN_TIMEOUT_MS, 'reader.open')
  } catch (error) {
    // Archive.open() already spawned a worker; without this it leaks.
    await reader.close().catch(() => {})
    throw toOpenError(error)
  }
  return reader
}

/**
 * A worker that stopped answering is reported as a backend problem, not as a
 * corrupt file: the archive is probably fine and telling the user it is broken
 * would send them looking in the wrong place.
 */
function toOpenError(error: unknown): ComicReaderError {
  if (error instanceof ComicReaderError) {
    return error
  }
  if (error instanceof WorkerTimeoutError) {
    return new ComicReaderError(
      'backend-unavailable',
      'The archive decoder stopped responding.',
      error
    )
  }
  return new ComicReaderError('corrupt', 'This comic archive could not be opened.', error)
}

/**
 * Recognises libarchive refusing to read an entry because it is encrypted.
 *
 * The check made at open only looks at the archive's first header, and for a
 * 7z archive that keeps its file names readable it comes back negative: the
 * archive lists normally and then every read fails. The message is the only
 * signal there is, so it is matched here. Two wordings are in use, one per
 * reader: "The file content is encrypted, but currently not supported" (7z)
 * and "Reading encrypted data is not currently supported" (RAR5).
 *
 * The pattern lives in encryptionMessages.json so that
 * scripts/verify-formats.mjs, which checks it against the real decoder, uses
 * the very same one.
 */
const ENCRYPTION_MESSAGE = new RegExp(encryptionMessages.pattern, encryptionMessages.flags)

export function encryptionErrorFrom(error: unknown): ComicReaderError | null {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return ENCRYPTION_MESSAGE.test(message)
    ? encryptedError(error)
    : null
}

/**
 * One entry as libarchive.js's worker reports it.
 *
 * The adapter talks to the worker's own calls (`listFiles`, `extractFiles`)
 * and not to the library's `getFilesArray()` and `extractFiles()`, which
 * first fold that flat list into an object keyed by path segment. Folding
 * does two things an untrusted archive must not be allowed: entries that
 * share a name collapse into one, hiding the one the decoder will actually
 * read, and a segment named `__proto__` writes into `Object.prototype` for
 * the whole page. `npm run verify:libarchive` checks these calls against the
 * real worker.
 */
interface WorkerEntry {
  path: string
  size: number
  type: string
  /** Present after `extractFiles` only. */
  fileData?: Uint8Array
}

interface WorkerClient {
  listFiles(): Promise<WorkerEntry[]>
  extractFiles(): Promise<WorkerEntry[]>
}

const workerOf = (reader: ArchiveReader) => (reader as unknown as { client: WorkerClient }).client

const fileEntriesOf = (listing: WorkerEntry[]) => listing.filter((entry) => entry.type === 'FILE')

/** The name an entry is shown and sorted under: its path, never rooted. */
const displayName = (path: string) => path.replace(/^\/+/, '')

const unreadable = (entry: { name: string }, cause?: unknown) =>
  new ComicReaderError('corrupt', `Page "${entry.name}" could not be read.`, cause)

interface CachedEntry {
  name: string
  size: number
  /**
   * What to ask the decoder for: its own notion of the entry's path, kept as
   * it came. Null when the entry must not or cannot be asked for.
   */
  path: string | null
  /** Filled by bulk extraction only. */
  data?: Blob
}

export interface LibArchiveAdapterOptions {
  format: ComicFormat
  /**
   * Above this size the adapter never bulk-extracts, because holding every
   * page in memory at once would be worse than slow page turns.
   */
  bulkExtractLimitMb?: number
  /** Per-entry ceiling; larger members are neither read nor retained. */
  maxEntryBytes?: number
  /** Most entries an archive may list before it is refused. */
  maxEntries?: number
  /**
   * What the container's own headers declare, when it is RAR4. Compared with
   * what the decoder enumerates, so entries it silently dropped are reported.
   */
  rar4?: Rar4Inspection | null
  /**
   * For a zip protected with the old zip scheme, the one kind of encryption
   * this build of libarchive undoes (it needs no cryptography library; AES
   * does). With it, finding the archive encrypted is not a refusal.
   */
  password?: string
  /**
   * With a password: the entries that are encrypted, by name, each with the
   * checksum the zip directory records for it. libarchive does not compare
   * that checksum, so a wrong password that gets past the old zip scheme's
   * one-byte check comes back from it as a successful read of noise. Until
   * the password is proved, this adapter compares it instead.
   */
  encryptedEntries?: ReadonlyMap<string, number | undefined>
  /** With a password: whether the caller has already proved it right. */
  passwordProven?: boolean
  /**
   * For a zip whose AES entries the app has decrypted (sevenZipAdapter.ts).
   * Such entries may carry no checksum (the scheme's second version relies
   * on an authentication code instead, which has been checked by then), so
   * the decoder is told not to compare them.
   */
  uncheckedZip?: boolean
  onBulkExtractStart?: () => void
  onBulkExtractDone?: () => void
}

/**
 * Back end for RAR and 7z containers, both of which are handled by the
 * libarchive WASM build. One library covers both formats, which keeps the
 * payload to a single lazily-loaded `.wasm` and one licence to review.
 *
 * libarchive.js runs its own worker internally, so this adapter deliberately
 * does *not* add another layer of worker plumbing on top.
 */
export class LibArchiveAdapter implements ArchiveAdapter {
  readonly format: ComicFormat
  /**
   * Entries the container itself declares, when we can count them. Compared
   * against what the decoder enumerated so silently dropped members can be
   * reported rather than passing for a short comic.
   */
  private declaredEntryCount: number | null = null
  /** Whether the container declares itself solid; see `dropped`. */
  private declaredSolid = false
  /**
   * Whether an entry that is not a regular file (a socket, a device, a
   * directory) declares data. The one-pass unpack reads every entry by its
   * declared size, files or not, so such an archive is never unpacked that
   * way: those sizes are in no budget.
   */
  private otherEntriesHaveData = false

  private entries: CachedEntry[] = []
  private bulkPromise: Promise<void> | null = null
  /**
   * Single-file extractions currently awaiting the worker.
   *
   * These have to be drained before bulk extraction runs. The worker is
   * terminated when that finishes, and a call that was
   * already in flight at that moment never settles — it does not reject, it
   * simply hangs forever, leaving the page stuck on a spinner. Prefetch makes
   * this near-certain rather than theoretical: solid-archive detection fires
   * on one of the first pages, which is exactly when several reads overlap.
   */
  private readonly inflightReads = new Set<Promise<unknown>>()
  /**
   * When the first single read finished. Reads that *started* before this
   * are exempt from solid-archive detection: prefetch fires several at open,
   * they all queue behind WASM start-up in the worker, and every one of them
   * would otherwise report a start-up-inflated duration. A simple "skip the
   * first completed read" does not cover that.
   */
  private firstReadDoneAt: number | null = null

  private readonly totalBytes: number
  /**
   * The archive, kept so that a fresh decoder can be started on it if the
   * one-pass unpack fails. Let go once that pass has succeeded, and by
   * close(), which is also how work that finishes after close() knows.
   * (It holds nothing the decoder's own reader does not hold as well.)
   */
  private file: File | null
  /**
   * With a password: whether it is known to be right, because the caller
   * said so or an encrypted entry has been read with it and matched its
   * checksum. Until then an encrypted entry that fails to read counts
   * against the password, and the reader asks again; after, the failure is
   * that entry's.
   */
  private passwordProven: boolean

  private constructor(
    private reader: ArchiveReader | null,
    file: File,
    private readonly options: Required<
      Pick<LibArchiveAdapterOptions, 'bulkExtractLimitMb' | 'maxEntryBytes'>
    > &
      LibArchiveAdapterOptions
  ) {
    this.format = options.format
    this.passwordProven = options.passwordProven ?? false
    this.file = file
    this.totalBytes = file.size
  }

  /** libarchive decodes every method it can list, so nothing is undecodable. */
  unsupportedEntries(): ReadonlySet<number> {
    return new Set()
  }

  /**
   * Members the container declares but the decoder did not return.
   *
   * Only ever solid RAR4: libarchive enumerates the first entry of a solid
   * block and stops. Without this the comic just looks short.
   */
  get dropped(): DroppedEntries | null {
    // Gated on the solid flag deliberately. Across all 50 RAR4 archives in
    // libarchive's own test corpus, the only entries missing from a non-solid
    // archive were symlinks, which are not pages and are excluded from the
    // header count anyway. Reporting on non-solid archives would therefore be
    // noise at best and a false alarm at worst.
    if (this.declaredEntryCount === null || !this.declaredSolid) {
      return null
    }
    const count = this.declaredEntryCount - this.entries.length
    return count > 0 ? { count, because: 'solid-rar' } : null
  }

  static async open(
    source: ArchiveSource,
    options: LibArchiveAdapterOptions
  ): Promise<LibArchiveAdapter> {
    if (source.kind !== 'blob') {
      // RAR and 7z directories live at the end and reference back into the
      // stream; there is no useful partial-read story, so callers must buffer.
      throw new ComicReaderError(
        'backend-unavailable',
        'This format has to be downloaded in full before it can be opened.'
      )
    }

    // Checked before spawning anything. When the policy forbids WebAssembly,
    // the worker starts, aborts inside its Emscripten runtime, and then never
    // answers — so without this the failure is an indefinite spinner rather
    // than an error. Probing up front turns it into a message that names the
    // actual cause.
    if (!(await checkWasmAllowed())) {
      throw new ComicReaderError(
        'backend-unavailable',
        'This browser is not allowed to run WebAssembly on this page.'
      )
    }

    try {
      initLibArchive()
    } catch (error) {
      throw new ComicReaderError(
        'backend-unavailable',
        'The archive decoder could not be started. Your server may block WebAssembly or workers.',
        error
      )
    }

    // Wrapping a Blob in a File shares its bytes, so nothing is copied on
    // this thread. The decoder's worker then reads the file into its own heap.
    const file = new File([source.data], source.name, { type: 'application/octet-stream' })

    const reader = await startReader(file, options.password, options.uncheckedZip)

    const adapter = new LibArchiveAdapter(reader, file, {
      bulkExtractLimitMb: DEFAULT_CONFIG.bulkExtractLimitMb,
      maxEntryBytes: DEFAULT_CONFIG.maxPageSizeMb * MB,
      ...options
    })

    try {
      if (
        // With a password, an encrypted archive is what is expected.
        options.password === undefined &&
        (await withTimeout(reader.hasEncryptedData(), OPEN_TIMEOUT_MS, 'hasEncryptedData'))
      ) {
        await adapter.close()
        throw encryptedError()
      }
    } catch (error) {
      if (error instanceof ComicReaderError) {
        throw error
      }
      if (error instanceof WorkerTimeoutError) {
        // The worker is gone; every later call would only time out again.
        await adapter.close()
        throw toOpenError(error)
      }
      // hasEncryptedData returns null when undeterminable; not fatal.
    }

    adapter.declaredEntryCount = options.rar4?.entryCount ?? null
    adapter.declaredSolid = options.rar4?.solid ?? false

    try {
      const listing = await withTimeout(workerOf(reader).listFiles(), OPEN_TIMEOUT_MS, 'listFiles')
      const files = fileEntriesOf(listing)
      // The decoder has listed everything by now, so this cannot spare its
      // worker the work; it keeps the rest of the app from sorting and
      // holding a listing no comic has. Entries of every kind count, as
      // they do for zip.
      if (options.maxEntries !== undefined && listing.length > options.maxEntries) {
        throw new ComicReaderError(
          'too-many-pages',
          `This archive lists more than ${options.maxEntries} entries, more than this reader will open.`
        )
      }
      // The decoder finds an entry by its path, among entries of every type,
      // and takes the first match. So of several entries with one path only
      // the first can be read, and only if it is a file. The others are
      // listed without a handle: asking for one would return the first, by
      // the first's size.
      const first = new Set<WorkerEntry>()
      const seen = new Set<string>()
      for (const entry of listing) {
        if (!seen.has(entry.path)) {
          seen.add(entry.path)
          first.add(entry)
        }
      }
      adapter.otherEntriesHaveData = listing.some(
        (entry) => entry.type !== 'FILE' && entry.size !== 0
      )
      adapter.entries = files.map((file) => {
        // The decoder hands sizes over as signed 32-bit numbers, so one of
        // 2 GiB or more can arrive negative. Such an entry is listed with no
        // size and no handle: asking the decoder for it would have it
        // allocate by that number.
        const readable = Number.isSafeInteger(file.size) && file.size >= 0 && first.has(file)
        return {
          name: displayName(file.path),
          size: readable ? file.size : 0,
          path: readable ? file.path : null
        }
      })
    } catch (error) {
      await adapter.close()
      if (error instanceof WorkerTimeoutError || error instanceof ComicReaderError) {
        throw toOpenError(error)
      }
      throw new ComicReaderError('corrupt', 'The contents of this comic could not be listed.', error)
    }

    return adapter
  }

  listEntries(): ArchiveEntry[] {
    return this.entries.map((entry, index) => ({
      index,
      name: entry.name,
      size: entry.size,
      isDirectory: false
    }))
  }

  async readEntry(index: number): Promise<Blob> {
    const entry = this.entries[index]
    if (!entry) {
      throw new ComicReaderError('corrupt', `Page ${index} is missing from the archive.`)
    }
    if (entry.data) {
      return entry.data
    }
    if (this.bulkPromise) {
      await this.bulkPromise
      if (entry.data) {
        return entry.data
      }
    }
    if (entry.size > this.options.maxEntryBytes) {
      // The decoder allocates what the entry declares before reading it.
      throw new ComicReaderError('page-too-large', `Page "${entry.name}" is too large to display.`)
    }
    if (!this.reader || entry.path === null) {
      // The reader is spent (bulk extraction) or closed, and this entry was
      // not kept. Nothing left to read it from.
      throw new ComicReaderError('page-unavailable', `Page "${entry.name}" could not be read.`)
    }

    const startedAt = Date.now()
    let extracted: File
    try {
      extracted = await this.extract(this.reader, entry.path)
    } catch (error) {
      if (this.options.password === undefined) {
        throw encryptionErrorFrom(error) ?? unreadable(entry, error)
      }
      // With a password. Until it is proved, an encrypted entry that fails
      // to read counts against it, however the decoder words the failure (a
      // wrong password that gets past the check byte fails as bad
      // compressed data), unless another entry then proves the password
      // right. Once proved, the failure is this entry's.
      // (A decoder that stopped answering says nothing about the password.)
      throw !this.passwordProven &&
        this.isEncryptedEntry(entry) &&
        !(error instanceof WorkerTimeoutError) &&
        !(await this.provedByAnother(entry))
        ? encryptedError(error)
        : unreadable(entry, error)
    }
    if (this.options.password !== undefined && !this.passwordProven && this.isEncryptedEntry(entry)) {
      // libarchive does not compare a zip entry's checksum, so that it read
      // something proves nothing yet.
      // Nor does an empty entry, which reads under any password, or one
      // there is no checksum to hold it to.
      const expected = this.options.encryptedEntries?.get(entry.name)
      if (this.options.encryptedEntries === undefined) {
        this.passwordProven = true
      } else if (expected !== undefined && extracted.size > 0) {
        if (crc32(new Uint8Array(await extracted.arrayBuffer())) !== expected) {
          // Noise: a wrong password, unless another entry says otherwise,
          // in which case it is this entry that is damaged.
          throw (await this.provedByAnother(entry)) ? unreadable(entry) : encryptedError()
        }
        this.passwordProven = true
      }
    }
    const elapsed = Date.now() - startedAt

    // Returned as the File the decoder produced, not read into an array: the
    // caller only needs something it can make a blob URL from.
    //
    // Deliberately not retained here. Caching decoded pages in the adapter as
    // well as in PageCache would keep every page ever read alive for the life
    // of the archive, defeating PageCache's eviction. Only bulk extraction
    // fills `entry.data`, because at that point the reader is spent and the
    // cache is the sole remaining source.

    // A slow read is the signature of a solid archive: libarchive had to walk
    // the stream from the start to reach the member. One bulk pass is far
    // cheaper than paying that cost on every page turn.
    const startedDuringWarmUp =
      this.firstReadDoneAt === null || startedAt < this.firstReadDoneAt
    if (this.firstReadDoneAt === null) {
      this.firstReadDoneAt = Date.now()
    }
    if (!startedDuringWarmUp && elapsed > SOLID_DETECT_MS && this.canBulkExtract()) {
      void this.bulkExtract()
    }

    return extracted
  }

  /** Reads one entry, within the time a read is allowed, and counted as in flight. */
  private async extract(reader: ArchiveReader, path: string): Promise<File> {
    const pending = withTimeout(reader.extractSingleFile(path), READ_TIMEOUT_MS, 'extractSingleFile')
    this.inflightReads.add(pending)
    try {
      return await pending
    } finally {
      this.inflightReads.delete(pending)
    }
  }

  /**
   * With a password not yet proved, and one entry that did not read with
   * it: asks up to two other encrypted entries. One of them reading, and
   * matching its checksum, proves the password, and the failure was the
   * first entry's own. Without this a single damaged entry, if it happened
   * to be read first, would have the reader ask for the password for ever.
   */
  private async provedByAnother(failed: CachedEntry): Promise<boolean> {
    const reader = this.reader
    const checksums = this.options.encryptedEntries
    if (!reader || !checksums) {
      return false
    }
    const others = this.entries
      .filter(
        (entry) =>
          entry !== failed &&
          entry.path !== null &&
          entry.size > 0 &&
          entry.size <= this.options.maxEntryBytes &&
          checksums.get(entry.name) !== undefined
      )
      .slice(0, 2)
    for (const other of others) {
      try {
        const file = await this.extract(reader, other.path as string)
        const data = new Uint8Array(await file.arrayBuffer())
        if (data.byteLength > 0 && crc32(data) === checksums.get(other.name)) {
          this.passwordProven = true
          return true
        }
      } catch {
        // This one did not read either; the next may.
      }
    }
    return false
  }

  /**
   * Whether reading this entry took the password. Known from the zip
   * directory when the caller passed it on; otherwise a page is assumed to
   * have been encrypted like the rest.
   */
  private isEncryptedEntry(entry: CachedEntry): boolean {
    return this.options.encryptedEntries
      ? this.options.encryptedEntries.has(entry.name)
      : Boolean(mimeTypeForImage(entry.name))
  }

  async readText(name: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
    const match = findEntryByName(this.listEntries(), name)
    if (!match) {
      return null
    }
    try {
      const data = await this.readEntry(match.index)
      // libarchive extracts inside the worker, so unlike zip there is no way
      // to abort mid-stream; the check is on the real length after the fact.
      if (data.size > maxBytes) {
        return null
      }
      return await data.text()
    } catch (error) {
      // An unreadable metadata file is not worth failing over, with one
      // exception: finding out here that the archive is encrypted.
      if (isEncryptedError(error)) {
        throw error
      }
      return null
    }
  }

  private canBulkExtract(): boolean {
    // close() nulls the reader, so a closed adapter fails the reader check.
    if (this.bulkPromise || !this.reader || this.otherEntriesHaveData) {
      return false
    }
    if (this.totalBytes > this.options.bulkExtractLimitMb * MB) {
      return false
    }
    // A page with no declared size makes the total below meaningless, so it
    // rules the one-pass unpack out. Such an archive is read a page at a time
    // instead, where each page is held to the per-entry cap.
    if (this.entries.some((entry) => mimeTypeForImage(entry.name) && !(entry.size > 0))) {
      return false
    }
    // The pass asks the decoder for every entry, pages or not, so one it
    // must not be asked for rules the pass out as well.
    if (
      this.entries.some((entry) => entry.path === null || entry.size > this.options.maxEntryBytes)
    ) {
      return false
    }
    const declaredBytes = this.entries.reduce((total, entry) => total + entry.size, 0)
    return declaredBytes <= this.bulkRetainLimit
  }

  /**
   * Most that bulk extraction may declare, and most it will then keep.
   *
   * The check before the pass goes by the sizes the archive declares, and the
   * pass is refused outright when any page declares none. That narrows the
   * gap without closing it: the pass runs inside the decoder's worker with no
   * way to stop it part way, so an archive whose declared sizes are wrong is
   * still unpacked there. What comes back is then held to this same limit,
   * and to the per-entry cap, by its real size.
   */
  private get bulkRetainLimit(): number {
    return this.totalBytes * EXPANSION_LIMIT
  }

  /**
   * Extracts every member in one sweep. The worker is terminated afterwards,
   * so the reader is spent once this resolves and all further reads must
   * come from the cache filled here.
   */
  private bulkExtract(): Promise<void> {
    // Only called once canBulkExtract() has said yes: there is a reader and
    // no pass has been started.
    const reader = this.reader!
    this.options.onBulkExtractStart?.()
    this.bulkPromise = (async () => {
      let unpacked = false
      try {
        // Let every outstanding single read finish first. Anything still in
        // flight when the worker goes would hang forever.
        await Promise.allSettled([...this.inflightReads])
        const extracted = await withTimeout(
          workerOf(reader).extractFiles(),
          BULK_TIMEOUT_MS,
          'extractFiles'
        )
        this.absorbExtracted(fileEntriesOf(extracted))
        unpacked = true
      } catch (error) {
        console.warn('[comic-reader] unpacking the archive in one pass failed:', error)
      }
      // Nothing may be read from this decoder from here on: it is spent if
      // the pass worked, and in an unknown state, where a read may never
      // settle, if it did not.
      this.reader = null
      await reader.close().catch(() => {})
      if (unpacked) {
        // The pages have been copied out, and with them goes any use for
        // the per-entry handles and for the archive.
        this.file = null
        this.forgetHandles()
      } else {
        await this.restartAfterFailedPass()
      }
      this.options.onBulkExtractDone?.()
    })()
    return this.bulkPromise
  }

  /** Marks every entry not held in memory as unreadable from here on. */
  private forgetHandles(): void {
    this.entries.forEach((entry) => {
      entry.path = null
    })
  }

  /**
   * After a one-pass unpack that failed: starts a fresh decoder on the same
   * archive, so that pages go on being read one at a time, as they were
   * before the pass was tried. (`bulkPromise` stays set, so the pass is not
   * tried again.) If that fails too, the pages not yet read are unreadable,
   * and say so at once instead of hanging.
   */
  private async restartAfterFailedPass(): Promise<void> {
    const file = this.file
    if (!file) {
      // Closed while the pass was failing.
      return
    }
    try {
      const fresh = await startReader(file, this.options.password, this.options.uncheckedZip)
      if (!this.file) {
        // Closed while the decoder was starting; nothing is left to read.
        await fresh.close().catch(() => {})
        return
      }
      this.reader = fresh
    } catch (error) {
      console.warn('[comic-reader] could not restart the decoder:', error)
      this.forgetHandles()
    }
  }

  /**
   * Keeps the pages out of what one pass over the archive returned.
   *
   * The pass walks the archive in the order the listing did, so entries are
   * matched by position, and the path is compared to be sure of it. Matching
   * by name alone could not tell two entries of the same name apart.
   */
  private absorbExtracted(extracted: WorkerEntry[]): void {
    // Checked against what actually came back, not what was declared.
    let retainedBytes = 0
    extracted.forEach((file, index) => {
      const entry = this.entries[index]
      const data = file.fileData
      if (!entry || entry.data || !data || displayName(file.path) !== entry.name) {
        return
      }
      // Only pages are read after this point, and an oversized one would be
      // refused by the page cache anyway; retaining either is waste.
      const wanted =
        mimeTypeForImage(entry.name) &&
        data.byteLength <= this.options.maxEntryBytes &&
        retainedBytes + data.byteLength <= this.bulkRetainLimit
      if (wanted) {
        // As a Blob, which the browser may hold outside the JS heap.
        entry.data = new Blob([data as BlobPart])
        retainedBytes += data.byteLength
      }
    })
  }

  async close(): Promise<void> {
    this.file = null
    this.entries.forEach((entry) => {
      entry.data = undefined
    })
    const reader = this.reader
    this.reader = null
    if (reader) {
      await reader.close().catch(() => {})
    }
  }
}
