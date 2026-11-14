import {
  ComicReaderError,
  encryptedError,
  type ArchiveAdapter,
  type ArchiveEntry,
  type ComicFormat,
  type DroppedEntries
} from './types'
import { PAGE_EXTENSIONS, findEntryByName } from './pageSort'
import { COMIC_INFO_FILE } from './comicInfo'
import { resolveVendorAssetUrl } from '../helpers/assetUrl'
import { EXPANSION_LIMIT, MAX_TEXT_BYTES } from '../config'
import { runWorkerRequest, type WorkerLike } from './workerRequest'

/**
 * Second back end for RAR4, for the archives libarchive cannot read.
 *
 * libarchive declines solid RAR4: it enumerates the first entry of a solid
 * block and stops. unarr (LGPL-3.0, derived from The Unarchiver) reads those
 * archives in full. It does not read RAR5, which libarchive handles, so the
 * two are complementary.
 *
 * The decoder runs in its own worker, shipped in `public/vendor/unarr/`. A
 * solid archive can only be read front to back, so the worker decodes the
 * whole thing in one pass and hands every page over at the end; there is no
 * cheaper per-page path to preserve. Running it off the main thread keeps the
 * tab responsive meanwhile and, as important, lets a decode that has stopped
 * making progress be cancelled by terminating the worker.
 *
 * The same machinery drives the 7-Zip worker that reads password-protected
 * 7z archives (see sevenZipAdapter.ts): it speaks the same messages, with a
 * password going in and, when that is missing or wrong, a word saying so
 * coming back.
 */

/** The limits object of public/vendor/unarr/unarr-extract.mjs. Change them together. */
export interface ExtractLimits {
  maxEntryBytes: number
  maxEntries: number
  maxTotalBytes: number
  maxRetainedBytes: number
  solid: boolean
  keepExtensions: string[]
  keepNames: string[]
  /** The archive was encrypted and has been decrypted; see cr_entry_finish in native/unarr/glue.c. */
  decrypted?: boolean
}

/** One archive member as the worker reports it. */
export interface ExtractedEntry<Data = Blob> {
  name: string
  size: number
  /**
   * Present only for kept entries that decoded cleanly. A Blob the worker
   * created, so the page's bytes are shared rather than copied across.
   */
  data?: Data
  /**
   * Whether the entry decoded, kept or not; false when it was damaged.
   * Absent when it was not tried, and from a decoder that does not say.
   */
  decoded?: boolean
}

/** The worker's answer. */
interface DoneMessage {
  type: 'done'
  supported: boolean
  truncated: boolean
  entries: ExtractedEntry[]
  /** Only from a decoder that takes a password: it had none, or a wrong one. */
  password?: 'needed' | 'wrong'
}

/** The slice of the Worker interface this adapter uses; lets tests fake one. */
export type UnarrWorker = WorkerLike<DoneMessage>

export interface UnarrAdapterOptions {
  /** Per-entry ceiling; larger entries are listed but come back unreadable. */
  maxEntryBytes: number
  /** Ceiling on entries listed. */
  maxEntries: number
  /**
   * Ceiling on the pages kept, in bytes. Everything kept stays in memory for
   * as long as the comic is open, outside the page cache's eviction, so it
   * needs its own bound. Never applied below the archive's own size, which is
   * about what a real comic's pages add up to.
   */
  maxRetainedBytes: number
  /**
   * Whether the container is solid; decides how unarr handles a damaged
   * entry. Not something the 7-Zip decoder is told. Defaults to false.
   */
  solid?: boolean
  /**
   * File entries the container's headers declare, for spotting a short
   * listing. Defaults to 0, which is "not known": nothing is reported short.
   */
  declaredEntryCount?: number
  signal?: AbortSignal
  /**
   * The archive was encrypted and has been decrypted (sevenZipAdapter.ts),
   * which leaves padding after each entry's data that unarr has to be told
   * to step over.
   */
  decrypted?: boolean
  /** The container the worker reads. Defaults to RAR. */
  format?: ComicFormat
  /** Handed to the worker as is; only the 7-Zip worker looks at it. */
  password?: string
  /** Names the decoder in console warnings. Defaults to unarr. */
  label?: string
  /**
   * Defaults to the worker shipped in `public/vendor/unarr/`. The 7-Zip
   * adapter passes its own, and tests pass a fake.
   */
  createWorker?: () => UnarrWorker
  inactivityTimeoutMs?: number
  deadlineMs?: number
}

function createDefaultWorker(): UnarrWorker {
  return new Worker(resolveVendorAssetUrl('unarr/unarr-worker.mjs'), {
    type: 'module',
    name: 'comic-reader-unarr'
  }) as UnarrWorker
}

export class UnarrAdapter implements ArchiveAdapter {
  /**
   * Entries the container's headers declare that the pass never listed: it
   * stopped at the entry limit, or gave up on a header it could not parse.
   * unarr reads solid RAR4, so a short listing is never about that. Entries
   * it did list but could not decode are not counted here; they show as
   * unreadable pages instead.
   */
  readonly dropped: DroppedEntries | null

  private constructor(
    private entries: ExtractedEntry[],
    declaredEntryCount: number,
    readonly format: ComicFormat
  ) {
    const count = declaredEntryCount - entries.length
    this.dropped = count > 0 ? { count, because: 'incomplete' } : null
  }

  /**
   * Decodes the archive, or resolves to null when the decoder cannot help:
   * the worker could not start, the container is not one it reads, or
   * decoding stalled. Never rejects for those, so a caller with another back
   * end to fall back on can use it. It rejects for two things the caller has
   * to act on: an abort, and a decoder saying the archive needs a password,
   * or a different one from the one it was given (`encrypted`).
   */
  static async open(archive: Blob, options: UnarrAdapterOptions): Promise<UnarrAdapter | null> {
    const { signal, label = 'unarr' } = options
    signal?.throwIfAborted()

    let worker: UnarrWorker
    try {
      worker = (options.createWorker ?? createDefaultWorker)()
    } catch (error) {
      console.warn(`[comic-reader] could not start the ${label} worker:`, error)
      return null
    }

    const limits: ExtractLimits = {
      maxEntryBytes: options.maxEntryBytes,
      maxEntries: options.maxEntries,
      maxTotalBytes: archive.size * EXPANSION_LIMIT,
      maxRetainedBytes: Math.max(archive.size, options.maxRetainedBytes),
      solid: options.solid ?? false,
      decrypted: options.decrypted ?? false,
      keepExtensions: PAGE_EXTENSIONS,
      keepNames: [COMIC_INFO_FILE.toLowerCase()]
    }
    const entries = await runWorkerRequest<DoneMessage, ExtractedEntry[] | null>(
      worker,
      { type: 'extract', archive, limits, password: options.password },
      {
        archiveBytes: archive.size,
        signal,
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        deadlineMs: options.deadlineMs,
        onFailure: (reason) => {
          console.warn(`[comic-reader] ${label} back end gave up: ${reason}`)
          return null
        },
        onAnswer: (message) => {
          if (message.password) {
            // No password, or not the right one: the caller knows which.
            throw encryptedError()
          }
          if (!message.supported) {
            // Not a container this decoder reads (RAR5, for unarr).
            // Expected, not a fault.
            return null
          }
          if (message.truncated) {
            console.warn(`[comic-reader] ${label} stopped before the end of the archive`)
          }
          return message.entries
        }
      }
    )

    // An empty listing is no better than no answer: let the caller fall
    // back to its other decoder, and to that decoder's error if it has one.
    return entries?.length
      ? new UnarrAdapter(entries, options.declaredEntryCount ?? 0, options.format ?? 'cbr')
      : null
  }

  unsupportedEntries(): ReadonlySet<number> {
    return new Set()
  }

  decodeOutcomes(): ReadonlyArray<boolean | undefined> {
    return this.entries.map((entry) => entry.decoded)
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
    if (!entry.data) {
      // Everything was decoded in one pass, so what is missing now stays
      // missing: over the size cap, past the decode budget, or damaged.
      throw new ComicReaderError('page-unavailable', `Page "${entry.name}" could not be read.`)
    }
    return entry.data
  }

  async readText(name: string, maxBytes = MAX_TEXT_BYTES): Promise<string | null> {
    const match = findEntryByName(this.listEntries(), name)
    const data = match ? this.entries[match.index]?.data : undefined
    if (!data || data.size > maxBytes) {
      return null
    }
    return data.text()
  }

  async close(): Promise<void> {
    this.entries = []
  }
}
