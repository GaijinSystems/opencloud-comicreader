/*
 * Comic Reader — worker that decodes one RAR4 archive with unarr.
 * Part of Comic Reader, AGPL-3.0-or-later. Not part of unarr.
 *
 * One archive per worker: the page terminates it afterwards, which is also
 * what returns the WebAssembly heap to the system, and is how a decode that
 * has stopped making progress gets cancelled.
 *
 * Messages in:   { type: 'extract', archive: Blob, limits }
 * Messages out:  { type: 'progress' }
 *                { type: 'done', supported, truncated, entries }
 *                { type: 'error', message }
 *
 * The archive arrives as a Blob and each kept entry's `data` leaves as one.
 * The browser passes Blobs between threads by reference, so neither the
 * archive nor the unpacked pages are copied across.
 */
/**
 * The page loads this worker as `unarr-worker.mjs?v=<hash>`, where the hash
 * covers every decoder file of the build. The same query is passed on to
 * everything loaded from here, so that a browser cannot combine this file
 * with a module or .wasm it cached from a different build.
 */
const version = self.location.search
const versioned = (file) => new URL(file, import.meta.url).href + version
const modules = Promise.all([import(versioned('./unarr-rar.mjs')), import(versioned('./unarr-extract.mjs'))])
// A failure is reported when a request arrives, not as an unhandled rejection.
modules.catch(() => {})

/**
 * unarr warns once per malformed header, and a hostile file can contain
 * millions. The first few are useful for debugging; the rest would only
 * flood the console.
 */
const MAX_WARNINGS = 20

self.onmessage = async (event) => {
  const request = event.data
  if (request?.type !== 'extract') {
    return
  }
  const onProgress = () => self.postMessage({ type: 'progress' })
  try {
    let warnings = 0
    const [{ default: createModule }, { copyBlobToHeap, extractRar }] = await modules
    const Module = await createModule({
      locateFile: versioned,
      // unarr reports problems on stderr; keep some, prefixed, for debugging.
      printErr: (line) => {
        warnings++
        if (warnings <= MAX_WARNINGS) {
          console.warn('[comic-reader] unarr:', line)
        } else if (warnings === MAX_WARNINGS + 1) {
          console.warn('[comic-reader] unarr: further warnings suppressed')
        }
      }
    })
    const archive = await copyBlobToHeap(Module, request.archive, onProgress)
    const result = extractRar(Module, archive, request.archive.size, request.limits, {
      onProgress,
      store: (data) => new Blob([data])
    })
    self.postMessage({ type: 'done', ...result })
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) })
  }
}
