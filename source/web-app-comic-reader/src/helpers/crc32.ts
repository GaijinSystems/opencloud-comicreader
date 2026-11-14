/**
 * CRC-32 as zip uses it (IEEE 802.3, reflected), as an unsigned number.
 *
 * For the one place a zip entry's checksum is not compared by the decoder:
 * libarchive, reading an encrypted entry (see libarchiveAdapter.ts).
 */

let table: Uint32Array | null = null

function buildTable(): Uint32Array {
  const built = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    built[index] = value >>> 0
  }
  return built
}

export function crc32(bytes: Uint8Array): number {
  table ??= buildTable()
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    crc = table[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
