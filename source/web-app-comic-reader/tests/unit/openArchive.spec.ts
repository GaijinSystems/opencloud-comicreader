import { describe, it, expect } from 'vitest'
import {
  resolveWarning,
  emptyArchiveError,
  namesAt,
  pageIndicesNamed
} from '../../src/archive/openArchive'
import { ComicReaderError, type ArchiveAdapter } from '../../src/archive/types'
import { makeAdapter, makePages } from './helpers/fakes'

/**
 * The orchestration layer's decisions, tested against minimal adapter shapes.
 * Every branch here maps to a user-visible outcome, and several were added in
 * response to real archives behaving unexpectedly, so they need to stay pinned.
 */

const pages = makePages
const base = makeAdapter()

function zipAdapter(unsupported: number[]): ArchiveAdapter {
  return makeAdapter({ unsupportedEntries: () => new Set(unsupported) })
}

function rarAdapter(dropped: number): ArchiveAdapter {
  return makeAdapter({
    format: 'cbr',
    dropped: dropped > 0 ? { count: dropped, because: 'solid-rar' } : null
  })
}

describe('resolveWarning', () => {
  it('is silent for an ordinary archive', () => {
    expect(resolveWarning(base, pages(6))).toBeNull()
    expect(resolveWarning(zipAdapter([]), pages(6))).toBeNull()
    expect(resolveWarning(rarAdapter(0), pages(6))).toBeNull()
  })

  it('warns, with a count, when only some zip pages are undecodable', () => {
    expect(resolveWarning(zipAdapter([1, 2]), pages(6))).toEqual({
      code: 'unsupported-compression',
      count: 2
    })
  })

  it('throws when every zip page is undecodable', () => {
    expect(() => resolveWarning(zipAdapter([0, 1, 2]), pages(3))).toThrow(ComicReaderError)
    try {
      resolveWarning(zipAdapter([0, 1, 2]), pages(3))
    } catch (error) {
      expect((error as ComicReaderError).code).toBe('unsupported-compression')
    }
  })

  it('surfaces the real fallback failure instead of a generic message', () => {
    // A bzip2 CBZ too large to buffer must say "too large", not blame WASM.
    const tooLarge = new ComicReaderError('too-large', 'too big')
    expect(() => resolveWarning(zipAdapter([0, 1]), pages(2), tooLarge)).toThrow(tooLarge)
  })

  it('ignores non-ComicReaderError fallback failures', () => {
    expect(() => resolveWarning(zipAdapter([0]), pages(1), new Error('x'))).toThrow(
      /compression method/
    )
  })

  it('does not count unsupported entries that are not pages', () => {
    // Entry 9 is not in the page list (e.g. ComicInfo.xml with odd compression).
    expect(resolveWarning(zipAdapter([9]), pages(6))).toBeNull()
  })

  it('warns about dropped solid-RAR entries with the count', () => {
    expect(resolveWarning(rarAdapter(3), pages(2))).toEqual({
      code: 'dropped-entries',
      count: 3
    })
  })

  it('prefers the zip warning when both could apply', () => {
    const both: ArchiveAdapter = {
      ...zipAdapter([0]),
      dropped: { count: 2, because: 'solid-rar' }
    }
    expect(resolveWarning(both, pages(4))?.code).toBe('unsupported-compression')
  })
})

describe('emptyArchiveError', () => {
  it('names solid RAR when entries were dropped', () => {
    // The real 6-page solid RAR4: libarchive returns one non-image entry, so
    // pages are empty and "No pages found" would send the user the wrong way.
    expect(emptyArchiveError(rarAdapter(8)).code).toBe('solid-rar-unsupported')
  })

  it('says damaged, not solid RAR, when a decoder that reads solid RAR stopped short', () => {
    // unarr reads solid RAR4. If its listing ends early and no page was
    // reached, "the decoder cannot read solid RAR" would be untrue.
    const stoppedShort = makeAdapter({ dropped: { count: 5, because: 'incomplete' } })
    const error = emptyArchiveError(stoppedShort)
    expect(error.code).toBe('corrupt')
    expect(error.message).toMatch(/damaged or incomplete/)
  })

  it('reports no-pages for a genuinely empty archive', () => {
    expect(emptyArchiveError(base).code).toBe('no-pages')
    expect(emptyArchiveError(rarAdapter(0)).code).toBe('no-pages')
  })
})

describe('ComicInfo page indices', () => {
  // ComicInfo numbers images before any are removed, so an index only means
  // something once it has been turned into a name against the full list.
  const unfiltered = pages(6)

  it('follows a double page to its new position when an earlier page is deleted', () => {
    const deleted = namesAt(unfiltered, new Set([1]))
    const remaining = unfiltered
      .filter((page) => !deleted.has(page.name))
      .map((page, index) => ({ ...page, index }))

    const wide = pageIndicesNamed(remaining, namesAt(unfiltered, new Set([4])))
    expect([...wide]).toEqual([3])
    expect(remaining[3].name).toBe('page4.png')
  })

  it('leaves indices alone when nothing is deleted', () => {
    expect([...pageIndicesNamed(unfiltered, namesAt(unfiltered, new Set([2, 4])))]).toEqual([2, 4])
  })

  it('ignores indices past the end and double pages that were themselves deleted', () => {
    expect(namesAt(unfiltered, new Set([99])).size).toBe(0)
    const remaining = unfiltered.filter((page) => page.index !== 2)
    expect(pageIndicesNamed(remaining, namesAt(unfiltered, new Set([2]))).size).toBe(0)
  })
})
