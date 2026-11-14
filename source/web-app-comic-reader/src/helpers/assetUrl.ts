/**
 * Resolves URLs for the files we ship in `public/`.
 *
 * This is fiddlier than it looks. The app is built with `base: './'` and loaded
 * through Module Federation from an arbitrary mount point
 * (`/assets/apps/comic-reader/`), so nothing may assume a site-root path. The
 * entry chunk lands in `dist/js/` while `public/` is copied to `dist/`, which is
 * why the default resolution walks one level up from the module URL.
 *
 * An admin can override the base outright when a deployment serves app assets
 * from somewhere unusual, e.g. another path on the same origin.
 */

let baseOverride: string | null = null

/** Set from the app config at startup; empty values are ignored. */
export function setAssetBaseUrl(base: string | null | undefined) {
  baseOverride = base && base.trim() ? base.trim() : null
}

function currentModuleUrl(): string | null {
  try {
    return import.meta.url || null
  } catch {
    return null
  }
}

/**
 * Base URL of the app's `dist/` directory, with a trailing slash.
 * Falls back to the document base so the app still boots in unusual hosts
 * rather than throwing during setup.
 */
export function appAssetBase(): string {
  if (baseOverride) {
    try {
      // Only a query or a fragment: not a location. It would resolve to the
      // document's base address, where there are no decoders. Control
      // characters before it count for nothing: the URL parser strips them.
      if (/^[\u0000- ]*[?#]/.test(baseOverride)) {
        throw new TypeError('not a location')
      }
      // Made absolute here because callers resolve against it with `new URL`,
      // which throws on a relative base such as `/assets/apps/comic-reader/`.
      const base = new URL(
        baseOverride,
        typeof document !== 'undefined' ? document.baseURI : undefined
      )
      // `localhost:8080/…` (scheme forgotten) parses, as scheme "localhost",
      // but nothing can be resolved against it.
      if (base.protocol !== 'http:' && base.protocol !== 'https:') {
        throw new TypeError('not an http(s) URL')
      }
      // The slash belongs on the path, not on the end of the text: appended
      // to `…/comic-reader?token=1` it would land in the query, and the last
      // path segment would then be dropped as if it were a file name.
      if (!base.pathname.endsWith('/')) {
        base.pathname += '/'
      }
      base.hash = ''
      return base.href
    } catch {
      console.warn(`[comic-reader] ignoring unusable assetBaseUrl: ${baseOverride}`)
    }
  }

  const moduleUrl = currentModuleUrl()
  if (moduleUrl) {
    // `…/comic-reader/js/comic-reader-abc123.mjs` → `…/comic-reader/`
    return new URL('../', moduleUrl).href
  }

  if (typeof document !== 'undefined') {
    return new URL('./', document.baseURI).href
  }
  return '/'
}

/**
 * Absolute URL for a file shipped under `public/vendor/`, with
 * `?v=<hash of public/vendor>` so that a decoder cached from another build
 * is never reused; see scripts/lib/vite-plugins.mjs.
 */
export function resolveVendorAssetUrl(relativePath: string): string {
  const cleaned = relativePath.replace(/^\/+/, '')
  const base = new URL(appAssetBase())
  const url = new URL(`vendor/${cleaned}`, base)
  // A query on a configured base (an access token, say) applies to every
  // file under it; resolving a relative path would otherwise discard it. It
  // is kept exactly as written, since a signed query may be compared as
  // text, so `v` is appended by hand and not through searchParams, which
  // would re-encode the rest.
  url.search = `${base.search}${base.search ? '&' : '?'}v=${__VENDOR_VERSION__}`
  return url.href
}
