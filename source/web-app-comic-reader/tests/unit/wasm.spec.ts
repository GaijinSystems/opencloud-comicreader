import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkWasmAllowed, resetWasmProbe, withTimeout, WorkerTimeoutError } from '../../src/helpers/wasm'

afterEach(() => {
  resetWasmProbe()
  vi.unstubAllGlobals()
})

describe('checkWasmAllowed', () => {
  it('is true where WebAssembly instantiates normally', async () => {
    await expect(checkWasmAllowed()).resolves.toBe(true)
  })

  it('is false when the policy blocks instantiate', async () => {
    // The real-world case: a CSP without 'wasm-unsafe-eval' rejects
    // instantiate() asynchronously.
    vi.stubGlobal('WebAssembly', {
      instantiate: () =>
        Promise.reject(new Error('call to WebAssembly.instantiate() blocked by CSP'))
    })
    resetWasmProbe()
    await expect(checkWasmAllowed()).resolves.toBe(false)
  })

  it('probes instantiate, not the Module constructor', async () => {
    // Regression guard. At least one browser allows `new WebAssembly.Module()`
    // under a policy that still blocks instantiate(), so probing the
    // constructor reported success on a page where decoding could not work.
    const Module = vi.fn()
    vi.stubGlobal('WebAssembly', {
      Module,
      instantiate: () => Promise.reject(new Error('blocked by CSP'))
    })
    resetWasmProbe()
    await expect(checkWasmAllowed()).resolves.toBe(false)
    expect(Module).not.toHaveBeenCalled()
  })

  it('is false when WebAssembly is absent entirely', async () => {
    vi.stubGlobal('WebAssembly', undefined)
    resetWasmProbe()
    await expect(checkWasmAllowed()).resolves.toBe(false)
  })

  it('caches the result rather than probing per call', async () => {
    const instantiate = vi.fn(() => Promise.resolve({}))
    vi.stubGlobal('WebAssembly', { instantiate })
    resetWasmProbe()
    await Promise.all([checkWasmAllowed(), checkWasmAllowed(), checkWasmAllowed()])
    expect(instantiate).toHaveBeenCalledTimes(1)
  })
})

describe('withTimeout', () => {
  it('passes through a value that arrives in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok')
  })

  it('passes through a rejection unchanged', async () => {
    const boom = new Error('boom')
    await expect(withTimeout(Promise.reject(boom), 1000, 'test')).rejects.toBe(boom)
  })

  it('rejects when the promise never settles, the dead-worker case', async () => {
    // A worker whose runtime aborted leaves its Comlink promise pending
    // forever. This is the only thing standing between that and a spinner
    // the user can never escape.
    const neverSettles = new Promise<string>(() => {})
    await expect(withTimeout(neverSettles, 10, 'test')).rejects.toBeInstanceOf(WorkerTimeoutError)
  })

  it('clears its timer so a resolved call cannot hold the event loop', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    await withTimeout(Promise.resolve(1), 5000, 'test')
    expect(clearSpy).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
