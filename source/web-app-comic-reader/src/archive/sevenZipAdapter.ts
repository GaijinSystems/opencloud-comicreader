import { ComicReaderError, encryptedError, type ArchiveAdapter } from './types'
import { UnarrAdapter, type UnarrAdapterOptions, type UnarrWorker } from './unarrAdapter'
import { resolveVendorAssetUrl } from '../helpers/assetUrl'
import { runWorkerRequest, type WorkerLike } from './workerRequest'

/**
 * The sevenzip module's two jobs, both to do with passwords.
 *
 * It decodes password-protected 7z, the one thing libarchive cannot do with
 * a 7z archive: it recognises the encryption and stops there.
 *
 * The decoder is 7-Zip's own 7z reader (LGPL-2.1-or-later), compiled to
 * WebAssembly from `native/sevenzip/` and shipped in `public/vendor/sevenzip/`.
 * It is used for nothing else. A 7z archive without a password is still read
 * by libarchive, page by page; this one decodes the whole archive in one
 * pass, in its own worker, exactly as the unarr back end does for solid RAR,
 * and so it runs on that adapter's machinery.
 *
 * And it decrypts, without decoding, the two kinds of archive the reader's
 * decoders can decompress and not decrypt: RAR, and zip with AES in a
 * compression method zip.js lacks. What comes back is the same archive
 * without the encryption, for those decoders to read; see `decryptArchive`.
 */

function createWorker(): unknown {
  return new Worker(resolveVendorAssetUrl('sevenzip/sevenzip-worker.mjs'), {
    type: 'module',
    name: 'comic-reader-sevenzip'
  })
}

export type SevenZipOptions = Pick<
  UnarrAdapterOptions,
  'maxEntryBytes' | 'maxEntries' | 'maxRetainedBytes' | 'signal'
> & { password: string }

/**
 * Decodes a password-protected 7z archive.
 *
 * Resolves to null when the decoder could not start or gave up. Rejects with
 * `encrypted` when the archive does not open with this password. 7z cannot
 * tell a wrong password from damaged data, so that covers both.
 */
export function openSevenZip(archive: Blob, options: SevenZipOptions): Promise<ArchiveAdapter | null> {
  return UnarrAdapter.open(archive, {
    ...options,
    format: 'cb7',
    label: '7-Zip',
    createWorker: createWorker as () => UnarrWorker
  })
}

/** The worker's answer; DecryptResult in public/vendor/sevenzip/decrypt-common.mjs. */
interface DecryptedMessage {
  type: 'decrypted'
  status: 'decrypted' | 'not-encrypted' | 'wrong-password' | 'unsupported'
  archive?: Blob
  proven?: boolean
  unchecked?: boolean
  encryptedEntries?: Decrypted['encryptedEntries']
  reason?: string
}

/** What the worker said about the archive's files, if it has the shape it should. */
function wellFormed(entries: Decrypted['encryptedEntries']): Decrypted['encryptedEntries'] {
  return entries &&
    Number.isInteger(entries.of) &&
    Array.isArray(entries.at) &&
    Array.isArray(entries.mismatched)
    ? entries
    : undefined
}

/** The slice of the Worker interface the decryption uses; lets tests fake one. */
export type DecryptWorker = WorkerLike<DecryptedMessage>

export interface Decrypted {
  /** The archive without its encryption; null when it had none to remove. */
  archive: Blob | null
  /**
   * Whether something in the archive confirmed the password. When false
   * (RAR before version 5 keeps nothing to check a password by, unless its
   * headers are encrypted or an entry is stored) a wrong password shows
   * only when the entries are decompressed.
   */
  proven: boolean
  /**
   * For a zip: some entries are written without the checksum of their
   * data, which the archive never held (its authentication codes, checked
   * while decrypting, stood in for them).
   */
  unchecked: boolean
  /**
   * For a RAR: how many files the archive holds, counted as a decoder
   * lists them, and which of them (by position in that list) were
   * encrypted. A wrong password that nothing confirmed or caught shows in
   * those entries and in no others. `mismatched` are the stored ones that
   * did not match their checksum once decrypted: failures already, without
   * being read.
   */
  encryptedEntries?: { of: number; at: number[]; mismatched: number[] }
}

export interface DecryptOptions {
  format: 'rar' | 'zip'
  password: string
  signal?: AbortSignal
  /** Test seam. Defaults to the worker shipped in `public/vendor/sevenzip/`. */
  createWorker?: () => DecryptWorker
  inactivityTimeoutMs?: number
  deadlineMs?: number
}

/**
 * Decrypts a RAR archive, or the AES entries of a zip, with this password.
 *
 * Rejects with `encrypted` when the archive's own checks say the password
 * is wrong, with `corrupt` when the archive uses encryption this cannot
 * undo (RAR's ciphers from before version 2, archives in several volumes)
 * or the worker fails, and with the signal's reason on an abort.
 */
export async function decryptArchive(archive: Blob, options: DecryptOptions): Promise<Decrypted> {
  options.signal?.throwIfAborted()
  const failed = (cause: unknown) =>
    new ComicReaderError('corrupt', 'This comic could not be unlocked: its decoder failed.', cause)

  let worker: DecryptWorker
  try {
    worker = (options.createWorker ?? (createWorker as () => DecryptWorker))()
  } catch (error) {
    throw failed(error)
  }
  return runWorkerRequest<DecryptedMessage, Decrypted>(
    worker,
    { type: 'decrypt', archive, format: options.format, password: options.password },
    {
      archiveBytes: archive.size,
      signal: options.signal,
      inactivityTimeoutMs: options.inactivityTimeoutMs,
      deadlineMs: options.deadlineMs,
      onFailure: (reason) => {
        throw failed(reason)
      },
      onAnswer: (message) => {
        if (message.status === 'wrong-password') {
          throw encryptedError()
        }
        if (message.status === 'unsupported') {
          throw new ComicReaderError(
            'corrupt',
            'This comic is encrypted in a way this reader cannot undo' +
              (message.reason ? ` (${message.reason})` : '') +
              '. Download it to read it in a desktop comic reader.'
          )
        }
        if (message.type === 'decrypted' && message.status === 'decrypted' && message.archive) {
          return {
            archive: message.archive,
            proven: message.proven ?? false,
            unchecked: message.unchecked ?? false,
            encryptedEntries: wellFormed(message.encryptedEntries)
          }
        }
        if (message.type === 'decrypted' && message.status === 'not-encrypted') {
          return { archive: null, proven: true, unchecked: false }
        }
        // Anything else is not an answer to this request.
        throw failed('the decoder gave an answer that makes no sense')
      }
    }
  )
}
