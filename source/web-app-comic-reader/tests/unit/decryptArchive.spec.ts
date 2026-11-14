import { describe, it, expect, vi, afterEach } from 'vitest'
import { FakeWorker } from './helpers/fakes'
import { decryptArchive, type DecryptWorker } from '../../src/archive/sevenZipAdapter'

/**
 * The page's side of the conversation with the worker that decrypts an
 * archive, against a scripted worker. The decryption itself is covered in
 * decryptArchives.spec.ts with the real module.
 */

type Answer = Exclude<Parameters<NonNullable<DecryptWorker['onmessage']>>[0]['data'], { type: 'progress' | 'error' }>
const newWorker = () => new FakeWorker<Answer>()

function start(overrides: Partial<Parameters<typeof decryptArchive>[1]> = {}) {
  const worker = newWorker()
  const archive = new Blob([new Uint8Array(1000)])
  const decrypting = decryptArchive(archive, {
    format: 'rar',
    password: 'comic',
    createWorker: () => worker,
    ...overrides
  })
  return { worker, archive, decrypting }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('decryptArchive', () => {
  it('sends the archive, the format and the password, and returns what comes back', async () => {
    const { worker, archive, decrypting } = start({ format: 'zip' })
    const plain = new Blob(['plain'])
    worker.reply({ type: 'decrypted', status: 'decrypted', archive: plain, proven: false })

    expect(await decrypting).toEqual({ archive: plain, proven: false, unchecked: false })
    expect(worker.posted).toEqual([{ type: 'decrypt', archive, format: 'zip', password: 'comic' }])
    // One archive per worker: ending it is what frees the password and the heap.
    expect(worker.terminated).toBe(true)
  })

  it('says there was nothing to decrypt when the archive was not encrypted', async () => {
    const { worker, decrypting } = start()
    worker.reply({ type: 'decrypted', status: 'not-encrypted' })
    expect(await decrypting).toEqual({ archive: null, proven: true, unchecked: false })
  })

  it('reports a wrong password as encrypted, which is what asks for it again', async () => {
    const { worker, decrypting } = start()
    worker.reply({ type: 'decrypted', status: 'wrong-password' })
    await expect(decrypting).rejects.toMatchObject({ code: 'encrypted' })
    expect(worker.terminated).toBe(true)
  })

  it('says what it cannot undo, in the worker\'s words, without asking for the password again', async () => {
    const { worker, decrypting } = start()
    worker.reply({ type: 'decrypted', status: 'unsupported', reason: 'an archive in several volumes' })
    const error = await decrypting.catch((caught) => caught)
    expect(error).toMatchObject({ code: 'corrupt' })
    expect(error.message).toMatch(/cannot undo \(an archive in several volumes\)/)
  })

  it('does not take a password as confirmed, or checksums as missing, unless the worker says so', async () => {
    const { worker, decrypting } = start()
    const plain = new Blob(['plain'])
    worker.reply({ type: 'decrypted', status: 'decrypted', archive: plain })
    expect(await decrypting).toEqual({ archive: plain, proven: false, unchecked: false })
  })

  it('takes nothing but an answer to its request for one', async () => {
    // Read as "not encrypted", either would send the archive on as it is.
    for (const stray of [
      { type: 'decrypted', status: 'no such status' },
      { type: 'done', supported: true, truncated: false, entries: [] as unknown[] }
    ]) {
      const { worker, decrypting } = start()
      worker.reply(stray as never)
      await expect(decrypting).rejects.toMatchObject({ code: 'corrupt' })
    }
  })

  it('reports a request that could not be sent as a failure', async () => {
    const { worker, decrypting } = start({
      createWorker: () => {
        const unsendable = newWorker()
        unsendable.postMessage = () => {
          throw new Error('could not be cloned')
        }
        return unsendable
      }
    })
    void worker
    await expect(decrypting).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('reports a worker that fails, or fails to load, as a failure and not as a wrong password', async () => {
    const failing = start()
    failing.worker.reply({ type: 'error', message: 'out of memory' })
    await expect(failing.decrypting).rejects.toMatchObject({ code: 'corrupt' })

    const unloadable = start()
    unloadable.worker.onerror?.({ message: '' } as ErrorEvent)
    await expect(unloadable.decrypting).rejects.toMatchObject({ code: 'corrupt' })
    expect(unloadable.worker.terminated).toBe(true)

    await expect(
      decryptArchive(new Blob(['x']), {
        format: 'rar',
        password: 'comic',
        createWorker: () => {
          throw new Error('blocked by the page policy')
        }
      })
    ).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('gives up on a worker that goes silent, and keeps waiting on one that reports progress', async () => {
    vi.useFakeTimers()
    const { worker, decrypting } = start({ inactivityTimeoutMs: 1000, deadlineMs: 60_000 })
    const settled = decrypting.catch((caught) => caught)

    await vi.advanceTimersByTimeAsync(900)
    worker.reply({ type: 'progress' })
    await vi.advanceTimersByTimeAsync(900)
    expect(worker.terminated).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(await settled).toMatchObject({ code: 'corrupt' })
    expect(worker.terminated).toBe(true)
  })

  it('gives up at the deadline however steadily the worker reports', async () => {
    vi.useFakeTimers()
    const { worker, decrypting } = start({ inactivityTimeoutMs: 1000, deadlineMs: 2500 })
    const settled = decrypting.catch((caught) => caught)
    for (let tick = 0; tick < 5; tick++) {
      await vi.advanceTimersByTimeAsync(600)
      worker.reply({ type: 'progress' })
    }
    expect(await settled).toMatchObject({ code: 'corrupt' })
    expect(worker.terminated).toBe(true)
  })

  it('stops, and ends the worker, when the comic is closed meanwhile', async () => {
    const controller = new AbortController()
    const { worker, decrypting } = start({ signal: controller.signal })
    const reason = new DOMException('closed', 'AbortError')
    controller.abort(reason)
    await expect(decrypting).rejects.toBe(reason)
    expect(worker.terminated).toBe(true)

    // And does not start at all for a comic already closed.
    const created = vi.fn()
    await expect(
      decryptArchive(new Blob(['x']), {
        format: 'rar',
        password: 'comic',
        signal: controller.signal,
        createWorker: created
      })
    ).rejects.toBe(reason)
    expect(created).not.toHaveBeenCalled()
  })
})
