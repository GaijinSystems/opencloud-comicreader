/**
 * Minimal reader for the ComicInfo.xml sidecar that most taggers (ComicRack,
 * Komga, Kavita, ComicTagger) write into comic archives.
 *
 * Parses the common descriptive fields; the reader currently acts on series,
 * number, title, the Manga flag and the page list. Everything is optional
 * and best-effort: a malformed or partial ComicInfo must never stop
 * a comic from opening, so every failure path returns nulls rather than
 * throwing.
 */

/** The sidecar's file name. Matched case-insensitively, at any depth. */
export const COMIC_INFO_FILE = 'ComicInfo.xml'

export type ReadingDirection = 'ltr' | 'rtl'

export interface ComicInfoPage {
  /** 0-based image index as written in the file. */
  image: number
  type?: string
  bookmark?: string
  doublePage?: boolean
}

export interface ComicInfo {
  title?: string
  series?: string
  number?: string
  volume?: string
  count?: number
  summary?: string
  writer?: string
  publisher?: string
  year?: number
  month?: number
  languageIso?: string
  pageCount?: number
  /** Derived from the `Manga` element: `YesAndRightToLeft` means RTL. */
  readingDirection?: ReadingDirection
  pages: ComicInfoPage[]
}

/** Page types that are informational rather than story content. */
const NON_STORY_PAGE_TYPES = new Set(['deleted'])

function textOf(parent: Element, tag: string): string | undefined {
  const node = parent.querySelector(`:scope > ${tag}`)
  const value = node?.textContent?.trim()
  return value ? value : undefined
}

function numberOf(parent: Element, tag: string): number | undefined {
  const raw = textOf(parent, tag)
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parses a ComicInfo.xml document.
 *
 * Uses DOMParser rather than a bundled XML library: the document is tiny, the
 * browser parser is already there, and it will not execute anything, since
 * the result is only ever read as text.
 */
export function parseComicInfo(xml: string): ComicInfo | null {
  if (!xml || !xml.trim()) {
    return null
  }

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml')
  } catch {
    return null
  }

  // DOMParser reports XML syntax errors as a document containing parsererror.
  if (doc.querySelector('parsererror')) {
    return null
  }

  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'comicinfo') {
    return null
  }

  const manga = textOf(root, 'Manga')?.toLowerCase()

  const pages: ComicInfoPage[] = []
  root.querySelectorAll('Pages > Page').forEach((page) => {
    const image = Number.parseInt(page.getAttribute('Image') ?? '', 10)
    if (!Number.isFinite(image)) {
      return
    }
    pages.push({
      image,
      type: page.getAttribute('Type') ?? undefined,
      bookmark: page.getAttribute('Bookmark') ?? undefined,
      doublePage: page.getAttribute('DoublePage') === 'true'
    })
  })

  return {
    title: textOf(root, 'Title'),
    series: textOf(root, 'Series'),
    number: textOf(root, 'Number'),
    volume: textOf(root, 'Volume'),
    count: numberOf(root, 'Count'),
    summary: textOf(root, 'Summary'),
    writer: textOf(root, 'Writer'),
    publisher: textOf(root, 'Publisher'),
    year: numberOf(root, 'Year'),
    month: numberOf(root, 'Month'),
    languageIso: textOf(root, 'LanguageISO'),
    pageCount: numberOf(root, 'PageCount'),
    readingDirection: manga === 'yesandrighttoleft' ? 'rtl' : undefined,
    pages
  }
}

/**
 * Image indices ComicInfo marks as deleted. Callers map these onto entry
 * names before handing them to `buildPageList`.
 */
export function deletedPageIndices(info: ComicInfo | null): Set<number> {
  const deleted = new Set<number>()
  info?.pages.forEach((page) => {
    if (page.type && NON_STORY_PAGE_TYPES.has(page.type.toLowerCase())) {
      deleted.add(page.image)
    }
  })
  return deleted
}

/** Page indices the reader should always render alone, never paired. */
export function doublePageIndices(info: ComicInfo | null): Set<number> {
  const doubles = new Set<number>()
  info?.pages.forEach((page) => {
    if (page.doublePage) {
      doubles.add(page.image)
    }
  })
  return doubles
}

export interface Bookmark {
  page: number
  label: string
}

export function bookmarksOf(info: ComicInfo | null): Bookmark[] {
  if (!info) {
    return []
  }
  return info.pages
    .filter((page) => Boolean(page.bookmark))
    .map((page) => ({ page: page.image, label: page.bookmark as string }))
    .sort((a, b) => a.page - b.page)
}

/** Title derived from the metadata alone, or null when it offers none. */
export function metadataTitle(info: ComicInfo | null): string | null {
  if (!info) {
    return null
  }
  const parts: string[] = []
  if (info.series) {
    parts.push(info.series)
  }
  if (info.number) {
    parts.push(`#${info.number}`)
  }
  if (!parts.length) {
    return info.title ?? null
  }
  if (info.title && info.title !== info.series) {
    return `${parts.join(' ')} — ${info.title}`
  }
  return parts.join(' ')
}

/** Human-readable title, falling back to the file name. */
export function displayTitle(info: ComicInfo | null, fileName: string): string {
  return metadataTitle(info) ?? fileName
}
