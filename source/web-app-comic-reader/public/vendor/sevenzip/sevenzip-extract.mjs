/*
 * Comic Reader — extraction loop over the 7-Zip 7z module.
 * Part of Comic Reader, AGPL-3.0-or-later. Not part of 7-Zip.
 *
 * Shipped as a plain module rather than bundled, so the worker beside it can
 * import it directly. scripts/verify-formats.mjs and the unit tests import the
 * same file, so what they exercise is what the reader runs.
 *
 * The limits, entries and hooks have the shapes documented in
 * ../unarr/unarr-extract.mjs, which src/archive/unarrAdapter.ts declares for
 * TypeScript; the result adds `password`. Change them together.
 *
 * Unlike that loop, this one does not copy the archive into the module's
 * memory: 7-Zip is given a source to read from, and asks for the parts it
 * wants. See sourceFromBlob and sourceFromBytes.
 */

/**
 * Where 7-Zip reads the archive from.
 *
 * @typedef {object} ByteSource
 * @property {number} size  The archive's length in bytes.
 * @property {(position: number, length: number) => Uint8Array} read
 *   The bytes from `position`, at most `length` of them and fewer only at
 *   the end of the archive. Synchronous: it is called from inside 7-Zip.
 *   What it returns may be reused by the next read.
 * @property {(position: number, length: number) => Uint8Array} peek
 *   As `read`, for a few bytes wanted on their own: nothing more is read
 *   than was asked for.
 * @property {(position: number, length: number) => Uint8Array | Blob} slice
 *   That stretch of the archive as something to put in a Blob, without
 *   reading it here if it need not be.
 */

/** How much of a Blob is read at a time, however little 7-Zip asks for. */
const READ_AHEAD_BYTES = 1024 * 1024

/**
 * An archive held in memory as bytes.
 * @param {Uint8Array} bytes
 * @returns {ByteSource}
 */
export function sourceFromBytes(bytes) {
  return {
    size: bytes.byteLength,
    read: (position, length) => bytes.subarray(position, position + length),
    peek: (position, length) => bytes.subarray(position, position + length),
    slice: (position, length) => bytes.subarray(position, position + length)
  }
}

/**
 * An archive in a Blob, read a window at a time as 7-Zip asks, so that it
 * is never held whole in this thread's memory. Needs FileReaderSync, which
 * workers have and pages do not; `canReadBlobsSynchronously` says whether
 * it is there.
 * @param {Blob} blob
 * @returns {ByteSource}
 */
export function sourceFromBlob(blob) {
  const reader = new FileReaderSync()
  let start = 0
  let window = new Uint8Array(0)
  return {
    size: blob.size,
    read(position, length) {
      const end = start + window.byteLength
      if (position < start || position + length > end) {
        // 7-Zip reads forwards in small steps for most of a pass, so a
        // window that starts where it asked serves many requests. What the
        // old window already holds of this request is kept, not read again:
        // a header and then the data after it is the usual order.
        const have = position >= start && position < end ? window.subarray(position - start) : null
        const from = have ? end : position
        const more = new Uint8Array(
          reader.readAsArrayBuffer(
            blob.slice(from, from + Math.max(length - (have?.byteLength ?? 0), READ_AHEAD_BYTES))
          )
        )
        let next = more
        if (have) {
          next = new Uint8Array(have.byteLength + more.byteLength)
          next.set(have)
          next.set(more, have.byteLength)
        }
        // Only once the read has worked, so the two never disagree.
        start = position
        window = next
      }
      return window.subarray(position - start, position - start + length)
    },
    peek(position, length) {
      // From the window if it is there; otherwise read on its own, and
      // the window left where it was.
      return position >= start && position + length <= start + window.byteLength
        ? window.subarray(position - start, position - start + length)
        : new Uint8Array(reader.readAsArrayBuffer(blob.slice(position, position + length)))
    },
    slice: (position, length) => blob.slice(position, position + length)
  }
}

export const canReadBlobsSynchronously = () => typeof FileReaderSync === 'function'

const PROGRESS_EVERY_BYTES = 4 * 1024 * 1024
/** Far longer than any real path; bounds a name read from a damaged heap. */
const MAX_NAME_BYTES = 4096
/** cr7_open_error() in native/sevenzip/glue.cpp. */
const OPEN_PASSWORD = 2
/** cr7_extract() in native/sevenzip/glue.cpp. (2 is "out of memory".) */
const EXTRACT_OK = 0
const EXTRACT_FAILED = 1
/** 7-Zip's NExtract::NOperationResult::kUnsupportedMethod, as crEnd's result. */
const RESULT_UNSUPPORTED_METHOD = 1
/**
 * Longer than any password anyone types. The time 7z's key derivation takes
 * grows with the password's length, so an absurd one would only run the
 * decoder into its time limit.
 */
const MAX_PASSWORD_LENGTH = 1024
/** At most this often, the pass reports that it is alive between entries. */
const BEGIN_PROGRESS_EVERY_MS = 250

/**
 * Whether these bytes begin like what an entry of this name should hold: an
 * image in one of the formats a page can be (the list has to cover every
 * format in IMAGE_MIME_BY_EXTENSION, src/archive/pageSort.ts), or, for an
 * entry kept by name and not as an image (ComicInfo.xml), XML. Used only
 * where there is nothing better to judge a password by; see extractSevenZip.
 */
function looksLikeContent(data, isImage) {
  const at = (offset, ...bytes) => bytes.every((byte, index) => data[offset + index] === byte)
  if (!isImage) {
    return at(0, 0x3c) || at(0, 0xef, 0xbb, 0xbf, 0x3c) // "<", or that after a byte-order mark
  }
  return (
    at(0, 0x89, 0x50, 0x4e, 0x47) || // PNG
    at(0, 0xff, 0xd8, 0xff) || // JPEG
    at(0, 0x47, 0x49, 0x46, 0x38) || // GIF
    at(0, 0x42, 0x4d) || // BMP
    (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) || // WebP
    at(4, 0x66, 0x74, 0x79, 0x70) || // AVIF and other ISO media: "ftyp"
    at(0, 0xff, 0x0a) || // JPEG XL codestream
    at(0, 0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20) // JPEG XL container
  )
}

/**
 * @typedef {object} SevenZipResult
 * @property {boolean} supported   False when 7-Zip cannot read the container.
 * @property {import('../unarr/unarr-extract.mjs').ExtractedEntry[]} entries
 * @property {boolean} truncated   True when a limit or a decode error cut the pass short.
 * @property {'needed' | 'wrong'} [password]  Set, with no entries, when the
 *   archive cannot be read without a password, or not with the one given.
 */

/** Whether an entry is kept, and as what: 'image', 'named' (ComicInfo.xml) or null. */
function wantedAs(name, limits) {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  if (limits.keepNames.includes(base)) {
    return 'named'
  }
  const dot = base.lastIndexOf('.')
  return dot > 0 && limits.keepExtensions.includes(base.slice(dot + 1)) ? 'image' : null
}

/**
 * Decodes a 7z archive in one pass, with a password if it needs one.
 *
 * One pass over everything, for the reason unarr's loop gives: most 7z
 * archives are solid, so reaching one entry means decoding those before it.
 * 7-Zip pushes each entry's bytes out as it decodes them; unwanted and
 * oversized entries are counted and dropped.
 *
 * The limits bound what a hostile archive controls: how many entries it
 * lists, how large one of them is, how much it expands to in total, and how
 * much of that is kept. When the total is spent the pass ends there: the
 * entries after it are listed, without data. (`limits.solid` is not
 * consulted. 7-Zip decides for itself whether it can carry on after a
 * damaged entry.)
 *
 * 7z has no way to check a password except by using it. With encrypted
 * headers a wrong one fails to open the archive at all. Without, it decodes
 * to noise, which shows as encrypted entries failing their checksum or their
 * decompression from the first one on. A damaged archive looks the same;
 * both are reported as `password: 'wrong'`.
 *
 * An archive can be built with no checksums at all, which 7-Zip itself
 * never does. 7-Zip then has nothing to check, and reports success whatever
 * the password made of the data. For that case alone the kept entries are
 * looked at: unless at least half of them begin like the images (or the
 * XML) they are named as, what came out is noise and the password is
 * reported wrong. Half, because noise passes for an image now and then, and
 * a real comic may hold a page or two in a format this does not know. An archive that is only partly
 * encrypted is not offered in part: without the password that opens its
 * encrypted entries the answer is the same as for one encrypted throughout.
 *
 * @param {object} Module  An instantiated sevenzip module.
 * @param {ByteSource} source  From sourceFromBlob or sourceFromBytes.
 * @param {import('../unarr/unarr-extract.mjs').ExtractLimits} limits
 * @param {import('../unarr/unarr-extract.mjs').ExtractHooks & { password?: string }} [hooks]
 * @returns {SevenZipResult}
 */
export function extractSevenZip(Module, source, limits, hooks = {}) {
  const { onProgress, store = (data) => data, password } = hooks
  const hasPassword = typeof password === 'string' && password.length > 0
  /** The answer when the password is what stands in the way. */
  const passwordResult = () => ({
    supported: true,
    entries: [],
    truncated: false,
    password: hasPassword ? 'wrong' : 'needed'
  })

  if (hasPassword && password.length > MAX_PASSWORD_LENGTH) {
    return passwordResult()
  }

  /** What a hook threw, if one did; see `guarded`. */
  let hookFailure = null
  /**
   * The hooks run inside 7-Zip, in functions that must not throw: an
   * exception passing through them aborts the module and hides what went
   * wrong (out of memory making a page's buffer, say). So each hook
   * catches and answers with `onFailure`, which stops what 7-Zip is doing,
   * and the error is thrown once 7-Zip has returned.
   */
  const guarded =
    (hook, onFailure = 0) =>
    (...args) => {
      if (hookFailure) {
        return onFailure
      }
      try {
        return hook(...args)
      } catch (error) {
        hookFailure = { error }
        return onFailure
      }
    }
  const rethrowHookFailure = () => {
    if (hookFailure) {
      throw hookFailure.error
    }
  }

  Module.crRead = guarded((position, pointer, byteCount) => {
    const chunk = source.read(position, byteCount)
    if (chunk.byteLength > byteCount) {
      throw new Error('the archive source returned more than was asked for')
    }
    // Read through Module.HEAPU8 every time: the view is replaced whenever
    // the heap grows.
    Module.HEAPU8.set(chunk, pointer)
    return chunk.byteLength
  }, -1)

  const passwordPointer = hasPassword ? Module.stringToNewUTF8(password) : 0
  let handle
  try {
    handle = Module._cr7_open(source.size, passwordPointer)
  } finally {
    Module._free(passwordPointer)
  }
  if (!handle) {
    Module.crRead = undefined
    rethrowHookFailure()
    return Module._cr7_open_error() === OPEN_PASSWORD
      ? passwordResult()
      : { supported: false, entries: [], truncated: false }
  }

  /** @type {import('../unarr/unarr-extract.mjs').ExtractedEntry[]} */
  const entries = []
  /**
   * Per archive item, in the archive's order: its entry (null for a
   * directory), what it is kept as if it is ('image', 'named' or null), and
   * whether it is encrypted and has a checksum to prove a password by.
   */
  const plan = []
  let truncated = false
  let totalBytes = 0
  let retainedBytes = 0
  let sinceProgress = 0
  /** The password is proved: an encrypted entry decoded and matched its checksum. */
  let decryptedOne = false
  /** An encrypted entry failed before any was proved. */
  let encryptedFailed = false
  /** Set when one of this function's own limits ended the pass. */
  let stoppedByLimit = false
  // For the archive without checksums: how many encrypted entries were
  // kept, and how many of those begin like what they are named as.
  let keptUnchecked = 0
  let keptUncheckedLookRight = 0
  let lastBeginProgress = Date.now()
  /** The item being decoded: how far it has got, and its buffer when it is kept. */
  let current = null

  try {
    // Encrypted headers that opened have already proved the password: as
    // 7-Zip writes them, they carry a checksum. Whatever fails after that is
    // damage, not a wrong password, and must not send the reader back to
    // ask again.
    if (hasPassword && Module._cr7_password_asked(handle) === 1) {
      decryptedOne = true
    }
    const count = Module._cr7_count(handle) >>> 0
    if (count > limits.maxEntries) {
      truncated = true
    }
    const listed = Math.min(count, limits.maxEntries)
    for (let index = 0; index < listed; index++) {
      if (Module._cr7_entry_is_directory(handle, index) === 1) {
        plan.push({ entry: null, wanted: null, encrypted: false, checked: false })
        continue
      }
      const namePointer = Module._cr7_entry_name(handle, index)
      const name = (namePointer ? Module.UTF8ToString(namePointer, MAX_NAME_BYTES) : '').replace(
        /\\/g,
        '/'
      )
      const declared = Module._cr7_entry_size(handle, index)
      const entry = { name, size: Number.isSafeInteger(declared) && declared >= 0 ? declared : 0 }
      entries.push(entry)
      plan.push({
        entry,
        wanted: entry.size <= limits.maxEntryBytes ? wantedAs(name, limits) : null,
        encrypted: Module._cr7_entry_is_encrypted(handle, index) === 1,
        checked: Module._cr7_entry_has_checksum(handle, index) === 1
      })
    }

    Module.crBegin = guarded((index) => {
      const item = plan[index]
      // Stopping the pass makes cr7_extract report it, which is what marks
      // the result as cut short.
      if (!hasPassword && encryptedFailed) {
        // Encrypted, and there is no password to try the rest with.
        return 0
      }
      // With a password, every block is tried, however many fail: a
      // failure is a wrong password or a damaged block, and only a block
      // that decodes can say which. So a wrong password costs a pass over
      // the archive, as the right one does.
      if (!item || totalBytes >= limits.maxTotalBytes) {
        // Past the entry limit, or the decoding budget is spent.
        stoppedByLimit = true
        return 0
      }
      // Between entries 7-Zip may spend seconds deriving a key, and many
      // small entries write too little to report progress by volume.
      const now = Date.now()
      if (now - lastBeginProgress >= BEGIN_PROGRESS_EVERY_MS) {
        lastBeginProgress = now
        onProgress?.()
      }
      const size = item.entry?.size ?? 0
      const keep = item.wanted && retainedBytes + size <= limits.maxRetainedBytes
      current = { item, size, done: 0, data: keep ? new Uint8Array(size) : null }
      return 1
    })
    Module.crWrite = guarded((pointer, byteCount) => {
      if (current.done + byteCount > current.size || totalBytes + byteCount > limits.maxTotalBytes) {
        // More than the entry declared, or more than the archive may expand to.
        stoppedByLimit = true
        return 0
      }
      // (Through Module.HEAPU8 afresh, as in crRead.)
      current.data?.set(Module.HEAPU8.subarray(pointer, pointer + byteCount), current.done)
      current.done += byteCount
      totalBytes += byteCount
      sinceProgress += byteCount
      if (sinceProgress >= PROGRESS_EVERY_BYTES) {
        sinceProgress = 0
        onProgress?.()
      }
      return 1
    })
    Module.crEnd = guarded((index, result) => {
      // No current item: 7-Zip is reporting one it could not begin.
      const began = current
      current = null
      const item = began?.item ?? plan[index]
      if (result !== 0 || !began || began.done !== began.size) {
        truncated = true
        // Not when a limit cut the entry short, nor when 7-Zip does not
        // support how it is packed: neither says anything about the password.
        if (
          item?.encrypted &&
          !decryptedOne &&
          !stoppedByLimit &&
          result !== RESULT_UNSUPPORTED_METHOD
        ) {
          encryptedFailed = true
        }
        return
      }
      // Only an entry with a checksum proves anything, and only one with
      // contents: 7-Zip passes an empty entry without decoding a byte.
      if (item.encrypted && item.checked && began.size > 0) {
        decryptedOne = true
      }
      if (began.data) {
        // (An empty entry is neither for nor against.)
        if (item.encrypted && !item.checked && began.size > 0) {
          keptUnchecked++
          if (looksLikeContent(began.data, item.wanted === 'image')) {
            keptUncheckedLookRight++
          }
        }
        retainedBytes += began.size
        item.entry.data = store(began.data)
      }
    })

    const status = Module._cr7_extract(handle)
    rethrowHookFailure()
    if (status !== EXTRACT_OK) {
      truncated = true
    }
    // An archive without checksums gives 7-Zip nothing to prove a password
    // by. There the kept entries stand in: if at least half are what they
    // are named as, the password is right, whatever else went wrong.
    const proved = decryptedOne || (keptUnchecked > 0 && keptUncheckedLookRight * 2 >= keptUnchecked)
    // 7-Zip wanted a password and nothing proved one: there was none, or
    // the one given produced noise. Noise shows as entries failing; as
    // 7-Zip giving the pass up without a word about any entry (a pass this
    // function stopped at a limit is not that, nor is running out of
    // memory); or, without checksums, as kept entries that are mostly not
    // what they are named as.
    if (
      !proved &&
      Module._cr7_password_asked(handle) === 1 &&
      (!hasPassword ||
        encryptedFailed ||
        (status === EXTRACT_FAILED && !stoppedByLimit) ||
        keptUnchecked > 0)
    ) {
      return passwordResult()
    }
  } finally {
    Module._cr7_close(handle)
    Module.crRead = Module.crBegin = Module.crWrite = Module.crEnd = undefined
  }

  return { supported: true, entries, truncated }
}
