/*
 * OpenCloud Comic Reader — what decrypt-rar.mjs and decrypt-zip.mjs share:
 * reading and writing little-endian fields, the decryption routines of the
 * sevenzip module, and the archive being written.
 * Part of OpenCloud Comic Reader, AGPL-3.0-or-later. Not part of 7-Zip.
 *
 * Files in this directory are loaded with a version query and so do not
 * import one another (scripts/prune-dist.mjs checks). Whoever loads the two
 * decrypters loads this module too and hands it to them.
 */

/** How much data is decrypted, or copied, at a time. */
export const CHUNK_BYTES = 1024 * 1024
/** What is written is gathered into a Blob each time this much has piled up. */
const FOLD_BYTES = 32 * 1024 * 1024
/** cr7_cipher_start() in native/sevenzip/glue.cpp. */
const START_CONFIRMED = 2
const START_READY = 1
const START_WRONG_PASSWORD = 0
/** Where a CRC-32 starts, as cr7_crc() keeps it. */
const CRC_START = 0xffffffff

/**
 * @typedef {object} DecryptResult
 * @property {'decrypted' | 'not-encrypted' | 'wrong-password' | 'unsupported'} status
 * @property {Blob} [archive]  With `decrypted`: the archive without its encryption.
 * @property {boolean} [proven]  With `decrypted`: whether something in the
 *   archive confirmed the password. When false the archive gave nothing to
 *   check it by, and a wrong password shows only as entries that fail to
 *   decompress.
 * @property {{ of: number, at: number[], mismatched: number[] }} [encryptedEntries]
 *   With `decrypted`, for a RAR: how many files the archive holds, counted
 *   as a decoder lists them; which of them, by position in that list, were
 *   encrypted; and which of those were stored and, decrypted, did not match
 *   their checksum. Left out for an archive of very many files.
 * @property {boolean} [unchecked]  With `decrypted`, for a zip: some entries
 *   are written without the checksum of their data, which the archive never
 *   held.
 * @property {string} [reason]  With `unsupported`: what the archive is.
 */

/** The archive's own checks say the password is wrong. */
export class WrongPassword extends Error {}
/** The archive is of a kind that is not decrypted here; the message says which. */
export class Unsupported extends Error {}

/**
 * What to answer for an error a decrypter threw: a status for the two
 * above, and the error again for anything else.
 * @returns {DecryptResult}
 */
export function resultFor(error) {
  if (error instanceof WrongPassword) {
    return { status: 'wrong-password' }
  }
  if (error instanceof Unsupported) {
    return { status: 'unsupported', reason: error.message }
  }
  throw error
}

let crcTable = null
/** CRC-32, for headers. Entry data is summed in the module; see Ciphers.crc. */
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = index
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value >>> 0
    }
  }
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return ~crc >>> 0
}

export const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8)
export const u32 = (bytes, at) => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0
export const putU16 = (bytes, at, value) => {
  bytes[at] = value & 0xff
  bytes[at + 1] = (value >>> 8) & 0xff
}
export const putU32 = (bytes, at, value) => {
  putU16(bytes, at, value & 0xffff)
  putU16(bytes, at + 2, value >>> 16)
}
export const concat = (...arrays) => {
  const out = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0))
  let at = 0
  for (const array of arrays) {
    out.set(array, at)
    at += array.length
  }
  return out
}

/**
 * Exactly `length` bytes of the source at `position`, or an error. What is
 * returned is the source's to reuse on its next read: use it at once, or
 * ask for a copy.
 */
export function readExactly(source, position, length, { copy = false } = {}) {
  const bytes = position >= 0 ? source.read(position, length) : new Uint8Array(0)
  if (bytes.length !== length) {
    throw new Error('the archive refers to data beyond its end')
  }
  return copy ? bytes.slice() : bytes
}

/**
 * As `readExactly`, for a few bytes read on their own: the source reads
 * them and no more, where it would otherwise read ahead.
 */
export function peekExactly(source, position, length) {
  const bytes = position >= 0 ? source.peek(position, length) : new Uint8Array(0)
  if (bytes.length !== length) {
    throw new Error('the archive refers to data beyond its end')
  }
  return bytes
}

/**
 * `length` bytes of the source at `position` as something to write out
 * unchanged, without reading them here where the source is a Blob.
 */
export function sliceExactly(source, position, length) {
  if (position < 0 || position + length > source.size) {
    throw new Error('the archive refers to data beyond its end')
  }
  return source.slice(position, length)
}

/**
 * The archive being written. Its parts are gathered into a Blob as they
 * pile up, so that what has been decrypted does not stay in this thread's
 * memory until the end.
 */
export class Output {
  constructor() {
    /** Blobs of what has been gathered, in order. */
    this.folded = []
    /** What has been written since, in order. */
    this.pending = []
    /** How much of `pending` is bytes held here, not yet in a Blob. */
    this.pendingBytes = 0
    /** Bytes written so far: where the next part will start. */
    this.size = 0
    /** Where in `pending` a place is being held, or -1. */
    this.held = -1
    /** `size` and `pendingBytes` as they were when it was taken. */
    this.heldAt = null
  }

  /** @param {Uint8Array | Blob} part  Not changed by the caller afterwards. */
  write(part) {
    const isBytes = part instanceof Uint8Array
    const length = isBytes ? part.length : part.size
    if (!length) {
      return
    }
    this.pending.push(part)
    this.pendingBytes += isBytes ? length : 0
    this.size += length
    this.foldIfDue()
  }

  /**
   * Holds a place for a header that can only be finished once the data
   * after it has been through; `fill` puts it there. One at a time.
   */
  reserve() {
    if (this.held >= 0) {
      throw new Error('a place is already being held')
    }
    this.held = this.pending.length
    this.heldAt = { size: this.size, pendingBytes: this.pendingBytes }
    this.pending.push(new Uint8Array(0))
  }

  /** Lets go of the place held, and of everything written since it was. */
  discard() {
    if (this.held < 0) {
      throw new Error('no place is being held')
    }
    // What came before the place is as it was when the place was taken.
    this.pending.length = this.held
    this.size = this.heldAt.size
    this.pendingBytes = this.heldAt.pendingBytes
    this.held = -1
  }

  fill(bytes) {
    if (this.held < 0) {
      throw new Error('no place is being held')
    }
    this.pending[this.held] = bytes
    this.pendingBytes += bytes.length
    this.size += bytes.length
    this.held = -1
    this.foldIfDue()
  }

  /**
   * Gathers what has piled up into a Blob. While a place is held, only what
   * comes after it: the place stays open, and the data behind it, however
   * much, still leaves this thread's memory. What came before the place is
   * still counted, and goes the next time nothing is held.
   */
  foldIfDue() {
    const before = this.held < 0 ? 0 : this.heldAt.pendingBytes
    if (this.pendingBytes - before < FOLD_BYTES) {
      return
    }
    if (this.held < 0) {
      this.folded.push(new Blob(this.pending))
      this.pending = []
    } else {
      const upTo = this.held + 1
      this.pending = [...this.pending.slice(0, upTo), new Blob(this.pending.slice(upTo))]
    }
    this.pendingBytes = before
  }

  /** @returns {Blob} */
  finish() {
    if (this.held >= 0) {
      throw new Error('a place was held and never filled')
    }
    return new Blob([...this.folded, ...this.pending])
  }
}

/** The decryption routines of the sevenzip module, over buffers in its heap. */
export class Ciphers {
  constructor(Module) {
    this.Module = Module
    this.live = new Set()
    this.buffer = this.allocate(CHUNK_BYTES)
  }

  allocate(size) {
    const pointer = this.Module._malloc(Math.max(size, 1))
    if (!pointer) {
      throw new Error('out of memory in the decryption module')
    }
    return pointer
  }

  /** Calls `make` with the given byte arrays copied into the heap (0 for none). */
  withBytes(arrays, make) {
    const pointers = []
    try {
      for (const bytes of arrays) {
        const pointer = bytes ? this.allocate(bytes.length) : 0
        pointers.push(pointer)
        if (pointer) {
          this.Module.HEAPU8.set(bytes, pointer)
        }
      }
      return make(...pointers)
    } finally {
      pointers.forEach((pointer) => pointer && this.Module._free(pointer))
    }
  }

  track(cipher, otherwise) {
    if (!cipher) {
      throw otherwise
    }
    this.live.add(cipher)
    return cipher
  }

  /** RAR5. `password` in UTF-8; `props` is the archive's encryption record. */
  rar5(password, props, includeIV) {
    return this.track(
      this.withBytes([password, props], (passwordPointer, record) =>
        this.Module._cr7_cipher_rar5(passwordPointer, password.length, record, props.length, includeIV ? 1 : 0)
      ),
      new Unsupported('an encryption record of a kind 7-Zip does not know')
    )
  }

  setIv(cipher, iv) {
    this.withBytes([iv], (pointer) => this.Module._cr7_cipher_set_iv(cipher, pointer))
  }

  /**
   * RAR3. `password` in UTF-16LE. One cipher for the whole archive: give it
   * each entry's salt and start it again. The key is derived anew only
   * when the salt changes, and deriving it is the slow part.
   */
  rar3(password) {
    return this.track(
      this.withBytes([password], (pointer) => this.Module._cr7_cipher_rar3(pointer, password.length)),
      new Error('the decryption module could not make a cipher')
    )
  }

  /**
   * RAR 2.0, the cipher from before AES. `password` as the archive's
   * writer typed it, in bytes. One cipher per entry: its state runs on.
   */
  rar2(password) {
    return this.track(
      this.withBytes([password], (pointer) => this.Module._cr7_cipher_rar2(pointer, password.length)),
      new Error('the decryption module could not make a cipher')
    )
  }

  /** @param {Uint8Array | null} salt  Eight bytes, or null for an entry without one. */
  rar3Salt(cipher, salt) {
    if (this.withBytes([salt], (pointer) => this.Module._cr7_cipher_rar3_salt(cipher, pointer)) !== 1) {
      throw new Error('the decryption module refused a salt')
    }
  }

  /**
   * WinZip AES. `password` as the zip's writer encoded it; `strength` is 1
   * to 3; `header` is the entry's salt and two verification bytes.
   */
  wzaes(password, strength, header) {
    return this.track(
      this.withBytes([password, header], (passwordPointer, headerPointer) =>
        this.Module._cr7_cipher_wzaes(passwordPointer, password.length, strength, headerPointer)
      ),
      new Error('the decryption module could not make a cipher')
    )
  }

  /**
   * Derives the key. Throws WrongPassword when the archive's own check
   * says so, and returns whether such a check took place and confirmed the
   * password: false where the archive has none to offer, or a damaged one.
   */
  start(cipher) {
    const status = this.Module._cr7_cipher_start(cipher)
    if (status === START_WRONG_PASSWORD) {
      throw new WrongPassword()
    }
    if (status !== START_READY && status !== START_CONFIRMED) {
      throw new Error('the decryption module could not start a cipher')
    }
    return status === START_CONFIRMED
  }

  /**
   * Decrypts up to a chunk, continuing from the previous call, and returns
   * a copy of the result. The result also stays in the module's buffer
   * until the next call, for `crc`.
   */
  decrypt(cipher, bytes) {
    const size = bytes.length
    if (size > CHUNK_BYTES) {
      throw new Error('decrypt is given a chunk at a time')
    }
    const { Module, buffer } = this
    Module.HEAPU8.set(bytes, buffer)
    // The ciphers work in blocks of 16. RAR's data is whole blocks. Zip's
    // is not, and what is left over at the very end of an entry is taken
    // in a call of its own.
    let done = Module._cr7_cipher_decrypt(cipher, buffer, size)
    if (done < size) {
      done += Module._cr7_cipher_decrypt(cipher, buffer + done, size - done)
    }
    if (done !== size) {
      throw new Error('the decryption module stopped short')
    }
    return Module.HEAPU8.slice(buffer, buffer + size)
  }

  /**
   * Carries a CRC-32 over the first `length` bytes of what `decrypt` last
   * returned. Start from `Ciphers.CRC_START`; `Ciphers.crcOf` ends it.
   */
  crc(state, length) {
    return this.Module._cr7_crc(state, this.buffer, length) >>> 0
  }

  rar5Checksum(cipher, crc) {
    return this.Module._cr7_cipher_rar5_checksum(cipher, crc) >>> 0
  }

  /** Whether the ten bytes after a zip entry's data authenticate it. */
  wzaesCheck(cipher, mac) {
    return this.withBytes([mac], (pointer) => this.Module._cr7_cipher_wzaes_check(cipher, pointer)) === 1
  }

  free(cipher) {
    if (this.live.delete(cipher)) {
      this.Module._cr7_cipher_free(cipher)
    }
  }

  close() {
    this.live.forEach((cipher) => this.Module._cr7_cipher_free(cipher))
    this.live.clear()
    this.Module._free(this.buffer)
  }
}
Ciphers.CRC_START = CRC_START
Ciphers.crcOf = (state) => ~state >>> 0
