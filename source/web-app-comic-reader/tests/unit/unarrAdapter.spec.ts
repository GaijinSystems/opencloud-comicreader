import { describe, it, expect, vi, afterEach } from 'vitest'
import { FakeWorker } from './helpers/fakes'
import { UnarrAdapter, type UnarrWorker } from '../../src/archive/unarrAdapter'

/**
 * The adapter's side of the worker conversation, against a scripted worker.
 * The decoding itself is covered in unarrExtract.spec.ts with the real module.
 */

type Answer = Exclude<Parameters<NonNullable<UnarrWorker['onmessage']>>[0]['data'], { type: 'progress' | 'error' }>
const newWorker = () => new FakeWorker<Answer>()

const blob = (...values: number[]) => new Blob([new Uint8Array(values)])
const onePage = () => ({ name: 'p1.png', size: 3, data: blob(1, 2, 3) })

const baseOptions = {
  maxEntryBytes: 100,
  maxEntries: 50,
  maxRetainedBytes: 500,
  solid: true,
  declaredEntryCount: 0
}

function start(overrides: Partial<Parameters<typeof UnarrAdapter.open>[1]> = {}) {
  const worker = newWorker()
  const archive = new Blob([new Uint8Array(1000)])
  const opening = UnarrAdapter.open(archive, {
    ...baseOptions,
    createWorker: () => worker,
    ...overrides
  })
  return { worker, archive, opening }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('UnarrAdapter', () => {
  it('sends the archive with limits derived from its size and the page cap', async () => {
    const { worker, archive, opening } = start()
    worker.reply({ type: 'done', supported: true, truncated: false, entries: [onePage()] })
    await opening

    const message = worker.posted[0] as { archive: Blob; limits: { keepExtensions: string[] } }
    // The Blob itself, by reference: no copy into this thread's heap.
    expect(message.archive).toBe(archive)
    expect(message).toMatchObject({
      type: 'extract',
      limits: {
        maxEntryBytes: 100,
        maxEntries: 50,
        maxTotalBytes: 4000,
        // Never below the archive's own size, whatever the caller asked for.
        maxRetainedBytes: 1000,
        solid: true,
        keepNames: ['comicinfo.xml']
      }
    })
    expect(message.limits.keepExtensions).toContain('png')
  })

  it('exposes what the worker decoded and terminates it', async () => {
    const { worker, opening } = start()
    worker.reply({
      type: 'done',
      supported: true,
      truncated: false,
      entries: [
        { name: 'pages/p1.png', size: 3, data: blob(1, 2, 3) },
        { name: 'ComicInfo.xml', size: 12, data: new Blob(['<ComicInfo/>']) }
      ]
    })
    const adapter = await opening

    expect(worker.terminated).toBe(true)
    expect(adapter?.listEntries().map((entry) => entry.name)).toEqual([
      'pages/p1.png',
      'ComicInfo.xml'
    ])
    const pageBlob = await adapter!.readEntry(0)
    // Handed over as the worker's Blob, not copied into an array.
    expect(pageBlob).toBeInstanceOf(Blob)
    expect(new Uint8Array(await pageBlob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(await adapter?.readText('ComicInfo.xml')).toBe('<ComicInfo/>')
    expect(adapter?.dropped).toBeNull()
  })

  it('reports an entry that came back without data as permanently unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { worker, opening } = start()
    worker.reply({
      type: 'done',
      supported: true,
      truncated: true,
      entries: [
        { name: 'huge.png', size: 5000 },
        { name: 'lost.png', size: 10 }
      ]
    })
    const adapter = await opening

    await expect(adapter?.readEntry(0)).rejects.toMatchObject({ code: 'page-unavailable' })
    await expect(adapter?.readEntry(1)).rejects.toMatchObject({ code: 'page-unavailable' })
    await expect(adapter?.readEntry(9)).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('resolves to null, quietly, for a container unarr does not read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { worker, opening } = start()
    worker.reply({ type: 'done', supported: false, truncated: false, entries: [] })

    expect(await opening).toBeNull()
    expect(warn).not.toHaveBeenCalled()
    expect(worker.terminated).toBe(true)
  })

  it('resolves to null for an empty listing, so the caller can try its other decoder', async () => {
    const { worker, opening } = start()
    worker.reply({ type: 'done', supported: true, truncated: true, entries: [] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await opening).toBeNull()
  })

  it('resolves to null when the worker reports an error or fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const failed = start()
    failed.worker.reply({ type: 'error', message: 'CompileError' })
    expect(await failed.opening).toBeNull()

    const unloaded = start()
    unloaded.worker.onerror?.({ message: 'script blocked' } as ErrorEvent)
    expect(await unloaded.opening).toBeNull()
    expect(unloaded.worker.terminated).toBe(true)
  })

  it('resolves to null when the worker cannot even be created', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opening = UnarrAdapter.open(new Blob(['12345678']), {
      ...baseOptions,
      createWorker: () => {
        throw new Error('blocked by policy')
      }
    })
    expect(await opening).toBeNull()
  })

  it('gives up on a worker that goes silent, and terminates it', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { worker, opening } = start({ inactivityTimeoutMs: 1000 })

    await vi.advanceTimersByTimeAsync(1001)
    expect(await opening).toBeNull()
    expect(worker.terminated).toBe(true)
  })

  it('keeps waiting for as long as progress keeps arriving', async () => {
    vi.useFakeTimers()
    const { worker, opening } = start({ inactivityTimeoutMs: 1000 })

    for (let step = 0; step < 5; step++) {
      await vi.advanceTimersByTimeAsync(800)
      worker.reply({ type: 'progress' })
    }
    worker.reply({ type: 'done', supported: true, truncated: false, entries: [onePage()] })

    expect(await opening).not.toBeNull()
  })

  it('rejects with an abort, and terminates the worker, when the open is cancelled', async () => {
    const controller = new AbortController()
    const { worker, opening } = start({ signal: controller.signal })
    controller.abort()

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminated).toBe(true)
  })

  it('does not start a worker for an open that is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const createWorker = vi.fn()
    await expect(
      UnarrAdapter.open(new Blob(['12345678']), {
        ...baseOptions,
        signal: controller.signal,
        createWorker
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('gives up at the overall deadline even while progress keeps arriving', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { worker, opening } = start({ inactivityTimeoutMs: 1000, deadlineMs: 3000 })

    // A decoder that reports progress forever and never finishes.
    for (let step = 0; step < 5; step++) {
      await vi.advanceTimersByTimeAsync(800)
      worker.reply({ type: 'progress' })
    }

    expect(await opening).toBeNull()
    expect(worker.terminated).toBe(true)
  })

  it('counts entries the container declares but the pass never listed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { worker, opening } = start({ declaredEntryCount: 9 })
    worker.reply({
      type: 'done',
      supported: true,
      truncated: true,
      entries: [
        { name: 'p1.png', size: 3, data: blob(1, 2, 3) },
        { name: 'p2.png', size: 3 }
      ]
    })
    expect((await opening)?.dropped).toEqual({ count: 7, because: 'incomplete' })
  })

  it('reports nothing dropped when the listing is complete', async () => {
    const { worker, opening } = start({ declaredEntryCount: 1 })
    worker.reply({
      type: 'done',
      supported: true,
      truncated: false,
      // More than declared is normal: the header count leaves out symlinks.
      entries: [
        { name: 'p1.png', size: 3, data: blob(1, 2, 3) },
        { name: 'link.png', size: 5, data: blob(1, 2, 3, 4, 5) }
      ]
    })
    expect((await opening)?.dropped).toBeNull()
  })
})

describe('UnarrAdapter driving a decoder that takes a password', () => {
  it('passes the password to the worker and reports the format it was given', async () => {
    const { worker, opening } = start({ password: 'comic', format: 'cb7' })
    worker.reply({ type: 'done', supported: true, truncated: false, entries: [onePage()] })
    const adapter = await opening

    expect(worker.posted[0]).toMatchObject({ type: 'extract', password: 'comic' })
    expect(adapter?.format).toBe('cb7')
  })

  it('still reads RAR, with no password, when told nothing else', async () => {
    const { worker, opening } = start()
    worker.reply({ type: 'done', supported: true, truncated: false, entries: [onePage()] })
    const adapter = await opening

    expect(worker.posted[0]).toMatchObject({ password: undefined })
    expect(adapter?.format).toBe('cbr')
  })

  it.each(['needed', 'wrong'] as const)(
    'rejects as encrypted when the decoder says the password is %s',
    async (password) => {
      const { worker, opening } = start({ password: 'comic', format: 'cb7' })
      worker.reply({ type: 'done', supported: true, truncated: false, entries: [], password })

      await expect(opening).rejects.toMatchObject({ code: 'encrypted' })
      expect(worker.terminated).toBe(true)
    }
  )

  it('resolves to null, for the caller to fall back, when the request cannot be sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const worker = newWorker()
    worker.postMessage = () => {
      throw new Error('could not be cloned')
    }
    const { opening } = start({ createWorker: () => worker })
    expect(await opening).toBeNull()
    expect(worker.terminated).toBe(true)
    vi.restoreAllMocks()
  })

  it('needs neither the solid flag nor a declared entry count', async () => {
    const worker = newWorker()
    const opening = UnarrAdapter.open(new Blob([new Uint8Array(1000)]), {
      maxEntryBytes: 100,
      maxEntries: 50,
      maxRetainedBytes: 500,
      createWorker: () => worker
    })
    worker.reply({ type: 'done', supported: true, truncated: false, entries: [onePage()] })
    const adapter = await opening

    expect(worker.posted[0]).toMatchObject({ limits: { solid: false } })
    expect(adapter?.dropped).toBeNull()
  })
})

