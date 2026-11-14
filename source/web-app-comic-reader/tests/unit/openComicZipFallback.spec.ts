import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Resource } from '@opencloud-eu/web-client'

import type { ArchiveSource } from '../../src/archive/types'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'

import { ComicReaderError, encryptedError } from '../../src/archive/types'
import { asBzip2, makeAdapter, openComicOptions, PIXEL } from './helpers/fakes'

/**
 * A zip that zip.js can list but not decode (bzip2) is handed to libarchive,
 * which needs the whole file. When the zip was being read by range, that
 * means fetching it in full once. It must not also look the location up
 * again or probe for range support again: both are already known.
 *
 * zip.js is real here and reads the fixture over a stubbed network;
 * libarchive is a stand-in, since it cannot run under the test environment.
 */

const libarchiveOpen = vi.fn()
vi.mock('../../src/archive/libarchiveAdapter', () => ({
  LibArchiveAdapter: { open: (...args: unknown[]) => libarchiveOpen(...args) }
}))
const decrypt = vi.fn()
vi.mock('../../src/archive/sevenZipAdapter', () => ({
  decryptArchive: (...args: unknown[]) => decrypt(...args),
  openSevenZip: vi.fn()
}))
vi.mock('../../src/helpers/wasm', async (original) => ({
  ...(await original<typeof import('../../src/helpers/wasm')>()),
  checkWasmAllowed: async () => true
}))

const { openComic } = await import('../../src/archive/openArchive')
const { shutdownZipWorkers } = await import('../../src/archive/zipAdapter')

const BZIP2_FIXTURE = new Uint8Array(
  readFileSync(resolve(__dirname, '../fixtures/zipmethods/bzip2.cbz'))
)
/** What the stand-in server serves. */
let file: Uint8Array = BZIP2_FIXTURE

interface Seen {
  range: string | null
}
let requests: Seen[] = []
/** Called when the full download is asked for, before it is answered. */
let onFullRequest: (() => void) | null = null

/** A server that honours Range, as OpenCloud's DAV endpoint does. */
async function fakeFetch(_input: unknown, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  const range = headers.get('Range')
  requests.push({ range })
  if (!range) {
    onFullRequest?.()
    init?.signal?.throwIfAborted()
    return new Response(file as BodyInit, { status: 200 })
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range)!
  let start: number
  let end: number
  if (match[1] === '') {
    // Suffix range: the last N bytes.
    start = Math.max(0, file.length - Number(match[2]))
    end = file.length - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? file.length - 1 : Math.min(Number(match[2]), file.length - 1)
  }
  return new Response(file.slice(start, end + 1) as BodyInit, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${file.length}`,
      'Accept-Ranges': 'bytes'
    }
  })
}

const fallbackAdapter = makeAdapter({
  listEntries: () => [{ index: 0, name: 'from-libarchive.png', size: 4, isDirectory: false }]
})

beforeEach(() => {
  file = BZIP2_FIXTURE
  requests = []
  onFullRequest = null
  libarchiveOpen.mockReset().mockResolvedValue(fallbackAdapter)
  decrypt.mockReset()
  vi.stubGlobal('fetch', fakeFetch)
})
afterEach(() => vi.unstubAllGlobals())
afterAll(async () => {
  await shutdownZipWorkers()
})

describe('openComic: handing a range-read zip to libarchive', () => {
  it('fetches the file once more, in full, and asks for nothing else again', async () => {
    const getUrlForResource = vi.fn(async () => 'https://files.example/book.cbz')

    const opened = await openComic(
      openComicOptions({
        resource: { name: 'book.cbz', size: file.length } as unknown as Resource,
        getUrlForResource,
        // Zero, so even this small fixture is read by range.
        rangeThresholdBytes: 0
      })
    )

    expect(opened.pages.map((page) => page.name)).toEqual(['from-libarchive.png'])

    // The location is resolved once, for the whole open.
    expect(getUrlForResource).toHaveBeenCalledTimes(1)

    // One probe (the first request, for the magic bytes), then zip.js's
    // range reads of the directory, then exactly one request without a
    // Range header: the full download. No second probe after it.
    const probe = 'bytes=0-7'
    expect(requests[0].range).toBe(probe)
    expect(requests.filter((request) => request.range === probe)).toHaveLength(1)
    const full = requests.filter((request) => request.range === null)
    expect(full).toHaveLength(1)
    expect(requests[requests.length - 1].range).toBeNull()

    // libarchive was given the whole file, as a Blob.
    const source = libarchiveOpen.mock.calls[0][0] as ArchiveSource
    expect(source.kind).toBe('blob')
    expect(source.kind === 'blob' && source.data.size).toBe(file.length)
    expect(source.kind === 'blob' && source.name).toBe('book.cbz')
  })

  const rangeRead = (overrides = {}) =>
    openComic(
      openComicOptions({
        resource: { name: 'book.cbz', size: file.length } as unknown as Resource,
        rangeThresholdBytes: 0,
        ...overrides
      })
    )

  it('holds the full download to the size limit, and reports that as the reason', async () => {
    // Every page of the fixture needs libarchive, so with the handover
    // refused there is nothing to show, and "too large" is the honest cause.
    await expect(rangeRead({ maxDownloadBytes: file.length - 1 })).rejects.toMatchObject({
      code: 'too-large'
    })
    expect(libarchiveOpen).not.toHaveBeenCalled()
  })

  it('sends the session headers with the full download only to a trusted origin', async () => {
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('Authorization'))
      return fakeFetch(input, init)
    })
    const getHeaders = () => ({ Authorization: 'Bearer token' })

    await rangeRead({ getHeaders, trustedOrigins: ['https://files.example'] })
    expect(seen[seen.length - 1]).toBe('Bearer token')

    seen.length = 0
    await rangeRead({ getHeaders, trustedOrigins: [] })
    expect(seen.every((header) => header === null)).toBe(true)
  })

  it('stops, without falling back to zip.js, when cancelled during the download', async () => {
    const controller = new AbortController()
    onFullRequest = () => controller.abort()

    await expect(rangeRead({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(libarchiveOpen).not.toHaveBeenCalled()
  })

  it('reports that it is parsing again once the download is over', async () => {
    const phases: string[] = []
    libarchiveOpen.mockImplementation(async () => {
      phases.push('libarchive opens')
      return fallbackAdapter
    })
    await rangeRead({ onProgress: (progress: { phase: string }) => phases.push(progress.phase) })

    expect(phases.slice(-2)).toEqual(['parsing', 'libarchive opens'])
    expect(phases).toContain('downloading')
  })
})

describe('openComic: a password-protected zip read by range and handed to libarchive', () => {
  it('keeps the download for the next password attempt', async () => {
    // Every entry in a method zip.js cannot decode, so it can check no
    // password: libarchive is the one to find a wrong one, after the whole
    // file has been fetched for it. The second attempt must start from that
    // download, not fetch it again.
    const writer = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', zipCrypto: true })
    await writer.add('p1.png', new Uint8ArrayReader(PIXEL))
    await writer.add('ComicInfo.xml', new Uint8ArrayReader(PIXEL))
    file = asBzip2(await writer.close(), ['p1.png', 'ComicInfo.xml'])

    const options = (extra = {}) =>
      openComicOptions({
        resource: { name: 'book.cbz', size: file.length } as unknown as Resource,
        rangeThresholdBytes: 0,
        ...extra
      })
    const refusing = makeAdapter({
      listEntries: () => [
        { index: 0, name: 'p1.png', size: 4, isDirectory: false },
        { index: 1, name: 'ComicInfo.xml', size: 4, isDirectory: false }
      ],
      readText: async () => {
        throw new ComicReaderError('encrypted', 'no')
      }
    })

    const asked = await openComic(options()).catch((error) => error)
    expect(asked.code).toBe('password-required')
    // Nothing fetched in full yet: there was nothing to hand over.
    expect(requests.filter((request) => !request.range)).toHaveLength(0)

    libarchiveOpen.mockResolvedValue(refusing)
    const wrong = await openComic(options({ password: 'nope', resolved: asked.resolved })).catch(
      (error) => error
    )
    expect(wrong.code).toBe('wrong-password')
    expect(requests.filter((request) => !request.range)).toHaveLength(1)
    expect(wrong.resolved.source.kind).toBe('blob')

    libarchiveOpen.mockResolvedValue(fallbackAdapter)
    const opened = await openComic(options({ password: 'comic', resolved: wrong.resolved }))
    expect(opened.pages).toHaveLength(1)
    // Still the one download.
    expect(requests.filter((request) => !request.range)).toHaveLength(1)
  })

  it('keeps the download when it is the decrypting that finds the password wrong', async () => {
    // AES, every entry in a method zip.js cannot decode: nothing checks the
    // password until the whole file has been fetched and decrypting begins.
    const writer = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', encryptionStrength: 3 })
    await writer.add('p1.png', new Uint8ArrayReader(PIXEL))
    file = asBzip2(await writer.close(), ['p1.png'])
    // (zip.js's writer fetches its own worker code, through the same stub.)
    requests = []
    const options = (extra = {}) =>
      openComicOptions({
        resource: { name: 'book.cbz', size: file.length } as unknown as Resource,
        rangeThresholdBytes: 0,
        ...extra
      })

    const asked = await openComic(options()).catch((error) => error)
    expect(asked.code).toBe('password-required')
    expect(requests.filter((request) => !request.range)).toHaveLength(0)

    decrypt.mockRejectedValue(encryptedError())
    const wrong = await openComic(options({ password: 'nope', resolved: asked.resolved })).catch(
      (error) => error
    )
    expect(wrong.code).toBe('wrong-password')
    expect(wrong.resolved.source.kind).toBe('blob')
    expect(requests.filter((request) => !request.range)).toHaveLength(1)

    const again = await openComic(options({ password: 'no', resolved: wrong.resolved })).catch(
      (error) => error
    )
    expect(again.code).toBe('wrong-password')
    // Still the one download.
    expect(requests.filter((request) => !request.range)).toHaveLength(1)
  })
})
