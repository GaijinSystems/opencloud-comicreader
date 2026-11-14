import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PageCache } from '../../src/composables/usePageCache'
import { body, makeAdapter, makePages } from './helpers/fakes'

/**
 * Blob URL accounting is the thing under test here: a reader that creates a
 * URL per page and never revokes it holds the whole comic in memory by the
 * end of the book, so these tests track create/revoke pairs explicitly.
 */
let created: string[] = []
let revoked: string[] = []

beforeEach(() => {
  created = []
  revoked = []
  let counter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => {
      const url = `blob:page-${counter++}`
      created.push(url)
      return url
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url)
    }
  })
})

function makeCache(options: Partial<ConstructorParameters<typeof PageCache>[0]> = {}) {
  return new PageCache({
    adapter: makeAdapter(),
    pages: makePages(50),
    radius: 2,
    prefetch: 0,
    maxPageBytes: 10_000,
    ...options
  })
}

describe('PageCache', () => {
  it('returns a blob URL for a page', async () => {
    const cache = makeCache()
    const entry = await cache.get(0)
    expect(entry?.url).toBe('blob:page-0')
    expect(entry?.bytes).toBe(1)
  })

  it('serves a second request from cache without re-reading', async () => {
    const readEntry = vi.fn(async () => body(1))
    const cache = makeCache({ adapter: makeAdapter({ readEntry }) })

    await cache.get(3)
    await cache.get(3)

    expect(readEntry).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent requests for the same page', async () => {
    const readEntry = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return body(1)
    })
    const cache = makeCache({ adapter: makeAdapter({ readEntry }) })

    const results = await Promise.all([cache.get(1), cache.get(1)])

    expect(readEntry).toHaveBeenCalledTimes(1)
    expect(results[0]?.url).toBe(results[1]?.url)
  })

  it('revokes blob URLs for pages that fall outside the window', async () => {
    const cache = makeCache({ radius: 2 })

    for (let page = 0; page <= 6; page++) {
      await cache.get(page)
      cache.setCentre(page)
    }

    // With radius 2 centred on page 6, pages 0..3 must be gone.
    expect(revoked).toContain('blob:page-0')
    expect(revoked).toContain('blob:page-3')
    expect(revoked).not.toContain('blob:page-6')
  })

  it('keeps retained memory bounded while reading a long comic', async () => {
    const cache = makeCache({ radius: 3, pages: makePages(200, { size: 500_000 }) })

    for (let page = 0; page < 200; page++) {
      await cache.get(page)
      cache.setCentre(page)
    }

    // radius 3 in both directions plus the current page is 7 at most.
    expect(created.length - revoked.length).toBeLessThanOrEqual(7)
  })

  it('prefetches ahead and behind the reading position', async () => {
    // Typed parameter so the recorded calls carry the requested index.
    const readEntry = vi.fn(async (index: number) => body(index))
    const cache = makeCache({ adapter: makeAdapter({ readEntry }), prefetch: 2, radius: 5 })

    cache.setCentre(10)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const requested = readEntry.mock.calls.map((call) => call[0]).sort((a, b) => a - b)
    expect(requested).toEqual([8, 9, 11, 12])
  })

  it('refuses a page whose declared size exceeds the limit', async () => {
    const onError = vi.fn()
    const cache = makeCache({ pages: makePages(3, { size: 999_999 }), maxPageBytes: 1000, onError })

    expect(await cache.get(0)).toBeNull()
    expect(onError).toHaveBeenCalledWith(0, expect.objectContaining({ code: 'page-too-large' }))
  })

  it('refuses a page that lies about its size, the decompression-bomb case', async () => {
    const onError = vi.fn()
    const cache = makeCache({
      // Declared small, actually huge: exactly what a zip bomb looks like.
      adapter: makeAdapter({ readEntry: async () => new Blob([new Uint8Array(50_000)]) }),
      maxPageBytes: 1000,
      onError
    })

    expect(await cache.get(0)).toBeNull()
    expect(onError).toHaveBeenCalledWith(0, expect.objectContaining({ code: 'page-too-large' }))
  })

  it('records a failed page and stops retrying it', async () => {
    const readEntry = vi.fn(async () => {
      throw new Error('bad entry')
    })
    const cache = makeCache({ adapter: makeAdapter({ readEntry }) })

    expect(await cache.get(0)).toBeNull()
    expect(await cache.get(0)).toBeNull()

    expect(readEntry).toHaveBeenCalledTimes(1)
    expect([...cache.failedPages]).toEqual([0])
  })

  it('lets one corrupt page fail without affecting its neighbours', async () => {
    const cache = makeCache({
      adapter: makeAdapter({
        readEntry: async (index: number) => {
          if (index === 2) {
            throw new Error('corrupt')
          }
          return body(index)
        }
      })
    })

    expect(await cache.get(1)).not.toBeNull()
    expect(await cache.get(2)).toBeNull()
    expect(await cache.get(3)).not.toBeNull()
  })

  it('revokes everything on dispose', async () => {
    const cache = makeCache()
    await cache.get(0)
    await cache.get(1)

    cache.dispose()

    expect(revoked).toHaveLength(2)
    expect(cache.retainedBytes).toBe(0)
  })

  it('returns null after dispose instead of resurrecting the cache', async () => {
    const cache = makeCache()
    cache.dispose()
    expect(await cache.get(0)).toBeNull()
  })

  it('reads a failed page again once the failure is forgotten', async () => {
    let attempts = 0
    const onError = vi.fn()
    const cache = makeCache({
      onError,
      adapter: makeAdapter({
        readEntry: async () => {
          if (attempts++ === 0) {
            throw new Error('connection dropped')
          }
          return body(7)
        }
      })
    })

    expect(await cache.get(4)).toBeNull()
    // Remembered as failed: asking again does not touch the adapter.
    expect(await cache.get(4)).toBeNull()
    expect(attempts).toBe(1)

    cache.forget(4)
    expect((await cache.get(4))?.url).toMatch(/^blob:/)
    expect(attempts).toBe(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('marks a page failed again when the second read fails too', async () => {
    const onError = vi.fn()
    const cache = makeCache({
      onError,
      adapter: makeAdapter({
        readEntry: async () => {
          throw new Error('still broken')
        }
      })
    })
    await cache.get(4)
    cache.forget(4)
    expect(await cache.get(4)).toBeNull()
    expect(onError).toHaveBeenCalledTimes(2)
    expect(cache.failedPages.has(4)).toBe(true)
  })

  it('types the page with slice(), which shares its bytes, instead of copying it', async () => {
    const page = new Blob([new Uint8Array(40)])
    const slice = vi.spyOn(page, 'slice')
    const cache = makeCache({ adapter: makeAdapter({ readEntry: async () => page }) })

    const entry = await cache.get(0)
    expect(entry?.bytes).toBe(40)
    expect(slice).toHaveBeenCalledWith(0, 40, 'image/png')
  })

  it('applies the size limit to a Blob page too', async () => {
    const onError = vi.fn()
    const cache = makeCache({
      onError,
      adapter: makeAdapter({ readEntry: async () => new Blob([new Uint8Array(50_000)]) })
    })
    expect(await cache.get(0)).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
