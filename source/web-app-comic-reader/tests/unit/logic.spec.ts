import { describe, it, expect } from 'vitest'
import { buildSpreads, spreadIndexOfPage, leadPageOfSpread } from '../../src/helpers/spread'
import {
  parseComicInfo,
  deletedPageIndices,
  doublePageIndices,
  bookmarksOf,
  displayTitle,
  metadataTitle
} from '../../src/archive/comicInfo'
import { formatFromMagic, formatFromFileName, resolveFormat } from '../../src/archive/detect'
import { readConfig, DEFAULT_CONFIG } from '../../src/config'

describe('buildSpreads', () => {
  it('gives the cover a row of its own, then pairs', () => {
    expect(buildSpreads(7)).toEqual([[0], [1, 2], [3, 4], [5, 6]])
  })

  it('can pair from the very first page', () => {
    expect(buildSpreads(6, { coverAlone: false })).toEqual([
      [0, 1],
      [2, 3],
      [4, 5]
    ])
  })

  it('leaves a trailing odd page alone', () => {
    expect(buildSpreads(4)).toEqual([[0], [1, 2], [3]])
  })

  it('reverses within a row for right-to-left reading', () => {
    expect(buildSpreads(5, { rightToLeft: true })).toEqual([[0], [2, 1], [4, 3]])
  })

  it('gives a wide page its own row and re-phases what follows', () => {
    // Page 2 is a genuine double-page spread stored as one wide image.
    expect(buildSpreads(6, { widePages: new Set([2]) })).toEqual([[0], [1], [2], [3, 4], [5]])
  })

  it('never pairs a wide page as the right half of a row', () => {
    const spreads = buildSpreads(5, { widePages: new Set([2]) })
    expect(spreads.every((row) => row.length === 1 || !row.includes(2))).toBe(true)
  })

  it('handles an empty comic', () => {
    expect(buildSpreads(0)).toEqual([])
  })

  it('handles a single page', () => {
    expect(buildSpreads(1)).toEqual([[0]])
  })

  it('covers every page exactly once, for any wide-page arrangement', () => {
    for (const wide of [[], [0], [1], [3], [0, 1, 2], [2, 5]]) {
      const spreads = buildSpreads(9, { widePages: new Set(wide) })
      const seen = spreads.flat().sort((a, b) => a - b)
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    }
  })
})

describe('spread helpers', () => {
  it('finds the row holding a page', () => {
    const spreads = buildSpreads(7)
    expect(spreadIndexOfPage(spreads, 4)).toBe(2)
  })

  it('reports the lowest page of a row, even when reversed', () => {
    expect(leadPageOfSpread([4, 3])).toBe(3)
    expect(leadPageOfSpread([])).toBe(0)
    expect(leadPageOfSpread(undefined)).toBe(0)
  })
})

const SAMPLE_COMIC_INFO = `<?xml version="1.0"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>The First Issue</Title>
  <Series>Test Comic</Series>
  <Number>3</Number>
  <Count>12</Count>
  <Writer>A. Writer</Writer>
  <Publisher>Test Press</Publisher>
  <Year>1998</Year>
  <PageCount>4</PageCount>
  <Manga>YesAndRightToLeft</Manga>
  <Pages>
    <Page Image="0" Type="FrontCover" />
    <Page Image="1" Bookmark="Chapter One" />
    <Page Image="2" DoublePage="true" />
    <Page Image="3" Type="Deleted" />
  </Pages>
</ComicInfo>`

describe('parseComicInfo', () => {
  it('reads the fields the reader acts on', () => {
    const info = parseComicInfo(SAMPLE_COMIC_INFO)
    expect(info?.series).toBe('Test Comic')
    expect(info?.number).toBe('3')
    expect(info?.count).toBe(12)
    expect(info?.year).toBe(1998)
    expect(info?.pageCount).toBe(4)
    expect(info?.pages).toHaveLength(4)
  })

  it('maps the Manga flag onto reading direction', () => {
    expect(parseComicInfo(SAMPLE_COMIC_INFO)?.readingDirection).toBe('rtl')
    expect(
      parseComicInfo('<ComicInfo><Manga>Yes</Manga></ComicInfo>')?.readingDirection
    ).toBeUndefined()
  })

  it('returns null rather than throwing on junk', () => {
    expect(parseComicInfo('')).toBeNull()
    expect(parseComicInfo('not xml at all <<<')).toBeNull()
    expect(parseComicInfo('<SomethingElse/>')).toBeNull()
  })

  it('survives a document with no Pages element', () => {
    const info = parseComicInfo('<ComicInfo><Series>Solo</Series></ComicInfo>')
    expect(info?.series).toBe('Solo')
    expect(info?.pages).toEqual([])
  })

  it('ignores Page elements without a usable Image attribute', () => {
    const info = parseComicInfo('<ComicInfo><Pages><Page Type="Story"/></Pages></ComicInfo>')
    expect(info?.pages).toEqual([])
  })
})

describe('comic info derivations', () => {
  const info = parseComicInfo(SAMPLE_COMIC_INFO)

  it('collects deleted pages', () => {
    expect([...deletedPageIndices(info)]).toEqual([3])
  })

  it('collects double pages', () => {
    expect([...doublePageIndices(info)]).toEqual([2])
  })

  it('collects bookmarks in page order', () => {
    expect(bookmarksOf(info)).toEqual([{ page: 1, label: 'Chapter One' }])
  })

  it('builds a display title from series and number', () => {
    expect(displayTitle(info, 'file.cbz')).toBe('Test Comic #3 — The First Issue')
  })

  it('falls back to the file name without metadata', () => {
    expect(displayTitle(null, 'file.cbz')).toBe('file.cbz')
  })

  it('tolerates null everywhere', () => {
    expect(deletedPageIndices(null).size).toBe(0)
    expect(doublePageIndices(null).size).toBe(0)
    expect(bookmarksOf(null)).toEqual([])
  })
})

describe('format detection', () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
  const rar4 = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00])
  const rar5 = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
  const sevenZip = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x00])

  it('recognises each container from its header', () => {
    expect(formatFromMagic(zip)).toBe('cbz')
    expect(formatFromMagic(rar4)).toBe('cbr')
    expect(formatFromMagic(rar5)).toBe('cbr')
    expect(formatFromMagic(sevenZip)).toBe('cb7')
  })

  it('maps all four registered extensions', () => {
    expect(formatFromFileName('a.cbz')).toBe('cbz')
    expect(formatFromFileName('a.CBR')).toBe('cbr')
    expect(formatFromFileName('a.cb7')).toBe('cb7')
    expect(formatFromFileName('a.c7z')).toBe('cb7')
    expect(formatFromFileName('a.pdf')).toBeNull()
    // Not what every object inherits, either.
    expect(formatFromFileName('a.constructor')).toBeNull()
    expect(formatFromFileName('a.__proto__')).toBeNull()
  })

  it('trusts the magic bytes over a misleading extension', () => {
    // Mislabelled comics are common: plenty of .cbr files are really zips.
    expect(resolveFormat('mislabelled.cbr', zip)).toBe('cbz')
  })

  it('falls back to the extension when the header is unrecognised', () => {
    expect(resolveFormat('real.cbz', new Uint8Array([1, 2, 3, 4]))).toBe('cbz')
  })

  it('does not take the extension\'s word for a .cbr or .cb7 with an unknown header', () => {
    const tar = new Uint8Array(8).fill(0x61)
    expect(resolveFormat('really-a-tar.cbr', tar)).toBeNull()
    expect(resolveFormat('really-a-tar.cb7', tar)).toBeNull()
    // A zip is located from its end, so a prefix does not disqualify it.
    expect(resolveFormat('prefixed.cbz', tar)).toBe('cbz')
    // No header to go by: the extension is all there is.
    expect(resolveFormat('unprobed.cbr')).toBe('cbr')
    expect(resolveFormat('unprobed.cbr', new Uint8Array(0))).toBe('cbr')
    // Nor is a header too short to rule anything out.
    expect(resolveFormat('short.cbr', new Uint8Array([1, 2, 3, 4]))).toBe('cbr')
  })

  it('returns null when neither signal identifies a comic', () => {
    expect(resolveFormat('notes.txt', new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

describe('readConfig', () => {
  it('returns defaults for empty input', () => {
    expect(readConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(readConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('accepts valid overrides', () => {
    const config = readConfig({ maxArchiveSizeMb: 2048, defaultFitMode: 'fit-width' })
    expect(config.maxArchiveSizeMb).toBe(2048)
    expect(config.defaultFitMode).toBe('fit-width')
  })

  it('clamps out-of-range numbers instead of trusting them', () => {
    expect(readConfig({ cacheRadius: 0 }).cacheRadius).toBe(1)
    expect(readConfig({ cacheRadius: 9999 }).cacheRadius).toBe(64)
    expect(readConfig({ maxArchiveSizeMb: -5 }).maxArchiveSizeMb).toBe(1)
  })

  it('falls back on nonsense values rather than propagating them', () => {
    expect(readConfig({ cacheRadius: 'lots' }).cacheRadius).toBe(DEFAULT_CONFIG.cacheRadius)
    expect(readConfig({ defaultFitMode: 'sideways' }).defaultFitMode).toBe(
      DEFAULT_CONFIG.defaultFitMode
    )
    expect(readConfig({ enableJxl: 'yes' }).enableJxl).toBe(false)
  })
})

describe('toolbar title derivation', () => {
  // The computed in App.vue: show the ComicInfo title, but fall back to empty
  // rather than the file name, since the app bar already shows that.
  const derive = (info: ReturnType<typeof parseComicInfo>, _fileName: string) =>
    metadataTitle(info) ?? ''

  it('shows series and issue when ComicInfo provides them', () => {
    const info = parseComicInfo(
      '<ComicInfo><Series>Comic Reader Test</Series><Number>1</Number></ComicInfo>'
    )
    expect(derive(info, 'test-comic.cbz')).toBe('Comic Reader Test #1')
  })

  it('is empty when there is no ComicInfo at all', () => {
    expect(derive(null, 'test-comic.cbz')).toBe('')
  })

  it('is empty when ComicInfo carries nothing worth showing', () => {
    const info = parseComicInfo('<ComicInfo><Writer>Someone</Writer></ComicInfo>')
    expect(derive(info, 'test-comic.cbz')).toBe('')
  })
})
