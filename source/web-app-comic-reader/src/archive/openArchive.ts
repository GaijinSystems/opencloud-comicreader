import {
  ComicReaderError,
  encryptedError,
  isEncryptedError,
  type ArchiveAdapter,
  type ArchiveOpenProgress,
  type ArchiveWarning,
  type ComicFormat,
  type ComicPage
} from './types'
import { ZipAdapter } from './zipAdapter'
import { LibArchiveAdapter, type LibArchiveAdapterOptions } from './libarchiveAdapter'
import { buildPageList, findEntryByName, mimeTypeForImage } from './pageSort'
import {
  COMIC_INFO_FILE,
  parseComicInfo,
  deletedPageIndices,
  doublePageIndices,
  type ComicInfo
} from './comicInfo'
import { inspectRar4, type Rar4Inspection } from './rar4'
import {
  downloadWhole,
  resolveArchiveSource,
  type ResolvedSource,
  type ResolveSourceOptions
} from './source'
import { checkWasmAllowed, WorkerTimeoutError } from '../helpers/wasm'
import { UnarrAdapter } from './unarrAdapter'
import { decryptArchive, openSevenZip, type Decrypted } from './sevenZipAdapter'
import { ENTRIES_PER_PAGE_LIMIT, EXPANSION_LIMIT, MAX_TEXT_BYTES, MB } from '../config'

export interface OpenComicOptions extends ResolveSourceOptions {
  rangeThresholdBytes: number
  maxDownloadBytes: number
  maxPages: number
  maxPageBytes: number
  enableJxl: boolean
  bulkExtractLimitMb: number
  onProgress?: (progress: ArchiveOpenProgress) => void
  onBulkExtractStart?: () => void
  onBulkExtractDone?: () => void
  /** For a password-protected comic. An empty one counts as none. */
  password?: string
  /**
   * What an earlier call resolved, to open the same comic again without
   * fetching it again. Both `OpenedComic` and `PasswordError` carry it, for
   * the second attempt that follows a password prompt.
   */
  resolved?: ResolvedSource
}

export interface OpenedComic {
  adapter: ArchiveAdapter
  pages: ComicPage[]
  info: ComicInfo | null
  /** Indices into `pages` that ComicInfo declares as double-page spreads. */
  widePages: Set<number>
  /**
   * Set when the comic opened but cannot be shown in full: entries the
   * container declares were never listed (see `ArchiveAdapter.dropped`), or
   * some pages use a compression method the back end cannot decode.
   */
  warning: ArchiveWarning | null
  /** Where the bytes came from; see `OpenComicOptions.resolved`. */
  resolved: ResolvedSource
  /**
   * Whether the password given has been checked against everything it
   * protects, so that no later page read can turn out to need another: the
   * comic was decrypted or decoded whole. False without a password, and for
   * a zip whose entries are decrypted as they are read.
   */
  passwordSettled: boolean
}

/**
 * The comic is password protected and this reader can unlock it: the cue to
 * ask for the password (`password-required`) or to ask again
 * (`wrong-password`). Carries the resolved source so that the next attempt
 * does not download the archive a second time.
 */
export class PasswordError extends ComicReaderError {
  constructor(
    code: 'password-required' | 'wrong-password',
    message: string,
    public readonly resolved: ResolvedSource | null
  ) {
    super(code, message)
    this.name = 'PasswordError'
  }
}

/**
 * What to tell the reader about an archive that turned out to be encrypted,
 * or not to open with the password it was given: the cue to ask for the
 * password, or to ask again. Every format can be unlocked: zip.js decrypts
 * zip, 7-Zip's reader decodes encrypted 7z, and RAR (and zip's AES in the
 * methods zip.js lacks) is decrypted first and then read as usual; see
 * sevenZipAdapter.ts.
 *
 * `resolved` is what the next attempt can start from without fetching the
 * comic again, or null when that has been let go.
 */
export function passwordErrorFor(
  resolved: ResolvedSource | null,
  triedPassword: boolean
): PasswordError {
  return triedPassword
    ? new PasswordError('wrong-password', 'That password did not open this comic.', resolved)
    : new PasswordError('password-required', 'This comic is password protected.', resolved)
}

/**
 * Opens a comic end to end: resolve bytes, pick a back end, read metadata,
 * and produce the ordered page list.
 *
 * Everything the UI needs comes back in one object, so the component never has
 * to know which back end it got.
 */
export async function openComic(options: OpenComicOptions): Promise<OpenedComic> {
  // Held in an object so that openResolved can replace it: a zip read by
  // range is downloaded whole when it is handed to libarchive, and the next
  // password attempt should start from that download, not make it again.
  const from = { resolved: options.resolved ?? (await resolveArchiveSource(options)) }
  const password = options.password || undefined
  try {
    return await openResolved(options, from, password)
  } catch (error) {
    const { resolved } = from
    // Back ends say `encrypted`, with or without a password; what that
    // means for the reader depends on which it was.
    if (isEncryptedError(error)) {
      throw passwordErrorFor(resolved, password !== undefined)
    }
    throw error
  }
}

async function openResolved(
  options: OpenComicOptions,
  from: { resolved: ResolvedSource },
  password: string | undefined
): Promise<OpenedComic> {
  let resolved = from.resolved
  options.onProgress?.({ phase: 'parsing', loadedBytes: 0 })

  let adapter: ArchiveAdapter
  /** See `OpenedComic.passwordSettled`. */
  let passwordSettled = false
  /** Why the zip→libarchive handover failed, if it did; informs the error. */
  let fallbackError: unknown = null

  /** Shared by every back end, so they agree on what is too much. */
  const limits = {
    maxEntryBytes: options.maxPageBytes,
    maxEntries: options.maxPages * ENTRIES_PER_PAGE_LIMIT
  }
  /** For the two decoders that read a whole archive in one pass. */
  const onePassOptions = {
    ...limits,
    // The same ceiling libarchive's one-pass unpack works under.
    maxRetainedBytes: options.bulkExtractLimitMb * MB * EXPANSION_LIMIT,
    signal: options.signal
  }
  const libarchiveOptions = (format: ComicFormat) => ({
    format,
    bulkExtractLimitMb: options.bulkExtractLimitMb,
    ...limits,
    onBulkExtractStart: options.onBulkExtractStart,
    onBulkExtractDone: options.onBulkExtractDone
  })

  if (resolved.format === 'cbz') {
    const zip = await ZipAdapter.open(resolved.source, {
      signal: options.signal,
      password,
      ...limits
    })
    adapter = zip

    // The two back ends turn out to be complementary. zip.js implements
    // stored, deflate and deflate64; libarchive implements stored, deflate,
    // bzip2, LZMA and PPMd but not deflate64. So a zip zip.js cannot read is
    // very likely one libarchive can, and handing it over turns an outright
    // failure into a comic that simply opens.
    const unsupported = zip.unsupportedEntries()
    const unsupportedPages = zip
      .listEntries()
      .filter((entry) => unsupported.has(entry.index) && mimeTypeForImage(entry.name))
    if (unsupportedPages.length > 0 && (await checkWasmAllowed())) {
      try {
        // libarchive has no partial-read story, so a streamed archive has to
        // be fetched in full before it can be handed over. The location and
        // the fact that it is a zip are already known, so this is one request
        // for the file and nothing else.
        if (resolved.source.kind === 'range') {
          const { url, getHeaders } = resolved.source
          const data = await downloadWhole(url, getHeaders(), {
            maxBytes: options.maxDownloadBytes,
            onProgress: options.onProgress,
            signal: options.signal
          })
          options.onProgress?.({ phase: 'parsing', loadedBytes: 0 })
          resolved = {
            format: resolved.format,
            source: { kind: 'blob', data, name: options.resource.name }
          }
        }
        // With a password there is the encryption to deal with as well.
        // libarchive undoes the old zip scheme itself, which needs no
        // cryptography library. It cannot undo AES, which does (the module
        // is built without one), so AES entries are decrypted first, and
        // what libarchive is handed is the zip without them encrypted.
        let handOver = resolved.source
        let passwordOptions: Partial<LibArchiveAdapterOptions> = {
          password,
          encryptedEntries: zip.encryptedEntryChecksums(),
          passwordProven: zip.isPasswordProven()
        }
        let settles = false
        if (password !== undefined && resolved.source.kind === 'blob' && zip.hasAesEntries()) {
          const decrypted = await decryptArchive(resolved.source.data, {
            format: 'zip',
            password,
            signal: options.signal
          })
          if (decrypted.archive) {
            handOver = { kind: 'blob', data: decrypted.archive, name: options.resource.name }
            // The authentication codes of the entries decrypted have been
            // checked, which proves the password, and stands in for the
            // checksums of the entries that have none.
            passwordOptions = { password, passwordProven: true, uncheckedZip: decrypted.unchecked }
            // Nothing read from here on can turn the password away. (An
            // entry left as it was shows as an unreadable page: an AES one
            // that did not authenticate, or one in the old scheme that
            // libarchive, decrypting it as it is read, cannot decrypt.)
            settles = true
          }
        }
        const fallback = await LibArchiveAdapter.open(handOver, {
          ...libarchiveOptions('cbz'),
          ...passwordOptions
        })
        if (password !== undefined) {
          // The download is kept for the next attempt, should this password
          // turn out wrong.
          from.resolved = resolved
        }
        // Only now is it safe to let go of the reader we know works.
        await zip.close().catch(() => {})
        adapter = fallback
        passwordSettled = settles
      } catch (error) {
        const refused = isEncryptedError(error)
        if ((error as Error)?.name === 'AbortError' || (refused && !zip.isPasswordProven())) {
          // Cancelled while fetching: there is no one left to open it for.
          // Or the password did not decrypt it, which is not a reason to
          // carry on with it.
          if (refused && password !== undefined) {
            // What was downloaded for the hand-over serves the next attempt.
            from.resolved = resolved
          }
          await zip.close().catch(() => {})
          throw error
        }
        // Carry on with zip.js. If it turns out no page is readable, this
        // error (e.g. the file being too large to buffer) is the honest one to
        // surface rather than a generic compression message.
        console.warn('[comic-reader] libarchive fallback for this zip failed:', error)
        // A password zip.js has already proved was not the trouble: an
        // entry that then fails its authentication is a damaged one.
        fallbackError = refused
          ? new ComicReaderError(
              'corrupt',
              'This comic is damaged: a page failed its integrity check after decryption.',
              error
            )
          : error
      }
    }
  } else if (resolved.source.kind !== 'blob') {
    // resolveArchiveSource only range-reads zips; anything else is whole.
    throw new ComicReaderError(
      'backend-unavailable',
      'This format has to be downloaded in full before it can be opened.'
    )
  } else if (resolved.format === 'cb7' && password !== undefined) {
    // A password is only ever supplied after libarchive has refused the
    // archive as encrypted, and 7-Zip's reader is what decrypts 7z.
    await requireWasm()
    const sevenZip = await openSevenZip(resolved.source.data, { ...onePassOptions, password })
    if (!sevenZip) {
      throw new ComicReaderError(
        'corrupt',
        'The decoder for password-protected 7z archives could not read this comic.'
      )
    }
    adapter = sevenZip
    passwordSettled = true
  } else {
    let source = resolved.source
    // With a password, a RAR is decrypted before anything reads it: neither
    // libarchive nor unarr decrypts RAR. What they are then given is the
    // same archive without the encryption.
    let decrypted = false
    let passwordProven = true
    /** Which entries of the decrypted archive were encrypted, where that is known. */
    let encryptedEntries: Decrypted['encryptedEntries']
    passwordSettled = password !== undefined
    if (resolved.format === 'cbr' && password !== undefined) {
      await requireWasm()
      const result = await decryptArchive(resolved.source.data, {
        format: 'rar',
        password,
        signal: options.signal
      })
      if (result.archive) {
        source = { kind: 'blob', data: result.archive, name: options.resource.name }
        decrypted = true
        passwordProven = result.proven
        encryptedEntries = result.encryptedEntries
      }
    }
    const archive = source.data
    // libarchive reads RAR5 and non-solid RAR4 in full. What it cannot read
    // is solid RAR4: it lists the first entry of a solid block and stops.
    // The container's own headers say which this is, cheaply, so the right
    // decoder is picked up front rather than discovered by failing.
    const rar4 = resolved.format === 'cbr' ? await inspectRar4(archive) : null
    if (rar4?.encrypted) {
      // Seen in the archive's own headers, before any decoder is started:
      // libarchive only looks at the first entry, and unarr lists the
      // entries and returns them all unreadable.
      throw encryptedError()
    }
    const openUnarr = async (declared: Rar4Inspection) =>
      (await checkWasmAllowed())
        ? UnarrAdapter.open(archive, {
            ...onePassOptions,
            solid: declared.solid,
            declaredEntryCount: declared.entryCount,
            decrypted
          })
        : null

    // A solid RAR4 goes to unarr, and so does any RAR4 that was decrypted:
    // unarr is the decoder that can be told about the padding decryption
    // leaves after each entry (see `decrypted` in unarrAdapter.ts).
    let chosen: ArchiveAdapter | null = null
    if (rar4 && (rar4.solid || decrypted)) {
      chosen = await openUnarr(rar4)
    }
    if (!chosen) {
      try {
        chosen = await LibArchiveAdapter.open(source, {
          ...libarchiveOptions(resolved.format),
          rar4
        })
      } catch (error) {
        // libarchive sometimes rejects a RAR4 outright. unarr reads RAR4
        // only, has already had its turn if the archive is solid, and has
        // nothing to offer for one libarchive found to be password protected
        // (encrypted headers, which the header walk above cannot see into).
        // (Nor a second turn at one that was decrypted, which went to it first.)
        chosen =
          rar4 && !rar4.solid && !decrypted && !isEncryptedError(error) ? await openUnarr(rar4) : null
        if (!chosen) {
          throw error
        }
      }
    }
    if (decrypted && !passwordProven) {
      // Nothing in the archive confirmed the password. If what it decrypted
      // to does not decode, it was wrong: with a wrong password that is noise.
      let reads: boolean
      try {
        reads = await unprovenPasswordHolds(chosen, options.enableJxl, encryptedEntries, options.signal)
      } catch (error) {
        await chosen.close().catch(() => {})
        throw error
      }
      if (!reads) {
        await chosen.close().catch(() => {})
        throw encryptedError()
      }
    }
    adapter = chosen
  }

  try {
    const entries = adapter.listEntries()

    // Metadata first: it can mark pages as deleted, which changes the page list.
    const info = await readComicInfo(adapter, entries)

    // ComicInfo addresses pages by position in the *unfiltered* image order,
    // so both the exclusion set and the double-page set have to be resolved
    // to entry names against a first pass before they mean anything.
    const unfiltered = buildPageList(entries, { enableJxl: options.enableJxl })
    const excludedNames = namesAt(unfiltered, deletedPageIndices(info))
    const pages = excludedNames.size
      ? buildPageList(entries, { enableJxl: options.enableJxl, excludedNames })
      : unfiltered
    const widePages = pageIndicesNamed(pages, namesAt(unfiltered, doublePageIndices(info)))

    if (!pages.length) {
      throw emptyArchiveError(adapter)
    }
    if (pages.length > options.maxPages) {
      throw new ComicReaderError(
        'too-many-pages',
        `This archive contains ${pages.length} pages, more than this reader will open.`
      )
    }

    return {
      adapter,
      pages,
      info,
      widePages,
      warning: resolveWarning(adapter, pages, fallbackError),
      resolved: from.resolved,
      passwordSettled
    }
  } catch (error) {
    await adapter.close().catch(() => {})
    throw error
  }
}

/**
 * An entry shorter than this matches its checksum under too many passwords
 * to prove one. (As MIN_BYTES_TO_CONFIRM in the decrypter, for the same reason.)
 */
const BYTES_THAT_SAY_ENOUGH = 4

/**
 * Whether what a password decrypted an archive to decodes, for the archives
 * that keep nothing to check a password by (RAR before version 5 with
 * compressed entries and plain headers; RAR5 written without a check
 * value). Decrypted with the wrong password their entries are noise, and
 * none decodes; with the right one, damage aside, they do. So the password
 * holds if any encrypted entry decodes, and is wrong if some were tried and
 * none did. Nothing to judge by is not a wrong password.
 *
 * Entries that never were encrypted (a cover, say) decode under any
 * password, and are left out where it is known which those are:
 * `encrypted` names entries by their place in the archive's list of files,
 * which is the adapter's list when the two are the same length. When they
 * are not (a decoder that lists differently, or stopped listing at a
 * limit), every entry is judged.
 *
 * unarr has decoded every entry by now and says how each came out, so for
 * RAR before 5 this reads nothing. libarchive reads a page at a time: its
 * pages are read until one does.
 */
async function unprovenPasswordHolds(
  adapter: ArchiveAdapter,
  enableJxl: boolean,
  encrypted: Decrypted['encryptedEntries'],
  signal?: AbortSignal
): Promise<boolean> {
  const entries = adapter.listEntries()
  const known = encrypted?.of === entries.length ? new Set(encrypted.at) : null
  const judged = (index: number) => !known || known.has(index)

  const outcomes = adapter.decodeOutcomes?.()
  if (outcomes) {
    let failed = false
    for (const entry of entries) {
      if (!judged(entry.index)) {
        continue
      }
      // (An entry of a few bytes decodes under too many passwords to count.)
      if (outcomes[entry.index] === true && entry.size >= BYTES_THAT_SAY_ENOUGH) {
        return true
      }
      failed ||= outcomes[entry.index] === false
    }
    return !failed
  }

  // Stored entries that did not match their checksum once decrypted:
  // failures already, and not worth a read to find that out again.
  const mismatched = new Set(known ? encrypted?.mismatched : [])
  let failed = mismatched.size > 0
  for (const page of buildPageList(entries, { enableJxl })) {
    if (!judged(page.entryIndex) || mismatched.has(page.entryIndex)) {
      continue
    }
    // (As above: a page of a few bytes reads under too many passwords.)
    if (page.size < BYTES_THAT_SAY_ENOUGH) {
      continue
    }
    signal?.throwIfAborted()
    try {
      await adapter.readEntry(page.entryIndex)
      return true
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof ComicReaderError && error.cause instanceof WorkerTimeoutError) {
        // A decoder that stopped answering says nothing about the password.
        throw error
      }
      // Nor does a page too large to show.
      failed ||= !(error instanceof ComicReaderError && error.code === 'page-too-large')
    }
  }
  return !failed
}

/** For the decoders that are WebAssembly and nothing else. */
async function requireWasm(): Promise<void> {
  if (!(await checkWasmAllowed())) {
    throw new ComicReaderError(
      'backend-unavailable',
      'This page is not allowed to run WebAssembly, which reading this comic needs.'
    )
  }
}

/**
 * Chooses the error for an archive that yielded no pages.
 *
 * A solid RAR typically leaves one non-image entry behind, so the naive
 * message would be "No pages found" — technically true and completely
 * misleading. Name the real cause instead.
 */
export function emptyArchiveError(adapter: ArchiveAdapter): ComicReaderError {
  if (adapter.dropped?.because === 'solid-rar') {
    return new ComicReaderError(
      'solid-rar-unsupported',
      'This is a solid RAR archive, which the decoder cannot read.'
    )
  }
  if (adapter.dropped?.because === 'incomplete') {
    // The decoder can read this kind of archive; this one stopped short.
    return new ComicReaderError(
      'corrupt',
      'This archive is damaged or incomplete: it could not be read far enough to find any pages.'
    )
  }
  return new ComicReaderError('no-pages', 'This archive does not contain any readable images.')
}

/**
 * Decides whether the comic can only be shown partially.
 *
 * A zip whose every page uses an unreadable compression method is a hard
 * failure: there is nothing to render, so an error naming the cause beats an
 * empty reader full of broken-page icons.
 */
export function resolveWarning(
  adapter: ArchiveAdapter,
  pages: ComicPage[],
  fallbackError: unknown = null
): ArchiveWarning | null {
  const unsupported = adapter.unsupportedEntries()
  const affected = pages.filter((page) => unsupported.has(page.entryIndex)).length
  if (affected > 0 && affected === pages.length) {
    // A specific reason the fallback could not run beats a generic one.
    if (fallbackError instanceof ComicReaderError) {
      throw fallbackError
    }
    throw new ComicReaderError(
      'unsupported-compression',
      'This comic uses a compression method the in-browser reader cannot decode.'
    )
  }
  if (affected > 0) {
    return { code: 'unsupported-compression', count: affected }
  }

  if (adapter.dropped) {
    return { code: 'dropped-entries', count: adapter.dropped.count }
  }

  return null
}

async function readComicInfo(
  adapter: ArchiveAdapter,
  entries: ReturnType<ArchiveAdapter['listEntries']>
): Promise<ComicInfo | null> {
  const entry = findEntryByName(entries, COMIC_INFO_FILE)
  if (!entry) {
    return null
  }
  // The declared size is attacker-controlled, so this is only a cheap early
  // exit; readText enforces the same cap on what is actually decoded.
  if (entry.size > MAX_TEXT_BYTES) {
    return null
  }
  try {
    const xml = await adapter.readText(COMIC_INFO_FILE, MAX_TEXT_BYTES)
    return xml ? parseComicInfo(xml) : null
  } catch (error) {
    // Metadata is a nicety; never let it block opening the comic. Unless
    // reading it is how we learn the archive is password protected, in which
    // case no page will read either and that is what the user needs to hear.
    if (isEncryptedError(error)) {
      throw error
    }
    return null
  }
}

/** Maps ComicInfo's positional page indices onto concrete entry names. */
export function namesAt(unfiltered: ComicPage[], indices: ReadonlySet<number>): Set<string> {
  const names = new Set<string>()
  indices.forEach((index) => {
    const page = unfiltered[index]
    if (page) {
      names.add(page.name)
    }
  })
  return names
}

/** The positions, in the final page list, of the pages with these names. */
export function pageIndicesNamed(pages: ComicPage[], names: ReadonlySet<string>): Set<number> {
  const indices = new Set<number>()
  pages.forEach((page) => {
    if (names.has(page.name)) {
      indices.add(page.index)
    }
  })
  return indices
}
