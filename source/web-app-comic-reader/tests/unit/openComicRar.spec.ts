import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Resource } from '@opencloud-eu/web-client'

import { ComicReaderError, type ArchiveAdapter } from '../../src/archive/types'
import { makeAdapter, openComicOptions } from './helpers/fakes'
import { syntheticRar4 } from './helpers/rar4Builder'

/**
 * Which decoder openComic hands a RAR to. Both decoders are replaced with
 * stand-ins here: the point is the choice, made from the container's own
 * headers, and what happens when the first choice cannot help.
 */

const libarchiveOpen = vi.fn()
const unarrOpen = vi.fn()

vi.mock('../../src/archive/libarchiveAdapter', () => ({
  LibArchiveAdapter: { open: (...args: unknown[]) => libarchiveOpen(...args) }
}))
vi.mock('../../src/archive/unarrAdapter', () => ({
  UnarrAdapter: { open: (...args: unknown[]) => unarrOpen(...args) }
}))
vi.mock('../../src/helpers/wasm', async (original) => ({
  ...(await original<typeof import('../../src/helpers/wasm')>()),
  checkWasmAllowed: async () => true
}))

const { openComic } = await import('../../src/archive/openArchive')

function fakeAdapter(label: string): ArchiveAdapter {
  return makeAdapter({
    format: 'cbr',
    listEntries: () => [{ index: 0, name: `${label}.png`, size: 4, isDirectory: false }]
  })
}

/** A libarchive stand-in for an archive with a ComicInfo.xml that reads like this. */
function withComicInfo(readText: ArchiveAdapter['readText']): ArchiveAdapter {
  return makeAdapter({
    format: 'cb7',
    listEntries: () => [
      { index: 0, name: 'p1.png', size: 4, isDirectory: false },
      { index: 1, name: 'ComicInfo.xml', size: 40, isDirectory: false }
    ],
    readText
  })
}

/** RAR5 signature followed by filler: enough for format detection. */
const rar5 = () => {
  const bytes = new Uint8Array(64)
  bytes.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
  return bytes
}

async function open(bytes: Uint8Array) {
  vi.stubGlobal('fetch', async () => new Response(bytes as BodyInit))
  const opened = await openComic(
    openComicOptions({ resource: { name: 'book.cbr', size: 0 } as unknown as Resource })
  )
  return opened.pages.map((page) => page.name)
}

beforeEach(() => {
  libarchiveOpen.mockReset().mockResolvedValue(fakeAdapter('libarchive'))
  unarrOpen.mockReset().mockResolvedValue(fakeAdapter('unarr'))
})
afterEach(() => vi.unstubAllGlobals())

describe('openComic: choosing a RAR decoder', () => {
  it('sends a solid RAR4 straight to unarr, without starting libarchive', async () => {
    expect(await open(syntheticRar4({ solid: true }))).toEqual(['unarr.png'])
    expect(libarchiveOpen).not.toHaveBeenCalled()
    expect(unarrOpen.mock.calls[0][1]).toMatchObject({
      solid: true,
      declaredEntryCount: 3,
      maxEntryBytes: 1024 * 1024,
      maxEntries: 400,
      // bulkExtractLimitMb (16) x 1 MiB x the expansion limit (4)
      maxRetainedBytes: 16 * 1024 * 1024 * 4
    })
  })

  it('falls back to libarchive, told what the headers declare, when unarr cannot help', async () => {
    unarrOpen.mockResolvedValue(null)
    expect(await open(syntheticRar4({ solid: true }))).toEqual(['libarchive.png'])
    expect(libarchiveOpen.mock.calls[0][1]).toMatchObject({
      rar4: { entryCount: 3, solid: true, encrypted: false },
      // The same limits unarr was given.
      maxEntries: 400,
      maxEntryBytes: 1024 * 1024
    })
  })

  it('sends a non-solid RAR4 to libarchive only', async () => {
    expect(await open(syntheticRar4())).toEqual(['libarchive.png'])
    expect(unarrOpen).not.toHaveBeenCalled()
  })

  it('tries unarr when libarchive rejects a non-solid RAR4', async () => {
    libarchiveOpen.mockRejectedValue(new ComicReaderError('corrupt', 'could not be opened'))
    expect(await open(syntheticRar4())).toEqual(['unarr.png'])
    expect(unarrOpen.mock.calls[0][1]).toMatchObject({ solid: false })
  })

  it('reports the libarchive error when unarr cannot help either', async () => {
    libarchiveOpen.mockRejectedValue(new ComicReaderError('corrupt', 'could not be opened'))
    unarrOpen.mockResolvedValue(null)
    await expect(open(syntheticRar4())).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('sends RAR5 to libarchive and never to unarr, even when it fails', async () => {
    expect(await open(rar5())).toEqual(['libarchive.png'])

    libarchiveOpen.mockRejectedValue(new ComicReaderError('corrupt', 'could not be opened'))
    await expect(open(rar5())).rejects.toMatchObject({ code: 'corrupt' })
    expect(unarrOpen).not.toHaveBeenCalled()
  })
})

describe('openComic: an archive that only shows it is encrypted when read', () => {
  it('reports password protected when reading ComicInfo is refused for that reason', async () => {
    // What a 7z with readable file names does: opens, lists, refuses to read.
    libarchiveOpen.mockResolvedValue(
      withComicInfo(async () => {
        throw new ComicReaderError('encrypted', 'This comic is password protected.')
      })
    )
    await expect(open(rar5())).rejects.toMatchObject({ code: 'password-required' })
  })

  it('still opens when ComicInfo is unreadable for any other reason', async () => {
    libarchiveOpen.mockResolvedValue(
      withComicInfo(async () => {
        throw new ComicReaderError('corrupt', 'could not be read')
      })
    )
    expect(await open(rar5())).toEqual(['p1.png'])
  })
})

describe('openComic: password-protected RAR4', () => {
  // Neither decoder decrypts. unarr would list such an archive's entries and
  // return them all unreadable, burying the real explanation; libarchive
  // would say "encrypted", but only after loading the whole archive.
  const encryptedError = () => new ComicReaderError('encrypted', 'This comic is password protected.')

  it.each([
    ['a solid archive', { solid: true, encrypted: true }],
    ['a non-solid archive', { encrypted: true }]
  ])('says so for %s straight from its headers, starting neither decoder', async (_name, shape) => {
    await expect(open(syntheticRar4(shape))).rejects.toMatchObject({ code: 'password-required' })
    expect(libarchiveOpen).not.toHaveBeenCalled()
    expect(unarrOpen).not.toHaveBeenCalled()
  })

  it.each([
    ['solid', { solid: true, encrypted: 1 }],
    ['non-solid', { encrypted: 1 }]
  ])('says so for a %s archive encrypted only after its first entry', async (_name, shape) => {
    // Neither decoder can announce this one: libarchive's check looks at the
    // first entry only, and unarr has none.
    await expect(open(syntheticRar4(shape))).rejects.toMatchObject({ code: 'password-required' })
    expect(libarchiveOpen).not.toHaveBeenCalled()
    expect(unarrOpen).not.toHaveBeenCalled()
  })

  it('does not retry with unarr when only libarchive noticed the encryption', async () => {
    // Encrypted headers: the header walk cannot see into them, libarchive can.
    libarchiveOpen.mockRejectedValue(encryptedError())
    await expect(open(syntheticRar4())).rejects.toMatchObject({ code: 'password-required' })
    expect(unarrOpen).not.toHaveBeenCalled()
  })
})
