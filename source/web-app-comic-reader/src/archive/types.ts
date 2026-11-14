/**
 * Format-agnostic contract between the reader UI and the archive back ends.
 *
 * The UI never imports zip.js or libarchive.js directly. It only ever sees
 * `ComicPage` descriptors and `Blob` bodies, which keeps the format zoo
 * isolated behind one small, testable interface.
 */

export type ComicFormat = 'cbz' | 'cbr' | 'cb7'

/** File extensions this app registers for, mapped onto the container format. */
export const COMIC_EXTENSIONS: Record<string, ComicFormat> = {
  cbz: 'cbz',
  cbr: 'cbr',
  cb7: 'cb7',
  c7z: 'cb7'
}

/** A single member of the container, before any comic-specific filtering. */
export interface ArchiveEntry {
  /** Stable handle for `readEntry`. Opaque; not necessarily the on-disk order. */
  index: number
  /** Full path inside the archive, e.g. `Chapter 1/page02.jpg`. */
  name: string
  /** Uncompressed size in bytes, or 0 when the container does not record it. */
  size: number
  isDirectory: boolean
}

/** A page: an archive entry that survived filtering, in reading order. */
export interface ComicPage {
  /** Position in reading order, 0-based. */
  index: number
  /** Handle to pass back to `ArchiveAdapter.readEntry`. */
  entryIndex: number
  name: string
  size: number
  mimeType: string
}

export interface ArchiveOpenProgress {
  loadedBytes: number
  totalBytes?: number
  phase: 'downloading' | 'parsing'
}

/**
 * Where the archive bytes come from.
 *
 * `range` lets the zip back end pull only the bytes it needs over HTTP, which
 * is why a 500 MB CBZ can show its first page without a full download. The
 * other back ends need the whole file, so they always get a `blob`.
 *
 * A Blob rather than an ArrayBuffer because the browser keeps a Blob's bytes
 * outside the JavaScript heap, and it can be wrapped in a File or posted to a
 * worker by reference. Held as an ArrayBuffer, a large archive was copied in
 * full on this thread once while downloading and again for each decoder.
 * (A decoder still makes its own working copy inside its worker.)
 */
export type ArchiveSource =
  | { kind: 'range'; url: string; getHeaders: () => Record<string, string> }
  | { kind: 'blob'; data: Blob; name: string }

/** Something the reader can open but only partially render. */
export interface ArchiveWarning {
  code: 'dropped-entries' | 'unsupported-compression'
  /** Pages or entries affected. */
  count: number
}

export interface DroppedEntries {
  count: number
  because: 'solid-rar' | 'incomplete'
}

export interface ArchiveAdapter {
  readonly format: ComicFormat
  /**
   * Set when the container declares entries this back end did not list.
   * `because` says why, since the two cases need different words to the
   * user: `solid-rar` when the decoder cannot read this kind of archive
   * (solid RAR4, through libarchive), `incomplete` when the archive could not
   * be listed to its end (damaged, cut short, or over the entry limit).
   */
  readonly dropped: DroppedEntries | null
  /**
   * Entry indices this back end lists but cannot decode, e.g. zip members
   * using a compression method zip.js does not implement.
   */
  unsupportedEntries(): ReadonlySet<number>
  listEntries(): ArchiveEntry[]
  /**
   * For a back end that decodes the whole archive at once: how each entry
   * of `listEntries` came out, by index. True when it decoded (kept or
   * not), false when it was damaged, undefined when it was not tried (a
   * limit was reached before it). Asked when a password that nothing
   * confirmed has to be judged by what it decrypted to.
   */
  decodeOutcomes?(): ReadonlyArray<boolean | undefined>
  /**
   * The bytes of one member, as a Blob. Back ends that already hold a member
   * as one (libarchive hands back Files; the unarr worker posts Blobs) return
   * it as is, so the page cache can make a URL from it without another copy.
   */
  readEntry(index: number): Promise<Blob>
  /**
   * Convenience for small text members such as ComicInfo.xml. `maxBytes` is
   * enforced against the decoded length, not the size the archive declares.
   */
  readText(name: string, maxBytes?: number): Promise<string | null>
  close(): Promise<void>
}

/** Raised for every failure the UI is expected to render as a friendly state. */
export class ComicReaderError extends Error {
  constructor(
    public readonly code:
      | 'unsupported-format'
      | 'unsupported-compression'
      | 'too-large'
      // Password protected, and this reader cannot unlock it (RAR).
      | 'encrypted'
      // Password protected, and it can: ask for the password, or ask again.
      | 'password-required'
      | 'wrong-password'
      | 'corrupt'
      | 'no-pages'
      | 'solid-rar-unsupported'
      | 'too-many-pages'
      | 'page-too-large'
      // The back end has no data for this entry and never will: reading it
      // again cannot help. Distinct from `corrupt`, which may be transient.
      | 'page-unavailable'
      | 'network'
      | 'backend-unavailable',
    message: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = 'ComicReaderError'
  }
}

/**
 * True for the error a back end raises on finding the archive, or an entry
 * of it, encrypted: with no password, or with one that does not open it.
 * Back ends only ever say `encrypted`. What the reader does about it depends
 * on the format and on whether a password was tried, and is decided in one
 * place (`passwordErrorFor` in openArchive.ts).
 */
export function isEncryptedError(error: unknown): error is ComicReaderError {
  return error instanceof ComicReaderError && error.code === 'encrypted'
}

/**
 * The error every back end raises for that. The wording is never shown:
 * `passwordErrorFor` replaces it with a request for the password, or for
 * another one.
 */
export function encryptedError(cause?: unknown): ComicReaderError {
  return new ComicReaderError('encrypted', 'This comic is password protected.', cause)
}

/** True for the two errors the reader answers by asking for a password. */
export function isPasswordPrompt(error: unknown): error is ComicReaderError {
  return (
    error instanceof ComicReaderError &&
    (error.code === 'password-required' || error.code === 'wrong-password')
  )
}
