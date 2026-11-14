import {
  configure,
  BlobReader,
  ERR_INVALID_AUTHENTICATION_CODE,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
  ERR_INVALID_PASSWORD,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_UNSUPPORTED_ENCRYPTION,
  HttpReader,
  Uint8ArrayWriter,
  ZipReader,
  terminateWorkers,
  type Entry,
  type Reader
} from '@zip.js/zip.js'

import {
  ComicReaderError,
  encryptedError,
  type ArchiveAdapter,
  type ArchiveEntry,
  type ArchiveSource
} from './types'
import { findEntryByName } from './pageSort'
import { DEFAULT_CONFIG, ENTRIES_PER_PAGE_LIMIT, MAX_TEXT_BYTES, MB } from '../config'

/** zip.js models directories as a separate variant without `getData`. */
type FileEntry = Entry & {
  getData: <T>(writer: { init?: unknown }, options?: unknown) => Promise<T>
  compressionMethod?: number
  /** Encrypted with the old zip scheme, as opposed to AES. */
  zipCrypto?: boolean
}

function asFileEntry(entry: Entry | undefined): FileEntry | null {
  if (!entry || entry.directory) {
    return null
  }
  return 'getData' in entry ? (entry as FileEntry) : null
}

/**
 * Compression methods zip.js implements: stored, deflate and deflate64.
 *
 * A zip using bzip2 (12), LZMA (14), zstd (93) or PPMd (98) opens fine — the
 * central directory is readable — and then fails on every single page. Knowing
 * the method up front turns that into one clear message instead of a wall of
 * identical per-page errors.
 */
const SUPPORTED_COMPRESSION_METHODS = new Set([0, 8, 9])
// (scripts/verify-formats.mjs keeps a copy of this list, ZIP_JS_METHODS.)

/** Whether zip.js can decode this entry's compression method. */
function isDecodable(entry: Entry): boolean {
  const method = (entry as FileEntry).compressionMethod
  return method === undefined || SUPPORTED_COMPRESSION_METHODS.has(method)
}

/** Applies when the caller does not specify one. */
const DEFAULT_MAX_ENTRY_BYTES = DEFAULT_CONFIG.maxPageSizeMb * MB

const DEFAULT_MAX_ENTRIES = DEFAULT_CONFIG.maxPages * ENTRIES_PER_PAGE_LIMIT

let workersConfigured = false

/**
 * zip.js spins up its own workers for inflation. That keeps decompression off
 * the main thread for free, but the default build creates them from blob URLs,
 * which a strict `worker-src` CSP will reject. We therefore probe once and fall
 * back to synchronous inflation rather than failing to open the file at all.
 */
function configureWorkers(useWebWorkers: boolean) {
  configure({ useWebWorkers })
  workersConfigured = true
}

/**
 * Thrown by {@link BoundedWriter} the moment an entry exceeds its budget.
 * Distinguishable from a genuine read error so callers can report it as a
 * size problem rather than corruption.
 */
export class EntryTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Entry exceeds ${limit} bytes`)
    this.name = 'EntryTooLargeError'
  }
}

/**
 * A Uint8ArrayWriter that refuses to grow past a limit.
 *
 * This is the actual decompression-bomb guard for zip. Checking the size
 * *after* `getData()` resolves is too late: by then the whole entry has been
 * inflated into memory, limit or no limit. Throwing from `writeUint8Array`
 * aborts the inflate stream at the first chunk that crosses the line.
 */
class BoundedWriter extends Uint8ArrayWriter {
  private written = 0
  /**
   * Set when the limit tripped. Callers read this rather than inspecting the
   * rejection, because zip.js does not promise to hand back the error a
   * writer throws unchanged.
   */
  exceeded = false

  constructor(private readonly limit: number) {
    super()
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    this.written += array.byteLength
    if (this.written > this.limit) {
      this.exceeded = true
      throw new EntryTooLargeError(this.limit)
    }
    await super.writeUint8Array(array)
  }
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {}
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries())
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return headers as Record<string, string>
}

export function canSpawnBlobWorker(): boolean {
  if (typeof Worker === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false
  }
  let url: string | undefined
  try {
    url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.terminate()
    return true
  } catch {
    return false
  } finally {
    if (url) {
      URL.revokeObjectURL(url)
    }
  }
}

export interface ZipAdapterOptions {
  /** Forced off in environments where blob workers are blocked. */
  useWebWorkers?: boolean
  /** Per-entry inflate ceiling. Enforced mid-stream, not after the fact. */
  maxEntryBytes?: number
  /**
   * Ceiling on directory entries. A zip can declare tens of millions of
   * entries in a small file, and each one becomes an object; the count has
   * to be bounded while the directory is read, not after.
   */
  maxEntries?: number
  /**
   * For a password-protected zip. Without the right one such a zip is
   * refused with `encrypted`.
   *
   * It is handed to the zip.js reader, which holds it for as long as the
   * comic is open, since every page read needs it. It lives there and
   * nowhere else: not in the reading position, not in storage, and it goes
   * when the reader does.
   */
  password?: string
  signal?: AbortSignal
}

/** True when zip.js failed with one of these messages, whichever way it wraps the fact. */
function failedWith(error: unknown, messages: readonly string[]): boolean {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 4; depth++) {
    if (messages.includes(cause.message)) {
      return true
    }
    cause = cause.cause
  }
  return false
}

/**
 * What reading an encrypted entry with the wrong password can end in: the
 * entry's check value turns it away, or it gets past that and what it
 * decrypts to is noise, which fails as bad compressed data, a wrong length,
 * a wrong checksum or (AES) a wrong signature. A damaged entry ends the same
 * ways, which is why this only counts against the password until the
 * password has been proved; see `passwordProven`.
 */
const WRONG_PASSWORD_SIGNS = [
  ERR_INVALID_PASSWORD,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_INVALID_CRC32,
  ERR_INVALID_AUTHENTICATION_CODE
]

/**
 * How many entries the password is checked against, at most, when the
 * archive is opened. zip's check value is short (one byte for the old
 * scheme, two for AES), so a single entry lets one wrong password in 256
 * through. Asking three, and going with the majority, makes that rarer and
 * lets one damaged entry be outvoted.
 */
const PASSWORD_SAMPLE = 3
/**
 * How many bytes of check value have to have matched before the password
 * counts as proved without decoding anything: three entries of the old
 * scheme, or two AES ones. Fewer, and a wrong password could pass for
 * proved, after which its unreadable pages would be blamed on the pages.
 */
const PROOF_BYTES = 3

/** What a password check that could not be made at all is reported as. */
function passwordCheckError(error: unknown): ComicReaderError {
  if (failedWith(error, [ERR_UNSUPPORTED_ENCRYPTION])) {
    return new ComicReaderError(
      'corrupt',
      'This comic uses a kind of zip encryption this reader cannot open.',
      error
    )
  }
  return new ComicReaderError(
    'network',
    'The comic could not be fetched while checking the password.',
    error
  )
}

export class ZipAdapter implements ArchiveAdapter {
  readonly format = 'cbz' as const
  /** The central directory lists every member, so nothing can go missing. */
  readonly dropped: null = null

  private constructor(
    private readonly reader: ZipReader<unknown>,
    private readonly entries: Entry[],
    /**
     * Per-instance, not static. As a static it was set by whichever open()
     * ran first and then applied to every archive opened afterwards, so a
     * limit intended for one file silently governed the next.
     */
    private readonly maxEntryBytes: number,
    /**
     * Whether the password is known to be right. It is from the start when
     * enough entries accepted it at open (see PROOF_BYTES), and failing
     * that open() decodes one to find out. So it is only still false after
     * open() when nothing could be checked or decoded then. It then becomes
     * true once an
     * encrypted entry has decoded cleanly, which only the right password
     * does: the entry's checksum, or for AES its signature, has to match.
     * (zip.js only compares the checksum when asked to; see `decode`.)
     *
     * Until then an encrypted entry that fails to decode counts against the
     * password, and the reader asks again. After it, the same failure is
     * that entry's: it is damaged, or was protected with another password.
     */
    private passwordProven: boolean
  ) {}

  /**
   * Whether any entry is encrypted with AES, and not with zip's old
   * scheme. openArchive.ts asks, because the old one is the only
   * encryption libarchive can undo.
   */
  hasAesEntries(): boolean {
    return this.entries.some((entry) => entry.encrypted && (entry as FileEntry).zipCrypto !== true)
  }

  /**
   * The encrypted entries, by name, with the checksum the directory records
   * for each: for the same hand-over, since libarchive does not compare it.
   */
  encryptedEntryChecksums(): Map<string, number | undefined> {
    const checksums = new Map<string, number | undefined>()
    for (const entry of this.entries) {
      if (!entry.encrypted) {
        continue
      }
      // Named as libarchive names it: forward slashes, no leading one.
      const name = entry.filename.replace(/\\/g, '/').replace(/^\/+/, '')
      const { crc32, signature } = entry as Entry & { crc32?: number; signature?: number }
      const checksum = crc32 ?? signature
      // Two entries of one name: which of them a read returns is the
      // decoder's choice, so there is no checksum to hold it to.
      checksums.set(name, checksums.has(name) || checksum === undefined ? undefined : checksum >>> 0)
    }
    return checksums
  }

  /**
   * Reads one entry. An encrypted one is read with its checksum compared,
   * which zip.js otherwise leaves out: without it a wrong password that
   * got past the old zip scheme's one-byte check would "decode" a stored
   * entry to noise, and that would count as proof the password was right.
   */
  private async decode(entry: FileEntry, writer: Uint8ArrayWriter): Promise<Uint8Array> {
    const data = await entry.getData<Uint8Array>(
      writer,
      entry.encrypted ? { checkCrc32: true } : undefined
    )
    // (An empty entry decodes under any password, and proves nothing.)
    if (entry.encrypted && data.byteLength > 0) {
      this.passwordProven = true
    }
    return data
  }

  /** Entry indices whose compression method zip.js cannot decode. */
  unsupportedEntries(): Set<number> {
    const unsupported = new Set<number>()
    this.entries.forEach((entry, index) => {
      if (entry.directory) {
        return
      }
      if (!isDecodable(entry)) {
        unsupported.add(index)
      }
    })
    return unsupported
  }

  static async open(source: ArchiveSource, options: ZipAdapterOptions = {}): Promise<ZipAdapter> {
    // canSpawnBlobWorker() spins up a throwaway worker, so it must only run
    // the first time rather than on every archive open.
    if (!workersConfigured) {
      configureWorkers(options.useWebWorkers ?? canSpawnBlobWorker())
    }

    let backing: Reader<unknown>
    if (source.kind === 'range') {
      backing = new HttpReader(source.url, {
        // Always read by range. The probe in source.ts already proved the
        // server answers 206; the plain range mode additionally insists on an
        // `Accept-Ranges` response header, which a cross-origin DAV endpoint
        // often does not expose to scripts, and would refuse to open a file
        // it could read.
        forceRangeRequests: true,
        // Headers are resolved per request, so a session token refreshed mid
        // book is picked up by the next page read rather than failing it.
        // zip.js's own headers (Range in particular) go last so nothing in
        // the session headers can ever displace them.
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...source.getHeaders(), ...headersToRecord(init?.headers) }
          })
      }) as unknown as Reader<unknown>
    } else {
      backing = new BlobReader(source.data) as unknown as Reader<unknown>
    }

    // An empty password is no password. Given to the reader, it applies to
    // every entry read from it.
    const password = options.password || undefined
    const reader = new ZipReader(backing, { signal: options.signal, password })
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    const entries: Entry[] = []
    try {
      for await (const entry of reader.getEntriesGenerator()) {
        if (entries.length >= maxEntries) {
          throw new ComicReaderError(
            'too-many-pages',
            `This archive lists more than ${maxEntries} entries, more than this reader will open.`
          )
        }
        entries.push(entry)
      }
    } catch (error) {
      await reader.close().catch(() => {})
      if (error instanceof ComicReaderError) {
        throw error
      }
      // On a range source the same URL answered the probe moments ago, so a
      // failure here is far more likely a dropped connection or an expired
      // token than a damaged file. Say so; "corrupt" points at the wrong fix.
      if (source.kind === 'range') {
        throw new ComicReaderError(
          'network',
          'The comic could not be fetched while reading its contents.',
          error
        )
      }
      throw new ComicReaderError(
        'corrupt',
        'The zip directory of this comic could not be read.',
        error
      )
    }

    const encryptedFiles = entries
      .map(asFileEntry)
      .filter((entry): entry is FileEntry => entry !== null && entry.encrypted)
    const accepted: FileEntry[] = []
    let refused = 0
    let matchedBytes = 0
    try {
      if (encryptedFiles.length > 0 && password === undefined) {
        throw encryptedError()
      }
      // The password is checked before anything is shown. zip keeps a short
      // check value per entry for this, so each check costs a small read and
      // no decoding. It needs entries zip.js can decode: asked about one in
      // a compression method it lacks, it refuses before looking at the
      // password.
      // And entries with contents: an empty one has nothing encrypted in
      // it, and accepts any password.
      const checkable = encryptedFiles.filter(
        (entry) => isDecodable(entry) && (entry.uncompressedSize ?? 0) > 0
      )
      for (const entry of checkable.slice(0, PASSWORD_SAMPLE)) {
        try {
          await entry.getData(new Uint8ArrayWriter(), { checkPasswordOnly: true })
          accepted.push(entry)
          matchedBytes += entry.zipCrypto ? 1 : 2
        } catch (error) {
          if (failedWith(error, [ERR_INVALID_PASSWORD])) {
            refused++
          } else if (failedWith(error, [ERR_UNSUPPORTED_ENCRYPTION]) || source.kind === 'range') {
            throw passwordCheckError(error)
          }
          // Otherwise this entry is damaged where the check looks. That
          // says nothing about the password; the entry will show as an
          // unreadable page, as it would in a comic without a password.
        }
        // Settled either way; another entry could not change the outcome.
        if (matchedBytes >= PROOF_BYTES || refused >= 2) {
          break
        }
      }
      // Refused by more of the entries asked than accepted it: a wrong
      // password.
      if (refused > accepted.length) {
        throw encryptedError()
      }
    } catch (error) {
      await reader.close().catch(() => {})
      throw error
    }

    const adapter = new ZipAdapter(
      reader,
      entries,
      options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      matchedBytes >= PROOF_BYTES
    )
    if (!adapter.passwordProven && accepted.length > 0) {
      // Too few check bytes matched to be sure (a comic of one or two
      // pages, or one entry turned the password away). Settle it now, by
      // decoding an entry that accepted the password: left for the first
      // page read, a right password with one bad page could be asked for
      // again for ever, and a wrong one could get in.
      if (!(await adapter.proveByDecoding(accepted))) {
        await adapter.close()
        throw encryptedError()
      }
    }
    return adapter
  }

  /**
   * Decodes entries that accepted the password until one comes out whole,
   * which proves it. Resolves to false when every one of them fails the way
   * a wrong password fails. Anything else (an entry over the size limit, a
   * read that failed) leaves the question open for that entry; if it is
   * still open at the end, the answer is true and the first page read
   * decides.
   */
  private async proveByDecoding(candidates: FileEntry[]): Promise<boolean> {
    let open = false
    for (const entry of candidates) {
      const writer = new BoundedWriter(this.maxEntryBytes)
      try {
        await this.decode(entry, writer)
        return true
      } catch (error) {
        if (writer.exceeded || !failedWith(error, WRONG_PASSWORD_SIGNS)) {
          open = true
        }
      }
    }
    return open
  }

  /** Whether the password is known to be right; passed on at a hand-over. */
  isPasswordProven(): boolean {
    return this.passwordProven
  }

  listEntries(): ArchiveEntry[] {
    return this.entries.map((entry, index) => ({
      index,
      name: entry.filename,
      size: entry.uncompressedSize ?? 0,
      isDirectory: Boolean(entry.directory)
    }))
  }

  async readEntry(index: number): Promise<Blob> {
    const entry = asFileEntry(this.entries[index])
    if (!entry) {
      throw new ComicReaderError('corrupt', `Page ${index} is missing from the archive.`)
    }
    if (this.unsupportedEntries().has(index)) {
      // Not something a second attempt can change.
      throw new ComicReaderError(
        'page-unavailable',
        `Page "${entry.filename}" uses a compression method this reader cannot decode.`
      )
    }
    const writer = new BoundedWriter(this.maxEntryBytes)
    try {
      return new Blob([(await this.decode(entry, writer)) as BlobPart])
    } catch (error) {
      if (writer.exceeded || error instanceof EntryTooLargeError) {
        throw new ComicReaderError(
          'page-too-large',
          `Page "${entry.filename}" is unusually large and was skipped.`,
          error
        )
      }
      if (entry.encrypted && !this.passwordProven && failedWith(error, WRONG_PASSWORD_SIGNS)) {
        // Wrong all along; it only got past the short check made at open.
        // That is a fact about the comic, not this page, so it is reported
        // as one and the reader asks again. See `passwordProven`.
        throw encryptedError(error)
      }
      throw new ComicReaderError('corrupt', `Page "${entry.filename}" could not be read.`, error)
    }
  }

  /** Metadata reads share the same bounded path as pages. */
  async readText(name: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
    const match = findEntryByName(this.listEntries(), name)
    if (!match) {
      return null
    }
    const entry = asFileEntry(this.entries[match.index])
    if (!entry) {
      return null
    }
    try {
      return new TextDecoder('utf-8').decode(await this.decode(entry, new BoundedWriter(maxBytes)))
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    await this.reader.close().catch(() => {})
  }
}

/** Releases zip.js's shared worker pool; called when the app unmounts. */
export async function shutdownZipWorkers(): Promise<void> {
  try {
    await terminateWorkers()
  } catch {
    // Nothing useful to do if the pool is already gone.
  }
}
