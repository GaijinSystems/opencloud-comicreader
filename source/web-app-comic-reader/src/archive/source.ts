import type { Resource, SpaceResource } from '@opencloud-eu/web-client'

import {
  ComicReaderError,
  type ArchiveSource,
  type ArchiveOpenProgress,
  type ComicFormat
} from './types'
import { MAGIC_PROBE_BYTES, resolveFormat } from './detect'

/**
 * Turns a file in a space into bytes the archive back ends can read.
 *
 * Two shapes come out of here. Zip containers get a `range` source, so zip.js
 * can pull just the central directory and then individual pages over HTTP.
 * Everything else gets a `blob` of the whole file, because RAR and 7z
 * directories reference back into the stream and have no useful partial-read
 * story.
 */

export interface ResolveSourceOptions {
  space: SpaceResource
  resource: Resource
  /** Resolves a direct download URL. Supplied by AppWrapper. */
  getUrlForResource: (
    space: SpaceResource,
    resource: Resource,
    options?: Record<string, unknown>
  ) => Promise<string>
  /**
   * Auth headers for the current session, read fresh on each call.
   *
   * A getter rather than a snapshot: zip range reads can span a long reading
   * session, and a token captured at open time would go stale and start
   * failing pages with 401 part way through the book.
   */
  getHeaders: () => Record<string, string>
  /**
   * Origins that may receive the bearer token. Must include the API server's
   * origin: OpenCloud Web is routinely hosted on a different origin from the
   * DAV endpoint, so comparing against `window.location` alone would strip
   * credentials from every authenticated download.
   */
  trustedOrigins: string[]
  signal?: AbortSignal
}

function isTrustedOrigin(url: string, trustedOrigins: string[]): boolean {
  try {
    const origin = new URL(url, window.location.href).origin
    return trustedOrigins.includes(origin)
  } catch {
    return false
  }
}

/**
 * Asks the server whether it will serve byte ranges for this URL.
 *
 * A one-byte request is used rather than HEAD: some proxies advertise
 * `Accept-Ranges` on HEAD but ignore `Range` on GET, and a 206 with a
 * `Content-Range` header is the only answer that actually proves support.
 * The response body doubles as the magic-byte probe.
 */
export interface RangeProbe {
  supported: boolean
  totalBytes?: number
  head?: Uint8Array
}

export async function probeRange(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<RangeProbe> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: `bytes=0-${MAGIC_PROBE_BYTES - 1}` },
      signal
    })

    if (response.status === 206) {
      const contentRange = response.headers.get('Content-Range') || ''
      const total = Number.parseInt(contentRange.split('/')[1] ?? '', 10)
      // Bounded read even on 206. A misbehaving server can answer 206 and then
      // stream the whole body, and arrayBuffer() would buffer all of it.
      const head = await readFirstBytes(response, MAGIC_PROBE_BYTES)
      return {
        supported: true,
        totalBytes: Number.isFinite(total) ? total : undefined,
        head
      }
    }

    if (response.ok) {
      // Server ignored the Range header and sent the whole file. Read only
      // what we need for the magic check, then drop the rest.
      const head = await readFirstBytes(response, MAGIC_PROBE_BYTES)
      return { supported: false, head }
    }

    throw new ComicReaderError(
      'network',
      `The comic could not be fetched (HTTP ${response.status}).`
    )
  } catch (error) {
    if (error instanceof ComicReaderError) {
      throw error
    }
    if (isAbort(error)) {
      throw error
    }
    // A failed probe is not fatal; fall back to a full download.
    return { supported: false }
  }
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

function isAbort(error: unknown): boolean {
  return (error as Error)?.name === 'AbortError'
}

/**
 * A rejected fetch or a stream that dies part way is a connection problem,
 * not a damaged file. Labelling it as such is what offers the user a retry.
 */
function networkError(cause: unknown): ComicReaderError {
  return new ComicReaderError(
    'network',
    'The connection was interrupted while fetching this comic.',
    cause
  )
}

/** How much of a download is held as raw chunks before being folded into a Blob. */
const FOLD_EVERY_BYTES = 8 * 1024 * 1024

function tooLargeError(): ComicReaderError {
  return new ComicReaderError('too-large', 'This comic is too large to open in the browser.')
}

/** Pulls the first N bytes off a response and cancels the rest. */
async function readFirstBytes(response: Response, count: number): Promise<Uint8Array | undefined> {
  if (!response.body) {
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer.slice(0, count))
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let have = 0
  try {
    // One read() is not guaranteed to deliver `count` bytes; HTTP/2 can hand
    // over a first frame of a few bytes. Keep reading until there are enough.
    while (have < count) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        chunks.push(value)
        have += value.byteLength
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (!have) {
    return undefined
  }
  return concatChunks(chunks, have).slice(0, count)
}

/**
 * Downloads the whole file, reporting progress as it goes.
 *
 * Progress matters here: for a RAR or 7z the user is staring at a spinner for
 * the entire download, and an indeterminate spinner on a 400 MB file reads as
 * a hang.
 */
export async function downloadWhole(
  url: string,
  headers: Record<string, string>,
  {
    maxBytes,
    onProgress,
    signal
  }: {
    maxBytes: number
    onProgress?: (progress: ArchiveOpenProgress) => void
    signal?: AbortSignal
  }
): Promise<Blob> {
  let response: Response
  try {
    response = await fetch(url, { headers, signal })
  } catch (error) {
    throw isAbort(error) ? error : networkError(error)
  }
  if (!response.ok) {
    throw new ComicReaderError(
      'network',
      `The comic could not be downloaded (HTTP ${response.status}).`
    )
  }

  const declared = Number.parseInt(response.headers.get('Content-Length') ?? '', 10)
  const totalBytes = Number.isFinite(declared) ? declared : undefined

  if (totalBytes !== undefined && totalBytes > maxBytes) {
    throw tooLargeError()
  }

  if (!response.body) {
    let blob: Blob
    try {
      blob = await response.blob()
    } catch (error) {
      throw isAbort(error) ? error : networkError(error)
    }
    if (blob.size > maxBytes) {
      throw tooLargeError()
    }
    return blob
  }

  const reader = response.body.getReader()
  // Chunks are folded into a Blob every few megabytes rather than collected
  // and merged at the end. The browser stores Blob data outside the
  // JavaScript heap, so the heap only ever holds the chunks not yet folded,
  // instead of the whole file once as chunks and once more as the merged copy.
  const parts: Blob[] = []
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let loadedBytes = 0
  const fold = () => {
    if (pending.length) {
      parts.push(new Blob(pending as BlobPart[]))
      pending = []
      pendingBytes = 0
    }
  }

  for (;;) {
    let done: boolean
    let value: Uint8Array | undefined
    try {
      ;({ done, value } = await reader.read())
    } catch (error) {
      throw isAbort(error) ? error : networkError(error)
    }
    if (done) {
      break
    }
    if (!value) {
      continue
    }
    loadedBytes += value.byteLength
    // Servers that omit Content-Length still must not be able to exhaust
    // memory, so the cap is enforced against the running total too.
    if (loadedBytes > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooLargeError()
    }
    pending.push(value)
    pendingBytes += value.byteLength
    if (pendingBytes >= FOLD_EVERY_BYTES) {
      fold()
    }
    onProgress?.({ phase: 'downloading', loadedBytes, totalBytes })
  }

  fold()
  return new Blob(parts)
}

export interface ResolvedSource {
  source: ArchiveSource
  /** Container format, detected from magic bytes where possible. */
  format: ComicFormat
}

/**
 * Resolves a download URL for the resource.
 *
 * `disposition: 'attachment'` is deliberate. The `inline` variant in web-client
 * fetches the entire file and hands back a `blob:` URL, which would defeat the
 * whole point of range reading.
 */
export async function resolveDownloadUrl({
  space,
  resource,
  getUrlForResource,
  signal
}: ResolveSourceOptions): Promise<string> {
  let url: string
  try {
    url = await getUrlForResource(space, resource, { disposition: 'attachment', signal })
  } catch (error) {
    throw isAbort(error) ? error : networkError(error)
  }
  if (!url) {
    throw new ComicReaderError('network', 'No download location could be resolved for this comic.')
  }
  return url
}

export async function resolveArchiveSource(
  options: ResolveSourceOptions & {
    /** Zip files under this size are simply downloaded; ranges add latency. */
    rangeThresholdBytes: number
    maxDownloadBytes: number
    onProgress?: (progress: ArchiveOpenProgress) => void
  }
): Promise<ResolvedSource> {
  const {
    resource,
    getHeaders,
    trustedOrigins,
    signal,
    rangeThresholdBytes,
    maxDownloadBytes,
    onProgress
  } = options

  const url = await resolveDownloadUrl(options)
  // Signed download URLs may live on a CDN or another host; attaching a bearer
  // token to an origin we do not trust would leak it.
  const trusted = isTrustedOrigin(url, trustedOrigins)
  const headersFor = () => (trusted ? getHeaders() : {})

  const probe = await probeRange(url, headersFor(), signal)
  // Number(undefined) is NaN, which `??` does not catch; `||` does.
  const size = probe.totalBytes ?? (Number(resource.size) || 0)

  // Detection has to happen before the range decision: only zip containers can
  // be read piecemeal, and the magic bytes are the reliable signal, since
  // plenty of files named `.cbr` are really zips.
  const format = resolveFormat(resource.name, probe.head)
  if (!format) {
    throw new ComicReaderError(
      'unsupported-format',
      'This file is not a comic archive we can read.'
    )
  }

  if (format === 'cbz' && probe.supported && size > rangeThresholdBytes) {
    return { source: { kind: 'range', url, getHeaders: headersFor }, format }
  }

  const data = await downloadWhole(url, headersFor(), {
    maxBytes: maxDownloadBytes,
    onProgress,
    signal
  })

  return { source: { kind: 'blob', data, name: resource.name }, format }
}
