<template>
  <div
    ref="root"
    class="comic-reader flex size-full flex-col outline-none"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <div v-if="loading" class="flex size-full flex-col items-center justify-center gap-4">
      <oc-spinner :aria-label="$gettext('Opening comic')" size="xlarge" />
      <p v-if="progressLabel" class="text-sm tabular-nums opacity-80" v-text="progressLabel" />
    </div>

    <!--
      A password-protected comic. Shown again, saying so, when the
      password did not work. Each showing starts with an empty field: the
      spinner above replaces it while a password is being tried.
    -->
    <reader-password
      v-else-if="error && isPasswordPrompt(error)"
      :wrong="error.code === 'wrong-password'"
      :file-name="resource.name"
      :download-url="downloadUrl"
      @submit="load"
    />

    <reader-error
      v-else-if="error"
      :error="error"
      :file-name="resource.name"
      :download-url="downloadUrl"
      @retry="load"
    />

    <template v-else>
      <!--
        min-h-0 is load-bearing. A flex item defaults to min-height:auto, so
        without it the viewport cannot shrink below its content: the column
        grows to the image's natural height, h-full inside resolves against
        that, and max-h-full stops constraining anything. Fit-page then
        behaves exactly like original size.
      -->
      <reader-viewport
        class="grow min-h-0"
        :spread="currentSpread"
        :rotation="rotation"
        :urls="visibleUrls"
        :failed="failedPages"
        :fit-mode="fitMode"
        :page-count="pageCount"
        @navigate="onViewportNavigate"
        @resize="onViewportResize"
        @toggle-chrome="chromeVisible = !chromeVisible"
        @page-is-wide="markPageWide"
        @retry-page="retryPage"
      />

      <!--
        A silently short comic is worse than an error: it looks like success.
        libarchive enumerates only the first entry of a solid RAR4 block, so
        the count from the container's own headers is what reveals the rest are
        gone. Dismissible, because the pages that did load are still readable.
      -->
      <div
        v-if="warning && !missingDismissed"
        class="flex items-center gap-2 px-3 py-2 text-sm"
        :style="{
          background: 'var(--oc-role-error-container)',
          color: 'var(--oc-role-on-error-container)'
        }"
      >
        <oc-icon name="alert" fill-type="line" />
        <span v-text="missingPagesMessage" />
        <oc-button
          v-if="downloadUrl"
          type="a"
          appearance="raw"
          size="small"
          class="underline"
          :style="{ marginLeft: 'auto' }"
          :href="downloadUrl"
          :download="resource.name"
        >
          {{ $gettext('Download original') }}
        </oc-button>
        <oc-button
          appearance="raw"
          size="small"
          :aria-label="$gettext('Dismiss')"
          @click="missingDismissed = true"
        >
          <oc-icon name="close" />
        </oc-button>
      </div>

      <div
        v-if="bulkExtracting"
        class="flex items-center justify-center gap-2 bg-role-surface-container-high px-3 py-1 text-sm"
      >
        <oc-spinner size="small" />
        <span v-text="$gettext('Unpacking the rest of this comic, page turns will speed up shortly')" />
      </div>

      <page-strip
        v-if="stripOpen"
        :page-count="pageCount"
        :current-page="currentPage"
        :urls="cachedUrls"
        @go-to-page="goToPage"
      />

      <reader-toolbar
        v-show="chromeVisible"
        :title="comicTitle"
        :rotation="rotation"
        :is-sideways="isSideways"
        :two-page-when-upright="twoPageWhenUpright"
        :current-page="currentPage"
        :page-count="pageCount"
        :can-go-back="canGoBack"
        :can-go-forward="canGoForward"
        :fit-mode="fitMode"
        :right-to-left="rightToLeft"
        :strip-open="stripOpen"
        :is-full-screen="isFullScreen"
        @previous="previous"
        @next="next"
        @go-to-page="goToPage"
        @cycle-fit="cycleFitMode"
        @rotate="rotateClockwise"
        @toggle-spread="toggleSpreadMode"
        @toggle-direction="toggleDirection"
        @toggle-strip="stripOpen = !stripOpen"
        @toggle-fullscreen="toggleFullScreen"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useGettext } from 'vue3-gettext'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import {
  useConfigStore,
  useDocumentTitle,
  useRequestHeaders,
  useUserStore,
  type AppConfigObject,
  type AppWrapperSlotProps,
  type AppFileHandlingResult
} from '@opencloud-eu/web-pkg'

import ReaderViewport from './components/ReaderViewport.vue'
import ReaderToolbar from './components/ReaderToolbar.vue'
import ReaderError from './components/ReaderError.vue'
import ReaderPassword from './components/ReaderPassword.vue'
import { isPasswordPrompt } from './archive/types'
import PageStrip from './components/PageStrip.vue'

import { useComicArchive } from './composables/useComicArchive'
import { useReaderState } from './composables/useReaderState'
import {
  ANONYMOUS_SCOPE,
  furthestPageOnScreen,
  loadProgress,
  saveProgress
} from './composables/useReadingProgress'
import { metadataTitle } from './archive/comicInfo'
import { readConfig } from './config'
import { formatBytes } from './helpers/format'

/**
 * Only the props this component genuinely uses are declared, and that is
 * load-bearing rather than tidiness: AppWrapper inspects the wrapped
 * component's props to decide what to fetch. Declaring `currentContent` or
 * `url` here would make it GET the entire archive before we ever run, which
 * would defeat the streaming reader entirely.
 */
const { applicationConfig, space, resource, getUrlForResource, revokeUrl } = defineProps<
  Pick<AppWrapperSlotProps, 'applicationConfig' | 'space' | 'resource'> &
    Pick<AppFileHandlingResult, 'getUrlForResource' | 'revokeUrl'>
>()

const { $gettext, $ngettext } = useGettext()
const { headers } = useRequestHeaders()
const configStore = useConfigStore()
const userStore = useUserStore()

/** Whose reading positions these are; public links have no user. */
const progressScope = () => userStore.user?.id || ANONYMOUS_SCOPE

const config = readConfig(applicationConfig as AppConfigObject)

const root = ref<HTMLElement | null>(null)
const chromeVisible = ref(true)
const stripOpen = ref(false)
const isFullScreen = ref(false)
const downloadUrl = ref<string | null>(null)
// The reading area's own box, reported by ReaderViewport, which measures
// itself. Not the window: OpenCloud's sidebar and top bar can leave the
// reading area far narrower than the window. And not this component's root:
// that includes the toolbar and page strip, so its height overstates the
// space a page can use. Seeded from the window only until the first report.
const viewportWidth = ref(window.innerWidth)
const viewportHeight = ref(window.innerHeight)

function onViewportResize(size: { width: number; height: number }) {
  viewportWidth.value = size.width
  viewportHeight.value = size.height
}
/** Blob URLs for pages currently on screen, refreshed as they resolve. */
const visibleUrls = ref<Record<number, string | null>>({})
const cachedUrls = ref<Record<number, string | null>>({})

/**
 * The token may go to the web app's own origin and to the API server, which
 * are frequently different hosts. Anything else (a signed CDN download URL,
 * say) is fetched without credentials.
 */
const trustedOrigins = [window.location.origin]
try {
  trustedOrigins.push(new URL(configStore.serverUrl).origin)
} catch {
  // No usable server URL configured; same-origin only.
}

const archive = useComicArchive({
  config,
  headers,
  trustedOrigins,
  getUrlForResource
})

const {
  loading,
  error,
  progress,
  pageCount,
  info,
  bulkExtracting,
  warning,
  failedPages,
  declaredWidePages
} = archive

const missingDismissed = ref(false)

/**
 * Names the shortfall precisely rather than hedging. The count comes from the
 * container's own headers, so "3 pages could not be read" is a fact, not a
 * guess, and the user can judge whether the comic is worth downloading.
 */
const missingPagesMessage = computed(() => {
  const count = warning.value?.count ?? 0
  if (warning.value?.code === 'unsupported-compression') {
    return $ngettext(
      '%{count} page uses a compression method this reader cannot decode and will not display. Download the file to read it in a desktop comic reader.',
      '%{count} pages use a compression method this reader cannot decode and will not display. Download the file to read it in a desktop comic reader.',
      count,
      { count: String(count) }
    )
  }
  return $ngettext(
    '%{count} item in this archive could not be read, so a page may be missing. The archive may be damaged, or use a feature the decoder does not support. Download the file to read it in a desktop comic reader.',
    '%{count} items in this archive could not be read, so pages may be missing. The archive may be damaged, or use a feature the decoder does not support. Download the file to read it in a desktop comic reader.',
    count,
    { count: String(count) }
  )
})

const {
  currentPage,
  fitMode,
  rotation,
  isSideways,
  twoPageWhenUpright,
  rightToLeft,
  currentSpread,
  canGoBack,
  canGoForward,
  goToPage,
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
} = useReaderState({
  config,
  pageCount,
  info,
  declaredWidePages,
  viewportWidth,
  viewportHeight
})

/**
 * Title from ComicInfo.xml, empty when the archive carries no metadata worth
 * showing. Deliberately falls back to empty rather than the file name: the
 * file name is already displayed in the app bar, so repeating it is clutter.
 */
const comicTitle = computed(() => metadataTitle(info.value) ?? '')

// Browser tab title, so a comic open in a background tab is identifiable.
useDocumentTitle({
  titleSegments: computed(() =>
    [comicTitle.value || (resource as Resource).name, $gettext('Comic Reader')].filter(Boolean)
  )
})

const progressLabel = computed(() => {
  const value = progress.value
  if (!value || value.phase !== 'downloading') {
    return null
  }
  if (value.totalBytes) {
    return `${formatBytes(value.loadedBytes)} / ${formatBytes(value.totalBytes)}`
  }
  return formatBytes(value.loadedBytes)
})

/**
 * Monotonic counters that let an async result recognise it has been
 * superseded. Without them a slow page read can resolve after a faster later
 * one and overwrite the screen with the previous page, and a slow archive open
 * can finish after the user has already switched to a different comic.
 */
let loadGeneration = 0
let refreshGeneration = 0
/**
 * True from the start of load() until the saved position has been applied.
 * Programmatic page changes during that window — the per-comic reset, the
 * resume itself — are not the reader turning pages and must not be recorded.
 * Without this, resetting to page 0 was written as "finished", which deletes
 * the entry, and the resume that followed found nothing to resume.
 */
let restoringPosition = false

/**
 * Resolves the link the download buttons use, for the comic being loaded.
 *
 * Done per load rather than once at mount: the route's resource can change
 * in place, and a link resolved for the previous comic would hand over the
 * wrong file under the new one's name. Not awaited by load(), so the error
 * states can offer a download even when opening the archive fails, without
 * the open having to wait for it.
 */
async function refreshDownloadUrl(generation: number) {
  if (downloadUrl.value) {
    revokeUrl(downloadUrl.value)
    downloadUrl.value = null
  }
  let url: string | null = null
  try {
    url = await getUrlForResource(space as SpaceResource, resource as Resource, {
      disposition: 'attachment'
    })
  } catch {
    url = null
  }
  if (generation !== loadGeneration) {
    // Superseded or unmounted while resolving; this link belongs to nobody.
    if (url) {
      revokeUrl(url)
    }
    return
  }
  downloadUrl.value = url
}

/**
 * Opens the comic the route names. With a password, opens it again with
 * that: the answer to the prompt a password-protected comic puts up.
 */
async function load(password?: string) {
  const generation = ++loadGeneration
  restoringPosition = true
  const unlocking = typeof password === 'string'
  if (!unlocking) {
    void refreshDownloadUrl(generation)
  }
  try {
    // The previous comic's blob URLs are revoked by close(); showing them would
    // render broken images until the new pages arrive.
    visibleUrls.value = {}
    cachedUrls.value = {}
    missingDismissed.value = false
    // Reader state is per-comic and this composable outlives a resource change.
    resetForNewComic()
    await (unlocking
      ? archive.unlock(password)
      : archive.open(space as SpaceResource, resource as Resource))

    const promptAgain = error.value !== null && isPasswordPrompt(error.value)
    if (unlocking && generation === loadGeneration && !promptAgain) {
      // The prompt held the focus and is gone; without this the keyboard
      // shortcuts would do nothing until the reader was clicked. (When the
      // prompt is back, for another try, it has taken the focus itself.)
      await nextTick()
      root.value?.focus()
    }

    if (generation !== loadGeneration || error.value || !pageCount.value) {
      return
    }

    // Resume where the reader left off. Silent for now; a "resume at page N?"
    // prompt is a reasonable follow-up but is not implemented.
    if (config.rememberPosition) {
      const saved = loadProgress(resource as Resource, progressScope())
      if (saved && saved.page < pageCount.value) {
        goToPage(saved.page)
      }
    }
  } finally {
    // Only the newest load may hand control back; a superseded one must not
    // re-enable recording while its successor is still restoring.
    if (generation === loadGeneration) {
      restoringPosition = false
    }
  }

  archive.setReadingPosition(currentPage.value)
  await refreshVisible()
}

/** Pulls blob URLs for the pages on screen, then records the position. */
async function refreshVisible() {
  const generation = ++refreshGeneration
  const wanted = currentSpread.value
  const resolved: Record<number, string | null> = {}
  await Promise.all(
    wanted.map(async (page) => {
      resolved[page] = await archive.pageUrl(page)
    })
  )
  // A newer turn has happened while these pages were loading; drop them.
  if (generation !== refreshGeneration) {
    return
  }
  visibleUrls.value = resolved
  refreshCached()
}

/** Re-reads a page the reader asked to try again. */
async function retryPage(page: number) {
  archive.retryPage(page)
  await refreshVisible()
}

/** Snapshot of everything currently decoded, used by the thumbnail strip. */
function refreshCached() {
  if (!stripOpen.value) {
    return
  }
  cachedUrls.value = archive.cachedPageUrls()
}

// Keyed on contents, not identity: the computed yields a fresh array on
// every viewport resize even when the visible pages have not changed.
watch(
  () => currentSpread.value.join(','),
  async () => {
    archive.setReadingPosition(currentPage.value)
    await refreshVisible()
  }
)

watch(stripOpen, (open) => {
  if (open) {
    refreshCached()
  }
})

watch(currentPage, (page) => {
  if (restoringPosition) {
    return
  }
  if (config.rememberPosition && pageCount.value) {
    const furthest = furthestPageOnScreen(page, currentSpread.value)
    saveProgress(resource as Resource, furthest, pageCount.value, progressScope())
  }
})

// Reopening on a different file happens when the user picks another comic
// without leaving the app.
watch(
  () => (resource as Resource)?.id,
  () => {
    void load()
  }
)

function onViewportNavigate(direction: 'left' | 'right') {
  // In right-to-left mode the physical left edge advances the story, so the
  // mapping from edge to page has to flip with the reading direction.
  const forward = rightToLeft.value ? direction === 'left' : direction === 'right'
  forward ? next() : previous()
}

/** Toolbar controls handle their own keys; the reader must not eat them. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, input, select, a'))
}

function onKeydown(event: KeyboardEvent) {
  // Leave browser and OS shortcuts alone: Ctrl+F, Cmd+R and the rest must not
  // also flip reader settings.
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return
  }
  // Typing in the password prompt: its letters are not shortcuts and its
  // arrow keys move the caret. (The toolbar's page slider is an input too,
  // and keeps the shortcuts.)
  if (event.target instanceof HTMLInputElement && event.target.type !== 'range') {
    return
  }
  // Space on a focused button activates the button; taking it here would make
  // the toolbar unusable by keyboard. Arrows are shared deliberately.
  if (event.key === ' ' && isInteractiveTarget(event.target)) {
    return
  }

  const forwardKeys = rightToLeft.value ? ['ArrowLeft'] : ['ArrowRight']
  const backKeys = rightToLeft.value ? ['ArrowRight'] : ['ArrowLeft']

  if (forwardKeys.includes(event.key) || event.key === 'PageDown') {
    event.preventDefault()
    next()
  } else if (backKeys.includes(event.key) || event.key === 'PageUp') {
    event.preventDefault()
    previous()
  } else if (event.key === ' ') {
    event.preventDefault()
    event.shiftKey ? previous() : next()
  } else if (event.key === 'Home') {
    event.preventDefault()
    first()
  } else if (event.key === 'End') {
    event.preventDefault()
    last()
  } else if (event.key === 'f') {
    cycleFitMode()
  } else if (event.key === 'd') {
    toggleSpreadMode()
  } else if (event.key === 'r') {
    toggleDirection()
  } else if (event.key === 't') {
    stripOpen.value = !stripOpen.value
  } else if (event.key === 'v') {
    rotateClockwise()
  }
}

async function toggleFullScreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else if (root.value) {
      await root.value.requestFullscreen()
    }
  } catch {
    // Denied by the browser or unsupported; the reader still works inline.
  }
}

function onFullScreenChange() {
  isFullScreen.value = Boolean(document.fullscreenElement)
}

onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullScreenChange)
  // Keyboard navigation only works if the reader holds focus on open.
  root.value?.focus()

  await load()
})

onBeforeUnmount(async () => {
  // Invalidate anything still in flight so it cannot touch unmounted state.
  loadGeneration++
  refreshGeneration++
  document.removeEventListener('fullscreenchange', onFullScreenChange)
  if (document.fullscreenElement === root.value) {
    document.exitFullscreen().catch(() => {})
  }
  if (downloadUrl.value) {
    revokeUrl(downloadUrl.value)
  }
  await archive.destroy()
})
</script>
