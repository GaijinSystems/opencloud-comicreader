import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker as NodeWorker } from 'node:worker_threads'
import { configure } from '@zip.js/zip.js'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'

import { DEFAULT_CONFIG } from '../../src/config'
import { ZIP_SCHEMES, lockedZip, serveBytes } from './helpers/fakes'
import { ComicReaderError } from '../../src/archive/types'
import { shutdownZipWorkers } from '../../src/archive/zipAdapter'

/**
 * The password prompt end to end, with as little replaced as a unit test
 * allows: the real prompt component, the REAL button of OpenCloud's design
 * system inside it, the real composable, the real openComic and zip.js, and
 * a password-protected zip written here. Only the network is stubbed.
 *
 * For 7z the same, with the decoder too: the real worker script and the
 * real 7-Zip module, run in a Node worker thread standing in for the
 * browser's Worker. The one thing replaced there is libarchive, which in the
 * reader is what first finds the archive encrypted; here a stand-in says so.
 *
 * This exists because the prompt once shipped with a button that the
 * stand-in used in readerPassword.spec.ts accepted and the real one did not:
 * clicking it did nothing, for every protected comic.
 */

// libarchive needs a worker and a module of its own. All it contributes to
// this flow is finding a 7z encrypted, which this says for it.
vi.mock('../../src/archive/libarchiveAdapter', () => ({
  LibArchiveAdapter: {
    open: async () => {
      throw new ComicReaderError('encrypted', 'This comic is password protected.')
    }
  }
}))

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({ $gettext: (message: string) => message }),
  createGettext: () => ({})
}))

const { OcButton } = await import('@opencloud-eu/design-system/components')
const { default: ReaderPassword } = await import('../../src/components/ReaderPassword.vue')
const { useComicArchive } = await import('../../src/composables/useComicArchive')

configure({ useWebWorkers: false })



let fetched = 0
function serve(bytes: Uint8Array) {
  fetched = 0
  serveBytes(bytes, () => fetched++)
}

/** Opens the comic, and shows the prompt wired to the composable as App.vue wires it. */
async function openToPrompt(name = 'book.cbz') {
  const archive = useComicArchive({
    config: { ...DEFAULT_CONFIG, prefetchPages: 0 },
    headers: ref({}),
    trustedOrigins: [],
    getUrlForResource: async () => `https://files.example/${name}`
  })
  await archive.open({} as SpaceResource, { name, size: 0 } as unknown as Resource)
  expect(archive.error.value).toMatchObject({ code: 'password-required' })

  const prompt = (wrong: boolean) =>
    mount(ReaderPassword, {
      attachTo: document.body,
      props: {
        wrong,
        fileName: name,
        onSubmit: (password: string) => void archive.unlock(password)
      },
      global: {
        mocks: { $gettext: (message: string) => message },
        // The real button. Its icon and spinner are decoration and stay stubbed.
        stubs: { 'oc-button': OcButton, 'oc-icon': true, 'oc-spinner': true }
      }
    })
  return { archive, prompt }
}

/** Lets the open that a submit started run to its end. */
async function settled(archive: { loading: { value: boolean } }) {
  await vi.waitFor(async () => {
    await flushPromises()
    expect(archive.loading.value).toBe(false)
  })
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:page')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})
afterAll(async () => {
  await shutdownZipWorkers()
})

describe.each(ZIP_SCHEMES)('the password prompt, for a zip protected with %s', (_scheme, zipOptions) => {
  it('opens the comic when the password is typed and the button is clicked', async () => {
    serve(await lockedZip(zipOptions))
    const { archive, prompt } = await openToPrompt()
    const fetchedToAsk = fetched
    const wrapper = prompt(false)

    // The design system's button, rendered as a real submit button.
    const button = wrapper.get('button')
    expect(button.attributes('type')).toBe('submit')

    await wrapper.get('input').setValue('comic')
    await button.trigger('click')
    await settled(archive)

    expect(archive.error.value).toBeNull()
    expect(archive.pageCount.value).toBe(2)
    expect(await archive.pageUrl(1)).toBe('blob:page')
    // And it was not downloaded again to do it.
    expect(fetched).toBe(fetchedToAsk)
    await archive.destroy()
  })

  it('opens the comic on Enter in the field', async () => {
    serve(await lockedZip(zipOptions))
    const { archive, prompt } = await openToPrompt()
    const wrapper = prompt(false)

    const input = wrapper.get('input')
    await input.setValue('comic')
    await input.trigger('keydown', { key: 'Enter' })
    await settled(archive)

    expect(archive.error.value).toBeNull()
    expect(archive.pageCount.value).toBe(2)
    await archive.destroy()
  })
})

describe('the password prompt', () => {
  it('comes back saying so after a wrong password, and then takes the right one', async () => {
    // AES, whose two-byte check makes "wrong" certain enough for a test.
    serve(await lockedZip({ encryptionStrength: 3 }))
    const { archive, prompt } = await openToPrompt()

    const first = prompt(false)
    await first.get('input').setValue('not the password')
    await first.get('button').trigger('click')
    await settled(archive)
    expect(archive.error.value).toMatchObject({ code: 'wrong-password' })
    expect(archive.pageCount.value).toBe(0)
    first.unmount()

    const second = prompt(true)
    expect(second.get('[role="alert"]').text()).toContain('did not open this comic')
    await second.get('input').setValue('comic')
    await second.get('button').trigger('click')
    await settled(archive)
    expect(archive.error.value).toBeNull()
    expect(archive.pageCount.value).toBe(2)
    await archive.destroy()
  })

  it('has a button that cannot be clicked while the field is empty', async () => {
    serve(await lockedZip({ encryptionStrength: 3 }))
    const { archive, prompt } = await openToPrompt()
    const wrapper = prompt(false)

    const button = wrapper.get('button')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    await flushPromises()
    expect(archive.error.value).toMatchObject({ code: 'password-required' })
    await archive.destroy()
  })
})

/**
 * The browser's Worker, for the 7-Zip decoder: a Node worker thread that
 * runs the worker script the app ships, unchanged. The thread is given the
 * few globals a worker has (`self`, its `location`, `postMessage`,
 * `onmessage`, `FileReaderSync`). The archive crosses as bytes, since the
 * test environment's Blob is not one Node can pass between threads, and is
 * presented to the worker script as something it can slice and read like a
 * Blob; pages come back as Node's own Blobs.
 */
const sevenZipWorker = resolve(__dirname, '../../public/vendor/sevenzip/sevenzip-worker.mjs')
const unarrWorker = resolve(__dirname, '../../public/vendor/unarr/unarr-worker.mjs')
const WORKER_THREAD = `
  const { parentPort, workerData } = require('node:worker_threads')
  globalThis.self = globalThis
  self.location = { search: '' }
  self.postMessage = (message) => parentPort.postMessage(message)
  // What a browser worker reads a Blob with, so that the worker script
  // takes the path it takes in a browser: the archive read a part at a
  // time. Node has neither it nor a Blob that can be read synchronously, so
  // both are stood in for over the archive's bytes.
  globalThis.FileReaderSync = class {
    readAsArrayBuffer(part) {
      return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
    }
  }
  const waiting = []
  let ready = false
  const deliver = (data) => {
    if (data.archiveBytes) {
      // Sliced, a part can be read both ways a worker reads a Blob: at once
      // (FileReaderSync, above) and with arrayBuffer().
      const bytes = data.archiveBytes
      const slice = (start = 0, end = bytes.byteLength) => {
        const part = bytes.subarray(start, end)
        part.arrayBuffer = async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
        return part
      }
      data.archive = { size: bytes.byteLength, slice }
      delete data.archiveBytes
    }
    self.onmessage({ data })
  }
  parentPort.on('message', (data) => (ready ? deliver(data) : waiting.push(data)))
  import(workerData.url).then(
    () => {
      ready = true
      waiting.forEach(deliver)
    },
    (error) => parentPort.postMessage({ type: 'error', message: String(error) })
  )
`
const threads: NodeWorker[] = []
class ThreadWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  private readonly thread: NodeWorker

  /** `url` is what the app asked for; which of the two worker scripts is taken from it. */
  constructor(url: string | URL) {
    const script = String(url).includes('unarr-worker') ? unarrWorker : sevenZipWorker
    this.thread = new NodeWorker(WORKER_THREAD, {
      eval: true,
      workerData: { url: pathToFileURL(script).href }
    })
    threads.push(this.thread)
    this.thread.on('message', (data) => {
      // A decrypted archive arrives as one of Node's Blobs. The app goes on
      // to read it as the test environment's kind, as a browser's would be.
      if (data?.archive) {
        void data.archive.arrayBuffer().then((buffer: ArrayBuffer) => {
          this.onmessage?.({ data: { ...data, archive: new Blob([buffer]) } })
        })
        return
      }
      this.onmessage?.({ data })
    })
    this.thread.on('error', (error) => this.onerror?.({ message: String(error) }))
  }
  postMessage(message: { archive: Blob }) {
    void message.archive.arrayBuffer().then((buffer) => {
      this.thread.postMessage({ ...message, archive: undefined, archiveBytes: new Uint8Array(buffer) })
    })
  }
  terminate() {
    void this.thread.terminate()
  }
}

describe.each(['encrypted.cb7', 'encrypted-headers.cb7'])(
  'the password prompt, for a 7z (%s), through the real worker and 7-Zip module',
  (name) => {
    const bytes = () => new Uint8Array(readFileSync(resolve(__dirname, '../fixtures/sevenzip', name)))

    beforeEach(() => {
      // The module is built from native/sevenzip, not committed.
      if (!existsSync(resolve(sevenZipWorker, '../sevenzip.wasm'))) {
        throw new Error(
          'The 7-Zip module has not been built. Run `npm run build:native` (needs podman or docker).'
        )
      }
      vi.stubGlobal('Worker', ThreadWorker)
    })
    afterEach(async () => {
      await Promise.all(threads.splice(0).map((thread) => thread.terminate()))
    })

    it('opens the comic when the password is typed and the button is clicked', async () => {
      serve(bytes())
      const shown: Blob[] = []
      vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
        shown.push(blob as Blob)
        return 'blob:page'
      })
      const { archive, prompt } = await openToPrompt('book.cb7')
      const fetchedToAsk = fetched
      const wrapper = prompt(false)

      await wrapper.get('input').setValue('comic')
      await wrapper.get('button').trigger('click')
      await settled(archive)

      expect(archive.error.value).toBeNull()
      // The sample comic: five images, one of which its ComicInfo marks deleted.
      expect(archive.pageCount.value).toBe(4)
      expect(await archive.pageUrl(0)).toBe('blob:page')
      // What the reader would show is a real page, decrypted.
      const page = new Uint8Array(await shown[0].arrayBuffer())
      expect([...page.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(fetched).toBe(fetchedToAsk)
      await archive.destroy()
    })

    it('comes back saying so after a wrong password, and then takes the right one', async () => {
      serve(bytes())
      const { archive, prompt } = await openToPrompt('book.cb7')

      const first = prompt(false)
      await first.get('input').setValue('not the password')
      await first.get('button').trigger('click')
      await settled(archive)
      expect(archive.error.value).toMatchObject({ code: 'wrong-password' })
      first.unmount()

      const second = prompt(true)
      await second.get('input').setValue('comic')
      await second.get('button').trigger('click')
      await settled(archive)
      expect(archive.error.value).toBeNull()
      expect(archive.pageCount.value).toBe(4)
      await archive.destroy()
    })
  }
)

describe.each(['rar4.cbr', 'rar4-solid.cbr', 'rar4-headers.cbr', 'rar4-stored.cbr'])(
  'the password prompt, for a RAR (%s), through the real workers and modules',
  (name) => {
    // Everything real from the prompt to the pages: the worker that
    // decrypts the archive, and then unarr's worker reading the result.
    const bytes = () =>
      new Uint8Array(readFileSync(resolve(__dirname, '../fixtures/rar-encrypted', name)))

    beforeEach(() => {
      vi.stubGlobal('Worker', ThreadWorker)
    })
    afterEach(async () => {
      await Promise.all(threads.splice(0).map((thread) => thread.terminate()))
    })

    it('opens the comic when the password is typed and the button is clicked', async () => {
      serve(bytes())
      const shown: Blob[] = []
      vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
        shown.push(blob as Blob)
        return 'blob:page'
      })
      const { archive, prompt } = await openToPrompt('book.cbr')
      const fetchedToAsk = fetched
      const wrapper = prompt(false)

      await wrapper.get('input').setValue('comic')
      await wrapper.get('button').trigger('click')
      await settled(archive)

      expect(archive.error.value).toBeNull()
      expect(archive.pageCount.value).toBe(3)
      expect(await archive.pageUrl(0)).toBe('blob:page')
      const page = new Uint8Array(await shown[0].arrayBuffer())
      expect([...page.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
      expect(fetched).toBe(fetchedToAsk)
      await archive.destroy()
    })

    it('comes back saying so after a wrong password, and then takes the right one', async () => {
      // Two of these four give the decryption nothing to check a password
      // by; for them the wrong one is caught when no page decodes.
      serve(bytes())
      const { archive, prompt } = await openToPrompt('book.cbr')

      const first = prompt(false)
      await first.get('input').setValue('not the password')
      await first.get('button').trigger('click')
      await settled(archive)
      expect(archive.error.value).toMatchObject({ code: 'wrong-password' })
      first.unmount()

      const second = prompt(true)
      await second.get('input').setValue('comic')
      await second.get('button').trigger('click')
      await settled(archive)
      expect(archive.error.value).toBeNull()
      expect(archive.pageCount.value).toBe(3)
      await archive.destroy()
    })
  }
)

