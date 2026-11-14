import type { Resource } from '@opencloud-eu/web-client'

/**
 * Remembers where the reader got to, per file.
 *
 * Keyed on the OpenCloud file id rather than the path, so renaming or moving a
 * comic does not lose your place, and on the signed-in user, so two accounts
 * sharing a browser profile neither see nor inherit each other's positions. Local storage only: there is currently no
 * per-user key/value API a third-party app can write to, so this deliberately
 * does not sync across devices and does not pretend to.
 */

const KEY_PREFIX = 'comic-reader:progress:'
/** Keeps local storage from growing without bound on a shared machine. */
const MAX_ENTRIES = 500

export interface ReadingProgress {
  page: number
  total: number
  updatedAt: number
}

/** Scope used when nobody is signed in, i.e. on public links. */
export const ANONYMOUS_SCOPE = 'public'

function keyFor(resource: Resource, scope: string): string | null {
  const id = resource.fileId || resource.id
  return id ? `${KEY_PREFIX}${scope}:${id}` : null
}

function storage(): Storage | null {
  try {
    // Private-mode Safari throws on access rather than returning null.
    return window.localStorage
  } catch {
    return null
  }
}

export function loadProgress(
  resource: Resource,
  scope: string = ANONYMOUS_SCOPE
): ReadingProgress | null {
  const key = keyFor(resource, scope)
  const store = storage()
  if (!key || !store) {
    return null
  }
  try {
    const raw = store.getItem(key)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as ReadingProgress
    if (!Number.isInteger(parsed?.page) || parsed.page < 0) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * The page to record as the reading position: the furthest one on screen.
 *
 * Not the spread's lead page. In two-page view the last spread leads with the
 * second-to-last page, which would never count as having finished the comic.
 */
export function furthestPageOnScreen(currentPage: number, spread: readonly number[]): number {
  return Math.max(currentPage, ...spread)
}

/**
 * Records the reading position, or clears it once the comic is finished.
 *
 * Clearing on the last page is why no separate "forget this comic" call
 * exists: reaching the end removes the entry, so nothing accumulates for
 * comics the reader has completed.
 */
export function saveProgress(
  resource: Resource,
  page: number,
  total: number,
  scope: string = ANONYMOUS_SCOPE
): void {
  const key = keyFor(resource, scope)
  const store = storage()
  if (!key || !store) {
    return
  }
  try {
    // Finishing a comic should not leave it asking to resume on the last page.
    if (page <= 0 || page >= total - 1) {
      store.removeItem(key)
      return
    }
    // Only a new key can push the count over the cap; pruning walks every
    // bookmark, which is too much to repeat on each page turn.
    const isNew = store.getItem(key) === null
    store.setItem(key, JSON.stringify({ page, total, updatedAt: Date.now() }))
    if (isNew) {
      prune(store)
    }
  } catch {
    // Quota exceeded or storage disabled; losing the bookmark is acceptable.
  }
}

/** Drops the oldest bookmarks once the cap is exceeded. */
function prune(store: Storage): void {
  const entries: Array<{ key: string; updatedAt: number }> = []
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (!key?.startsWith(KEY_PREFIX)) {
      continue
    }
    try {
      const parsed = JSON.parse(store.getItem(key) || '{}') as ReadingProgress
      entries.push({ key, updatedAt: parsed.updatedAt ?? 0 })
    } catch {
      entries.push({ key, updatedAt: 0 })
    }
  }
  if (entries.length <= MAX_ENTRIES) {
    return
  }
  entries
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, entries.length - MAX_ENTRIES)
    .forEach((entry) => store.removeItem(entry.key))
}
