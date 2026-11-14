<template>
  <!--
    Every style that the layout depends on is inline. This app ships no utility
    CSS of its own and has no Tailwind compiler; a class works only if
    OpenCloud's shell happens to compile it for its own use, and an absent
    class fails silently. `left-1/2` did exactly that and cost four releases.
    Classes remain only for decoration (colours), where failure is visible and
    harmless. See README, "Utility classes are not all available".
  -->
  <div
    ref="viewport"
    class="comic-viewport bg-role-surface-container"
    :style="viewportStyle"
    @click="onClick"
    @scroll.passive="onScroll"
  >
    <!--
      Centred with `margin: auto` on the row rather than align/justify on the
      container. The two look identical until the row is larger than the
      container: align/justify then overflows equally on both sides and the
      start side becomes unreachable, so the top of a zoomed page cannot be
      scrolled to. An auto margin centres the same way while leaving overflow
      reachable. min-width/height 100% make the row fill the container when
      the page is smaller than it, so centring still applies in that direction.
    -->
    <div :style="rowStyle">
      <template v-for="page in spread" :key="page">
        <div :style="paneStyle">
          <!--
            Sideways pages get a wrapper sized to their ROTATED footprint, with
            the image centred inside it and rotated about that centre. The row
            then lays out a plain box of the right size and never has to reason
            about the transform, which is what keeps scroll geometry correct.

            At 0 and 180 degrees this wrapper is not rendered. Aspect ratio is
            unchanged at 180, so the upright sizing remains correct there.
          -->
          <div v-if="urls[page] && rotatedBoxes[page]" :style="wrapperStyle(page)">
            <img
              :src="urls[page] as string"
              :alt="altTextFor(page)"
              class="comic-page"
              :style="rotatedImageStyle(page)"
              draggable="false"
              @load="onImageLoad(page, $event)"
            />
          </div>

          <img
            v-else-if="urls[page]"
            :src="urls[page] as string"
            :alt="altTextFor(page)"
            class="comic-page"
            :style="uprightImageStyle"
            draggable="false"
            @load="onImageLoad(page, $event)"
          />

          <div v-else-if="failed[page]" :style="placeholderStyle">
            <oc-icon name="file-damage" size-class="size-10" color="var(--oc-role-error)" />
            <p class="text-sm" v-text="$gettext('This page could not be read')" />
            <!--
              Not every failure is permanent: a page read over the network can
              fail on a dropped connection. Offered only where reading again
              can help. `.stop` keeps the click from also toggling the toolbar,
              and the z-index lifts the button above the page-turn zones,
              which would otherwise cover it in a two-page spread.
            -->
            <oc-button
              v-if="failed[page] === 'retryable'"
              appearance="outline"
              size="small"
              style="position: relative; z-index: 1"
              @click.stop="$emit('retry-page', page)"
            >
              <oc-icon name="refresh" fill-type="line" size="small" />
              {{ $gettext('Try again') }}
            </oc-button>
          </div>
          <div v-else :style="placeholderStyle">
            <oc-spinner :aria-label="$gettext('Loading page')" size="large" />
          </div>
        </div>
      </template>
    </div>

    <!--
      Invisible click targets. A click on the outer quarters turns the page and
      a click in the middle toggles the toolbar, which is the interaction model
      every dedicated comic reader uses. Inset from the edges so neither zone
      ever sits on top of a scrollbar.
    -->
    <button
      :style="{ ...zoneStyle, left: `${scrollOffset.left}px`, cursor: 'w-resize' }"
      :aria-label="$gettext('Previous page')"
      @click.stop="$emit('navigate', 'left')"
    />
    <button
      :style="{ ...zoneStyle, right: `calc(1rem - ${scrollOffset.left}px)`, cursor: 'e-resize' }"
      :aria-label="$gettext('Next page')"
      @click.stop="$emit('navigate', 'right')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import { useGettext } from 'vue3-gettext'
import type { FitMode } from '../config'
import {
  isSidewaysRotation,
  rotatedFit,
  type RotatedFit,
  type Rotation
} from '../helpers/rotatedFit'

const { spread, urls, failed, fitMode, pageCount, rotation } = defineProps<{
  /** Page indices to render, already in display order. */
  spread: number[]
  /** Blob URL per page index, or null while loading. */
  urls: Record<number, string | null>
  /** Pages that could not be read, and whether reading again could help. */
  failed: Record<number, 'retryable' | 'permanent'>
  fitMode: FitMode
  pageCount: number
  /** Display rotation for the whole comic. 0 is the untouched path. */
  rotation: Rotation
}>()

const emit = defineEmits<{
  (e: 'navigate', direction: 'left' | 'right'): void
  (e: 'toggle-chrome'): void
  (e: 'page-is-wide', page: number): void
  (e: 'retry-page', page: number): void
  /** The reading area's own size, for anything that must fit inside it. */
  (e: 'resize', size: { width: number; height: number }): void
}>()

const { $gettext } = useGettext()
const viewport = ref<HTMLElement | null>(null)

/**
 * The reading area's size, measured on this element and nowhere else.
 *
 * It has to be this element: the app root also contains the toolbar, the page
 * strip and any banners, so its height overstates the space a page can use.
 */
const containerWidth = ref(0)
const containerHeight = ref(0)
let resizeObserver: ResizeObserver | null = null

function measure() {
  const element = viewport.value
  if (!element) {
    return
  }
  // The client box: what is left for a page once a scrollbar has taken its
  // share. Measured from the outer box, a sideways page was sized to space
  // the scrollbar occupied and lost that strip of itself.
  const { clientWidth: width, clientHeight: height } = element
  containerWidth.value = width
  containerHeight.value = height
  emit('resize', { width, height })
  onScroll()
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(viewport.value)
  } else {
    window.addEventListener('resize', measure)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', measure)
})

/**
 * Natural dimensions per page, learned as each image decodes.
 *
 * Keyed by the blob URL rather than the page index: page 3 of one comic and
 * page 3 of the next share an index but never a URL, so a stale hit is
 * impossible. Entries whose URL is no longer on screen are dropped on every
 * insert, so the map never grows past the current spread.
 */
const naturalSizes = ref(new Map<string, { width: number; height: number }>())

function rememberSize(url: string, width: number, height: number) {
  const onScreen = new Set(Object.values(urls).filter(Boolean) as string[])
  const next = new Map<string, { width: number; height: number }>()
  for (const [key, size] of naturalSizes.value) {
    if (onScreen.has(key)) {
      next.set(key, size)
    }
  }
  next.set(url, { width, height })
  naturalSizes.value = next
}

/*
 * Layout tables, one per level of the chain. Every fit mode needs a matching
 * constraint at each level: `height: 100%` on an <img> does nothing unless an
 * ancestor has a definite height, and `width: 100%` is circular when the
 * parent's width is derived from its own content. Setting only the image
 * silently produced original-size behaviour for three of the four modes.
 */

interface FitLayout {
  viewport: CSSProperties
  row: CSSProperties
  pane: CSSProperties
  image: CSSProperties
}

/**
 * The per-mode part of each level, side by side so a mode can be read across.
 *
 * - viewport: which axes scroll. fit-width constrains the width, so only
 *   vertical scroll; fit-height the reverse.
 * - pane: `flex: 1` splits the row between the halves of a spread; without it
 *   each pane claims the full width and the second one overflows.
 * - image: `maxWidth: none` matters in three of the four modes. The host's
 *   preflight sets `img { max-width: 100% }`, which would otherwise cap
 *   fit-height and original at the pane width.
 */
const FIT_LAYOUT: Record<FitMode, FitLayout> = {
  'fit-page': {
    viewport: { overflow: 'hidden' },
    row: { width: '100%', height: '100%' },
    pane: { flex: '1 1 0%', height: '100%' },
    image: { maxWidth: '100%', maxHeight: '100%' }
  },
  'fit-width': {
    viewport: { overflowY: 'auto', overflowX: 'hidden' },
    row: { width: '100%' },
    pane: { flex: '1 1 0%' },
    image: { width: '100%', height: 'auto', maxWidth: 'none' }
  },
  'fit-height': {
    viewport: { overflowX: 'auto', overflowY: 'hidden' },
    row: { height: '100%' },
    pane: { height: '100%' },
    image: { height: '100%', width: 'auto', maxWidth: 'none' }
  },
  original: {
    viewport: { overflow: 'auto' },
    row: {},
    pane: {},
    image: { maxWidth: 'none', maxHeight: 'none' }
  }
}

const layout = computed(() => FIT_LAYOUT[fitMode])

/**
 * What a sideways page adds to the viewport, where it is fitted to one axis.
 *
 * An upright page is sized by the browser, which settles "does this need a
 * scrollbar?" and "how wide is the page then?" together. A sideways page is
 * sized by script from the measured client box, and there the two questions
 * chase each other: the scrollbar narrows the box, the narrower page no
 * longer needs it, the scrollbar goes, and round again. Reserving the
 * scrollbar on the axis that scrolls makes the client box the same either
 * way. Where scrollbars overlay the content this changes nothing visible.
 */
const SIDEWAYS_SCROLL: Partial<Record<FitMode, CSSProperties>> = {
  'fit-width': { overflowY: 'scroll' },
  'fit-height': { overflowX: 'scroll' }
}

const viewportStyle = computed<CSSProperties>(() => ({
  position: 'relative',
  display: 'flex',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  userSelect: 'none',
  ...layout.value.viewport,
  ...(isSidewaysRotation(rotation) ? SIDEWAYS_SCROLL[fitMode] : {})
}))

const rowStyle = computed<CSSProperties>(() => ({
  margin: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  minWidth: '100%',
  minHeight: '100%',
  ...layout.value.row
}))

const paneStyle = computed<CSSProperties>(() => ({
  position: 'relative',
  display: 'flex',
  minWidth: 0,
  ...layout.value.pane
}))

/** The upright image. A half turn is a pure transform with no resizing. */
const uprightImageStyle = computed<CSSProperties>(() => ({
  display: 'block',
  objectFit: 'contain',
  margin: 'auto',
  ...layout.value.image,
  ...(rotation === 180 ? { transform: 'rotate(180deg)' } : {})
}))

const placeholderStyle: CSSProperties = {
  margin: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.5rem',
  padding: '2rem',
  textAlign: 'center'
}

/**
 * Geometry for the invisible page-turn zones. A zone whose positioning
 * silently did nothing would either vanish or cover the whole reader and
 * swallow every click, so this is not left to classes.
 */
const scrollOffset = ref({ top: 0, left: 0 })

// Clamped to what the content row itself needs. Measured as the row's
// scrollable extent, not its box: the row is a flex item that shrinks to the
// container's width, so a page wider than the reading area overflows it. The zones are part of the
// container's scrollable overflow, so placing them at the raw scroll position
// would hold the extent open after the content shrinks (a resize, a shorter
// page) and the view could only creep back a little per frame.
function onScroll() {
  const element = viewport.value
  const row = element?.firstElementChild as HTMLElement | null
  if (element && row) {
    scrollOffset.value = {
      top: Math.min(element.scrollTop, Math.max(0, row.scrollHeight - element.clientHeight)),
      left: Math.min(element.scrollLeft, Math.max(0, row.scrollWidth - element.clientWidth))
    }
  }
}

/**
 * The zones are positioned against the scroll container's own box, which
 * moves with its content. Left alone they would scroll out of view, and a
 * click at the edge of a scrolled page would toggle the toolbar instead of
 * turning the page. Offsetting them by the scroll position keeps them over
 * the visible area; at the origin this is exactly `top: 0; bottom: 1rem`.
 */
const zoneStyle = computed<CSSProperties>(() => ({
  position: 'absolute',
  top: `${scrollOffset.value.top}px`,
  bottom: `calc(1rem - ${scrollOffset.value.top}px)`,
  width: '25%',
  opacity: 0
}))

/**
 * Geometry for each sideways page on screen, computed once per render rather
 * than once per binding. Absent entries mean "render upright": that covers
 * 0 and 180 degrees, and the frames before an image has reported its size.
 */
const rotatedBoxes = computed<Record<number, RotatedFit>>(() => {
  const boxes: Record<number, RotatedFit> = {}
  const container = { width: containerWidth.value, height: containerHeight.value }
  for (const page of spread) {
    const url = urls[page]
    const natural = url ? naturalSizes.value.get(url) : undefined
    if (!natural) {
      continue
    }
    const box = rotatedFit(natural, container, fitMode, rotation)
    if (box) {
      boxes[page] = box
    }
  }
  return boxes
})

/** Wrapper box for a sideways page: the rotated footprint, centred in the pane. */
function wrapperStyle(page: number): CSSProperties | undefined {
  const box = rotatedBoxes.value[page]
  if (!box) {
    return undefined
  }
  return {
    position: 'relative',
    flex: '0 0 auto',
    margin: 'auto',
    width: `${box.footprint.width}px`,
    height: `${box.footprint.height}px`
  }
}

/**
 * The image inside that wrapper. Centred with pixel offsets computed from
 * sizes we already know, then rotated about its own centre, which the offsets
 * have placed at the wrapper's centre — so the rotated box lands exactly on
 * the wrapper regardless of how the browser resolves percentages.
 */
function rotatedImageStyle(page: number): CSSProperties | undefined {
  const box = rotatedBoxes.value[page]
  if (!box) {
    return undefined
  }
  return {
    position: 'absolute',
    display: 'block',
    maxWidth: 'none',
    width: `${box.image.width}px`,
    height: `${box.image.height}px`,
    left: `${(box.footprint.width - box.image.width) / 2}px`,
    top: `${(box.footprint.height - box.image.height) / 2}px`,
    transform: `rotate(${rotation}deg)`,
    transformOrigin: 'center'
  }
}

function altTextFor(page: number): string {
  return $gettext('Page %{current} of %{total}', {
    current: String(page + 1),
    total: String(pageCount)
  })
}

/**
 * Records the page's natural size, and reports landscape pages upward so the
 * spread layout can give them a row of their own. Dimensions are only knowable
 * once the image has decoded, which is why both are events rather than
 * something computed up front.
 */
function onImageLoad(page: number, event: Event) {
  const image = event.target as HTMLImageElement
  const { naturalWidth, naturalHeight } = image
  const url = urls[page]
  if (url && naturalWidth && naturalHeight) {
    rememberSize(url, naturalWidth, naturalHeight)
  }
  if (naturalWidth > naturalHeight) {
    emit('page-is-wide', page)
  }
}

function onClick() {
  emit('toggle-chrome')
}

// A change of fit or rotation can add or remove a scrollbar, and with it
// change the client box, so that is measured again once the change is in the
// DOM. A ResizeObserver reports it too, where there is one.
watch(() => `${rotation}|${fitMode}`, measure, { flush: 'post' })

// Scroll to the visual start of the page on a page turn, a rotation or a fit
// change. At 90° and 270° the wrapper's top is the visual top, so the origin
// is right. At 180° the image is rotated in place, so its layout top is its
// visual bottom: the half turn scrolls to the far corner instead, after a tick
// so the new extent has been laid out.
watch(
  () => `${spread.join(',')}|${rotation}|${fitMode}`,
  async () => {
    const element = viewport.value
    if (!element) {
      return
    }
    if (rotation === 180) {
      await nextTick()
      element.scrollTo({ top: element.scrollHeight, left: element.scrollWidth })
      return
    }
    element.scrollTo({ top: 0, left: 0 })
  }
)
</script>
