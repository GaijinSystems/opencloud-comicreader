import { MB } from '../config'

/**
 * One request to a decoder worker, supervised: the reader's one-pass
 * decoders (unarrAdapter.ts) and its decrypter (sevenZipAdapter.ts) each
 * give a worker one archive and wait for one answer, and both need the same
 * things around that wait.
 */

/** No message from the worker for this long means it is stuck or dead. */
const INACTIVITY_TIMEOUT_MS = 30_000

/**
 * The whole request must finish within this, however steadily the worker
 * reports progress. An archive controls how fast it makes progress (RAR's
 * filter programs can be made very slow), so without an overall limit a
 * hostile one could keep a worker busy for as long as it likes while never
 * going silent. Generous on purpose: a real archive is many times faster.
 */
const DEADLINE_BASE_MS = 60_000
const DEADLINE_PER_MB_MS = 1_000

/** What every worker says besides its answer. */
type Report = { type: 'progress' } | { type: 'error'; message: string }

/** The slice of the Worker interface used here; lets tests fake one. */
export interface WorkerLike<Answer> {
  postMessage(message: unknown): void
  terminate(): void
  onmessage: ((event: MessageEvent<Answer | Report>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror?: ((event: MessageEvent) => void) | null
}

export interface WorkerRequestOptions<Answer, Result> {
  /** The archive's size, which sets the overall deadline. */
  archiveBytes: number
  signal?: AbortSignal
  inactivityTimeoutMs?: number
  deadlineMs?: number
  /** The worker's answer: return the result, or throw. */
  onAnswer: (answer: Answer) => Result
  /**
   * The worker failed, went silent or ran out of time: return what the
   * request resolves to, or throw.
   */
  onFailure: (reason: string) => Result
}

/**
 * Posts `request` and waits for the answer. Rejects with the signal's
 * reason on an abort. However it ends, the worker is terminated: one
 * archive per worker, and terminating is what frees its heap.
 */
export async function runWorkerRequest<Answer extends { type: string }, Result>(
  worker: WorkerLike<Answer>,
  request: unknown,
  options: WorkerRequestOptions<Answer, Result>
): Promise<Result> {
  const { signal } = options
  const timeoutMs = options.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS
  const deadlineMs =
    options.deadlineMs ?? DEADLINE_BASE_MS + (options.archiveBytes / MB) * DEADLINE_PER_MB_MS

  let watchdog: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<Result>((resolve, reject) => {
      const settle = (produce: () => Result) => {
        try {
          resolve(produce())
        } catch (error) {
          reject(error)
        }
      }
      const fail = (reason: string) => settle(() => options.onFailure(reason))
      const restartWatchdog = () => {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => fail('the decoder stopped responding'), timeoutMs)
      }

      onAbort = () => reject(signal?.reason)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      worker.onerror = (event) => fail(event.message || 'the worker failed to load')
      worker.onmessageerror = () => fail('the worker sent something that could not be read')
      worker.onmessage = ({ data: message }) => {
        if (message.type === 'progress') {
          restartWatchdog()
        } else if (message.type === 'error') {
          fail((message as { message: string }).message)
        } else {
          settle(() => options.onAnswer(message as Answer))
        }
      }

      restartWatchdog()
      deadline = setTimeout(() => fail('it took too long'), deadlineMs)
      // A Blob in the request is passed by reference; the worker reads it a
      // part at a time.
      try {
        worker.postMessage(request)
      } catch (error) {
        fail(String((error as Error)?.message ?? error))
      }
    })
  } finally {
    clearTimeout(watchdog)
    clearTimeout(deadline)
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort)
    }
    worker.terminate()
  }
}
