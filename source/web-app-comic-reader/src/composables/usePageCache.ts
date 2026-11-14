import { ComicReaderError, type ArchiveAdapter, type ComicPage } from '../archive/types'

/**
 * Holds decoded page images and, crucially, throws them away again.
 *
 * Blob URLs pin their backing data until explicitly revoked, so a reader that
 * creates one per page and forgets about them will hold an entire comic in
 * memory by the end of the book. Eviction here is what keeps the tab flat.
 */

export interface CachedPage {
  index: number
  url: string
  bytes: number
}

export interface PageCacheOptions {
  adapter: ArchiveAdapter
  pages: ComicPage[]
  /** Pages retained on each side of the reading position. */
  radius: number
  /** Pages fetched ahead of the reading position. */
  prefetch: number
  maxPageBytes: number
  onError?: (index: number, error: unknown) => void
}

export class PageCache {
  private readonly entries = new Map<number, CachedPage>()
  private readonly inflight = new Map<number, Promise<CachedPage | null>>()
  /** Pages that failed to read, so we stop retrying them on every prefetch. */
  private readonly failed = new Set<number>()
  private disposed = false
  private centre = 0

  constructor(private readonly options: PageCacheOptions) {}

  get failedPages(): ReadonlySet<number> {
    return this.failed
  }

  /**
   * Fetches a page, deduplicating concurrent requests for the same index.
   * Returns null when the page is unreadable, so a single corrupt image
   * degrades to a placeholder instead of killing the whole session.
   */
  async get(index: number): Promise<CachedPage | null> {
    if (this.disposed) {
      return null
    }
    const cached = this.entries.get(index)
    if (cached) {
      return cached
    }
    if (this.failed.has(index)) {
      return null
    }
    const pending = this.inflight.get(index)
    if (pending) {
      return pending
    }

    const promise = this.load(index).finally(() => {
      this.inflight.delete(index)
    })
    this.inflight.set(index, promise)
    return promise
  }

  private async load(index: number): Promise<CachedPage | null> {
    const page = this.options.pages[index]
    if (!page) {
      return null
    }

    const assertWithinLimit = (bytes: number) => {
      if (bytes > this.options.maxPageBytes) {
        throw new ComicReaderError(
          'page-too-large',
          `Page "${page.name}" is unusually large and was skipped.`
        )
      }
    }

    try {
      assertWithinLimit(page.size)

      const data = await this.options.adapter.readEntry(page.entryIndex)

      // The archive may have lied about the uncompressed size, so the real
      // length is checked too. This is the decompression-bomb guard.
      assertWithinLimit(data.size)

      if (this.disposed) {
        return null
      }

      // slice() gives the Blob its image type and shares its bytes, so the
      // page is not copied again on its way to a URL.
      const entry: CachedPage = {
        index,
        url: URL.createObjectURL(data.slice(0, data.size, page.mimeType)),
        bytes: data.size
      }
      this.entries.set(index, entry)
      // Exempt the page we just loaded. Without this, requesting a page
      // outside the current window evicts it before returning, handing the
      // caller a blob URL that has already been revoked.
      this.evict(index)
      return entry
    } catch (error) {
      // A read that outlives the cache (libarchive only rejects on timeout
      // once its worker is gone) must not report into whatever comic is open
      // by then.
      if (this.disposed) {
        return null
      }
      this.failed.add(index)
      this.options.onError?.(index, error)
      return null
    }
  }

  /**
   * Moves the retention window and kicks off read-ahead.
   *
   * Read-ahead runs in both directions, because page-back is just as common as
   * page-forward and a cold cache behind you is what makes flicking back to
   * check a panel feel sluggish.
   */
  setCentre(index: number) {
    this.centre = index
    this.evict()

    const { prefetch, pages } = this.options
    const targets: number[] = []
    for (let offset = 1; offset <= prefetch; offset++) {
      if (index + offset < pages.length) {
        targets.push(index + offset)
      }
      if (index - offset >= 0) {
        targets.push(index - offset)
      }
    }
    targets.forEach((target) => {
      void this.get(target)
    })
  }

  /** Drops pages outside the retention window and revokes their blob URLs. */
  private evict(keep?: number) {
    const { radius } = this.options
    for (const [index, entry] of this.entries) {
      if (index !== keep && Math.abs(index - this.centre) > radius) {
        URL.revokeObjectURL(entry.url)
        this.entries.delete(index)
      }
    }
  }

  /**
   * Forgets that a page failed, so the next request reads it again.
   *
   * A failure is remembered so read-ahead does not hammer a page that cannot
   * be read, but not every failure is permanent: a range read can fail on a
   * dropped connection and succeed a moment later.
   */
  forget(index: number) {
    this.failed.delete(index)
  }

  /** Index → blob URL for every page currently retained. */
  cachedUrls(): Record<number, string> {
    const urls: Record<number, string> = {}
    for (const [index, entry] of this.entries) {
      urls[index] = entry.url
    }
    return urls
  }

  /** Current retained size; lets tests assert that memory stays bounded. */
  get retainedBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) {
      total += entry.bytes
    }
    return total
  }

  dispose() {
    this.disposed = true
    for (const entry of this.entries.values()) {
      URL.revokeObjectURL(entry.url)
    }
    this.entries.clear()
    this.inflight.clear()
    this.failed.clear()
  }
}
