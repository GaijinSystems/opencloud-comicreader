import { describe, it, expect, afterEach } from 'vitest'
import { resolveVendorAssetUrl, setAssetBaseUrl } from '../../src/helpers/assetUrl'

afterEach(() => setAssetBaseUrl(null))

describe('assetBaseUrl override', () => {
  it('accepts an absolute URL, with or without a trailing slash', () => {
    setAssetBaseUrl('https://cdn.example/apps/comic-reader')
    const expected = `https://cdn.example/apps/comic-reader/vendor/libarchive/worker-bundle.js?v=${__VENDOR_VERSION__}`
    expect(resolveVendorAssetUrl('libarchive/worker-bundle.js')).toBe(expected)

    setAssetBaseUrl('https://cdn.example/apps/comic-reader/')
    expect(resolveVendorAssetUrl('libarchive/worker-bundle.js')).toBe(expected)
  })

  it('accepts a root-relative path instead of throwing', () => {
    setAssetBaseUrl('/assets/apps/comic-reader')
    const url = resolveVendorAssetUrl('libarchive/worker-bundle.js')
    expect(new URL(url).pathname).toBe(
      '/assets/apps/comic-reader/vendor/libarchive/worker-bundle.js'
    )
  })

  it('adds the hash of the vendor files, so a cached older decoder is not reused', () => {
    setAssetBaseUrl('https://cdn.example/apps/comic-reader')
    const url = new URL(resolveVendorAssetUrl('unarr/unarr-worker.mjs'))
    expect(url.search).toMatch(/^\?v=[0-9a-f]{12}$/)
  })

  it('keeps the path and the query of an override that has a query', () => {
    for (const base of [
      'https://host.example/apps/comic-reader?token=1',
      'https://host.example/apps/comic-reader/?token=1#ignored'
    ]) {
      setAssetBaseUrl(base)
      const url = new URL(resolveVendorAssetUrl('unarr/unarr-worker.mjs'))
      expect(url.pathname).toBe('/apps/comic-reader/vendor/unarr/unarr-worker.mjs')
      expect(url.search).toBe(`?token=1&v=${__VENDOR_VERSION__}`)
      expect(url.hash).toBe('')
    }
  })

  it('leaves a signed query exactly as written', () => {
    setAssetBaseUrl('https://host.example/apps/comic-reader?sig=ab/cd==&e=a%20b')
    const url = resolveVendorAssetUrl('unarr/unarr-worker.mjs')
    expect(url.endsWith(`?sig=ab/cd==&e=a%20b&v=${__VENDOR_VERSION__}`)).toBe(true)
  })

  it('ignores an override that is not an http(s) URL', () => {
    setAssetBaseUrl('localhost:8080/apps/comic-reader')
    expect(() => resolveVendorAssetUrl('unarr/unarr-worker.mjs')).not.toThrow()
  })

  it('ignores an override that is only a query or a fragment', () => {
    const withoutOverride = resolveVendorAssetUrl('unarr/unarr-worker.mjs')
    for (const base of ['#x', '?token=1', '?', '\u0001?x']) {
      setAssetBaseUrl(base)
      expect(resolveVendorAssetUrl('unarr/unarr-worker.mjs')).toBe(withoutOverride)
    }
  })

  it('ignores a blank override', () => {
    setAssetBaseUrl('   ')
    expect(() => resolveVendorAssetUrl('libarchive/worker-bundle.js')).not.toThrow()
  })
})
