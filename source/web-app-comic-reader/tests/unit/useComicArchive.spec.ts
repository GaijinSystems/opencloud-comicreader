import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'

import { ComicReaderError, type ArchiveAdapter } from '../../src/archive/types'
import type { OpenedComic } from '../../src/archive/openArchive'
import type { ResolvedSource } from '../../src/archive/source'
import { makeAdapter, makePages } from './helpers/fakes'
import { DEFAULT_CONFIG } from '../../src/config'

/**
 * What the composable does with a page that fails to read. The archive layer
 * is replaced with a stand-in; the cache and the bookkeeping are real.
 */

const openComic = vi.fn()
vi.mock('../../src/archive/openArchive', async (original) => ({
  ...(await original<typeof import('../../src/archive/openArchive')>()),
  openComic: (...args: unknown[]) => openComic(...args)
}))
// The real module pulls in the decoders' adapters; none is used here.
vi.mock('../../src/archive/libarchiveAdapter', () => ({ LibArchiveAdapter: {} }))

const { PasswordError } = await import('../../src/archive/openArchive')

const { useComicArchive } = await import('../../src/composables/useComicArchive')

/** Where a comic of this format came from, as openComic reports it. */
const resolvedAs = (format: ArchiveAdapter['format']): ResolvedSource => ({
  format,
  source: { kind: 'blob', data: new Blob(['archive']), name: `book.${format}` }
})

/** What openComic resolves to. */
function openedComic(
  adapter: ArchiveAdapter,
  pageCount: number,
  passwordSettled = false
): OpenedComic {
  return {
    adapter,
    pages: makePages(pageCount, { size: 10 }),
    info: null,
    widePages: new Set<number>(),
    warning: null,
    resolved: resolvedAs(adapter.format),
    passwordSettled
  }
}

function makeArchive() {
  return useComicArchive({
    // No read-ahead, so each test decides exactly which pages are read.
    config: { ...DEFAULT_CONFIG, prefetchPages: 0 },
    headers: ref({}),
    trustedOrigins: [],
    getUrlForResource: async () => 'https://files.example/book.cb7'
  })
}

const openBook = (archive: ReturnType<typeof makeArchive>) =>
  archive.open({} as SpaceResource, { name: 'book.cb7' } as unknown as Resource)

async function opened(readEntry: ArchiveAdapter['readEntry'], close = async () => {}) {
  openComic.mockResolvedValue(openedComic(makeAdapter({ format: 'cb7', readEntry, close }), 4))
  const archive = makeArchive()
  await openBook(archive)
  return archive
}

beforeEach(() => {
  openComic.mockReset()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:page')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('useComicArchive: a page that fails to read', () => {
  it('asks for the password when a read reveals a 7z is encrypted', async () => {
    // A 7z with readable file names passes the check made at open, lists
    // normally, and only refuses when a page is read.
    const close = vi.fn(async () => {})
    const archive = await opened(async () => {
      throw new ComicReaderError('encrypted', 'This comic is password protected.')
    }, close)
    expect(archive.error.value).toBeNull()

    expect(await archive.pageUrl(0)).toBeNull()

    expect(archive.error.value).toMatchObject({ code: 'password-required' })
    // Not also a book of broken pages with a retry on each.
    expect(archive.failedPages.value).toEqual({})
    // And the archive is let go: nothing in it can be read, and the decoder
    // is holding a copy of all of it.
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(archive.pageCount.value).toBe(0)
  })

  it('marks an ordinary failure as retryable, on that page only', async () => {
    const archive = await opened(async (index) => {
      if (index === 2) {
        throw new ComicReaderError('corrupt', 'could not be read')
      }
      return new Blob(['page'])
    })

    expect(await archive.pageUrl(2)).toBeNull()
    expect(await archive.pageUrl(1)).toBe('blob:page')

    expect(archive.error.value).toBeNull()
    expect(archive.failedPages.value).toEqual({ 2: 'retryable' })
  })

  it.each(['page-too-large', 'page-unavailable'] as const)(
    'marks a %s failure as permanent, so no retry is offered',
    async (code) => {
      const archive = await opened(async () => {
        throw new ComicReaderError(code, 'cannot be shown')
      })
      await archive.pageUrl(0)
      expect(archive.failedPages.value).toEqual({ 0: 'permanent' })
    }
  )

  it('reads a page again after a retry, and clears its failed state', async () => {
    let attempts = 0
    const archive = await opened(async () => {
      if (attempts++ === 0) {
        throw new Error('connection dropped')
      }
      return new Blob(['page'])
    })

    await archive.pageUrl(3)
    expect(archive.failedPages.value).toEqual({ 3: 'retryable' })

    archive.retryPage(3)
    expect(archive.failedPages.value).toEqual({})
    expect(await archive.pageUrl(3)).toBe('blob:page')
    expect(attempts).toBe(2)
  })
})

describe('useComicArchive: torn down while an archive is still opening', () => {
  function deferredOpen() {
    let finish: () => void = () => {}
    const close = vi.fn(async () => {})
    openComic.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve(openedComic(makeAdapter({ format: 'cb7', close }), 4))
      })
    )
    return { archive: makeArchive(), close, finish: () => finish() }
  }
  /** open() tidies up before it calls openComic; wait until it has. */
  const untilOpening = (calls: number) =>
    vi.waitFor(() => expect(openComic).toHaveBeenCalledTimes(calls))

  it('closes the adapter an open hands back after destroy, instead of installing it', async () => {
    // Parts of opening cannot be aborted (the decoder starting, the listing).
    // If that finishes after the reader is gone, nothing is left to close the
    // decoder's worker unless the open itself notices it was superseded.
    const { archive, close, finish } = deferredOpen()
    const opening = openBook(archive)
    await untilOpening(1)

    await archive.destroy()
    finish()
    await opening

    expect(close).toHaveBeenCalledTimes(1)
    expect(archive.pageCount.value).toBe(0)
    expect(await archive.pageUrl(0)).toBeNull()
  })

  it('does the same when a second open supersedes the first', async () => {
    const first = deferredOpen()
    const openingFirst = openBook(first.archive)
    await untilOpening(1)

    // The same composable instance is asked to open something else.
    openComic.mockResolvedValue(openedComic(makeAdapter({ format: 'cb7' }), 2))
    await openBook(first.archive)
    expect(first.archive.pageCount.value).toBe(2)

    first.finish()
    await openingFirst

    expect(first.close).toHaveBeenCalledTimes(1)
    // The late arrival did not replace the comic that is actually open.
    expect(first.archive.pageCount.value).toBe(2)
  })

  it('installs the adapter normally when nothing intervened', async () => {
    const { archive, close, finish } = deferredOpen()
    const opening = openBook(archive)
    finish()
    await opening

    expect(close).not.toHaveBeenCalled()
    expect(archive.pageCount.value).toBe(4)
  })
})

describe('useComicArchive: a password-protected comic', () => {
  const encrypted = () => new ComicReaderError('encrypted', 'This comic is password protected.')

  it('asks for the password of a RAR that a read reveals is encrypted, like any other', async () => {
    openComic.mockResolvedValue(
      openedComic(
        makeAdapter({
          format: 'cbr',
          readEntry: async () => {
            throw encrypted()
          }
        }),
        4
      )
    )
    const archive = makeArchive()
    await openBook(archive)
    await archive.pageUrl(0)

    expect(archive.error.value).toMatchObject({ code: 'password-required' })
  })

  it('tries a password on what was already fetched, and opens the comic', async () => {
    const source = resolvedAs('cbz')
    openComic.mockRejectedValueOnce(
      new PasswordError('password-required', 'This comic is password protected.', source)
    )
    const archive = makeArchive()
    await openBook(archive)
    expect(archive.error.value).toMatchObject({ code: 'password-required' })
    expect(openComic.mock.calls[0][0]).not.toHaveProperty('password')

    openComic.mockResolvedValueOnce(openedComic(makeAdapter(), 3))
    await archive.unlock('comic')

    expect(openComic.mock.calls[1][0]).toMatchObject({ password: 'comic', resolved: source })
    expect(archive.error.value).toBeNull()
    expect(archive.pageCount.value).toBe(3)
  })

  it('asks again after a wrong password, still without fetching again', async () => {
    const source = resolvedAs('cb7')
    const refusal = (code: 'password-required' | 'wrong-password') =>
      new PasswordError(code, 'no', source)
    openComic
      .mockRejectedValueOnce(refusal('password-required'))
      .mockRejectedValueOnce(refusal('wrong-password'))
      .mockResolvedValueOnce(openedComic(makeAdapter({ format: 'cb7' }), 2))
    const archive = makeArchive()
    await openBook(archive)

    await archive.unlock('nope')
    expect(archive.error.value).toMatchObject({ code: 'wrong-password' })

    await archive.unlock('comic')
    expect(openComic.mock.calls[2][0]).toMatchObject({ password: 'comic', resolved: source })
    expect(archive.pageCount.value).toBe(2)
  })

  it('unlocks a 7z whose encryption only showed when a page was read', async () => {
    const lazy = openedComic(
      makeAdapter({
        format: 'cb7',
        readEntry: async () => {
          throw encrypted()
        }
      }),
      4
    )
    openComic.mockResolvedValueOnce(lazy)
    const archive = makeArchive()
    await openBook(archive)
    await archive.pageUrl(0)
    expect(archive.error.value).toMatchObject({ code: 'password-required' })

    openComic.mockResolvedValueOnce(openedComic(makeAdapter({ format: 'cb7' }), 4))
    await archive.unlock('comic')

    expect(openComic.mock.calls[1][0]).toMatchObject({ password: 'comic', resolved: lazy.resolved })
    expect(archive.error.value).toBeNull()
  })

  it('opening another comic forgets the one that was waiting for a password', async () => {
    openComic.mockRejectedValueOnce(
      new PasswordError('password-required', 'no', resolvedAs('cbz'))
    )
    const archive = makeArchive()
    await openBook(archive)

    openComic.mockResolvedValueOnce(openedComic(makeAdapter(), 1))
    await openBook(archive)
    expect(openComic.mock.calls[1][0]).not.toHaveProperty('resolved')
    expect(openComic.mock.calls[1][0]).not.toHaveProperty('password')
  })

  it('does nothing when asked to unlock with no comic open', async () => {
    const archive = makeArchive()
    await archive.unlock('comic')
    expect(openComic).not.toHaveBeenCalled()
  })

  it('asks again when a zip password turns out wrong on a later page', async () => {
    const zip = openedComic(
      makeAdapter({
        readEntry: async () => {
          throw encrypted()
        }
      }),
      4
    )
    openComic
      .mockRejectedValueOnce(
        new PasswordError('password-required', 'no', resolvedAs('cbz'))
      )
      .mockResolvedValueOnce(zip)
    const archive = makeArchive()
    await openBook(archive)
    await archive.unlock('nearly')
    expect(archive.error.value).toBeNull()

    await archive.pageUrl(0)
    expect(archive.error.value).toMatchObject({ code: 'wrong-password' })

    openComic.mockResolvedValueOnce(openedComic(makeAdapter(), 4))
    await archive.unlock('comic')
    expect(openComic.mock.calls[2][0]).toMatchObject({ password: 'comic', resolved: zip.resolved })
  })

  it('lets go of the archive once 7-Zip has decoded it with the password', async () => {
    openComic
      .mockRejectedValueOnce(new PasswordError('password-required', 'no', resolvedAs('cb7')))
      .mockResolvedValueOnce(openedComic(makeAdapter({ format: 'cb7' }), 2, true))
      .mockResolvedValueOnce(openedComic(makeAdapter({ format: 'cb7' }), 2, true))
    const archive = makeArchive()
    await openBook(archive)
    await archive.unlock('comic')

    // Nothing is kept to open it from again: a second unlock would have to
    // fetch, which shows as no `resolved` being passed.
    await archive.unlock('comic')
    expect(openComic.mock.calls[2][0].resolved).toBeUndefined()
  })

  it('treats an empty password as none', async () => {
    openComic.mockRejectedValue(new PasswordError('password-required', 'no', resolvedAs('cbz')))
    const archive = makeArchive()
    await openBook(archive)
    await archive.unlock('')
    expect(openComic.mock.calls[1][0].password).toBeUndefined()
  })

  it('lets go of the archive when an unlock fails for another reason', async () => {
    openComic
      .mockRejectedValueOnce(new PasswordError('password-required', 'no', resolvedAs('cb7')))
      .mockRejectedValueOnce(new ComicReaderError('corrupt', 'The decoder could not read it.'))
      .mockRejectedValueOnce(new ComicReaderError('corrupt', 'again'))
    const archive = makeArchive()
    await openBook(archive)
    await archive.unlock('comic')
    expect(archive.error.value).toMatchObject({ code: 'corrupt' })

    await archive.unlock('comic')
    expect(openComic.mock.calls[2][0].resolved).toBeUndefined()
  })

  it('lets go of the archive once a page has been read without a password being asked for', async () => {
    // An ordinary comic: after its first page it will not ask, and its
    // download should not sit in memory beside its pages. Seen here as a
    // later request for the password having to fetch the comic again.
    openComic.mockResolvedValue(openedComic(makeAdapter({ format: 'cb7' }), 3))
    const archive = makeArchive()
    await openBook(archive)
    expect(await archive.pageUrl(0)).toBe('blob:page')

    await archive.unlock('comic')
    expect(openComic.mock.calls[1][0].resolved).toBeUndefined()
  })

  it('keeps it until then, for the archive that turns out encrypted on its first page', async () => {
    const lazy = openedComic(
      makeAdapter({
        format: 'cb7',
        readEntry: async () => {
          throw encrypted()
        }
      }),
      3
    )
    openComic.mockResolvedValueOnce(lazy).mockResolvedValueOnce(openedComic(makeAdapter(), 3))
    const archive = makeArchive()
    await openBook(archive)
    expect(await archive.pageUrl(0)).toBeNull()

    await archive.unlock('comic')
    expect(openComic.mock.calls[1][0].resolved).toBe(lazy.resolved)
  })

  it('keeps a zip opened with a password within reach however many pages it has shown', async () => {
    const zip = openedComic(makeAdapter(), 3)
    openComic
      .mockRejectedValueOnce(new PasswordError('password-required', 'no', resolvedAs('cbz')))
      .mockResolvedValueOnce(zip)
      .mockResolvedValueOnce(openedComic(makeAdapter(), 3))
    const archive = makeArchive()
    await openBook(archive)
    await archive.unlock('nearly')
    expect(await archive.pageUrl(0)).toBe('blob:page')

    await archive.unlock('comic')
    expect(openComic.mock.calls[2][0].resolved).toBe(zip.resolved)
  })
})

