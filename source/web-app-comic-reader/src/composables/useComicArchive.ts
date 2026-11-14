import { computed, ref, shallowRef, type Ref } from 'vue'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'

import { openComic, passwordErrorFor, PasswordError } from '../archive/openArchive'
import type { ResolvedSource } from '../archive/source'
import { PageCache } from './usePageCache'
import { shutdownZipWorkers } from '../archive/zipAdapter'
import {
  ComicReaderError,
  isEncryptedError,
  type ArchiveAdapter,
  type ArchiveOpenProgress,
  type ArchiveWarning,
  type ComicPage
} from '../archive/types'
import type { ComicInfo } from '../archive/comicInfo'
import { MB, type ComicReaderConfig } from '../config'

export type PageFailure = 'retryable' | 'permanent'

const PERMANENT_FAILURES = ['page-too-large', 'page-unavailable']

function failureOf(cause: unknown): PageFailure {
  return cause instanceof ComicReaderError && PERMANENT_FAILURES.includes(cause.code)
    ? 'permanent'
    : 'retryable'
}

export interface UseComicArchiveOptions {
  config: ComicReaderConfig
  headers: Ref<Record<string, string>>
  /** Origins allowed to receive the session token; see `source.ts`. */
  trustedOrigins: string[]
  getUrlForResource: (
    space: SpaceResource,
    resource: Resource,
    options?: Record<string, unknown>
  ) => Promise<string>
}

/**
 * Owns everything to do with the open archive: fetching bytes, choosing a back
 * end, the page list, the blob cache, and cleanup.
 *
 * Kept separate from the reader's view state so that opening a different comic
 * tears down exactly one thing, and so the view state survives page turns
 * without touching the archive.
 */
export function useComicArchive({
  config,
  headers,
  trustedOrigins,
  getUrlForResource
}: UseComicArchiveOptions) {
  const loading = ref(true)
  const error = shallowRef<ComicReaderError | null>(null)
  const progress = shallowRef<ArchiveOpenProgress | null>(null)
  const pages = shallowRef<ComicPage[]>([])
  const info = shallowRef<ComicInfo | null>(null)
  /** Set when the comic opened but cannot be rendered in full. */
  const warning = shallowRef<ArchiveWarning | null>(null)
  /** True while a solid archive is being extracted in one sweep. */
  const bulkExtracting = ref(false)
  /**
   * Pages that failed to read, rendered as placeholders rather than errors.
   * `retryable` is false when reading again cannot help (the page is over the
   * size limit, or the back end holds no data for it), so the UI only offers
   * "Try again" where it can do something.
   */
  const failedPages = ref<Record<number, PageFailure>>({})

  let adapter: ArchiveAdapter | null = null
  let cache: PageCache | null = null
  let controller: AbortController | null = null
  /**
   * open() can be superseded by another open() while its fetch is in flight.
   * The abort makes the fetch fail, but without this token the stale call's
   * `finally` would still flip `loading` off while the new one is working,
   * flashing an empty reader between comics.
   */
  let openToken = 0
  /**
   * The comic last asked for and where its bytes came from, kept so that a
   * password can be tried without fetching the archive again. `source` is
   * set only while it may still be wanted for that: on the error that asks
   * for a password, and after opening until the comic has shown that it
   * will not ask (see `releaseSource`). Otherwise it is null, so that it
   * does not keep a downloaded archive in memory beside its decoded pages.
   * A comic that asks after all is then fetched again.
   */
  let target: { space: SpaceResource; resource: Resource; source: ResolvedSource | null } | null =
    null
  /**
   * Whether the open comic may yet ask for its password again however many
   * pages it has shown: a zip opened with one, where a later page can still
   * turn it away. Its source is a link, or a Blob the zip reader holds
   * anyway, so keeping it costs nothing.
   */
  let mayAskLater = false

  const pageCount = computed(() => pages.value.length)

  /** Pages ComicInfo declares as double-page spreads, shown alone. */
  const declaredWidePages = shallowRef<ReadonlySet<number>>(new Set())

  /** Opens a comic from scratch. */
  function open(space: SpaceResource, resource: Resource) {
    target = { space, resource, source: null }
    return start(space, resource, {})
  }

  /**
   * Tries a password on the comic that asked for one. The archive is not
   * fetched again. The password goes to the decoder and is not kept here.
   */
  function unlock(password: string) {
    if (!target) {
      return Promise.resolve()
    }
    const { space, resource, source } = target
    // An empty password is no password, here as in openComic.
    return start(space, resource, { password: password || undefined, resolved: source ?? undefined })
  }

  async function start(
    space: SpaceResource,
    resource: Resource,
    attempt: { password?: string; resolved?: ResolvedSource }
  ) {
    const token = ++openToken
    await close()

    loading.value = true
    error.value = null
    progress.value = null
    failedPages.value = {}
    bulkExtracting.value = false
    warning.value = null
    controller = new AbortController()

    try {
      const opened = await openComic({
        space,
        resource,
        getUrlForResource,
        getHeaders: () => headers.value,
        trustedOrigins,
        signal: controller.signal,
        rangeThresholdBytes: config.rangeThresholdMb * MB,
        maxDownloadBytes: config.maxArchiveSizeMb * MB,
        bulkExtractLimitMb: config.bulkExtractLimitMb,
        maxPages: config.maxPages,
        maxPageBytes: config.maxPageSizeMb * MB,
        enableJxl: config.enableJxl,
        ...attempt,
        onProgress: (value) => {
          if (token === openToken) {
            progress.value = value
          }
        },
        // Guarded like onProgress: a bulk pass still running when its comic
        // is closed finishes minutes later, and must not touch the next one.
        onBulkExtractStart: () => {
          if (token === openToken) {
            bulkExtracting.value = true
          }
        },
        onBulkExtractDone: () => {
          if (token === openToken) {
            bulkExtracting.value = false
          }
        }
      })

      if (token !== openToken) {
        // Superseded while opening; the newer call owns the state now.
        await opened.adapter.close().catch(() => {})
        return
      }

      const tried = attempt.password !== undefined
      mayAskLater = tried && !opened.passwordSettled
      if (target) {
        // A comic decrypted or decoded whole with its password has nothing
        // left to ask. Anything else may yet, on the first page read (some
        // 7z archives only show then that they are encrypted), so it is
        // kept until a page has been read.
        target.source = opened.passwordSettled ? null : opened.resolved
      }
      adapter = opened.adapter
      pages.value = opened.pages
      info.value = opened.info
      declaredWidePages.value = opened.widePages
      warning.value = opened.warning

      cache = new PageCache({
        adapter: opened.adapter,
        pages: opened.pages,
        radius: config.cacheRadius,
        // A page prefetched beyond the retention window is evicted the moment
        // it loads, so reading further ahead than that is pure waste.
        prefetch: Math.min(config.prefetchPages, config.cacheRadius),
        maxPageBytes: config.maxPageSizeMb * MB,
        onError: (index, cause) => {
          if (token !== openToken) {
            return
          }
          // Some archives only reveal that they are encrypted when a page is
          // read. That is a fact about the comic, not about one page: show
          // the password-protected screen, not a book of unreadable pages.
          if (isEncryptedError(cause)) {
            // Through `target`, not `opened`: this callback lives as long as
            // the comic is open and must not be what keeps its archive alive.
            error.value = passwordErrorFor(target?.source ?? null, tried)
            // Nothing in it can be read, so let it go: the decoder's worker
            // is holding a copy of the whole archive. Closing also disposes
            // the cache, which silences the read-ahead still on its way to
            // the same refusal.
            void close()
            return
          }
          failedPages.value = { ...failedPages.value, [index]: failureOf(cause) }
        }
      })
    } catch (caught) {
      if (token !== openToken || (caught as Error)?.name === 'AbortError') {
        return
      }
      if (target) {
        // Kept for the prompt's next attempt, and for nothing else: any
        // other failure leaves no use for the archive.
        target.source = caught instanceof PasswordError ? caught.resolved : null
      }
      error.value =
        caught instanceof ComicReaderError
          ? caught
          : new ComicReaderError('corrupt', 'This comic could not be opened.', caught)
    } finally {
      if (token === openToken) {
        loading.value = false
        progress.value = null
      }
    }
  }

  /** Resolves to a blob URL, or null when the page is unreadable. */
  async function pageUrl(index: number): Promise<string | null> {
    const reading = target
    const entry = await cache?.get(index)
    // (Still the comic this read was for: another may have been opened since.)
    if (entry?.url && target === reading && target?.source && !mayAskLater) {
      // A page has been read without a word about a password: the archive
      // is not going to be wanted again.
      target.source = null
    }
    return entry?.url ?? null
  }

  /** Clears a page's failed state, so the next request for it reads it again. */
  function retryPage(index: number) {
    const { [index]: _cleared, ...rest } = failedPages.value
    failedPages.value = rest
    cache?.forget(index)
  }

  /** Blob URLs of every page currently decoded, keyed by page index. */
  function cachedPageUrls(): Record<number, string> {
    return cache?.cachedUrls() ?? {}
  }

  function setReadingPosition(index: number) {
    cache?.setCentre(index)
  }

  async function close() {
    controller?.abort()
    controller = null
    cache?.dispose()
    cache = null
    const current = adapter
    adapter = null
    pages.value = []
    info.value = null
    declaredWidePages.value = new Set()
    if (current) {
      await current.close().catch(() => {})
    }
  }

  /** Full teardown, including the shared zip.js worker pool. */
  async function destroy() {
    // Supersede any open() still in flight. Parts of it cannot be aborted
    // (the decoder's own start-up and listing), and without this it would
    // finish after teardown and install a worker nothing is left to close.
    openToken++
    target = null
    await close()
    await shutdownZipWorkers()
  }

  return {
    loading,
    error,
    progress,
    pageCount,
    info,
    warning,
    bulkExtracting,
    failedPages,
    declaredWidePages,
    open,
    unlock,
    destroy,
    pageUrl,
    retryPage,
    cachedPageUrls,
    setReadingPosition
  }
}
