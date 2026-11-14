import type { ArchiveEntry, ComicPage } from './types'

/**
 * Raster formats only. SVG is deliberately excluded: an SVG page would be a
 * script execution vector, and no real comic archive uses one.
 */
// (A format added here needs its signature added to looksLikeContent in
// public/vendor/sevenzip/sevenzip-extract.mjs, which recognises pages by
// their first bytes where a 7z gives it nothing else to go by.)
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  jxl: 'image/jxl'
}

/** Every extension a page can have, including the opt-in ones. */
export const PAGE_EXTENSIONS = Object.keys(IMAGE_MIME_BY_EXTENSION)

/** Extensions that need an explicit opt-in because browser support is partial. */
const OPT_IN_EXTENSIONS = new Set(['jxl'])

function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

export function extensionOf(name: string): string {
  const base = baseName(name)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function mimeTypeForImage(name: string): string | null {
  // Own keys only: the name comes from an archive, and a plain lookup would
  // answer for `page.constructor` or `page.__proto__` with what every object
  // inherits.
  const extension = extensionOf(name)
  return Object.hasOwn(IMAGE_MIME_BY_EXTENSION, extension) ? IMAGE_MIME_BY_EXTENSION[extension] : null
}

/**
 * Junk that turns up inside real-world comic archives and must never be shown
 * as a page. macOS resource forks are by far the most common offender.
 */
export function isJunkEntry(name: string): boolean {
  const segments = name.split('/')
  const base = segments[segments.length - 1]
  if (!base) {
    return true
  }
  if (segments.some((segment) => segment === '__MACOSX' || segment === '.DS_Store')) {
    return true
  }
  // Hidden files, including AppleDouble sidecars (`._page.png`), which carry
  // the same extension as the page they shadow.
  if (base.startsWith('.')) {
    return true
  }
  if (segments.some((segment) => segment.toLowerCase() === 'thumbs.db')) {
    return true
  }
  return false
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Natural order, so `page2.jpg` precedes `page10.jpg`.
 *
 * Sorting is done per path segment rather than on the whole string, otherwise
 * `Ch 2/p1.jpg` and `Ch 10/p1.jpg` can interleave when segment counts differ.
 */
export function compareEntryNames(a: string, b: string): number {
  const left = a.split('/')
  const right = b.split('/')
  const shared = Math.min(left.length, right.length)

  for (let i = 0; i < shared; i++) {
    const compared = collator.compare(left[i], right[i])
    if (compared !== 0) {
      return compared
    }
  }

  // Same prefix: the shallower path wins, so a cover sitting at the archive
  // root precedes the chapter folders beside it.
  if (left.length !== right.length) {
    return left.length - right.length
  }
  // Collator ties (e.g. `a.jpg` vs `A.jpg`) still need a stable resolution.
  return a < b ? -1 : a > b ? 1 : 0
}

export interface BuildPageListOptions {
  /** Include formats browsers may not decode natively. Default false. */
  enableJxl?: boolean
  /** Entry names ComicInfo.xml flagged as deleted, so they are skipped. */
  excludedNames?: Set<string>
}

/**
 * Turns raw archive members into the ordered page list the reader renders.
 * Pure, synchronous, and the single source of truth for reading order.
 */
export function buildPageList(
  entries: ArchiveEntry[],
  { enableJxl = false, excludedNames }: BuildPageListOptions = {}
): ComicPage[] {
  const candidates = entries.filter((entry) => {
    if (entry.isDirectory) {
      return false
    }
    if (isJunkEntry(entry.name)) {
      return false
    }
    if (excludedNames?.has(entry.name)) {
      return false
    }
    const extension = extensionOf(entry.name)
    if (!enableJxl && OPT_IN_EXTENSIONS.has(extension)) {
      return false
    }
    return Object.hasOwn(IMAGE_MIME_BY_EXTENSION, extension)
  })

  candidates.sort((a, b) => compareEntryNames(a.name, b.name))

  return candidates.map((entry, index) => ({
    index,
    entryIndex: entry.index,
    name: entry.name,
    size: entry.size,
    mimeType: mimeTypeForImage(entry.name) as string
  }))
}

/** Case-insensitive lookup for metadata members, which vary in casing. */
export function findEntryByName(entries: ArchiveEntry[], name: string): ArchiveEntry | undefined {
  const wanted = name.toLowerCase()
  return entries.find((entry) => {
    if (entry.isDirectory) {
      return false
    }
    return baseName(entry.name).toLowerCase() === wanted && !isJunkEntry(entry.name)
  })
}
