/**
 * Builds a structurally valid RAR4 archive by hand, for tests of the code
 * that reads RAR4 headers. The members hold zeros, not compressed data, so
 * this is for header walking and back-end selection, never for decoding.
 */
export interface SyntheticRar4Options {
  members?: number
  /** Bytes of (fake) packed data after each file header. */
  packedBytes?: number
  solid?: boolean
  /** Password-flag every entry, or only those from the given index on. */
  encrypted?: boolean | number
}

const MARKER = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]

export function syntheticRar4({
  members = 3,
  packedBytes = 64,
  solid = false,
  encrypted = false
}: SyntheticRar4Options = {}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array(MARKER)]

  const main = new Uint8Array(13)
  main[2] = 0x73
  new DataView(main.buffer).setUint16(3, solid ? 0x0008 : 0, true)
  new DataView(main.buffer).setUint16(5, 13, true)
  parts.push(main)

  for (let index = 0; index < members; index++) {
    const name = new TextEncoder().encode(`page${index}.png`)
    const header = new Uint8Array(32 + name.length)
    const view = new DataView(header.buffer)
    header[2] = 0x74
    // 0x8000: a data area follows. 0x0010: continues a solid block (never the
    // first entry). 0x0004: password protected.
    const isEncrypted = typeof encrypted === 'number' ? index >= encrypted : encrypted
    const flags = 0x8000 | (solid && index > 0 ? 0x0010 : 0) | (isEncrypted ? 0x0004 : 0)
    view.setUint16(3, flags, true)
    view.setUint16(5, header.length, true)
    view.setUint32(7, packedBytes, true)
    view.setUint32(11, packedBytes, true)
    header[15] = 2 // Windows host
    view.setUint16(26, name.length, true)
    view.setUint32(28, 0x20, true)
    header.set(name, 32)
    parts.push(header, new Uint8Array(packedBytes))
  }

  const end = new Uint8Array(7)
  end[2] = 0x7b
  new DataView(end.buffer).setUint16(5, 7, true)
  parts.push(end)

  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    whole.set(part, offset)
    offset += part.length
  }
  return whole
}
