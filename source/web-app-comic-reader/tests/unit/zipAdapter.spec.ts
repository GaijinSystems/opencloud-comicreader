import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { ZipAdapter, shutdownZipWorkers } from '../../src/archive/zipAdapter'
import { buildPageList } from '../../src/archive/pageSort'
import { parseComicInfo, doublePageIndices, bookmarksOf } from '../../src/archive/comicInfo'
import { resolveFormat } from '../../src/archive/detect'
import type { ArchiveSource } from '../../src/archive/types'

const fixture = (name: string) => resolve(__dirname, '../fixtures', name)

const bytesOf = async (page: Promise<Blob>) => new Uint8Array(await (await page).arrayBuffer())

function bufferSource(name: string): ArchiveSource {
  const data = readFileSync(fixture(name))
  return {
    kind: 'blob',
    data: new Blob([data]),
    name
  }
}

// zip.js workers are unavailable under happy-dom, so the adapter's fallback
// path is what these tests exercise. That is the same path a strict CSP
// deployment would take, which makes it worth covering directly.
const openOptions = { useWebWorkers: false }

afterAll(async () => {
  await shutdownZipWorkers()
})

describe('ZipAdapter against a real CBZ', () => {
  it('lists every member of the archive', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), openOptions)
    const names = adapter.listEntries().map((entry) => entry.name)

    expect(names).toContain('Chapter 1/page1.png')
    expect(names).toContain('ComicInfo.xml')
    expect(names).toContain('__MACOSX/Chapter 1/._page1.png')
    await adapter.close()
  })

  it('produces pages in natural reading order, junk removed', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), openOptions)
    const pages = buildPageList(adapter.listEntries())

    expect(pages.map((page) => page.name)).toEqual([
      'Chapter 1/page1.png',
      'Chapter 1/page2.PNG',
      'Chapter 1/page10.png',
      'Chapter 2/page1.jpg',
      'Chapter 2/page2.png'
    ])
    // notes.txt, Thumbs.db, ComicInfo.xml and the resource fork are all gone.
    expect(pages).toHaveLength(5)
    await adapter.close()
  })

  it('reads page bytes that are a valid PNG', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), openOptions)
    const pages = buildPageList(adapter.listEntries())
    const data = await bytesOf(adapter.readEntry(pages[0].entryIndex))

    expect([...data.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await adapter.close()
  })

  it('maps a mislabelled .jpg member to its declared mime type', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), openOptions)
    const pages = buildPageList(adapter.listEntries())
    const jpgNamed = pages.find((page) => page.name.endsWith('.jpg'))

    // The reader trusts the extension for the blob type; browsers sniff the
    // real format anyway, so a mislabelled member still renders.
    expect(jpgNamed?.mimeType).toBe('image/jpeg')
    await adapter.close()
  })

  it('reads and parses the embedded ComicInfo.xml', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), openOptions)
    const xml = await adapter.readText('ComicInfo.xml')
    const info = parseComicInfo(xml as string)

    expect(info?.series).toBe('Fixture Comic')
    expect([...doublePageIndices(info)]).toEqual([2])
    expect(bookmarksOf(info)).toEqual([{ page: 2, label: 'The big reveal' }])
    await adapter.close()
  })

  it('returns null for a metadata file that is not there', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), openOptions)
    expect(await adapter.readText('NoSuchFile.xml')).toBeNull()
    await adapter.close()
  })

  it('reports a readable format from the file header', () => {
    const data = readFileSync(fixture('sample.cbz'))
    expect(resolveFormat('sample.cbz', new Uint8Array(data.subarray(0, 8)))).toBe('cbz')
  })

  it('yields no pages for an archive with no images', async () => {
    const adapter = await ZipAdapter.open(bufferSource('no-pages.cbz'), openOptions)
    expect(buildPageList(adapter.listEntries())).toHaveLength(0)
    await adapter.close()
  })

  it('rejects a file that is not a zip at all', async () => {
    const notAZip: ArchiveSource = {
      kind: 'blob',
      data: new Blob(['this is not an archive']),
      name: 'broken.cbz'
    }
    await expect(ZipAdapter.open(notAZip, openOptions)).rejects.toMatchObject({
      code: 'corrupt'
    })
  })
})

describe('ZipAdapter size limits', () => {
  it('rejects a page over the limit as page-too-large, not corrupt', async () => {
    // Every fixture page is ~75 bytes; a 10-byte cap must trip on all of them.
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), {
      ...openOptions,
      maxEntryBytes: 10
    })
    const pages = buildPageList(adapter.listEntries())

    await expect(adapter.readEntry(pages[0].entryIndex)).rejects.toMatchObject({
      code: 'page-too-large'
    })
    await adapter.close()
  })

  it('still reads pages under the limit', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), {
      ...openOptions,
      maxEntryBytes: 1024
    })
    const pages = buildPageList(adapter.listEntries())
    const data = await bytesOf(adapter.readEntry(pages[0].entryIndex))
    expect(data.byteLength).toBeGreaterThan(0)
    await adapter.close()
  })

  it('applies an independent cap to metadata reads', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), openOptions)
    // ComicInfo.xml in the fixture is a few hundred bytes.
    expect(await adapter.readText('ComicInfo.xml', 16)).toBeNull()
    expect(await adapter.readText('ComicInfo.xml', 1024 * 1024)).not.toBeNull()
    await adapter.close()
  })
})

describe('ZipAdapter entry limit', () => {
  it('refuses an archive with more entries than the cap', async () => {
    // sample.cbz has nine members.
    await expect(
      ZipAdapter.open(bufferSource('sample.cbz'), { ...openOptions, maxEntries: 3 })
    ).rejects.toMatchObject({ code: 'too-many-pages' })
  })

  it('opens an archive exactly at the cap', async () => {
    const adapter = await ZipAdapter.open(bufferSource('sample.cbz'), {
      ...openOptions,
      maxEntries: 9
    })
    expect(adapter.listEntries()).toHaveLength(9)
    await adapter.close()
  })
})

describe('libarchive-backed fixtures', () => {
  // The libarchive back end needs a real worker and WASM, so it cannot run
  // under happy-dom. Decoding these is covered by `npm run verify:libarchive`,
  // which drives the same library through its Node build. What is checked
  // here is the dispatch decision: that each fixture routes to the right
  // back end in the first place.
  it.each([
    ['sample.cb7', 'cb7'],
    ['sample.c7z', 'cb7'],
    ['sample.cbr', 'cbr']
  ])('%s is dispatched as %s', (name, expected) => {
    if (!existsSync(fixture(name))) {
      return
    }
    const data = readFileSync(fixture(name))
    expect(resolveFormat(name, new Uint8Array(data.subarray(0, 8)))).toBe(expected)
  })

  it('routes a comic to the back end its header implies, not its extension', () => {
    // A .cbr that is really a zip must reach the zip back end, or it fails to
    // open for no reason the reader can explain.
    const zipBytes = readFileSync(fixture('sample.cbz'))
    expect(resolveFormat('mislabelled.cbr', new Uint8Array(zipBytes.subarray(0, 8)))).toBe('cbz')
  })
})

describe('zip compression method support', () => {
  const methodFixture = (name: string) => resolve(__dirname, '../fixtures/zipmethods', name)

  function methodSource(name: string): ArchiveSource {
    const data = readFileSync(methodFixture(name))
    return {
      kind: 'blob',
      data: new Blob([data]),
      name
    }
  }

  it('accepts deflate64, which zip.js does implement', async () => {
    // deflate64 cannot be written by Python's zipfile, so this fixture only
    // exists when the 7z-based format matrix has been generated.
    if (!existsSync(methodFixture('deflate64.cbz'))) {
      return
    }
    const adapter = await ZipAdapter.open(methodSource('deflate64.cbz'), openOptions)
    expect(adapter.unsupportedEntries().size).toBe(0)

    const pages = buildPageList(adapter.listEntries())
    const data = await bytesOf(adapter.readEntry(pages[0].entryIndex))
    expect([...data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    await adapter.close()
  })

  it('flags every page of a bzip2 zip as undecodable by zip.js', async () => {
    // zip.js implements store, deflate and deflate64 only. Detecting that up
    // front is what lets openComic hand the archive to libarchive instead of
    // failing on every page. These archives do open in the reader.
    const adapter = await ZipAdapter.open(methodSource('bzip2.cbz'), openOptions)
    const unsupported = adapter.unsupportedEntries()
    const pages = buildPageList(adapter.listEntries())

    expect(pages.length).toBeGreaterThan(0)
    expect(pages.every((page) => unsupported.has(page.entryIndex))).toBe(true)
    await adapter.close()
  })

  it('flags every page of an LZMA zip as undecodable by zip.js', async () => {
    const adapter = await ZipAdapter.open(methodSource('lzma.cbz'), openOptions)
    const unsupported = adapter.unsupportedEntries()
    const pages = buildPageList(adapter.listEntries())
    expect(pages.length).toBeGreaterThan(0)
    expect(pages.every((page) => unsupported.has(page.entryIndex))).toBe(true)
    await adapter.close()
  })

  it('refuses a page in a method zip.js cannot decode, as permanently unavailable', async () => {
    // Not `corrupt`: that would offer a retry which can never succeed.
    const adapter = await ZipAdapter.open(methodSource('bzip2.cbz'), openOptions)
    const pages = buildPageList(adapter.listEntries())
    await expect(adapter.readEntry(pages[0].entryIndex)).rejects.toMatchObject({
      code: 'page-unavailable'
    })
    await adapter.close()
  })
})
