import { COMIC_EXTENSIONS, type ComicFormat } from './types'
import { extensionOf } from './pageSort'

/** RAR 1.5–4.x signature; also the gate for the RAR4 header walker. */
export const RAR4_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]

/** Container signatures, checked against the first bytes of the file. */
const SIGNATURES: Array<{ format: ComicFormat; magic: number[] }> = [
  // Local file header, empty archive, and spanned-archive markers.
  { format: 'cbz', magic: [0x50, 0x4b, 0x03, 0x04] },
  { format: 'cbz', magic: [0x50, 0x4b, 0x05, 0x06] },
  { format: 'cbz', magic: [0x50, 0x4b, 0x07, 0x08] },
  { format: 'cbr', magic: RAR4_MAGIC },
  // RAR 5.0
  { format: 'cbr', magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00] },
  // 7z
  { format: 'cb7', magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }
]

export function formatFromFileName(name: string): ComicFormat | null {
  const extension = extensionOf(name)
  return Object.hasOwn(COMIC_EXTENSIONS, extension) ? COMIC_EXTENSIONS[extension] : null
}

/**
 * Detects the real container from the file header.
 *
 * Worth doing because mislabelled comics are common: plenty of `.cbr` files in
 * circulation are actually zips, and opening them with the RAR back end fails
 * for no reason the user can understand.
 */
export function formatFromMagic(head: Uint8Array): ComicFormat | null {
  for (const { format, magic } of SIGNATURES) {
    if (head.length < magic.length) {
      continue
    }
    if (magic.every((byte, i) => head[i] === byte)) {
      return format
    }
  }
  return null
}

/** Number of leading bytes `resolveFormat` needs. */
export const MAGIC_PROBE_BYTES = 8

/**
 * Magic wins over the extension; the extension is only a fallback, and only
 * where it is safe to be wrong.
 *
 * That is when the header could not be read at all, and for `.cbz`: a zip is
 * found from its end, so one with something in front of it is still a zip,
 * and the zip reader is plain JavaScript. A `.cbr` or `.cb7` whose header is
 * none of the known ones is refused instead: nothing in its header says it
 * is a RAR or 7z, and finding out would mean downloading it whole and
 * handing it to a WebAssembly decoder.
 */
export function resolveFormat(name: string, head?: Uint8Array): ComicFormat | null {
  const byName = formatFromFileName(name)
  if (!head?.length) {
    return byName
  }
  const detected = formatFromMagic(head)
  if (detected) {
    return detected
  }
  return head.length >= MAGIC_PROBE_BYTES && byName !== 'cbz' ? null : byName
}
