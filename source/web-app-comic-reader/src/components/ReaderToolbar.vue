<template>
  <div
    class="comic-toolbar flex flex-wrap items-center gap-2 border-t border-role-outline-variant bg-role-surface-container-high px-3 py-2"
  >
    <oc-button
      appearance="raw"
      :aria-label="$gettext('Previous page')"
      :title="
        rightToLeft ? $gettext('Previous page (Right arrow)') : $gettext('Previous page (Left arrow)')
      "
      :disabled="!canGoBack"
      @click="$emit('previous')"
    >
      <oc-icon :name="rightToLeft ? 'arrow-right-s' : 'arrow-left-s'" />
    </oc-button>

    <oc-button
      appearance="raw"
      :aria-label="$gettext('Next page')"
      :title="
        rightToLeft ? $gettext('Next page (Left arrow)') : $gettext('Next page (Right arrow)')
      "
      :disabled="!canGoForward"
      @click="$emit('next')"
    >
      <oc-icon :name="rightToLeft ? 'arrow-left-s' : 'arrow-right-s'" />
    </oc-button>

    <!--
      A range input rather than a custom widget: it is keyboard accessible and
      screen-reader friendly for free, and scrubbing a long comic is exactly
      what it is for.
    -->
    <label class="flex flex-1 min-w-40 items-center gap-2">
      <span class="sr-only" v-text="$gettext('Page')" />
      <input
        type="range"
        class="w-full"
        min="0"
        :max="Math.max(pageCount - 1, 0)"
        :value="currentPage"
        :aria-valuetext="positionLabel"
        @input="onScrub"
      />
    </label>

    <span class="tabular-nums text-sm whitespace-nowrap" v-text="positionLabel" />

    <!--
      Only rendered when ComicInfo.xml supplied a series or title; otherwise
      the file name is already in the app bar above and repeating it is noise.
    -->
    <span
      v-if="title"
      class="hidden max-w-60 truncate text-sm opacity-80 md:inline"
      :title="title"
      v-text="title"
    />

    <oc-button
      appearance="raw"
      :aria-label="$gettext('Change zoom mode')"
      :title="fitTitle"
      @click="$emit('cycle-fit')"
    >
      <oc-icon :name="fitIcon" />
    </oc-button>

    <oc-button
      appearance="raw"
      :aria-label="$gettext('Rotate page')"
      :title="rotateTitle"
      @click="$emit('rotate')"
    >
      <oc-icon name="clockwise" />
    </oc-button>

    <oc-button
      appearance="raw"
      :aria-label="$gettext('Toggle two-page view')"
      :title="spreadTitle"
      :aria-pressed="twoPageWhenUpright"
      @click="$emit('toggle-spread')"
    >
      <oc-icon :name="twoPageWhenUpright ? 'book-open' : 'file-list'" />
    </oc-button>

    <oc-button
      appearance="raw"
      :aria-label="$gettext('Toggle right-to-left reading')"
      :title="directionTitle"
      :aria-pressed="rightToLeft"
      @click="$emit('toggle-direction')"
    >
      <oc-icon name="arrow-left-right" />
    </oc-button>

    <oc-button
      appearance="raw"
      :aria-label="$gettext('Show all pages')"
      :title="stripTitle"
      :aria-pressed="stripOpen"
      @click="$emit('toggle-strip')"
    >
      <oc-icon name="layout-grid" />
    </oc-button>

    <oc-button
      appearance="raw"
      :aria-label="$gettext('Toggle full screen')"
      :title="isFullScreen ? $gettext('Exit full screen') : $gettext('Full screen')"
      @click="$emit('toggle-fullscreen')"
    >
      <oc-icon :name="isFullScreen ? 'fullscreen-exit' : 'fullscreen'" />
    </oc-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import type { FitMode } from '../config'
import type { Rotation } from '../helpers/rotatedFit'

const {
  title,
  rotation,
  isSideways,
  twoPageWhenUpright,
  currentPage,
  pageCount,
  canGoBack,
  canGoForward,
  fitMode,
  rightToLeft,
  stripOpen,
  isFullScreen
} = defineProps<{
  /** Series/issue from ComicInfo.xml, or empty when the file has none. */
  title: string
  /** Current display rotation, in degrees clockwise. */
  rotation: Rotation
  /** True at 90 and 270, where two-page mode is suspended. */
  isSideways: boolean
  /** The stored two-page preference, which the button toggles. */
  twoPageWhenUpright: boolean
  currentPage: number
  pageCount: number
  canGoBack: boolean
  canGoForward: boolean
  fitMode: FitMode
  rightToLeft: boolean
  stripOpen: boolean
  isFullScreen: boolean
}>()

const emit = defineEmits<{
  (e: 'previous'): void
  (e: 'next'): void
  (e: 'go-to-page', page: number): void
  (e: 'cycle-fit'): void
  (e: 'toggle-spread'): void
  (e: 'rotate'): void
  (e: 'toggle-direction'): void
  (e: 'toggle-strip'): void
  (e: 'toggle-fullscreen'): void
}>()

const { $gettext } = useGettext()

const positionLabel = computed(() =>
  $gettext('%{current} / %{total}', {
    current: String(currentPage + 1),
    total: String(pageCount)
  })
)

const fitModeLabel = computed(() => {
  switch (fitMode) {
    case 'fit-width':
      return $gettext('Fit width')
    case 'fit-height':
      return $gettext('Fit height')
    case 'original':
      return $gettext('Original size')
    default:
      return $gettext('Fit page')
  }
})

const fitTitle = computed(() =>
  $gettext('Zoom: %{mode} — click to change (f)', { mode: fitModeLabel.value })
)

const rotateTitle = computed(() =>
  rotation === 0
    ? $gettext('Rotate page (v)')
    : $gettext('Rotated %{angle}° — click to rotate further (v)', {
        angle: String(rotation)
      })
)

/**
 * While sideways the button still toggles the stored preference, but the
 * effect is deferred. Saying so beats a disabled control that does not
 * explain itself.
 */
const spreadTitle = computed(() => {
  if (isSideways) {
    return twoPageWhenUpright
      ? $gettext('Two-page view: on, paused while rotated — returns at 0° or 180° (d)')
      : $gettext('Two-page view: off — click to turn on; applies at 0° or 180° (d)')
  }
  return twoPageWhenUpright
    ? $gettext('Two-page view: on — click for single page (d)')
    : $gettext('Two-page view: off — click for two pages (d)')
})

const directionTitle = computed(() =>
  rightToLeft
    ? $gettext('Reading right to left — click for left to right (r)')
    : $gettext('Reading left to right — click for right to left (r)')
)

const stripTitle = computed(() =>
  stripOpen ? $gettext('Hide page thumbnails (t)') : $gettext('Show page thumbnails (t)')
)

const fitIcon = computed(() => {
  switch (fitMode) {
    case 'fit-width':
      return 'expand-horizontal'
    case 'fit-height':
      return 'expand-vertical'
    case 'original':
      return 'search'
    default:
      return 'aspect-ratio'
  }
})

function onScrub(event: Event) {
  const value = Number.parseInt((event.target as HTMLInputElement).value, 10)
  if (Number.isFinite(value)) {
    emit('go-to-page', value)
  }
}
</script>
