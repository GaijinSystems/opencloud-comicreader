/*
 * Comic Reader — extraction loop over the unarr RAR module.
 * Part of Comic Reader, AGPL-3.0-or-later. Not part of unarr.
 *
 * Shipped as a plain module rather than bundled, so the worker beside it can
 * import it directly. scripts/verify-formats.mjs and the unit tests import the
 * same file, so what they exercise is what the reader runs.
 *
 * The shapes below are also declared, for TypeScript, in
 * src/archive/unarrAdapter.ts. Change them together.
 */

const READ_CHUNK_BYTES = 64 * 1024
const COPY_CHUNK_BYTES = 8 * 1024 * 1024
const PROGRESS_EVERY_BYTES = 4 * 1024 * 1024
/** Lengths cross into the module as 32-bit integers, and its heap tops out at 2 GiB. */
const MAX_ARCHIVE_BYTES = 0x7fffffff
/** Far longer than any real path; bounds a name read from a damaged heap. */
const MAX_NAME_BYTES = 4096

/**
 * @typedef {object} ExtractLimits
 * @property {number} maxEntryBytes  Entries larger than this are decoded but not kept.
 * @property {number} maxEntries     Listing stops after this many entries.
 * @property {number} maxTotalBytes  Decoding stops once this much has been produced.
 * @property {number} maxRetainedBytes  Once this much has been kept, further
 *   entries are decoded (to keep a solid archive's state) but not kept.
 * @property {boolean} solid  Whether the archive is solid. Decides whether a
 *   damaged entry ends the pass or only costs that entry.
 * @property {string[]} keepExtensions  Lower-case extensions (no dot) worth keeping.
 * @property {string[]} keepNames       Lower-case base names worth keeping.
 * @property {boolean} [decrypted]  The archive was encrypted and has been
 *   decrypted, which leaves padding after each entry's data; see
 *   cr_entry_finish in native/unarr/glue.c.
 *
 * @typedef {object} ExtractedEntry
 * @property {string} name   Path inside the archive, '/' separated.
 * @property {number} size   Uncompressed size the archive declares.
 * @property {*} [data]  Present only for kept entries that decoded cleanly: the
 *   bytes, or whatever the `store` hook turned them into.
 * @property {boolean} [decoded]  Whether the entry decoded (and matched its
 *   checksum), kept or not: true, or false when it was damaged. Absent when
 *   it was not tried, or a limit cut it short.
 *
 * @typedef {object} ExtractResult
 * @property {boolean} supported   False when unarr cannot read the container (e.g. RAR5).
 * @property {ExtractedEntry[]} entries
 * @property {boolean} truncated   True when a limit or a decode error cut the pass short.
 *
 * @typedef {object} ExtractHooks
 * @property {() => void} [onProgress]  Called every few megabytes decoded.
 * @property {(data: Uint8Array) => *} [store]  Called once per kept entry with its
 *   bytes; what it returns is what the entry carries. The worker uses it to move
 *   each page into a Blob as soon as it is decoded, so pages never pile up in
 *   its heap. Defaults to keeping the bytes.
 */

function allocate(Module, length) {
  if (!(length <= MAX_ARCHIVE_BYTES)) {
    throw new Error('archive too large for the decoder')
  }
  const pointer = Module._malloc(length)
  if (!pointer) {
    throw new Error('out of memory copying the archive')
  }
  return pointer
}

/**
 * Copies an archive held in memory into the module's heap.
 * Returns the pointer to pass to extractRar, which frees it.
 */
export function copyToHeap(Module, bytes) {
  const pointer = allocate(Module, bytes.byteLength)
  Module.HEAPU8.set(bytes, pointer)
  return pointer
}

/**
 * Copies a Blob into the module's heap a slice at a time, so the archive is
 * held once (in the heap) rather than twice (heap plus a full ArrayBuffer).
 * Returns the pointer to pass to extractRar, which frees it.
 */
export async function copyBlobToHeap(Module, blob, onProgress) {
  const pointer = allocate(Module, blob.size)
  try {
    for (let offset = 0; offset < blob.size; offset += COPY_CHUNK_BYTES) {
      const chunk = new Uint8Array(await blob.slice(offset, offset + COPY_CHUNK_BYTES).arrayBuffer())
      // Read through Module.HEAPU8 every time: the view is replaced whenever
      // the heap grows.
      Module.HEAPU8.set(chunk, pointer + offset)
      onProgress?.()
    }
  } catch (error) {
    Module._free(pointer)
    throw error
  }
  return pointer
}

function isWanted(name, limits) {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  if (limits.keepNames.includes(base)) {
    return true
  }
  const dot = base.lastIndexOf('.')
  return dot > 0 && limits.keepExtensions.includes(base.slice(dot + 1))
}

/**
 * Decodes a RAR4 archive in one sequential pass.
 *
 * Sequential and complete on purpose. In a solid archive each entry continues
 * the compression state of the one before, so skipping an entry makes unarr
 * re-decode everything from the start to reach the next one. Every entry is
 * therefore decoded in order, and unwanted or oversized ones are decoded into
 * a scratch buffer and dropped.
 *
 * The limits bound what a hostile archive controls: how many entries it
 * lists, how large one of them is, how much it expands to in total, and how
 * much of that is kept. Once the total is spent, the remaining entries are
 * still listed (so the page count stays honest) but not decoded. A damaged
 * entry does the same in a solid archive, where nothing after it can be
 * reached; in a non-solid one it costs only that entry.
 *
 * @param {object} Module  An instantiated unarr-rar module.
 * @param {number} archive  Pointer from copyToHeap or copyBlobToHeap. Freed here.
 * @param {number} length   The archive's size in bytes.
 * @param {ExtractLimits} limits
 * @param {ExtractHooks} [hooks]
 * @returns {ExtractResult}
 */
export function extractRar(Module, archive, length, limits, hooks = {}) {
  const { onProgress, store = (data) => data } = hooks

  const handle = Module._cr_open(archive, length)
  if (!handle) {
    Module._free(archive)
    return { supported: false, entries: [], truncated: false }
  }

  const scratch = Module._malloc(READ_CHUNK_BYTES)
  if (!scratch) {
    Module._cr_close(handle)
    Module._free(archive)
    throw new Error('out of memory starting the decoder')
  }
  let totalBytes = 0
  let retainedBytes = 0
  let sinceProgress = 0

  /**
   * Decodes the current entry to its end. Returns `data`, its bytes when it
   * decoded and is being kept; `decoded`, true when it decoded (kept or
   * not), false when it is damaged, and undefined when a limit cut it
   * short; and `stop`, when decoding has to stop for good.
   */
  const decodeEntry = (name, size) => {
    const keep =
      isWanted(name, limits) &&
      size <= limits.maxEntryBytes &&
      retainedBytes + size <= limits.maxRetainedBytes
    const data = keep ? new Uint8Array(size) : null
    for (let done = 0; done < size; ) {
      if (totalBytes >= limits.maxTotalBytes) {
        return { stop: true }
      }
      const count = Math.min(READ_CHUNK_BYTES, size - done)
      if (!Module._cr_entry_read(handle, scratch, count)) {
        // In a solid archive every later entry depends on this one, and
        // trying them makes unarr re-decode from the start each time.
        return { decoded: false, stop: limits.solid }
      }
      // Read through Module.HEAPU8 every time: any call into the module can
      // grow the heap, which replaces the view.
      data?.set(Module.HEAPU8.subarray(scratch, scratch + count), done)
      done += count
      totalBytes += count
      sinceProgress += count
      if (sinceProgress >= PROGRESS_EVERY_BYTES) {
        sinceProgress = 0
        onProgress?.()
      }
    }
    if (data) {
      retainedBytes += size
    }
    if (limits.decrypted) {
      Module._cr_entry_finish(handle)
    }
    return { data, decoded: true }
  }

  /** @type {ExtractedEntry[]} */
  const entries = []
  // Cleared when decodeEntry says to stop; the rest are then only listed.
  let decoding = true
  let truncated = false

  try {
    let status
    while ((status = Module._cr_next(handle)) === 1) {
      if (entries.length >= limits.maxEntries) {
        truncated = true
        break
      }
      const namePointer = Module._cr_entry_name(handle)
      const name = (namePointer ? Module.UTF8ToString(namePointer, MAX_NAME_BYTES) : '').replace(
        /\\/g,
        '/'
      )
      const size = Module._cr_entry_size(handle) >>> 0

      const entry = { name, size }
      if (decoding) {
        const { data, decoded, stop } = decodeEntry(name, size)
        if (data) {
          entry.data = store(data)
        }
        // Left out when a limit cut the entry short, as it is for the
        // entries that are only listed.
        if (decoded !== undefined) {
          entry.decoded = decoded
        }
        decoding = !stop
        truncated ||= !decoded
      }
      entries.push(entry)
    }
    if (status === -1) {
      truncated = true
    }
  } finally {
    Module._free(scratch)
    Module._cr_close(handle)
    Module._free(archive)
  }

  return { supported: true, entries, truncated }
}
