/*
 * Comic Reader — turns a zip whose entries are encrypted with WinZip AES
 * into the same zip without the encryption.
 * Part of Comic Reader, AGPL-3.0-or-later. Not part of 7-Zip.
 *
 * zip.js decrypts AES, and decodes stored, deflate and deflate64. libarchive
 * decodes bzip2, LZMA and PPMd, and cannot undo AES (it is built without a
 * cryptography library). So an AES zip in one of those three methods is
 * read by neither. Here each AES entry is decrypted, with 7-Zip's routine
 * in the sevenzip module beside this file, and the zip is written out again
 * with the entries as they were before encryption: still compressed, for
 * libarchive to decode. Nothing is decompressed here.
 *
 * Entries that are not AES-encrypted are copied as they are, including any
 * encrypted with the old zip scheme, which libarchive undoes itself.
 *
 * An entry that does not decrypt (damaged, or under a password of its own)
 * is left as it is too, for a reader to show as a page it cannot read. The
 * password is wrong when no entry at all decrypts with it.
 *
 * zip64 archives (over 4 GiB, or with more than 65,535 entries) are read
 * and written as such. Not handled, and reported as `unsupported`:
 * archives split into parts.
 *
 * Shipped as a plain module, like the extraction loops, so that the worker,
 * the unit tests and scripts/verify-formats.mjs all run this same file.
 */

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const END64 = 0x06064b50
const END64_LOCATOR = 0x07064b50
const DESCRIPTOR = 0x08074b50
const AES_METHOD = 99
const AES_EXTRA = 0x9901
const ZIP64_EXTRA = 0x0001
/** The second version of the scheme, which stores no checksum of the data. */
const AE_2 = 2
const STORED = 0
const FLAG_ENCRYPTED = 0x0001
const FLAG_DESCRIPTOR = 0x0008
/** Salt length by key strength (1 to 3), then two verification bytes. */
const SALT_BYTES = [0, 8, 12, 16]
const VERIFIER_BYTES = 2
const MAC_BYTES = 10
const LOCAL_BYTES = 30
const CENTRAL_BYTES = 46
/** The end record, and the longest comment that can follow it. */
const END_BYTES = 22
const MAX_COMMENT_BYTES = 0xffff
const END64_BYTES = 56
const END64_LOCATOR_BYTES = 20
/** A directory larger than this is not one: a million entries rarely need it. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024
/** What decryptData answers for an entry that does not decrypt. */
const REFUSED = -1
const UNAUTHENTIC = -2
/**
 * How many entries may refuse a password at once, with none decrypted,
 * before it is called wrong. Far more than damage leaves behind (each
 * would have to be hit in the 18 bytes before its data); few enough that
 * an archive of a million tiny entries does not hold a wrong guess for
 * minutes.
 */
const REFUSALS_TO_CONDEMN = 1000
/** What a 32-bit and a 16-bit field hold when the real value is in a zip64 one. */
const MAX_U32 = 0xffffffff
const MAX_U16 = 0xffff
/** The version of the format that zip64 needs: 4.5. */
const ZIP64_VERSION = 45

/**
 * The helpers of decrypt-common.mjs, set by decryptZip before anything
 * here runs (this file cannot import them; see the top of that one).
 */
let CHUNK_BYTES, Ciphers, Unsupported, WrongPassword, concat, peekExactly, putU16, putU32, readExactly, sliceExactly, u16, u32

/** A 64-bit field, which has to be a number this language can count with. */
function u64(bytes, at) {
  const high = u32(bytes, at + 4)
  if (high >= 2 ** 21) {
    throw new Error('a size too large to be one')
  }
  return high * 2 ** 32 + u32(bytes, at)
}
function putU64(bytes, at, value) {
  putU32(bytes, at, value % 2 ** 32)
  putU32(bytes, at + 4, Math.floor(value / 2 ** 32))
}

/**
 * Finds the end record, and the zip64 one before it if there is one, and
 * returns the directory's entry count, size and offset.
 */
function readEnd(source) {
  const span = Math.min(source.size, END_BYTES + MAX_COMMENT_BYTES)
  const tailStart = source.size - span
  const tail = readExactly(source, tailStart, span, { copy: true })
  // The record whose comment runs exactly to the end of the file, or
  // failing that (some files have bytes after it) the last one whose
  // comment fits. A look-alike inside the comment is neither: it is met
  // first, scanning backwards, and passed over for the real one.
  let at = -1
  for (let candidate = tail.length - END_BYTES; candidate >= 0; candidate--) {
    if (u32(tail, candidate) !== END) {
      continue
    }
    const room = tail.length - candidate - END_BYTES
    if (u16(tail, candidate + 20) === room) {
      at = candidate
      break
    }
    if (at < 0 && u16(tail, candidate + 20) < room) {
      at = candidate
    }
  }
  if (at < 0) {
    throw new Error('no end record: not a zip')
  }
  let disks = [u16(tail, at + 4), u16(tail, at + 6)]
  let onThisDisk = u16(tail, at + 8)
  let count = u16(tail, at + 10)
  let size = u32(tail, at + 12)
  let offset = u32(tail, at + 16)

  // A zip64 archive has a locator just before the end record, pointing at
  // a record with the same fields in 64 bits.
  const locatorAt = tailStart + at - END64_LOCATOR_BYTES
  const locator = locatorAt >= 0 ? readExactly(source, locatorAt, END64_LOCATOR_BYTES, { copy: true }) : null
  if (locator && u32(locator, 0) === END64_LOCATOR) {
    if (u32(locator, 4) !== 0 || u32(locator, 16) > 1) {
      throw new Unsupported('a zip split into parts')
    }
    const record = readExactly(source, u64(locator, 8), END64_BYTES, { copy: true })
    if (u32(record, 0) !== END64) {
      throw new Error('a damaged zip64 end record')
    }
    disks = [u32(record, 16), u32(record, 20)]
    onThisDisk = u64(record, 24)
    count = u64(record, 32)
    size = u64(record, 40)
    offset = u64(record, 48)
  } else if (size === MAX_U32 || offset === MAX_U32) {
    // (A count of 65,535 on its own can be just that many entries.)
    throw new Error('a zip64 archive without its end record')
  }

  if (disks[0] !== 0 || disks[1] !== 0 || onThisDisk !== count) {
    throw new Unsupported('a zip split into parts')
  }
  if (size > MAX_DIRECTORY_BYTES || offset + size > source.size || count * CENTRAL_BYTES > size) {
    throw new Error('a zip directory of an impossible size')
  }
  return { count, size, offset }
}

/**
 * The fields of an extra area: the AES one and the zip64 one picked out,
 * and the rest, with the AES one (`asItIs`) and without (`plain`).
 */
function splitExtra(extra) {
  const plain = []
  let aes = null
  let zip64 = null
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = u16(extra, at)
    const size = u16(extra, at + 2)
    const field = extra.subarray(at, at + 4 + size)
    if (id === AES_EXTRA && size >= 7) {
      aes = { version: u16(field, 4), strength: field[8], method: u16(field, 9), field }
    } else if (id === ZIP64_EXTRA) {
      zip64 = field.subarray(4)
    } else {
      plain.push(field)
    }
    at += 4 + size
  }
  return { aes, zip64, plain, asItIs: aes ? [...plain, aes.field] : plain }
}

/** A zip64 extra field holding these 64-bit values, or nothing for none. */
function zip64Extra(values) {
  const field = new Uint8Array(values.length ? 4 + 8 * values.length : 0)
  if (values.length) {
    putU16(field, 0, ZIP64_EXTRA)
    putU16(field, 2, 8 * values.length)
    values.forEach((value, index) => putU64(field, 4 + 8 * index, value))
  }
  return field
}

/**
 * The directory record at `at`, with its sizes and the entry's place
 * resolved: from the zip64 field, in this order, for each that the
 * record's own field says is there.
 */
function readRecord(directory, at) {
  if (at + CENTRAL_BYTES > directory.length || u32(directory, at) !== CENTRAL) {
    throw new Error('a damaged zip directory')
  }
  const nameLength = u16(directory, at + 28)
  const extraLength = u16(directory, at + 30)
  const length = CENTRAL_BYTES + nameLength + extraLength + u16(directory, at + 32)
  if (at + length > directory.length) {
    throw new Error('a damaged zip directory')
  }
  const record = directory.subarray(at, at + length)
  const extra = splitExtra(record.subarray(CENTRAL_BYTES + nameLength, CENTRAL_BYTES + nameLength + extraLength))

  let from64 = 0
  const whole = (value) => {
    if (value !== MAX_U32) {
      return value
    }
    if (!extra.zip64 || from64 + 8 > extra.zip64.length) {
      throw new Error('a damaged zip64 record')
    }
    from64 += 8
    return u64(extra.zip64, from64 - 8)
  }
  const unpackedSize = whole(u32(record, 24))
  const packedSize = whole(u32(record, 20))
  const localOffset = whole(u32(record, 42))
  // The disk the entry starts on comes last, and in 32 bits.
  let disk = u16(record, 34)
  if (disk === MAX_U16) {
    if (!extra.zip64 || from64 + 4 > extra.zip64.length) {
      throw new Error('a damaged zip64 record')
    }
    disk = u32(extra.zip64, from64)
  }
  if (disk !== 0) {
    throw new Unsupported('a zip split into parts')
  }
  return {
    length,
    record,
    flags: u16(record, 8),
    method: u16(record, 10),
    checksum: u32(record, 16),
    name: record.subarray(CENTRAL_BYTES, CENTRAL_BYTES + nameLength),
    comment: record.subarray(CENTRAL_BYTES + nameLength + extraLength),
    extra,
    unpackedSize,
    packedSize,
    localOffset
  }
}

/** The version of the format an entry needs: at least 4.5 with a zip64 field. */
const versionFor = (fixed, zip64) => (zip64 ? Math.max(u16(fixed, 0), ZIP64_VERSION) : u16(fixed, 0))

/**
 * An entry's local header and its directory record, as they are to be
 * written: as the archive has them but for what `fields` gives, and with
 * zip64 fields where a size or the entry's place needs one.
 *
 * @param {ReturnType<typeof readRecord>} entry
 * @param {number} offset  Where the local header is being written.
 * @param {Uint8Array} fixed  Ten bytes from a header of the entry's,
 *   starting at "version needed": that and the time and date are taken.
 */
function describe(entry, offset, fixed, { flags, method, checksum, packed, extra, localName, localExtra }) {
  const { unpackedSize, name, comment } = entry
  const bigSizes = packed >= MAX_U32 || unpackedSize >= MAX_U32
  const localFields = concat(...localExtra, zip64Extra(bigSizes ? [unpackedSize, packed] : []))
  const header = new Uint8Array(LOCAL_BYTES + localName.length + localFields.length)
  putU32(header, 0, LOCAL)
  putU16(header, 4, versionFor(fixed, bigSizes))
  putU16(header, 6, flags)
  putU16(header, 8, method)
  header.set(fixed.subarray(6, 10), 10) // time and date
  putU32(header, 14, checksum)
  putU32(header, 18, bigSizes ? MAX_U32 : packed)
  putU32(header, 22, bigSizes ? MAX_U32 : unpackedSize)
  putU16(header, 26, localName.length)
  putU16(header, 28, localFields.length)
  header.set(localName, LOCAL_BYTES)
  header.set(localFields, LOCAL_BYTES + localName.length)

  // In the directory, only the values too large for their own fields.
  const large = [unpackedSize, packed, offset].filter((value) => value >= MAX_U32)
  const fields = concat(...extra, zip64Extra(large))
  const record = new Uint8Array(CENTRAL_BYTES + name.length + fields.length + comment.length)
  record.set(entry.record.subarray(0, CENTRAL_BYTES))
  putU16(record, 6, versionFor(fixed, large.length > 0))
  putU16(record, 8, flags)
  putU16(record, 10, method)
  putU32(record, 16, checksum)
  putU32(record, 20, Math.min(packed, MAX_U32))
  putU32(record, 24, Math.min(unpackedSize, MAX_U32))
  putU16(record, 30, fields.length)
  putU16(record, 34, 0) // the disk it starts on
  putU32(record, 42, Math.min(offset, MAX_U32))
  record.set(name, CENTRAL_BYTES)
  record.set(fields, CENTRAL_BYTES + name.length)
  record.set(comment, CENTRAL_BYTES + name.length + fields.length)
  return { header, record, bigSizes }
}

/**
 * Decrypts the AES entries of a zip.
 *
 * @param {object} common  The decrypt-common.mjs module.
 * @param {object} Module  An instantiated sevenzip module.
 * @param {import('./sevenzip-extract.mjs').ByteSource} source  The archive.
 * @param {string} password
 * @param {{ onProgress?: () => void }} [hooks]
 * @returns {import('./decrypt-common.mjs').DecryptResult}
 */
export function decryptZip(common, Module, source, password, hooks = {}) {
  ;({
    CHUNK_BYTES,
    Ciphers,
    Unsupported,
    WrongPassword,
    concat,
    peekExactly,
    putU16,
    putU32,
    readExactly,
    sliceExactly,
    u16,
    u32
  } = common)
  const { onProgress } = hooks
  const passwordBytes = new TextEncoder().encode(password)
  const ciphers = new Ciphers(Module)
  const out = new common.Output()
  /** The directory records to write. */
  const records = []
  let decryptedAny = false
  let unchecked = false
  /** The bytes of the archive the entries seen so far lay claim to. */
  let claimed = 0
  /** AES entries that did not decrypt: turned away at once, and after their data. */
  let refused = 0
  let unauthentic = 0

  /** Writes the entry out as the archive has it: its data untouched. */
  const copyAsItIs = (entry, local) => {
    const { flags, packedSize, unpackedSize, checksum } = entry
    const whole = readExactly(source, entry.localOffset, local.length, { copy: true })
    // Encrypted, with its sizes after the data: that flag stays. In the
    // old scheme it also says which byte the password check is made
    // against. Otherwise the header is given the sizes, from the
    // directory, and what followed the data is not needed.
    const keepsDescriptor = Boolean(flags & FLAG_ENCRYPTED && flags & FLAG_DESCRIPTOR)
    const { header, record, bigSizes } = describe(entry, out.size, whole.subarray(4, 14), {
      flags: keepsDescriptor ? flags : flags & ~FLAG_DESCRIPTOR,
      method: entry.method,
      checksum,
      packed: packedSize,
      extra: entry.extra.asItIs,
      localName: whole.subarray(LOCAL_BYTES, LOCAL_BYTES + local.nameLength),
      localExtra: splitExtra(whole.subarray(LOCAL_BYTES + local.nameLength)).asItIs
    })
    records.push(record)
    out.write(header)
    out.write(sliceExactly(source, local.dataOffset, packedSize))
    if (keepsDescriptor) {
      // Written anew: the checksum and both sizes, in 64 bits where the
      // header says the entry is that large.
      const descriptor = new Uint8Array(bigSizes ? 24 : 16)
      putU32(descriptor, 0, DESCRIPTOR)
      putU32(descriptor, 4, checksum)
      if (bigSizes) {
        putU64(descriptor, 8, packedSize)
        putU64(descriptor, 16, unpackedSize)
      } else {
        putU32(descriptor, 8, packedSize)
        putU32(descriptor, 12, unpackedSize)
      }
      out.write(descriptor)
    }
    onProgress?.()
  }

  /**
   * Decrypts an AES entry's data into the output: `headBytes` of salt and
   * verification bytes, `plainSize` of data, then the authentication code.
   * Returns the checksum of the data (zero unless `wantChecksum`), or why
   * the entry does not decrypt with this password: REFUSED by its two
   * verification bytes, before any data, or UNAUTHENTIC by the code after
   * the data.
   */
  const decryptData = (entry, dataOffset, headBytes, plainSize, wantChecksum) => {
    // Read exactly, and not through the source's read-ahead: with a wrong
    // password this is all that is read of each entry.
    const cipher = ciphers.wzaes(passwordBytes, entry.extra.aes.strength, peekExactly(source, dataOffset, headBytes))
    try {
      ciphers.start(cipher)
      let crc = Ciphers.CRC_START
      for (let left = plainSize, from = dataOffset + headBytes; left > 0; ) {
        const size = Math.min(left, CHUNK_BYTES)
        out.write(ciphers.decrypt(cipher, readExactly(source, from, size)))
        if (wantChecksum) {
          crc = ciphers.crc(crc, size)
        }
        from += size
        left -= size
        onProgress?.()
      }
      // The two verification bytes let one wrong password in 65,536
      // through; the authentication code does not.
      const authentic = ciphers.wzaesCheck(
        cipher,
        readExactly(source, dataOffset + headBytes + plainSize, MAC_BYTES)
      )
      return authentic ? Ciphers.crcOf(crc) : UNAUTHENTIC
    } catch (error) {
      if (error instanceof WrongPassword) {
        return REFUSED
      }
      throw error
    } finally {
      ciphers.free(cipher)
    }
  }

  try {
    const end = readEnd(source)
    const directory = readExactly(source, end.offset, end.size, { copy: true })

    for (let at = 0, index = 0; index < end.count; index++) {
      const entry = readRecord(directory, at)
      at += entry.length
      const { flags, packedSize } = entry
      const { aes } = entry.extra

      const head = peekExactly(source, entry.localOffset, LOCAL_BYTES)
      if (u32(head, 0) !== LOCAL) {
        throw new Error('a zip entry that is not where its directory says')
      }
      const local = { nameLength: u16(head, 26), length: LOCAL_BYTES + u16(head, 26) + u16(head, 28) }
      local.dataOffset = entry.localOffset + local.length
      // Entries that do not overlap never add up to more than the archive.
      // Ones that do (many records naming one entry) would be written out
      // once each: an archive made to be as large as it likes.
      claimed += local.length + packedSize
      if (claimed > source.size) {
        throw new Error('zip entries that overlap')
      }

      if (!(flags & FLAG_ENCRYPTED) || entry.method !== AES_METHOD || !aes) {
        copyAsItIs(entry, local)
        continue
      }

      // An AES entry: salt, two verification bytes, the data, then a
      // 10-byte authentication code.
      if (!SALT_BYTES[aes.strength]) {
        throw new Unsupported('AES of a strength that does not exist')
      }
      const headBytes = SALT_BYTES[aes.strength] + VERIFIER_BYTES
      // An empty entry is written with the AES markings and nothing else:
      // no salt, no authentication code, nothing to decrypt or to check.
      const empty = packedSize === 0
      if (!empty && packedSize < headBytes + MAC_BYTES) {
        throw new Error('an encrypted zip entry too short to be one')
      }
      const plainSize = empty ? 0 : packedSize - headBytes - MAC_BYTES
      const stored = aes.method === STORED

      // The header is written once the data has been through, since it
      // may carry the data's checksum; hold its place.
      const offset = out.size
      out.reserve()
      const crc = empty ? 0 : decryptData(entry, local.dataOffset, headBytes, plainSize, stored)
      if (crc === REFUSED || crc === UNAUTHENTIC) {
        // The entry did not decrypt. That is a wrong password, or this
        // entry damaged (or under a password of its own), and one entry
        // cannot say which. It is left as it is, which a reader will show
        // as a page it cannot read, and the rest are tried: one that
        // decrypts proves the password.
        out.discard()
        if (crc === UNAUTHENTIC) {
          unauthentic++
        } else if (++refused >= REFUSALS_TO_CONDEMN && !decryptedAny) {
          // The verification bytes come first and cost next to nothing,
          // but an archive can be made of any number of entries. This
          // many that will not even start, and none that has decrypted,
          // is a wrong password.
          throw new WrongPassword()
        }
        copyAsItIs(entry, local)
        continue
      }
      decryptedAny ||= !empty

      // The entry's checksum. The first version of the scheme (AE-1) keeps
      // the real one; the second (AE-2) stores zero, relying on the
      // authentication code that has just been checked. A stored entry's
      // is what was just computed. A compressed entry's would take
      // decompressing, so it stays as the archive has it, and the caller
      // is told that not every checksum in what is written is one.
      unchecked ||= !stored && !empty && aes.version === AE_2
      const { header, record } = describe(entry, offset, entry.record.subarray(6, 16), {
        flags: flags & ~(FLAG_ENCRYPTED | FLAG_DESCRIPTOR),
        method: aes.method,
        checksum: stored ? crc : entry.checksum,
        packed: plainSize,
        extra: entry.extra.plain,
        localName: entry.name,
        localExtra: entry.extra.plain
      })
      records.push(record)
      out.fill(header)
    }

    if (!decryptedAny) {
      // Nothing decrypted. Entries whose verification bytes accepted the
      // password and whose data then failed its authentication code, with
      // none that refused it outright: the password is right (those bytes
      // let one wrong password in 65,536 through) and the data is damaged.
      if (unauthentic && !refused) {
        throw new Error('encrypted zip entries that are all damaged')
      }
      // Otherwise nothing was AES-encrypted, or the password is wrong.
      return { status: refused || unauthentic ? 'wrong-password' : 'not-encrypted' }
    }

    const directoryOffset = out.size
    records.forEach((record) => out.write(record))
    const directorySize = out.size - directoryOffset
    if (records.length >= MAX_U16 || directorySize >= MAX_U32 || directoryOffset >= MAX_U32) {
      const end64 = new Uint8Array(END64_BYTES + END64_LOCATOR_BYTES)
      putU32(end64, 0, END64)
      putU64(end64, 4, END64_BYTES - 12) // the length of the rest of this record
      putU16(end64, 12, ZIP64_VERSION)
      putU16(end64, 14, ZIP64_VERSION)
      putU64(end64, 24, records.length)
      putU64(end64, 32, records.length)
      putU64(end64, 40, directorySize)
      putU64(end64, 48, directoryOffset)
      putU32(end64, END64_BYTES, END64_LOCATOR)
      putU64(end64, END64_BYTES + 8, out.size)
      putU32(end64, END64_BYTES + 16, 1) // one disk
      out.write(end64)
    }
    const tail = new Uint8Array(END_BYTES)
    putU32(tail, 0, END)
    putU16(tail, 8, Math.min(records.length, MAX_U16))
    putU16(tail, 10, Math.min(records.length, MAX_U16))
    putU32(tail, 12, Math.min(directorySize, MAX_U32))
    putU32(tail, 16, Math.min(directoryOffset, MAX_U32))
    out.write(tail)
    // An entry decrypted and passed its authentication code: the password is right.
    return { status: 'decrypted', archive: out.finish(), proven: true, unchecked }
  } catch (error) {
    return common.resultFor(error)
  } finally {
    ciphers.close()
  }
}
