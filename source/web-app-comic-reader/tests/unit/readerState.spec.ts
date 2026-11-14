import { describe, it, expect } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { useReaderState } from '../../src/composables/useReaderState'
import { DEFAULT_CONFIG, type ComicReaderConfig } from '../../src/config'
import type { ComicInfo } from '../../src/archive/comicInfo'

/**
 * `useReaderState` is a plain composable over refs, so it can be driven
 * directly without mounting anything. These tests exist mainly to pin the
 * per-comic reset: the composable is created once per mount and reused when
 * the route's resource changes in place, so anything not cleared leaks from
 * one comic into the next.
 */
function setup(
  overrides: {
    pageCount?: number
    config?: Partial<ComicReaderConfig>
    width?: number
    height?: number
  } = {}
) {
  const pageCount = ref(overrides.pageCount ?? 10)
  const info = ref<ComicInfo | null>(null)
  const declaredWidePages = ref<ReadonlySet<number>>(new Set())
  const viewportWidth = ref(overrides.width ?? 1400)
  const viewportHeight = ref(overrides.height ?? 900)

  const state = useReaderState({
    config: { ...DEFAULT_CONFIG, ...overrides.config },
    pageCount,
    info,
    declaredWidePages: computed(() => declaredWidePages.value),
    viewportWidth,
    viewportHeight
  })

  return { state, pageCount, info, declaredWidePages, viewportWidth, viewportHeight }
}

describe('resetForNewComic', () => {
  it('returns to the first page', () => {
    const { state } = setup({ pageCount: 50 })
    state.goToPage(40)
    expect(state.currentPage.value).toBe(40)

    state.resetForNewComic()
    expect(state.currentPage.value).toBe(0)
  })

  it('clears measured wide pages, which would otherwise corrupt the next comic', () => {
    // Without this, a landscape page 3 in one comic forces page 3 of the next
    // onto a row of its own no matter what shape it actually is.
    const { state } = setup({ config: { defaultSpread: 'double' } })
    state.markPageWide(3)
    expect(state.spreads.value).toContainEqual([3])

    state.resetForNewComic()
    expect(state.spreads.value).toEqual([[0], [1, 2], [3, 4], [5, 6], [7, 8], [9]])
  })

  it('keeps view preferences, which belong to the reader and not the comic', () => {
    const { state } = setup()
    state.cycleFitMode()
    state.toggleDirection()
    const fit = state.fitMode.value
    const rtl = state.rightToLeft.value

    state.resetForNewComic()

    expect(state.fitMode.value).toBe(fit)
    expect(state.rightToLeft.value).toBe(rtl)
  })

  it('leaves a shorter next comic in a consistent state', () => {
    // The concrete symptom: page 40 carried into a 20-page comic left the
    // viewport on spread 0 while the toolbar read "41 / 20".
    const { state, pageCount } = setup({ pageCount: 50 })
    state.goToPage(40)

    pageCount.value = 20
    state.resetForNewComic()

    expect(state.currentPage.value).toBe(0)
    expect(state.currentSpreadIndex.value).toBe(0)
    expect(state.canGoBack.value).toBe(false)
  })
})

describe('reader state basics', () => {
  it('clamps navigation to the available pages', () => {
    const { state } = setup({ pageCount: 5 })
    state.goToPage(99)
    expect(state.currentPage.value).toBe(4)
    state.goToPage(-5)
    expect(state.currentPage.value).toBe(0)
  })

  it('honours a right-to-left declaration from ComicInfo', async () => {
    const { state, info } = setup()
    expect(state.rightToLeft.value).toBe(false)

    info.value = { readingDirection: 'rtl', pages: [] } as ComicInfo
    // The watcher is not immediate for later changes; it flushes on tick.
    await nextTick()

    expect(state.rightToLeft.value).toBe(true)
  })

  it('auto spread needs a wide, landscape viewport', () => {
    const narrow = setup({ config: { defaultSpread: 'auto' }, width: 700, height: 900 })
    expect(narrow.state.twoPageActive.value).toBe(false)

    const wide = setup({ config: { defaultSpread: 'auto' }, width: 1400, height: 900 })
    expect(wide.state.twoPageActive.value).toBe(true)
  })

  it('re-phases spreads when a page is measured as wide', () => {
    const { state } = setup({ pageCount: 7, config: { defaultSpread: 'double' } })
    expect(state.spreads.value).toEqual([[0], [1, 2], [3, 4], [5, 6]])

    state.markPageWide(2)
    expect(state.spreads.value).toEqual([[0], [1], [2], [3, 4], [5, 6]])
  })
})

describe('rotation', () => {
  it('cycles a quarter turn at a time and returns to upright', () => {
    const { state } = setup()
    const seen = [state.rotation.value]
    for (let i = 0; i < 4; i++) {
      state.rotateClockwise()
      seen.push(state.rotation.value)
    }
    expect(seen).toEqual([0, 90, 180, 270, 0])
  })

  it('suspends two-page mode while sideways without losing the preference', () => {
    const { state } = setup({ config: { defaultSpread: 'double' } })
    expect(state.twoPageActive.value).toBe(true)

    state.rotateClockwise() // 90
    expect(state.twoPageActive.value).toBe(false)
    // The stored preference is untouched — only the derived value changed.
    expect(state.spreadMode.value).toBe('double')

    state.rotateClockwise() // 180: aspect unchanged, pairing valid again
    expect(state.twoPageActive.value).toBe(true)

    state.rotateClockwise() // 270
    expect(state.twoPageActive.value).toBe(false)

    state.rotateClockwise() // 0
    expect(state.twoPageActive.value).toBe(true)
    expect(state.spreadMode.value).toBe('double')
  })

  it('collapses spreads to one page per row while sideways', () => {
    const { state } = setup({ pageCount: 6, config: { defaultSpread: 'double' } })
    expect(state.spreads.value).toEqual([[0], [1, 2], [3, 4], [5]])

    state.rotateClockwise()
    expect(state.spreads.value).toEqual([[0], [1], [2], [3], [4], [5]])
  })

  it('still accepts a two-page toggle while sideways, applied on return', () => {
    // The button and `d` key keep working; only the effect is deferred.
    const { state } = setup({ config: { defaultSpread: 'single' } })
    state.rotateClockwise()
    expect(state.twoPageActive.value).toBe(false)

    state.toggleSpreadMode()
    expect(state.spreadMode.value).toBe('double')
    expect(state.twoPageActive.value).toBe(false)

    state.rotateClockwise()
    state.rotateClockwise()
    state.rotateClockwise()
    expect(state.rotation.value).toBe(0)
    expect(state.twoPageActive.value).toBe(true)
  })

  it('returns to upright for a new comic', () => {
    const { state } = setup()
    state.rotateClockwise()
    state.resetForNewComic()
    expect(state.rotation.value).toBe(0)
  })
})

describe('two-page toggle while sideways', () => {
  it('can still be turned off, not only on', () => {
    // Regression: the toggle used to read `twoPageActive`, which is always
    // false while sideways, so it could only ever set 'double'. The button
    // appeared stuck on.
    const { state } = setup({ config: { defaultSpread: 'double' } })
    state.rotateClockwise() // 90
    expect(state.twoPageActive.value).toBe(false)

    state.toggleSpreadMode()
    expect(state.spreadMode.value).toBe('single')

    state.toggleSpreadMode()
    expect(state.spreadMode.value).toBe('double')
  })

  it('reports the upright value so the toolbar can show the real setting', () => {
    const { state } = setup({ config: { defaultSpread: 'double' } })
    state.rotateClockwise()
    expect(state.twoPageActive.value).toBe(false)
    expect(state.twoPageWhenUpright.value).toBe(true)
  })
})

describe('reading direction set by metadata', () => {
  it('does not carry a manga’s right-to-left into the next comic', async () => {
    const { state, info } = setup()
    info.value = { readingDirection: 'rtl', pages: [] } as ComicInfo
    await nextTick()
    expect(state.rightToLeft.value).toBe(true)

    state.resetForNewComic()
    expect(state.rightToLeft.value).toBe(false)
  })

  it('keeps a direction the reader chose', () => {
    const { state } = setup()
    state.toggleDirection()
    state.resetForNewComic()
    expect(state.rightToLeft.value).toBe(true)
  })

  it('treats the reader switching back as their choice, not the comic’s', async () => {
    const { state, info } = setup()
    info.value = { readingDirection: 'rtl', pages: [] } as ComicInfo
    await nextTick()
    state.toggleDirection()
    state.toggleDirection()
    state.resetForNewComic()
    expect(state.rightToLeft.value).toBe(true)
  })
})
