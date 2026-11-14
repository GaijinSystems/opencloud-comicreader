import { computed, ref, watch, type Ref } from 'vue'

import { buildSpreads, leadPageOfSpread, spreadIndexOfPage } from '../helpers/spread'
import type { ComicInfo } from '../archive/comicInfo'
import { FIT_MODES, type FitMode, type SpreadMode, type ComicReaderConfig } from '../config'
import { isSidewaysRotation, nextRotation, type Rotation } from '../helpers/rotatedFit'

export interface UseReaderStateOptions {
  config: ComicReaderConfig
  pageCount: Ref<number>
  info: Ref<ComicInfo | null>
  /** Pages ComicInfo marks as double-page spreads. */
  declaredWidePages: Ref<ReadonlySet<number>>
  /** Viewport width, used to decide `auto` spread mode. */
  viewportWidth: Ref<number>
  viewportHeight: Ref<number>
}

/** Below this the screen is too narrow for two pages to be legible. */
const TWO_PAGE_MIN_WIDTH = 900

export function useReaderState({
  config,
  pageCount,
  info,
  declaredWidePages,
  viewportWidth,
  viewportHeight
}: UseReaderStateOptions) {
  const currentPage = ref(0)
  const fitMode = ref<FitMode>(config.defaultFitMode)
  const spreadMode = ref<SpreadMode>(config.defaultSpread)
  const rightToLeft = ref(false)
  /** Pages measured as landscape once loaded, on top of ComicInfo's list. */
  const measuredWidePages = ref<Set<number>>(new Set())
  /** Display rotation for the whole comic. Never persisted. */
  const rotation = ref<Rotation>(0)
  /**
   * True while right-to-left was switched on by a comic's metadata rather
   * than by the reader. That setting belongs to the comic and must not carry
   * into the next one; a direction the reader chose does.
   */
  let rightToLeftFromMetadata = false

  /**
   * True at 90° and 270°, where every page's displayed aspect is inverted.
   * Drives both the rendering path and the suspension of two-page mode.
   */
  const isSideways = computed(() => isSidewaysRotation(rotation.value))

  // Manga releases declare their direction in ComicInfo; honouring it saves
  // the reader from flipping the whole book backwards before noticing.
  watch(
    info,
    (value) => {
      if (value?.readingDirection === 'rtl') {
        rightToLeftFromMetadata = !rightToLeft.value
        rightToLeft.value = true
      }
    },
    { immediate: true }
  )

  /**
   * What two-page mode resolves to ignoring rotation — i.e. what the reader
   * would see upright. `auto` has to be resolved against the viewport, so
   * this cannot simply read `spreadMode`.
   */
  const twoPageWhenUpright = computed(() => {
    if (spreadMode.value === 'single') {
      return false
    }
    if (spreadMode.value === 'double') {
      return true
    }
    // auto: only when the viewport is genuinely landscape and wide enough.
    return viewportWidth.value >= TWO_PAGE_MIN_WIDTH && viewportWidth.value > viewportHeight.value
  })

  /**
   * What the layout actually uses.
   *
   * Rotated a quarter turn, pages display landscape. Pairing two of them
   * gives four half-height columns, which is unreadable. Derived rather than
   * stored, so the reader's own preference survives untouched and returns the
   * moment rotation is back to 0° or 180°.
   */
  const twoPageActive = computed(() => !isSideways.value && twoPageWhenUpright.value)

  const widePages = computed(() => {
    const combined = new Set<number>(declaredWidePages.value)
    measuredWidePages.value.forEach((index) => combined.add(index))
    return combined
  })

  const spreads = computed(() => {
    if (!twoPageActive.value) {
      return Array.from({ length: pageCount.value }, (_, index) => [index])
    }
    return buildSpreads(pageCount.value, {
      widePages: widePages.value,
      coverAlone: true,
      rightToLeft: rightToLeft.value
    })
  })

  const currentSpreadIndex = computed(() => spreadIndexOfPage(spreads.value, currentPage.value))
  const currentSpread = computed(() => spreads.value[currentSpreadIndex.value] ?? [])

  const canGoBack = computed(() => currentSpreadIndex.value > 0)
  const canGoForward = computed(() => currentSpreadIndex.value < spreads.value.length - 1)

  function goToPage(index: number) {
    if (!pageCount.value) {
      return
    }
    currentPage.value = Math.min(Math.max(index, 0), pageCount.value - 1)
  }

  function goToSpread(index: number) {
    const spread = spreads.value[Math.min(Math.max(index, 0), spreads.value.length - 1)]
    if (spread) {
      currentPage.value = leadPageOfSpread(spread)
    }
  }

  function next() {
    goToSpread(currentSpreadIndex.value + 1)
  }

  function previous() {
    goToSpread(currentSpreadIndex.value - 1)
  }

  function first() {
    goToPage(0)
  }

  function last() {
    goToSpread(spreads.value.length - 1)
  }

  /**
   * Records that a page turned out to be landscape.
   *
   * Dimensions are only known once the image decodes, so the spread layout has
   * to be able to change under the reader. Position is tracked as a page
   * index rather than a spread index, which is what keeps the reader on the
   * same page when the pairing shifts around it.
   */
  function markPageWide(index: number) {
    if (measuredWidePages.value.has(index)) {
      return
    }
    const next = new Set(measuredWidePages.value)
    next.add(index)
    measuredWidePages.value = next
  }

  function cycleFitMode() {
    const index = FIT_MODES.indexOf(fitMode.value)
    fitMode.value = FIT_MODES[(index + 1) % FIT_MODES.length]
  }

  function toggleSpreadMode() {
    // Deliberately reasons about the upright value, not the active one. While
    // sideways `twoPageActive` is always false, so using it here would let the
    // button switch two-page on and never back off again.
    spreadMode.value = twoPageWhenUpright.value ? 'single' : 'double'
  }

  function toggleDirection() {
    rightToLeft.value = !rightToLeft.value
    rightToLeftFromMetadata = false
  }

  function rotateClockwise() {
    rotation.value = nextRotation(rotation.value)
  }

  /**
   * Clears everything that belongs to one specific comic.
   *
   * This composable is created once per mount and reused when the route's
   * resource changes in place, which happens on browser back/forward between
   * two comics. Without this, `measuredWidePages` carries one comic's
   * landscape pages into the next and forces them onto rows of their own, and
   * `currentPage` survives past the end of a shorter comic — leaving the
   * viewport on spread 0 while the toolbar reads "41 / 20".
   *
   * View preferences are deliberately kept: fit mode, spread mode and reading
   * direction belong to the reader, not to the comic. The exception is a
   * right-to-left setting that the previous comic's metadata switched on,
   * which is undone here; the `info` watcher sets it again if the next comic
   * declares it too.
   */
  function resetForNewComic() {
    currentPage.value = 0
    measuredWidePages.value = new Set()
    rotation.value = 0
    if (rightToLeftFromMetadata) {
      rightToLeft.value = false
      rightToLeftFromMetadata = false
    }
  }

  return {
    currentPage,
    fitMode,
    spreadMode,
    rightToLeft,
    rotation,
    isSideways,
    twoPageActive,
    twoPageWhenUpright,
    spreads,
    currentSpread,
    currentSpreadIndex,
    canGoBack,
    canGoForward,
    goToPage,
    goToSpread,
    next,
    previous,
    first,
    last,
    markPageWide,
    resetForNewComic,
    cycleFitMode,
    toggleSpreadMode,
    toggleDirection,
    rotateClockwise
  }
}
