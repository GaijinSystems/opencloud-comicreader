import { describe, it, expect } from 'vitest'
import {
  buildPageList,
  compareEntryNames,
  extensionOf,
  findEntryByName,
  isJunkEntry,
  mimeTypeForImage
} from '../../src/archive/pageSort'
import type { ArchiveEntry } from '../../src/archive/types'

function entries(...names: string[]): ArchiveEntry[] {
  return names.map((name, index) => ({
    index,
    name,
    size: 1000,
    isDirectory: name.endsWith('/')
  }))
}

describe('extensionOf', () => {
  it('reads the extension of a nested path', () => {
    expect(extensionOf('Chapter 1/page01.JPG')).toBe('jpg')
  })

  it('returns empty for dotfiles and extensionless names', () => {
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('README')).toBe('')
  })
})

describe('mimeTypeForImage', () => {
  it.each(['page.constructor', 'page.__proto__', 'page.CONSTRUCTOR'])(
    'does not take %s for an image because every object has that key',
    (name) => {
      expect(mimeTypeForImage(name)).toBeNull()
      expect(buildPageList([{ index: 0, name, size: 1, isDirectory: false }])).toEqual([])
    }
  )

  it('maps the common page formats', () => {
    expect(mimeTypeForImage('a.jpeg')).toBe('image/jpeg')
    expect(mimeTypeForImage('a.png')).toBe('image/png')
    expect(mimeTypeForImage('a.webp')).toBe('image/webp')
  })

  it('refuses svg, which would be a script vector', () => {
    expect(mimeTypeForImage('a.svg')).toBeNull()
  })
})

describe('isJunkEntry', () => {
  it('drops macOS resource forks', () => {
    expect(isJunkEntry('__MACOSX/page01.jpg')).toBe(true)
    expect(isJunkEntry('Chapter 1/._page01.jpg')).toBe(true)
    expect(isJunkEntry('.DS_Store')).toBe(true)
  })

  it('drops Thumbs.db regardless of case', () => {
    expect(isJunkEntry('thumbs.db')).toBe(true)
    expect(isJunkEntry('Sub/Thumbs.db')).toBe(true)
  })

  it('keeps ordinary pages', () => {
    expect(isJunkEntry('Chapter 1/page01.jpg')).toBe(false)
  })
})

describe('compareEntryNames', () => {
  it('sorts numerically, not lexically', () => {
    const sorted = ['page10.jpg', 'page2.jpg', 'page1.jpg'].sort(compareEntryNames)
    expect(sorted).toEqual(['page1.jpg', 'page2.jpg', 'page10.jpg'])
  })

  it('keeps chapter folders in numeric order', () => {
    const sorted = ['Ch 10/p1.jpg', 'Ch 2/p1.jpg', 'Ch 2/p10.jpg', 'Ch 2/p2.jpg'].sort(
      compareEntryNames
    )
    expect(sorted).toEqual(['Ch 2/p1.jpg', 'Ch 2/p2.jpg', 'Ch 2/p10.jpg', 'Ch 10/p1.jpg'])
  })

  it('compares segment by segment rather than as one flat string', () => {
    // 'art' vs 'art.jpg' is a plain comparison of the first segment. There is
    // deliberately no "files before directories" rule: it would push a page
    // named zzz.jpg ahead of an entire Chapter 1 folder. Covers that live
    // outside the chapter folders are handled via ComicInfo's FrontCover type,
    // not by special-casing the sort.
    const sorted = ['art/extra.jpg', 'art.jpg'].sort(compareEntryNames)
    expect(sorted).toEqual(['art/extra.jpg', 'art.jpg'])
  })

  it('breaks ties on depth only when one path is a prefix of the other', () => {
    // This is the sole case where the depth rule fires. Sibling names are
    // decided by the segment comparison above long before depth matters, so
    // 'Ch 1/extra/p1.jpg' still sorts before 'Ch 1/p1.jpg' ('extra' < 'p1').
    expect(compareEntryNames('a', 'a/b.jpg')).toBeLessThan(0)
    expect(compareEntryNames('Ch 1/extra/p1.jpg', 'Ch 1/p1.jpg')).toBeLessThan(0)
  })

  it('is deterministic for case-only differences', () => {
    expect(compareEntryNames('a.jpg', 'A.jpg')).not.toBe(0)
    expect(compareEntryNames('a.jpg', 'A.jpg')).toBe(-compareEntryNames('A.jpg', 'a.jpg'))
  })
})

describe('buildPageList', () => {
  it('filters junk and non-images, then numbers pages in reading order', () => {
    const pages = buildPageList(
      entries(
        'ComicInfo.xml',
        '__MACOSX/page01.jpg',
        'page10.jpg',
        'page2.jpg',
        'page1.jpg',
        'notes.txt',
        'Thumbs.db'
      )
    )

    expect(pages.map((page) => page.name)).toEqual(['page1.jpg', 'page2.jpg', 'page10.jpg'])
    expect(pages.map((page) => page.index)).toEqual([0, 1, 2])
  })

  it('preserves the entry handle so reads hit the right member', () => {
    const list = entries('b.jpg', 'a.jpg')
    const pages = buildPageList(list)
    expect(pages[0].name).toBe('a.jpg')
    // a.jpg was the second entry, so its handle must still be 1
    expect(pages[0].entryIndex).toBe(1)
  })

  it('excludes jxl unless explicitly enabled', () => {
    const list = entries('p1.jxl', 'p2.jpg')
    expect(buildPageList(list).map((p) => p.name)).toEqual(['p2.jpg'])
    expect(buildPageList(list, { enableJxl: true }).map((p) => p.name)).toEqual([
      'p1.jxl',
      'p2.jpg'
    ])
  })

  it('honours an exclusion set', () => {
    const pages = buildPageList(entries('p1.jpg', 'p2.jpg'), {
      excludedNames: new Set(['p1.jpg'])
    })
    expect(pages.map((p) => p.name)).toEqual(['p2.jpg'])
  })

  it('skips directory entries', () => {
    const pages = buildPageList(entries('Chapter 1/', 'Chapter 1/p1.jpg'))
    expect(pages).toHaveLength(1)
  })
})

describe('findEntryByName', () => {
  it('matches the basename case-insensitively', () => {
    const found = findEntryByName(entries('meta/comicinfo.XML'), 'ComicInfo.xml')
    expect(found?.name).toBe('meta/comicinfo.XML')
  })

  it('ignores junk copies', () => {
    const found = findEntryByName(entries('__MACOSX/ComicInfo.xml'), 'ComicInfo.xml')
    expect(found).toBeUndefined()
  })
})
