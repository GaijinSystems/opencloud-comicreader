import { describe, it, expect, vi, afterEach } from 'vitest'
import { downloadWhole } from '../../src/archive/source'

/**
 * The whole-file download. It folds what arrives into a Blob every 8 MB, so
 * the page never holds the file as one array; these check that nothing is
 * lost or reordered across those folds, and that the size cap still applies
 * to what actually arrives.
 */

const MB = 1024 * 1024

/** A response whose body arrives in the given chunk sizes, each chunk stamped with its number. */
function streamedResponse(chunkSizes: number[], headers: Record<string, string> = {}) {
  let next = 0
  let cancelled = false
  const response = {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: {
      getReader: () => ({
        read: async () => {
          if (next >= chunkSizes.length) {
            return { done: true, value: undefined }
          }
          const chunk = new Uint8Array(chunkSizes[next]).fill(next + 1)
          next++
          return { done: false, value: chunk }
        },
        cancel: async () => {
          cancelled = true
        }
      })
    }
  }
  return { response, wasCancelled: () => cancelled, chunksRead: () => next }
}

afterEach(() => vi.unstubAllGlobals())

describe('downloadWhole', () => {
  it('returns every byte, in order, across several folds', async () => {
    // 21 MB in 3 MB chunks: crosses the 8 MB fold point twice, with a tail.
    const sizes = Array.from({ length: 7 }, () => 3 * MB)
    const { response } = streamedResponse(sizes)
    vi.stubGlobal('fetch', async () => response)

    const blob = await downloadWhole('https://files.example/a', {}, { maxBytes: 64 * MB })

    expect(blob.size).toBe(21 * MB)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    sizes.forEach((size, index) => {
      const start = index * size
      // First and last byte of each chunk carry that chunk's number.
      expect(bytes[start]).toBe(index + 1)
      expect(bytes[start + size - 1]).toBe(index + 1)
    })
  })

  it('handles chunks that are themselves larger than the fold size', async () => {
    const { response } = streamedResponse([10 * MB, 1, 9 * MB])
    vi.stubGlobal('fetch', async () => response)

    const blob = await downloadWhole('https://files.example/a', {}, { maxBytes: 64 * MB })
    const bytes = new Uint8Array(await blob.arrayBuffer())

    expect(blob.size).toBe(19 * MB + 1)
    expect(bytes[10 * MB - 1]).toBe(1)
    expect(bytes[10 * MB]).toBe(2)
    expect(bytes[10 * MB + 1]).toBe(3)
  })

  it('reports progress against the declared length', async () => {
    const { response } = streamedResponse([4 * MB, 4 * MB, 4 * MB], {
      'Content-Length': String(12 * MB)
    })
    vi.stubGlobal('fetch', async () => response)
    const seen: number[] = []

    await downloadWhole('https://files.example/a', {}, {
      maxBytes: 64 * MB,
      onProgress: (progress) => {
        expect(progress.totalBytes).toBe(12 * MB)
        seen.push(progress.loadedBytes)
      }
    })
    expect(seen).toEqual([4 * MB, 8 * MB, 12 * MB])
  })

  it('refuses up front when the declared length is over the cap', async () => {
    const { response, chunksRead } = streamedResponse([1], { 'Content-Length': String(20 * MB) })
    vi.stubGlobal('fetch', async () => response)

    await expect(
      downloadWhole('https://files.example/a', {}, { maxBytes: 10 * MB })
    ).rejects.toMatchObject({ code: 'too-large' })
    expect(chunksRead()).toBe(0)
  })

  it('stops part way, and cancels the stream, when an undeclared body runs over the cap', async () => {
    // No Content-Length: the cap can only be applied to what arrives.
    const { response, wasCancelled, chunksRead } = streamedResponse(
      Array.from({ length: 10 }, () => 3 * MB)
    )
    vi.stubGlobal('fetch', async () => response)

    await expect(
      downloadWhole('https://files.example/a', {}, { maxBytes: 10 * MB })
    ).rejects.toMatchObject({ code: 'too-large' })
    expect(wasCancelled()).toBe(true)
    // It gave up on the chunk that crossed the line, not at the end.
    expect(chunksRead()).toBe(4)
  })

  it('reports a stream that dies part way as a network error', async () => {
    let reads = 0
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            if (reads++ === 0) {
              return { done: false, value: new Uint8Array(MB) }
            }
            throw new TypeError('network error')
          },
          cancel: async () => {}
        })
      }
    }))
    await expect(
      downloadWhole('https://files.example/a', {}, { maxBytes: 64 * MB })
    ).rejects.toMatchObject({ code: 'network' })
  })

  it('lets an abort through as an abort, not as a network error', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    vi.stubGlobal('fetch', async () => {
      throw abort
    })
    await expect(
      downloadWhole('https://files.example/a', {}, { maxBytes: 64 * MB })
    ).rejects.toBe(abort)
  })

  it('reports an HTTP error status as a network error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, headers: new Headers() }))
    await expect(
      downloadWhole('https://files.example/a', {}, { maxBytes: 64 * MB })
    ).rejects.toMatchObject({ code: 'network' })
  })
})
