import { describe, it, expect, beforeEach } from 'vitest'
import {
  furthestPageOnScreen,
  loadProgress,
  saveProgress
} from '../../src/composables/useReadingProgress'
import { buildSpreads } from '../../src/helpers/spread'
import type { Resource } from '@opencloud-eu/web-client'

const resource = (fileId: string) => ({ fileId, id: fileId, name: 'x.cbz' }) as unknown as Resource

beforeEach(() => localStorage.clear())

describe('reading progress', () => {
  it('round-trips a mid-book position', () => {
    saveProgress(resource('a'), 12, 100)
    expect(loadProgress(resource('a'))?.page).toBe(12)
  })

  it('is keyed by file id, so a rename or move keeps your place', () => {
    saveProgress(resource('same-id'), 5, 50)
    const renamed = { fileId: 'same-id', id: 'same-id', name: 'renamed.cbz' } as unknown as Resource
    expect(loadProgress(renamed)?.page).toBe(5)
  })

  it('clears the entry when the comic is finished', () => {
    saveProgress(resource('b'), 10, 50)
    saveProgress(resource('b'), 49, 50)
    expect(loadProgress(resource('b'))).toBeNull()
  })

  it('does not record page one, which is not a position worth resuming', () => {
    saveProgress(resource('c'), 0, 50)
    expect(loadProgress(resource('c'))).toBeNull()
  })

  it('ignores corrupt stored values rather than throwing', () => {
    localStorage.setItem('comic-reader:progress:d', 'not json')
    expect(loadProgress(resource('d'))).toBeNull()
    localStorage.setItem('comic-reader:progress:d', JSON.stringify({ page: -1 }))
    expect(loadProgress(resource('d'))).toBeNull()
  })

  it('returns null for a resource with no usable id', () => {
    expect(loadProgress({ name: 'x' } as unknown as Resource)).toBeNull()
  })

  it('prunes the oldest entries beyond the cap', () => {
    for (let i = 0; i < 520; i++) {
      localStorage.setItem(
        `comic-reader:progress:old${i}`,
        JSON.stringify({ page: 1, total: 10, updatedAt: i })
      )
    }
    saveProgress(resource('newest'), 3, 10)
    const remaining = Object.keys(localStorage).filter((k) => k.startsWith('comic-reader:progress:'))
    expect(remaining.length).toBeLessThanOrEqual(500)
    expect(loadProgress(resource('newest'))?.page).toBe(3)
    expect(localStorage.getItem('comic-reader:progress:old0')).toBeNull()
  })
})

describe('reading progress is scoped to the user', () => {
  it('does not show one account another account’s position', () => {
    saveProgress(resource('shared'), 12, 100, 'alice')
    expect(loadProgress(resource('shared'), 'alice')?.page).toBe(12)
    expect(loadProgress(resource('shared'), 'bob')).toBeNull()
    expect(loadProgress(resource('shared'))).toBeNull()
  })

  it('keeps separate positions for the same file', () => {
    saveProgress(resource('shared'), 12, 100, 'alice')
    saveProgress(resource('shared'), 40, 100, 'bob')
    expect(loadProgress(resource('shared'), 'alice')?.page).toBe(12)
    expect(loadProgress(resource('shared'), 'bob')?.page).toBe(40)
  })

  it('rejects a stored page that is not a whole number', () => {
    localStorage.setItem(
      'comic-reader:progress:public:a',
      JSON.stringify({ page: 2.5, total: 10, updatedAt: 1 })
    )
    expect(loadProgress(resource('a'))).toBeNull()
  })
})

describe('reading progress in two-page view', () => {
  // A 10-page comic, cover alone: [0] [1,2] [3,4] [5,6] [7,8] [9]
  // An 11-page one ends on a full spread:  ... [7,8] [9,10]
  const lead = (spread: number[]) => Math.min(...spread)

  it('clears the bookmark on the last spread, whose lead page is not the last page', () => {
    const spreads = buildSpreads(11)
    const last = spreads[spreads.length - 1]
    expect(last).toEqual([9, 10])

    saveProgress(resource('book'), 5, 11)
    expect(loadProgress(resource('book'))?.page).toBe(5)

    // What App.vue does on a page turn: currentPage is the spread's lead.
    saveProgress(resource('book'), furthestPageOnScreen(lead(last), last), 11)
    expect(loadProgress(resource('book'))).toBeNull()
  })

  it('would not have cleared it going by the lead page alone', () => {
    // The bug this guards against: page 9 of 11 is not "finished".
    saveProgress(resource('book'), 9, 11)
    expect(loadProgress(resource('book'))?.page).toBe(9)
  })

  it('records a mid-book spread by its furthest page and resumes on the same spread', () => {
    const spreads = buildSpreads(11)
    const middle = spreads[2]
    expect(middle).toEqual([3, 4])

    saveProgress(resource('book'), furthestPageOnScreen(lead(middle), middle), 11)
    const saved = loadProgress(resource('book'))
    expect(saved?.page).toBe(4)
    expect(spreads.find((spread) => spread.includes(saved!.page))).toEqual(middle)
  })

  it('is the page itself in single-page view, and with right-to-left order', () => {
    expect(furthestPageOnScreen(6, [6])).toBe(6)
    expect(furthestPageOnScreen(3, [4, 3])).toBe(4)
    expect(furthestPageOnScreen(0, [])).toBe(0)
  })
})
