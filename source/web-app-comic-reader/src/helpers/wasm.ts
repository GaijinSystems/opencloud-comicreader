/**
 * Guards against the two ways the libarchive worker can fail silently.
 *
 * Both exist because a dead worker does not reject: libarchive.js talks to it
 * over Comlink, and if the worker's runtime aborts mid-call the promise simply
 * never settles. The reader then sits on a spinner forever with nothing in the
 * console except the worker's own message. That is exactly what a CSP without
 * `wasm-unsafe-eval` produces.
 */

/** Magic number + version: the smallest valid module, with no sections. */
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

let wasmProbe: Promise<boolean> | null = null

/**
 * Checks whether this page may compile WebAssembly.
 *
 * Probes `WebAssembly.instantiate` specifically, because that is the call
 * libarchive's Emscripten runtime makes and CSP enforcement is not uniform
 * across the WebAssembly entry points: at least one browser permits the
 * synchronous `new WebAssembly.Module()` constructor under a policy that
 * still rejects `instantiate()`. Probing the constructor therefore reported
 * success on a page where the worker went on to abort, which is worse than no
 * probe at all — the reader spun forever instead of explaining itself.
 *
 * Async as a result, and cached, since the policy cannot change within a page
 * load.
 */
export function checkWasmAllowed(): Promise<boolean> {
  if (wasmProbe) {
    return wasmProbe
  }
  wasmProbe = (async () => {
    try {
      if (typeof WebAssembly?.instantiate !== 'function') {
        return false
      }
      await WebAssembly.instantiate(EMPTY_MODULE)
      return true
    } catch {
      // CompileError from CSP, or WebAssembly unavailable entirely.
      return false
    }
  })()
  return wasmProbe
}

/** Reset hook for tests. */
export function resetWasmProbe(): void {
  wasmProbe = null
}

export class WorkerTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Worker call did not respond within ${ms}ms`)
    this.name = 'WorkerTimeoutError'
  }
}

/**
 * Rejects if a worker call has not settled in time.
 *
 * A backstop, not a performance limit. The WASM probe catches the common CSP
 * case up front; this catches everything else that can kill the worker
 * mid-call, where the alternative is an indefinite spinner. Budgets are
 * therefore generous — a slow legitimate extraction must not trip it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WorkerTimeoutError(ms)), ms)
    })
  ]).finally(() => clearTimeout(timer)) as Promise<T>
}
