/**
 * A minimal RAR4 header walker, used only to count what the container claims
 * to hold.
 *
 * This exists because of a concrete libarchive limitation: in a *solid* RAR4
 * archive it enumerates only the first entry and silently drops the rest. A
 * solid RAR4 comic therefore opens as a one-page comic with no error — the
 * worst kind of failure, because it looks like success.
 *
 * Counting the file headers here lets the reader compare its own count with
 * what the decoder produced and tell the user when pages are missing. It does
 * not recover them; the limitation is inside libarchive.
 *
 * Deliberately narrow: it walks the header chain and reads sizes, and never
 * touches compressed data. Every failure returns null, because a wrong guess
 * here would produce a false warning on a perfectly good comic.
 */

import { RAR4_MAGIC as MARKER } from './detect'

const BLOCK_MAIN = 0x73
const BLOCK_FILE = 0x74
const BLOCK_END = 0x7b

/** Main archive header: the whole archive is one solid block. */
const MHD_SOLID = 0x0008

/** File header: this entry continues the previous entry's solid block. */
const LHD_SOLID = 0x0010
/** File header: this entry's data is encrypted. */
const LHD_PASSWORD = 0x0004
/** File header: 64-bit sizes are present, shifting the name field by 8 bytes. */
const LHD_LARGE = 0x0100
/** Block header: a data area follows the header and is counted separately. */
const LONG_BLOCK = 0x8000

/** Entries are directories rather than files. */
const LHD_DIRECTORY = 0xe0

/** HOST_OS value meaning ATTR holds a Unix st_mode rather than DOS flags. */
const HOST_OS_UNIX = 3
const S_IFMT = 0xf000
const S_IFLNK = 0xa000

export interface Rar4Inspection {
  /** File entries the container declares, directories excluded. */
  entryCount: number
  /** Whether the archive is marked solid, at archive or entry level. */
  solid: boolean
  /** Whether any file entry is password protected. */
  encrypted: boolean
}

/** How much of a Blob is read at a time while walking its headers. */
const WINDOW_BYTES = 64 * 1024

/**
 * Random access to the archive's bytes, a window at a time.
 *
 * The walk only ever needs a few dozen bytes at the start of each block, with
 * the compressed data between them skipped by offset. Reading the whole file
 * into memory to do that would cost as much as the archive itself, so a Blob
 * is read in small windows and nothing but the current one is ever held.
 */
class ByteWindow {
  private window = new Uint8Array(0)
  private windowStart = 0

  constructor(private readonly source: Uint8Array | Blob) {}

  get length(): number {
    return this.source instanceof Blob ? this.source.size : this.source.byteLength
  }

  /** A view of `length` bytes at `offset`, or null when the source ends first. */
  async read(offset: number, length: number): Promise<DataView | null> {
    if (offset < 0 || offset + length > this.length) {
      return null
    }
    const { source } = this
    if (!(source instanceof Blob)) {
      return new DataView(source.buffer, source.byteOffset + offset, length)
    }
    const windowEnd = this.windowStart + this.window.byteLength
    if (offset < this.windowStart || offset + length > windowEnd) {
      const size = Math.max(WINDOW_BYTES, length)
      this.window = new Uint8Array(await source.slice(offset, offset + size).arrayBuffer())
      this.windowStart = offset
    }
    return new DataView(this.window.buffer, offset - this.windowStart, length)
  }
}

/**
 * Walks the RAR4 block chain. Resolves to null for anything that is not a
 * RAR4 archive, or whose structure does not parse cleanly.
 */
export async function inspectRar4(source: Uint8Array | Blob): Promise<Rar4Inspection | null> {
  const bytes = new ByteWindow(source)
  if (bytes.length < 20) {
    return null
  }

  try {
    const marker = await bytes.read(0, MARKER.length)
    if (!marker || !MARKER.every((byte, index) => marker.getUint8(index) === byte)) {
      return null
    }

    let offset = MARKER.length
    let entryCount = 0
    let solid = false
    let encrypted = false
    // A malformed archive must not be able to spin this loop forever.
    let blocks = 0

    while (blocks++ < 100_000) {
      const head = await bytes.read(offset, 7)
      if (!head) {
        break
      }
      const type = head.getUint8(2)
      const flags = head.getUint16(3, true)
      const headerSize = head.getUint16(5, true)

      if (headerSize < 7) {
        return null
      }

      if (type === BLOCK_END) {
        break
      }

      if (type === BLOCK_MAIN) {
        if (flags & MHD_SOLID) {
          solid = true
        }
        offset += headerSize
        continue
      }

      if (type === BLOCK_FILE) {
        const fixed = await bytes.read(offset, 32)
        if (!fixed) {
          return null
        }
        let packedSize = fixed.getUint32(7, true)
        if (flags & LHD_LARGE) {
          // High 32 bits sit immediately after the fixed header fields.
          const high = await bytes.read(offset + 32, 4)
          if (!high) {
            return null
          }
          packedSize += high.getUint32(0, true) * 2 ** 32
        }
        const hostOs = fixed.getUint8(15)
        const attributes = fixed.getUint32(28, true)
        const isDirectory = (flags & LHD_DIRECTORY) === LHD_DIRECTORY
        // libarchive does not surface symlinks through this API, so counting
        // them here would report a shortfall on a perfectly intact archive.
        // Every non-solid mismatch observed across libarchive's own RAR test
        // corpus was exactly this.
        const isSymlink = hostOs === HOST_OS_UNIX && (attributes & S_IFMT) === S_IFLNK

        if (flags & LHD_SOLID) {
          solid = true
        }
        // Any encrypted file makes the whole comic one this reader cannot
        // show in full, and neither decoder says so on its own: libarchive
        // looks at the first entry only and then feeds ciphertext to the
        // decompressor, unarr lists the entries and fails each read. Every
        // other format is refused on its first encrypted entry too.
        if (flags & LHD_PASSWORD && !isDirectory) {
          encrypted = true
        }
        if (!isDirectory && !isSymlink) {
          entryCount++
        }

        // A file block's data area is skipped whatever its flags say, as the
        // decoders do. Honouring the flag here would let a crafted header
        // make this walk read the data as headers and disagree with them.
        offset += headerSize + packedSize
        continue
      }

      // Any other block type: skip it, honouring its data area if present.
      let addSize = 0
      if (flags & LONG_BLOCK) {
        const size = await bytes.read(offset + 7, 4)
        if (!size) {
          return null
        }
        addSize = size.getUint32(0, true)
      }
      offset += headerSize + addSize
    }

    return entryCount > 0 ? { entryCount, solid, encrypted } : null
  } catch {
    // Unreadable or malformed; better to say nothing than to warn wrongly.
    return null
  }
}
