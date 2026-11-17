/*
 * OpenCloud Comic Reader — turns a password-protected RAR archive into the same
 * archive without the encryption.
 * Part of OpenCloud Comic Reader, AGPL-3.0-or-later. Not part of 7-Zip.
 *
 * The reader's RAR decoders (libarchive, unarr) decompress RAR and do not
 * decrypt it. So an encrypted RAR is decrypted here first: the container is
 * walked, every encrypted header and every entry's packed data is run
 * through 7-Zip's decryption routines (in the sevenzip module beside this
 * file), and what comes out is written as an ordinary RAR for those
 * decoders to read. Nothing is decompressed here.
 *
 * Both containers are handled: RAR 1.5 to 4.x ("RAR4": AES as of RAR 3.0,
 * and before it the cipher of RAR 2.x) and RAR5, each with encrypted data
 * only or with encrypted headers too. Not handled, and reported as
 * `unsupported`: the cipher that came before RAR 2.0, and archives split
 * into volumes.
 *
 * Shipped as a plain module, like the extraction loops, so that the worker,
 * the unit tests and scripts/verify-formats.mjs all run this same file.
 */

const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]
const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]
/** Both ciphers are AES in CBC mode: 16-byte blocks. */
const BLOCK = 16
/** A header larger than this is not a header. */
const MAX_HEADER_BYTES = 2 * 1024 * 1024
/** Both formats take this much of a password and no more. */
const MAX_PASSWORD_UNITS = 127
const EMPTY = new Uint8Array(0)
/** More files than this, and which of them were encrypted is not reported. */
const MAX_FILES_LISTED = 65536
/** The least a stored entry must hold for its checksum to confirm a password. */
const MIN_BYTES_TO_CONFIRM = 4

const roundUp = (size) => Math.ceil(size / BLOCK) * BLOCK
const startsWith = (bytes, signature) => signature.every((byte, index) => bytes[index] === byte)

/**
 * The helpers of decrypt-common.mjs, set by decryptRar before anything
 * here runs (this file cannot import them; see the top of that one).
 */
let CHUNK_BYTES, Ciphers, Unsupported, WrongPassword, concat, crc32, putU16, putU32, u16, u32

/** Reads the archive front to back and writes out what it becomes. */
class Walk {
  constructor(source, ciphers, out, onProgress) {
    this.source = source
    this.ciphers = ciphers
    this.out = out
    this.onProgress = onProgress
    this.at = 0
    /** Whether anything in the archive was encrypted. */
    this.encrypted = false
    /**
     * The files of the archive, counted in order as a decoder lists them
     * (directories left out), and which of them were encrypted: a wrong
     * password that nothing here catches shows in those, and only those.
     */
    this.files = 0
    this.encryptedFiles = []
    /**
     * And which of those were stored and did not match their checksum
     * once decrypted: damaged, or decrypted with a wrong password. Known
     * here already, so whoever judges the password need not read them.
     */
    this.mismatchedFiles = []
    /** Whether anything confirmed the password. */
    this.proven = false
  }

  get remaining() {
    return this.source.size - this.at
  }

  /** Counts an encrypted file among the files, and returns its place in the list. */
  listEncrypted() {
    if (this.files <= MAX_FILES_LISTED) {
      this.encryptedFiles.push(this.files)
    }
    return this.files++
  }

  /** Notes that the file listed at `place` (-1: not listed) did not match its checksum. */
  noteMismatch(place) {
    if (place >= 0) {
      this.mismatchedFiles.push(place)
    }
  }

  /**
   * What is told about the files: how many, which were encrypted, and
   * which of those did not match. Nothing, for an archive of more files
   * than any decoder here lists: the lists would only be long.
   */
  encryptedEntries() {
    return this.files > MAX_FILES_LISTED
      ? undefined
      : { of: this.files, at: this.encryptedFiles, mismatched: this.mismatchedFiles }
  }

  /**
   * The next `length` bytes, exactly, or an error: the archive is cut
   * short. Borrowed from the source, which reuses them on its next read.
   */
  borrow(length) {
    const bytes = this.source.read(this.at, length)
    if (bytes.length !== length) {
      throw new Error('the archive ends in the middle of a block')
    }
    this.at += length
    return bytes
  }

  /** As `borrow`, and a copy, to keep or to change. */
  take(length) {
    return this.borrow(length).slice()
  }

  write(bytes) {
    this.out.write(bytes)
  }

  /** Writes the next `length` bytes of the archive out unchanged, without reading them. */
  copy(length) {
    this.skip(length)
    this.write(this.source.slice(this.at - length, length))
    this.onProgress?.()
  }

  skip(length) {
    if (length > this.remaining) {
      throw new Error('the archive ends in the middle of a block')
    }
    this.at += length
  }

  /**
   * What an encrypted header that makes no sense means: the wrong
   * password, unless the password is already known to be right.
   */
  badHeader() {
    return this.proven ? new Error('a damaged block header') : new WrongPassword()
  }

  /**
   * Decrypts the header that comes next. Its first block says how long it
   * is: `lengthOf` reads that, and returns nothing (or throws) when the
   * block is not the start of a header.
   */
  decryptHeader(cipher, lengthOf) {
    const first = this.ciphers.decrypt(cipher, this.borrow(BLOCK))
    let length
    try {
      length = lengthOf(first)
    } catch {
      // Garbage, which is what a wrong password leaves behind.
    }
    if (!length || roundUp(length) - BLOCK > this.remaining) {
      throw this.badHeader()
    }
    const blocks = [first]
    for (let left = roundUp(length) - BLOCK; left > 0; ) {
      const size = Math.min(left, CHUNK_BYTES)
      blocks.push(this.ciphers.decrypt(cipher, this.borrow(size)))
      left -= size
    }
    return concat(...blocks).subarray(0, length)
  }

  /**
   * Decrypts `packed` bytes of entry data and writes out the first `keep`
   * of them: all, unless the padding that encryption added at the end is
   * cut. For a stored entry `keep` is its size. For a compressed one a
   * `measure` may be given: it is fed what is decrypted and says, by the
   * last chunk, how much of it is data (see Rar5Blocks).
   *
   * Returns how much was written, and its checksum where one is asked for.
   */
  decryptData(cipher, packed, keep, wantChecksum, measure = null) {
    if (packed % BLOCK !== 0) {
      throw new Error('encrypted data that is not a whole number of blocks')
    }
    let crc = Ciphers.CRC_START
    let written = 0
    for (let left = packed; left > 0; ) {
      const size = Math.min(left, CHUNK_BYTES)
      let plain = this.ciphers.decrypt(cipher, this.borrow(size))
      left -= size
      measure?.feed(plain)
      if (left === 0 && measure) {
        keep = measure.dataBytes(packed) ?? keep
      }
      if (written + plain.length > keep) {
        plain = plain.subarray(0, Math.max(keep - written, 0))
      }
      if (plain.length) {
        if (wantChecksum) {
          crc = this.ciphers.crc(crc, plain.length)
        }
        written += plain.length
        this.write(plain)
      }
      this.onProgress?.()
    }
    return { written, crc: Ciphers.crcOf(crc) }
  }
}

// ---------------------------------------------------------------- RAR4

const RAR4 = {
  MAIN: 0x73,
  FILE: 0x74,
  SUB: 0x7a,
  END: 0x7b,
  MAIN_VOLUME: 0x0001,
  MAIN_HEADERS_ENCRYPTED: 0x0080,
  FILE_SPLIT: 0x0003,
  FILE_ENCRYPTED: 0x0004,
  FILE_DIRECTORY: 0x00e0,
  FILE_LARGE: 0x0100,
  FILE_SALT: 0x0400,
  HAS_DATA: 0x8000,
  STORED: 0x30,
  /** Unpacker version 2.0, the first whose cipher 7-Zip has. */
  FIRST_KNOWN_VERSION: 20,
  /** Unpacker version 2.9, the first with AES. */
  FIRST_AES_VERSION: 29,
  LAST_HOST_OS: 5,
  LAST_METHOD: 0x35,
  LAST_VERSION: 36
}

/**
 * Whether a header that passed its checksum also has, in the fields of a
 * file header, values a file header can have. Noise that passes the one
 * does not pass the other more than once in tens of thousands of tries.
 */
function readsAsFileHeader(header) {
  return (
    (header[2] === RAR4.FILE || header[2] === RAR4.SUB) &&
    header.length >= 32 + u16(header, 26) &&
    header[15] <= RAR4.LAST_HOST_OS &&
    header[24] >= RAR4.FIRST_KNOWN_VERSION &&
    header[24] <= RAR4.LAST_VERSION &&
    header[25] >= RAR4.STORED &&
    header[25] <= RAR4.LAST_METHOD
  )
}

/**
 * What a RAR4 decoder passes over as a directory and does not list: the
 * directory bits all set, and no data.
 */
const isRar4Directory = (flags, dataSize) =>
  (flags & RAR4.FILE_DIRECTORY) === RAR4.FILE_DIRECTORY && dataSize === 0

/** A RAR4 header's own checksum: the low half of a CRC-32 of all that follows it. */
const rar4HeaderCrc = (header) => crc32(header.subarray(2)) & 0xffff

function decryptRar4(walk, passwords) {
  const { ciphers } = walk
  walk.write(walk.take(RAR4_SIGNATURE.length))
  let headersEncrypted = false
  /** How many encrypted headers have passed their checksum. */
  let headersPassed = 0

  /** The archive's one cipher, started for whatever was encrypted with `salt`. */
  let cipher = 0
  const cipherFor = (salt) => {
    cipher ||= ciphers.rar3(passwords.utf16)
    ciphers.rar3Salt(cipher, salt)
    ciphers.start(cipher)
    return cipher
  }

  /** The next header, decrypted if headers are; null at the end of the archive. */
  const nextHeader = () => {
    if (!headersEncrypted) {
      if (walk.remaining < 7) {
        return null
      }
      const start = walk.take(7)
      const size = u16(start, 5)
      if (size < 7) {
        throw new Error('a block header shorter than a block header')
      }
      return concat(start, walk.take(size - 7))
    }
    if (walk.remaining < 8 + BLOCK) {
      return null
    }
    const header = walk.decryptHeader(cipherFor(walk.take(8)), (first) => (u16(first, 5) >= 7 ? u16(first, 5) : 0))
    if (rar4HeaderCrc(header) !== u16(header, 0)) {
      throw walk.badHeader()
    }
    // The checksum is 16 bits: one wrong password in 65,536 gets a header
    // past it. So it takes two headers, or one that also reads, field by
    // field, as the header of a file.
    headersPassed++
    walk.proven ||= headersPassed > 1 || readsAsFileHeader(header)
    return header
  }

  for (let header; (header = nextHeader()); ) {
    const type = header[2]
    const flags = u16(header, 3)
    const hasSizes = type === RAR4.FILE || type === RAR4.SUB
    let dataSize = hasSizes || flags & RAR4.HAS_DATA ? u32(header, 7) : 0
    if (hasSizes && flags & RAR4.FILE_LARGE) {
      dataSize += u32(header, 32) * 2 ** 32
    }

    if (type === RAR4.MAIN) {
      if (flags & RAR4.MAIN_VOLUME) {
        throw new Unsupported('an archive in several volumes')
      }
      if (flags & RAR4.MAIN_HEADERS_ENCRYPTED) {
        headersEncrypted = true
        walk.encrypted = true
        putU16(header, 3, flags & ~RAR4.MAIN_HEADERS_ENCRYPTED)
        putU16(header, 0, rar4HeaderCrc(header))
      }
      walk.write(header)
      continue
    }
    if (type === RAR4.SUB) {
      // Comments, recovery records and the like: nothing a reader of pages
      // needs, and some refer to places in the archive that are about to move.
      walk.skip(dataSize)
      continue
    }
    if (type !== RAR4.FILE || !(flags & RAR4.FILE_ENCRYPTED)) {
      if (type === RAR4.FILE && !isRar4Directory(flags, dataSize)) {
        walk.files++
      }
      walk.write(header)
      walk.copy(dataSize)
      if (type === RAR4.END) {
        break
      }
      continue
    }

    // An encrypted entry.
    walk.encrypted = true
    if (flags & RAR4.FILE_SPLIT) {
      throw new Unsupported('an archive in several volumes')
    }
    const version = header[24]
    if (version < RAR4.FIRST_KNOWN_VERSION) {
      throw new Unsupported('encryption from before RAR 2.0')
    }
    const fixedEnd = flags & RAR4.FILE_LARGE ? 40 : 32
    if (header.length < fixedEnd) {
      throw new Error('a file header shorter than a file header')
    }
    const unpackedSize = u32(header, 11) + (flags & RAR4.FILE_LARGE ? u32(header, 36) * 2 ** 32 : 0)
    const nameEnd = fixedEnd + u16(header, 26)
    // (The cipher from before AES has no salt.)
    const aes = version >= RAR4.FIRST_AES_VERSION
    const salt = aes && flags & RAR4.FILE_SALT ? header.subarray(nameEnd, nameEnd + 8) : null
    if (salt && salt.length !== 8) {
      throw new Error('a file header that ends before its salt does')
    }
    const stored = header[25] === RAR4.STORED && unpackedSize <= dataSize
    const keep = stored ? unpackedSize : dataSize

    putU16(header, 3, flags & ~RAR4.FILE_ENCRYPTED)
    if (stored) {
      putU32(header, 7, keep >>> 0)
      if (flags & RAR4.FILE_LARGE) {
        putU32(header, 32, Math.floor(keep / 2 ** 32))
      }
    }
    putU16(header, 0, rar4HeaderCrc(header))
    walk.write(header)
    const listedAt = isRar4Directory(flags, keep) ? -1 : walk.listEncrypted()

    if (dataSize === 0) {
      // Nothing to decrypt, and so no key to derive (which is slow).
      continue
    }
    // Neither cipher has a password check of its own. A stored entry's
    // checksum is one; a compressed entry's can only be checked by
    // decompressing.
    const checkable = stored && unpackedSize > 0
    let crc
    if (aes) {
      crc = walk.decryptData(cipherFor(salt), dataSize, keep, checkable).crc
    } else {
      // RAR 2.0's cipher carries its state from block to block, so each
      // entry gets one of its own.
      const old = ciphers.rar2(passwords.bytes)
      try {
        crc = walk.decryptData(old, dataSize, keep, checkable).crc
      } finally {
        ciphers.free(old)
      }
    }
    // A match proves the password. A mismatch is a wrong password or a
    // damaged entry, and there is no telling which, so it settles nothing:
    // if nothing else proves the password, whoever reads the result finds
    // out by whether its pages decode.
    // (Of four bytes or more: the checksum of fewer says less than it has
    // bits, and noise matches it too often.)
    if (checkable && crc !== u32(header, 16)) {
      walk.noteMismatch(listedAt)
    } else if (checkable && unpackedSize >= MIN_BYTES_TO_CONFIRM) {
      walk.proven = true
    }
  }
}

// ---------------------------------------------------------------- RAR5

const RAR5 = {
  MAIN: 1,
  FILE: 2,
  SERVICE: 3,
  ENCRYPTION: 4,
  END: 5,
  HAS_EXTRA: 0x0001,
  HAS_DATA: 0x0002,
  SPLIT: 0x0018,
  MAIN_VOLUME: 0x0001,
  FILE_HAS_MTIME: 0x0002,
  FILE_HAS_CRC: 0x0004,
  FILE_UNKNOWN_SIZE: 0x0008,
  HOST_UNIX: 1,
  UNIX_TYPE_MASK: 0o170000,
  UNIX_REGULAR_FILE: 0o100000,
  WINDOWS_DIRECTORY: 0x10,
  EXTRA_ENCRYPTION: 1,
  EXTRA_HASH: 2,
  ENCRYPTION_TWEAKED_CHECKSUMS: 0x0002
}

/** RAR5's variable-length integers: seven bits a byte, low bits first. */
class Fields {
  constructor(bytes, at = 0) {
    this.bytes = bytes
    this.at = at
  }
  vint() {
    let value = 0
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.at >= this.bytes.length) {
        throw new Error('a number runs past the end of its header')
      }
      const byte = this.bytes[this.at++]
      value += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) {
        if (!Number.isSafeInteger(value)) {
          throw new Error('a number too large to be a size')
        }
        return value
      }
    }
    throw new Error('a number that never ends')
  }
  /** A number that is a set of flags: read with bit operations, so held to 31 bits. */
  flags() {
    const value = this.vint()
    if (value > 0x7fffffff) {
      throw new Error('flags this reader does not know')
    }
    return value
  }
  take(length) {
    if (this.at + length > this.bytes.length) {
      throw new Error('a field runs past the end of its header')
    }
    const bytes = this.bytes.subarray(this.at, this.at + length)
    this.at += length
    return bytes
  }
  rest() {
    return this.take(this.bytes.length - this.at)
  }
}

function vint(value) {
  const out = []
  do {
    const low = value % 128
    value = Math.floor(value / 128)
    out.push(value > 0 ? low | 0x80 : low)
  } while (value > 0)
  return Uint8Array.from(out)
}

/** Puts a RAR5 header together from what follows its size field. */
function rar5Header(content) {
  const sized = concat(vint(content.length), content)
  const header = new Uint8Array(4 + sized.length)
  putU32(header, 0, crc32(sized))
  header.set(sized, 4)
  return header
}

/** Splits a RAR5 header that has been read whole (checksum and size included). */
function parseRar5Header(header) {
  const fields = new Fields(header, 4)
  fields.vint()
  const type = fields.vint()
  const flags = fields.flags()
  const extraSize = flags & RAR5.HAS_EXTRA ? fields.vint() : 0
  const dataSize = flags & RAR5.HAS_DATA ? fields.vint() : 0
  const rest = fields.rest()
  if (extraSize > rest.length) {
    throw new Error('an extra area larger than its header')
  }
  const records = []
  for (const extra = new Fields(rest.subarray(rest.length - extraSize)); extra.at < extra.bytes.length; ) {
    const record = new Fields(extra.take(extra.vint()))
    records.push({ type: record.vint(), data: record.rest() })
  }
  return { type, flags, dataSize, body: rest.subarray(0, rest.length - extraSize), records }
}

const rar5Extra = (records) =>
  concat(
    ...records.map(({ type, data }) => {
      const typed = concat(vint(type), data)
      return concat(vint(typed.length), typed)
    })
  )

/**
 * Whether libarchive, which reads what RAR5 this module writes, lists a
 * file header as a file: it goes by the attributes, as the host system
 * that wrote them meant them. (Anything else is a directory, a link or a
 * device, and not in its list of files.)
 */
function rar5ListedAsFile(body) {
  const fields = new Fields(body)
  const fileFlags = fields.flags()
  fields.vint() // unpacked size
  const attributes = fields.vint()
  fields.take((fileFlags & RAR5.FILE_HAS_MTIME ? 4 : 0) + (fileFlags & RAR5.FILE_HAS_CRC ? 4 : 0))
  fields.vint() // compression
  const hostOs = fields.vint()
  return hostOs === RAR5.HOST_UNIX
    ? (attributes & RAR5.UNIX_TYPE_MASK) === RAR5.UNIX_REGULAR_FILE
    : !(attributes & RAR5.WINDOWS_DIRECTORY)
}

/**
 * Finds where the compressed data of a RAR5 entry ends, without
 * decompressing it.
 *
 * RAR encrypts an entry's data in whole blocks of the cipher, so up to 15
 * bytes of padding follow it, and stay there once it is decrypted. RAR's
 * own unpacker stops where the data ends. libarchive's, in a solid archive,
 * reads on into the padding and gives the archive up.
 *
 * The data is a chain of blocks, each with a header that says how long it
 * is and whether it is the last: a byte of flags, a byte that checks the
 * header (0x5A xor every other byte of it), and one to three bytes of
 * length. Following the chain to the block marked last gives the length of
 * the data exactly. Where the chain does not hold (a checksum that fails,
 * or an end that is not within a cipher block of the entry's end), nothing
 * is cut: the entry is written with its padding.
 *
 * The layout of the header is taken from libarchive's RAR5 reader
 * (archive_read_support_format_rar5.c: parse_block_header and the bf_*
 * accessors; BSD-2-Clause), which is also the decoder that reads what is
 * written here.
 */
export class Rar5Blocks {
  constructor() {
    this.at = 0
    /** Bytes of the current block still to pass over. */
    this.left = 0
    this.header = []
    /** Set by the header of the last block: `at` stops where that block ends. */
    this.last = false
    this.broken = false
  }

  feed(bytes) {
    let index = 0
    while (index < bytes.length && !this.broken && !(this.last && this.left === 0)) {
      if (this.left > 0) {
        const step = Math.min(this.left, bytes.length - index)
        this.left -= step
        index += step
        this.at += step
      } else {
        this.header.push(bytes[index++])
        this.at++
        this.readHeader()
      }
    }
  }

  readHeader() {
    const header = this.header
    // Three bits, of which libarchive takes only the values for one to
    // three bytes; anything else it refuses, and here nothing is cut.
    const lengthBytes = ((header[0] >> 3) & 7) + 1
    if (lengthBytes > 3) {
      this.broken = true
    } else if (header.length === 2 + lengthBytes) {
      let check = 0x5a ^ header[0]
      let length = 0
      for (let index = 0; index < lengthBytes; index++) {
        check ^= header[2 + index]
        length += header[2 + index] * 2 ** (8 * index)
      }
      this.broken = check !== header[1]
      this.last = Boolean(header[0] & 0x40)
      this.left = length
      this.header = []
    }
  }

  /** The length of the data in an entry of `packed` bytes, or null when the chain did not hold. */
  dataBytes(packed) {
    const ended = !this.broken && this.last && this.left === 0 && this.header.length === 0
    return ended && this.at <= packed && packed - this.at < BLOCK ? this.at : null
  }
}

/** Whether a RAR5 header, read whole, matches the checksum it begins with. */
const rar5HeaderIntact = (header) => crc32(header.subarray(4)) === u32(header, 0)

function decryptRar5(walk, password) {
  const { ciphers } = walk
  walk.write(walk.take(RAR5_SIGNATURE.length))
  /** Set once the archive says its headers are encrypted. */
  let headerCipher = null

  /** The next header, decrypted if headers are; null at the end of the archive. */
  const nextHeader = () => {
    const readPlain = () => {
      if (walk.remaining < 7) {
        return null
      }
      // Checksum, then a size of at most three bytes.
      const start = walk.take(7)
      const fields = new Fields(start, 4)
      const size = fields.vint()
      const total = fields.at + size
      if (size > MAX_HEADER_BYTES || total < start.length) {
        throw new Error('a block header of an impossible size')
      }
      return concat(start, walk.take(total - start.length))
    }
    if (!headerCipher) {
      return readPlain()
    }
    if (walk.remaining < 2 * BLOCK) {
      return null
    }
    ciphers.setIv(headerCipher, walk.borrow(BLOCK))
    ciphers.start(headerCipher)
    const header = walk.decryptHeader(headerCipher, (first) => {
      const fields = new Fields(first, 4)
      const size = fields.vint()
      return size > MAX_HEADER_BYTES ? 0 : fields.at + size
    })
    if (!rar5HeaderIntact(header)) {
      throw walk.badHeader()
    }
    walk.proven = true
    return header
  }

  for (let raw; (raw = nextHeader()); ) {
    const header = parseRar5Header(raw)
    const { type, flags, dataSize } = header
    if (flags & RAR5.SPLIT) {
      throw new Unsupported('an archive in several volumes')
    }

    if (type === RAR5.ENCRYPTION) {
      // Everything after this header is encrypted. The header itself is
      // left out of what is written. Its salt and check value are what the
      // password is about to be judged by, so it is held to its checksum:
      // damaged, it would turn the right password away.
      if (!rar5HeaderIntact(raw)) {
        throw new Error('a damaged encryption header')
      }
      walk.encrypted = true
      headerCipher = ciphers.rar5(password, header.body, false)
      // Its own check, where the archive recorded one, settles the password now.
      const confirmed = ciphers.start(headerCipher)
      walk.proven ||= confirmed
      continue
    }
    if (type === RAR5.MAIN) {
      const fields = new Fields(header.body)
      const archiveFlags = fields.flags()
      if (archiveFlags & RAR5.MAIN_VOLUME) {
        throw new Unsupported('an archive in several volumes')
      }
      // Without its extra area, which points at places that are about to
      // move. (A main header has no data; one that claims some loses it.)
      walk.write(rar5Header(concat(vint(type), vint(flags & ~(RAR5.HAS_EXTRA | RAR5.HAS_DATA)), header.body)))
      walk.skip(dataSize)
      continue
    }
    if (type === RAR5.SERVICE) {
      // Comments, the quick-open index, recovery records: nothing a reader
      // of pages needs, and the index repeats headers as they were.
      walk.skip(dataSize)
      continue
    }
    const encryption = type === RAR5.FILE && header.records.find((record) => record.type === RAR5.EXTRA_ENCRYPTION)
    let isFile = type === RAR5.FILE
    try {
      isFile &&= rar5ListedAsFile(header.body)
    } catch {
      // A header too odd to read that far is passed on as it is.
    }
    if (!encryption) {
      walk.files += isFile ? 1 : 0
      walk.write(raw)
      walk.copy(dataSize)
      if (type === RAR5.END) {
        break
      }
      continue
    }

    // An encrypted entry.
    walk.encrypted = true
    const listedAt = isFile ? walk.listEncrypted() : -1
    const fields = new Fields(header.body)
    const fileFlags = fields.flags()
    const unpackedSize = fields.vint()
    const attributes = fields.vint()
    const mtime = fileFlags & RAR5.FILE_HAS_MTIME ? fields.take(4) : EMPTY
    const storedCrc = fileFlags & RAR5.FILE_HAS_CRC ? u32(fields.take(4), 0) : null
    const compression = fields.flags()
    const afterCompression = fields.rest()
    const stored = ((compression >> 7) & 7) === 0 && !(fileFlags & RAR5.FILE_UNKNOWN_SIZE) && unpackedSize <= dataSize
    const keep = stored ? unpackedSize : dataSize

    const record = new Fields(encryption.data)
    record.vint()
    const encryptionFlags = record.flags()
    const tweaked = Boolean(encryptionFlags & RAR5.ENCRYPTION_TWEAKED_CHECKSUMS)

    const cipher = ciphers.rar5(password, encryption.data, true)
    // The header is written after the data is decrypted, since it may carry
    // the data's checksum; hold its place.
    walk.out.reserve()
    let crc
    /** How much of the entry's data is written: all of it, less its padding. */
    let written
    /** A stored entry whose data does not match its checksum: damaged. */
    let mismatched = false
    try {
      // Where the record carries a check value that is intact, starting
      // the cipher compares it: a wrong password does not get past this.
      // (Nor does a record whose salt is damaged, which is what a refusal
      // means once the password is known to be right, or where the header
      // fails its own checksum.)
      let confirmed
      try {
        confirmed = ciphers.start(cipher)
      } catch (error) {
        const damaged = walk.proven || !rar5HeaderIntact(raw)
        throw damaged && error instanceof WrongPassword ? new Error('a damaged encryption record') : error
      }
      walk.proven ||= confirmed
      // A compressed entry's padding is found by where its blocks end.
      // (Only a compressed one: data stored as it is has no blocks to follow.)
      const measure = ((compression >> 7) & 7) !== 0 ? new Rar5Blocks() : null
      ;({ crc, written } = walk.decryptData(cipher, dataSize, keep, stored, measure))
      // A stored entry's checksum confirms the password where nothing else has.
      if (stored && unpackedSize > 0 && storedCrc !== null) {
        mismatched = ciphers.rar5Checksum(cipher, crc) !== storedCrc
        if (mismatched) {
          walk.noteMismatch(listedAt)
        }
        // (As for RAR4: a checksum of fewer than four bytes says too little.
        // One stored transformed with a key from the password says enough.)
        walk.proven ||= !mismatched && (tweaked || unpackedSize >= MIN_BYTES_TO_CONFIRM)
      }
    } finally {
      ciphers.free(cipher)
    }

    // The checksums of an entry encrypted this way are stored transformed
    // with a key from the password, so that they give nothing away. A
    // stored entry's real one has just been computed. A compressed entry's
    // cannot be had without decompressing, so it is left out, and with it
    // the entry's hash record, which is transformed the same way.
    const keepCrc = storedCrc !== null && (!tweaked || stored)
    const crcBytes = new Uint8Array(keepCrc ? 4 : 0)
    if (keepCrc) {
      // (For a damaged entry, a checksum its data is sure not to match, so
      // that the decoder finds it damaged too.)
      putU32(crcBytes, 0, tweaked ? (mismatched ? ~crc >>> 0 : crc) : storedCrc)
    }
    const records = header.records.filter(
      (other) => other.type !== RAR5.EXTRA_ENCRYPTION && !(tweaked && other.type === RAR5.EXTRA_HASH)
    )
    const extra = rar5Extra(records)
    const newFlags = extra.length ? flags | RAR5.HAS_EXTRA : flags & ~RAR5.HAS_EXTRA
    walk.out.fill(rar5Header(
      concat(
        vint(type),
        vint(newFlags),
        extra.length ? vint(extra.length) : EMPTY,
        flags & RAR5.HAS_DATA ? vint(written) : EMPTY,
        vint(keepCrc ? fileFlags : fileFlags & ~RAR5.FILE_HAS_CRC),
        vint(unpackedSize),
        vint(attributes),
        mtime,
        crcBytes,
        vint(compression),
        afterCompression,
        extra
      )
    ))
  }
}

/**
 * The password as each cipher takes it: UTF-8 for RAR5, UTF-16LE for RAR3,
 * and for RAR 2.0 the bytes its writer typed (in a DOS code page; UTF-8
 * here, which is the same for a password in ASCII and the best guess for
 * any other).
 */
function encodePassword(password) {
  const units = password.slice(0, MAX_PASSWORD_UNITS)
  const utf8 = new TextEncoder().encode(units)
  const utf16 = new Uint8Array(units.length * 2)
  for (let index = 0; index < units.length; index++) {
    putU16(utf16, index * 2, units.charCodeAt(index))
  }
  return { utf8, utf16, bytes: utf8.subarray(0, MAX_PASSWORD_UNITS) }
}

/**
 * Decrypts a RAR archive.
 *
 * @param {object} common  The decrypt-common.mjs module.
 * @param {object} Module  An instantiated sevenzip module.
 * @param {import('./sevenzip-extract.mjs').ByteSource} source  The archive.
 * @param {string} password
 * @param {{ onProgress?: () => void }} [hooks]
 * @returns {import('./decrypt-common.mjs').DecryptResult}
 */
export function decryptRar(common, Module, source, password, hooks = {}) {
  ;({ CHUNK_BYTES, Ciphers, Unsupported, WrongPassword, concat, crc32, putU16, putU32, u16, u32 } = common)
  const head = source.read(0, RAR5_SIGNATURE.length)
  const isRar5 = startsWith(head, RAR5_SIGNATURE)
  if (!isRar5 && !startsWith(head, RAR4_SIGNATURE)) {
    return { status: 'unsupported', reason: 'not a RAR archive' }
  }
  const ciphers = new Ciphers(Module)
  const walk = new Walk(source, ciphers, new common.Output(), hooks.onProgress)
  try {
    const passwords = encodePassword(password)
    if (isRar5) {
      decryptRar5(walk, passwords.utf8)
    } else {
      decryptRar4(walk, passwords)
    }
  } catch (error) {
    return common.resultFor(error)
  } finally {
    ciphers.close()
  }
  return walk.encrypted
    ? {
        status: 'decrypted',
        archive: walk.out.finish(),
        proven: walk.proven,
        encryptedEntries: walk.encryptedEntries()
      }
    : { status: 'not-encrypted' }
}
