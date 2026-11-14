/*
 * Comic Reader — worker around the sevenzip module: 7-Zip's 7z reader, and
 * its decryption routines for RAR and for zip's AES.
 * Part of Comic Reader, AGPL-3.0-or-later. Not part of 7-Zip.
 *
 * One archive per worker: the page terminates it afterwards, which is also
 * what returns the WebAssembly heap to the system (and with it the password
 * and whatever was decrypted), and is how a pass that has stopped making
 * progress gets cancelled.
 *
 * Two kinds of request, one per worker.
 *
 * To decode a password-protected 7z:
 *   in:   { type: 'extract', archive: Blob, limits, password }
 *   out:  { type: 'done', supported, truncated, entries, password? }
 * `password` in the answer is 'needed' or 'wrong', and comes with no
 * entries. Each kept entry's `data` is a Blob.
 *
 * To decrypt a RAR, or a zip whose entries are AES-encrypted, into the same
 * archive without encryption, for the reader's other decoders to read:
 *   in:   { type: 'decrypt', archive: Blob, format: 'rar' | 'zip', password }
 *   out:  { type: 'decrypted', status, archive?: Blob, proven?, unchecked?, reason? }
 * `status` is 'decrypted', 'not-encrypted', 'wrong-password' or
 * 'unsupported'; see DecryptResult in decrypt-common.mjs.
 *
 * Either way: { type: 'progress' } as the work goes, and
 * { type: 'error', message } if it fails.
 *
 * Archives arrive and leave as Blobs. The browser passes Blobs between
 * threads by reference, so nothing is copied across. The archive is read
 * from its Blob a part at a time, and a decrypted one is gathered into a
 * Blob as it is written: neither is held whole in this worker's memory.
 */

/**
 * The page loads this worker as `sevenzip-worker.mjs?v=<hash>`, where the
 * hash covers every decoder file of the build. The same query is passed on
 * to everything loaded from here, so that a browser cannot combine this file
 * with a module or .wasm it cached from a different build.
 */
const version = self.location.search
const versioned = (file) => new URL(file, import.meta.url).href + version
const modules = Promise.all([
  import(versioned('./sevenzip.mjs')),
  import(versioned('./sevenzip-extract.mjs')),
  import(versioned('./decrypt-common.mjs')),
  import(versioned('./decrypt-rar.mjs')),
  import(versioned('./decrypt-zip.mjs'))
])
// A failure is reported when a request arrives, not as an unhandled rejection.
modules.catch(() => {})

self.onmessage = async (event) => {
  const request = event.data
  if (request?.type !== 'extract' && request?.type !== 'decrypt') {
    return
  }
  const onProgress = () => self.postMessage({ type: 'progress' })
  try {
    const [{ default: createModule }, extract, common, { decryptRar }, { decryptZip }] = await modules
    const Module = await createModule({
      locateFile: versioned,
      printErr: (line) => console.warn('[comic-reader] 7-Zip:', line)
    })
    // Read from the Blob as 7-Zip asks for it (see the top of this file).
    // Workers have FileReaderSync for that; in a runtime that has not, the
    // archive is read into memory first.
    const source = extract.canReadBlobsSynchronously()
      ? extract.sourceFromBlob(request.archive)
      : extract.sourceFromBytes(new Uint8Array(await request.archive.arrayBuffer()))
    // Deriving the key from the password takes a moment and reports nothing.
    onProgress()
    if (request.type === 'decrypt') {
      const decrypt = request.format === 'zip' ? decryptZip : decryptRar
      const result = decrypt(common, Module, source, request.password, { onProgress })
      self.postMessage({ type: 'decrypted', ...result })
      return
    }
    const result = extract.extractSevenZip(Module, source, request.limits, {
      onProgress,
      password: request.password,
      store: (data) => new Blob([data])
    })
    self.postMessage({ type: 'done', ...result })
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message ?? error) })
  }
}
