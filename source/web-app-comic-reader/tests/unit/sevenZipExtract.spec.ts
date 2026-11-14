import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExtractLimits, ExtractedEntry } from '../../src/archive/unarrAdapter'

/**
 * The real 7-Zip WebAssembly module and the extraction loop the worker runs,
 * driven here under Node against password-protected 7z fixtures (password
 * "comic"). This is the same file the browser loads, so what passes here is
 * what ships.
 */

type Entry = ExtractedEntry<unknown>
interface Result {
  supported: boolean
  truncated: boolean
  entries: Entry[]
  password?: 'needed' | 'wrong'
}

const vendor = (name: string) => resolve(__dirname, '../../public/vendor/sevenzip', name)
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, '../fixtures', name)))

let extract: (
  bytes: Uint8Array,
  password?: string,
  limits?: Partial<ExtractLimits>,
  store?: (data: Uint8Array) => unknown
) => Promise<Result>
interface Source {
  size: number
  read(position: number, length: number): Uint8Array
  /** Only the decrypters ask for this; the 7z reader does not. */
  slice?(position: number, length: number): Uint8Array | Blob
}
let extractFrom: (source: Source, password?: string) => Promise<Result>
let blobSource: (blob: Blob) => Source

beforeAll(async () => {
  // The module is built from native/sevenzip, not committed. Say so plainly
  // rather than failing on a missing file.
  if (!existsSync(vendor('sevenzip.wasm')) || !existsSync(vendor('sevenzip.mjs'))) {
    throw new Error(
      'The 7-Zip module has not been built. Run `npm run build:native` (needs podman or docker).'
    )
  }
  // Imported by URL so the bundler leaves these plain modules alone.
  const { default: createModule } = await import(
    /* @vite-ignore */ pathToFileURL(vendor('sevenzip.mjs')).href
  )
  const { extractSevenZip, sourceFromBytes, sourceFromBlob } = await import(
    /* @vite-ignore */ pathToFileURL(vendor('sevenzip-extract.mjs')).href
  )
  const limitsWith = (limits: Partial<ExtractLimits>): ExtractLimits => ({
    maxEntryBytes: 1024 * 1024,
    maxEntries: 100,
    maxTotalBytes: 16 * 1024 * 1024,
    maxRetainedBytes: 16 * 1024 * 1024,
    solid: true,
    keepExtensions: ['png', 'jpg'],
    keepNames: ['comicinfo.xml'],
    ...limits
  })
  // A fresh instance per archive, as the worker does. In the browser the
  // module finds its .wasm beside itself; here it is told where the file is.
  const instance = () =>
    createModule({ locateFile: () => vendor('sevenzip.wasm'), printErr: () => {} })
  extract = async (bytes, password, limits = {}, store) =>
    extractSevenZip(await instance(), sourceFromBytes(bytes), limitsWith(limits), { password, store })
  extractFrom = async (source, password) =>
    extractSevenZip(await instance(), source, limitsWith({}), { password })
  blobSource = sourceFromBlob
})

const isPng = (data?: unknown) =>
  data instanceof Uint8Array &&
  data[0] === 0x89 &&
  data[1] === 0x50 &&
  data[2] === 0x4e &&
  data[3] === 0x47

const names = (result: Result) => result.entries.map((entry) => entry.name).sort()
const kept = (result: Result) =>
  result.entries
    .filter((entry) => entry.data)
    .map((entry) => entry.name)
    .sort()

const ALL_NAMES = [
  'Chapter 1/page1.png',
  'Chapter 1/page10.png',
  'Chapter 1/page2.PNG',
  'Chapter 2/page1.jpg',
  'Chapter 2/page2.png',
  'ComicInfo.xml',
  'Thumbs.db',
  '__MACOSX/Chapter 1/._page1.png',
  'notes.txt'
]
/** Pages and ComicInfo; notes.txt and Thumbs.db are listed but not kept. */
const KEPT_NAMES = ALL_NAMES.filter((name) => !['Thumbs.db', 'notes.txt'].includes(name))

describe.each(['sevenzip/encrypted.cb7', 'sevenzip/encrypted-headers.cb7'])(
  '7-Zip extraction of %s',
  (name) => {
    it('decodes every page with the right password', async () => {
      const result = await extract(fixture(name), 'comic')

      expect(result).toMatchObject({ supported: true, truncated: false })
      expect(result.password).toBeUndefined()
      expect(names(result)).toEqual(ALL_NAMES)
      expect(kept(result)).toEqual(KEPT_NAMES)
      const page = result.entries.find((entry) => entry.name === 'Chapter 1/page1.png')
      expect(isPng(page?.data)).toBe(true)
      expect(page?.size).toBe(75)
    })

    it('says a password is needed when there is none, and gives nothing', async () => {
      for (const password of [undefined, '']) {
        const result = await extract(fixture(name), password)
        expect(result).toMatchObject({ supported: true, password: 'needed', entries: [] })
      }
    })

    it('says the password is wrong, and gives nothing', async () => {
      const result = await extract(fixture(name), 'not the password')
      expect(result).toMatchObject({ supported: true, password: 'wrong', entries: [] })
    })
  }
)

describe('7-Zip extraction', () => {
  it('produces the same bytes as the unencrypted archive holds', async () => {
    const plain = await extract(fixture('sample.cb7'))
    const locked = await extract(fixture('sevenzip/encrypted.cb7'), 'comic')
    expect(kept(plain)).toEqual(KEPT_NAMES)
    for (const name of KEPT_NAMES) {
      const expected = plain.entries.find((entry) => entry.name === name)?.data
      expect(locked.entries.find((entry) => entry.name === name)?.data, name).toEqual(expected)
    }
  })

  it('takes a password with characters outside ASCII without mistaking it for the right one', async () => {
    const result = await extract(fixture('sevenzip/encrypted.cb7'), 'cömic 漫画')
    expect(result.password).toBe('wrong')
  })

  it('asks for the password of an archive that is only partly encrypted', async () => {
    // One block without a password, then one with. Half a comic is not
    // offered: without the password the answer is the same as for an
    // archive that is encrypted throughout.
    expect(await extract(fixture('sevenzip/mixed.cb7'))).toMatchObject({
      password: 'needed',
      entries: []
    })
    expect(await extract(fixture('sevenzip/mixed.cb7'), 'not the password')).toMatchObject({
      password: 'wrong',
      entries: []
    })
    const unlocked = await extract(fixture('sevenzip/mixed.cb7'), 'comic')
    expect(unlocked).toMatchObject({ supported: true, truncated: false })
    expect(names(unlocked)).toEqual(ALL_NAMES)
    expect(kept(unlocked)).toEqual(KEPT_NAMES)
  })

  it('reports a file that is not 7z as unsupported, with or without a password', async () => {
    for (const password of [undefined, 'comic']) {
      const result = await extract(fixture('sample.cbz'), password)
      expect(result).toEqual({ supported: false, entries: [], truncated: false })
    }
  })

  it('reads the archive from its source a part at a time, never asking for it whole', async () => {
    const bytes = fixture('sevenzip/encrypted.cb7')
    const asked: number[] = []
    const result = await extractFrom(
      {
        size: bytes.byteLength,
        read(position, length) {
          asked.push(length)
          return bytes.subarray(position, position + length)
        }
      },
      'comic'
    )
    expect(kept(result)).toEqual(KEPT_NAMES)
    expect(asked.length).toBeGreaterThan(1)
    expect(Math.max(...asked)).toBeLessThanOrEqual(bytes.byteLength)
  })

  it('reads a Blob through a window, where the browser can read one synchronously', async () => {
    // Workers have FileReaderSync; Node has not, so one is stood in here
    // over the same bytes. What is checked is the windowing around it.
    const bytes = fixture('sevenzip/encrypted.cb7')
    const slices: Array<[number, number]> = []
    const blob = {
      size: bytes.byteLength,
      slice: (start: number, end: number) => {
        slices.push([start, end])
        return bytes.slice(start, Math.min(end, bytes.byteLength))
      }
    } as unknown as Blob
    vi.stubGlobal(
      'FileReaderSync',
      class {
        readAsArrayBuffer(part: Uint8Array) {
          return part.buffer
        }
      }
    )
    try {
      const result = await extractFrom(blobSource(blob), 'comic')
      expect(kept(result)).toEqual(KEPT_NAMES)
      // The whole fixture fits one window, so few reads of the Blob serve
      // the many small requests 7-Zip makes.
      expect(slices.length).toBeGreaterThan(0)
      expect(slices.length).toBeLessThan(10)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a source that fails to read as that failure, not as an aborted module', async () => {
    const failure = new Error('the file went away')
    await expect(
      extractFrom(
        {
          size: 1000,
          read() {
            throw failure
          }
        },
        'comic'
      )
    ).rejects.toBe(failure)
  })

  it('hands each kept entry to the store hook, and keeps what it returns', async () => {
    const stored: number[] = []
    const result = await extract(fixture('sevenzip/encrypted.cb7'), 'comic', {}, (data) => {
      stored.push(data.byteLength)
      return `blob of ${data.byteLength}`
    })
    expect(stored).toHaveLength(KEPT_NAMES.length)
    expect(result.entries.find((entry) => entry.name === 'ComicInfo.xml')?.data).toBe('blob of 295')
  })
})

describe('7-Zip extraction limits', () => {
  it('lists an oversized entry without keeping it', async () => {
    const result = await extract(fixture('sevenzip/encrypted.cb7'), 'comic', { maxEntryBytes: 76 })
    expect(result.truncated).toBe(false)
    expect(names(result)).toEqual(ALL_NAMES)
    // page10.png (80 bytes) and ComicInfo.xml (295) are over; the rest are 75 or less.
    expect(kept(result)).toEqual(
      KEPT_NAMES.filter((name) => !['Chapter 1/page10.png', 'ComicInfo.xml'].includes(name))
    )
  })

  it('stops keeping entries once the retained budget is spent', async () => {
    const result = await extract(fixture('sevenzip/encrypted.cb7'), 'comic', {
      maxRetainedBytes: 160
    })
    const retained = result.entries
      .filter((entry) => entry.data)
      .reduce((sum, entry) => sum + entry.size, 0)
    expect(retained).toBeGreaterThan(0)
    expect(retained).toBeLessThanOrEqual(160)
    expect(names(result)).toEqual(ALL_NAMES)
  })

  it('stops decoding once the total budget is spent, and says it was cut short', async () => {
    const result = await extract(fixture('sevenzip/encrypted.cb7'), 'comic', { maxTotalBytes: 200 })
    expect(result.truncated).toBe(true)
    expect(result.password).toBeUndefined()
    expect(names(result)).toEqual(ALL_NAMES)
    const decoded = result.entries
      .filter((entry) => entry.data)
      .reduce((sum, entry) => sum + entry.size, 0)
    expect(decoded).toBeLessThanOrEqual(200)
  })

  it('does not mistake a budget spent inside the first encrypted entry for a wrong password', async () => {
    for (const name of ['sevenzip/encrypted.cb7', 'sevenzip/encrypted-headers.cb7']) {
      const result = await extract(fixture(name), 'comic', { maxTotalBytes: 50 })
      expect(result.password, name).toBeUndefined()
      expect(result.truncated, name).toBe(true)
      expect(names(result), name).toEqual(ALL_NAMES)
    }
  })

  it('lists no more entries than the cap, and says it was cut short', async () => {
    const result = await extract(fixture('sevenzip/encrypted.cb7'), 'comic', { maxEntries: 3 })
    expect(result.truncated).toBe(true)
    expect(result.entries.length).toBeLessThanOrEqual(3)
  })
})

describe('7-Zip extraction with a wrong password', () => {
  /** How much of the archive a pass asks its source for. */
  async function bytesRead(name: string, password: string) {
    const bytes = fixture(name)
    let total = 0
    const result = await extractFrom(
      {
        size: bytes.byteLength,
        read(position, length) {
          const part = bytes.subarray(position, position + length)
          total += part.byteLength
          return part
        }
      },
      password
    )
    return { result, total }
  }

  it('tries every block before calling the password wrong', async () => {
    // Forty encrypted pages, each a block of its own, each with a checksum
    // to fail. A failure is a wrong password or a damaged block, and only a
    // block that decodes can say which, so none is left untried: a wrong
    // password costs a pass over the archive, as the right one does.
    const wrong = await bytesRead('sevenzip/many-blocks.cb7', 'not the password')
    const right = await bytesRead('sevenzip/many-blocks.cb7', 'comic')
    expect(wrong.result).toMatchObject({ password: 'wrong', entries: [] })
    expect(kept(right.result)).toHaveLength(40)
    expect(wrong.total).toBeGreaterThan(right.total * 0.9)
  })

  it('stops at the first encrypted block when there is no password to try', async () => {
    const none = await bytesRead('sevenzip/many-blocks.cb7', '')
    const right = await bytesRead('sevenzip/many-blocks.cb7', 'comic')
    expect(none.result).toMatchObject({ password: 'needed', entries: [] })
    expect(none.total).toBeLessThan(right.total / 2)
  })

  /** many-blocks.cb7 with the first `count` of its 80-byte blocks damaged. */
  const damagedBlocks = (count: number) => {
    const bytes = fixture('sevenzip/many-blocks.cb7')
    for (let block = 0; block < count; block++) {
      bytes[32 + block * 80 + 5] ^= 0xff
    }
    return bytes
  }

  it('does not take damage at the front for a wrong password while later blocks still open', async () => {
    const result = await extract(damagedBlocks(2), 'comic')
    expect(result.password).toBeUndefined()
    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(40)
    expect(kept(result)).toHaveLength(38)
  })

  it('opens with the right password however many blocks at the front are damaged', async () => {
    const result = await extract(damagedBlocks(30), 'comic')
    expect(result.password).toBeUndefined()
    expect(kept(result)).toHaveLength(10)
  })

  it('cannot tell an archive damaged throughout from a wrong password', async () => {
    // The limit of it: 7z has nothing else to go by.
    expect((await extract(damagedBlocks(40), 'comic')).password).toBe('wrong')
  })
})

describe('reading the archive from a Blob', () => {
  // The stand-in for FileReaderSync and Blob that the Node tests use; what
  // is under test is the window kept over them.
  const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 123 }, (_, index) => (index * 7 + (index >> 9)) & 0xff)
  let slices: Array<[number, number]>
  let source: Source

  beforeEach(() => {
    slices = []
    vi.stubGlobal(
      'FileReaderSync',
      class {
        readAsArrayBuffer(part: Uint8Array) {
          return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)
        }
      }
    )
    source = blobSource({
      size: bytes.byteLength,
      slice: (start: number, end: number) => {
        slices.push([start, end])
        return bytes.subarray(start, end)
      }
    } as unknown as Blob)
  })
  afterEach(() => vi.unstubAllGlobals())

  const expectBytes = (position: number, length: number) =>
    expect([...source.read(position, length)]).toEqual([
      ...bytes.subarray(position, position + length)
    ])

  it('serves small forward reads from one window', () => {
    for (let position = 0; position < 4096; position += 512) {
      expectBytes(position, 512)
    }
    expect(slices).toHaveLength(1)
  })

  it('reads again for a request that crosses the end of the window', () => {
    expectBytes(0, 16)
    expectBytes(1024 * 1024 - 8, 16)
    expect(slices).toHaveLength(2)
  })

  it('keeps what the window already holds of a request that runs past its end', () => {
    // A header and then the data after it: the usual order when decrypting.
    source.read(0, 30)
    const wanted = source.read(1000, 1024 * 1024)
    // (Compared as buffers: element by element is slow over a megabyte.)
    expect(Buffer.compare(wanted, bytes.subarray(1000, 1000 + 1024 * 1024))).toBe(0)
    // The second read of the Blob starts where the first ended.
    expect(slices.map(([start]) => start)).toEqual([0, 1024 * 1024])
    // And the window now starts at the request, and still serves what follows it.
    expect(source.read(1000 + 1024 * 1024, 50)).toEqual(
      bytes.subarray(1000 + 1024 * 1024, 1050 + 1024 * 1024)
    )
    expect(slices).toHaveLength(2)
  })

  it('hands out a stretch of the Blob without reading it', () => {
    slices.length = 0
    expect(source.slice?.(5, 10)).toEqual(bytes.subarray(5, 15))
    expect(slices).toEqual([[5, 15]])
  })

  it('reads again for a request before the window', () => {
    expectBytes(2 * 1024 * 1024, 16)
    expectBytes(100, 16)
    expectBytes(2 * 1024 * 1024, 16)
    expect(slices).toHaveLength(3)
  })

  it('returns all of a request larger than the window', () => {
    expectBytes(5, 2 * 1024 * 1024)
  })

  it('returns what there is at the end, and nothing past it', () => {
    expect(source.read(bytes.byteLength - 10, 64)).toHaveLength(10)
    expect(source.read(bytes.byteLength, 64)).toHaveLength(0)
    expect(source.read(bytes.byteLength + 1000, 64)).toHaveLength(0)
    expect(source.read(0, 0)).toHaveLength(0)
  })
})

describe('7-Zip extraction when something goes wrong outside 7-Zip', () => {
  it('reports what a hook threw, not an aborted module', async () => {
    // The hooks run inside 7-Zip, which must not be unwound through. Running
    // out of memory while making a page's Blob is the real case.
    const failure = new Error('no memory for this page')
    await expect(
      extract(fixture('sevenzip/encrypted.cb7'), 'comic', {}, () => {
        throw failure
      })
    ).rejects.toBe(failure)
  })

  it('answers an absurdly long password as wrong, without starting the decoder on it', async () => {
    const started = Date.now()
    const result = await extract(fixture('sevenzip/encrypted.cb7'), 'x'.repeat(100_000))
    expect(result).toMatchObject({ supported: true, password: 'wrong', entries: [] })
    // Deriving a key from it would take far longer than this.
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('treats damage after encrypted headers have opened as damage, not as a wrong password', async () => {
    // The headers carry a checksum, so opening them proved the password.
    const damaged = fixture('sevenzip/encrypted-headers.cb7')
    damaged[40] ^= 0xff
    const result = await extract(damaged, 'comic')
    expect(result.password).toBeUndefined()
    expect(result.truncated).toBe(true)
    expect(names(result)).toEqual(ALL_NAMES)
  })
})

describe('7-Zip extraction of an archive that records no checksums', () => {
  // 7-Zip never writes one; scripts/make-sevenzip-nocrc-fixture.mjs does.
  // With nothing to check against, 7-Zip reports success for any password,
  // and the loop goes by whether what came out looks like pages. Forty of
  // them, so that one piece of noise that happens to look like an image
  // does not carry the day.

  it('opens with the right password', async () => {
    const result = await extract(fixture('sevenzip/no-checksums.cb7'), 'comic')
    expect(result).toMatchObject({ supported: true, truncated: false })
    expect(result.password).toBeUndefined()
    expect(kept(result)).toHaveLength(40)
    expect(result.entries.every((entry) => isPng(entry.data))).toBe(true)
  })

  it.each(['not the password', 'Comic', 'comic '])(
    'still calls a wrong password (%j) wrong, going by what came out',
    async (password) => {
      const result = await extract(fixture('sevenzip/no-checksums.cb7'), password)
      expect(result).toMatchObject({ supported: true, password: 'wrong', entries: [] })
    }
  )

  it('asks for a password when there is none', async () => {
    const result = await extract(fixture('sevenzip/no-checksums.cb7'))
    expect(result).toMatchObject({ supported: true, password: 'needed', entries: [] })
  })

  it('opens when most pages, though not all, are what they are named as', async () => {
    // Ten of the forty hold text under a .png name.
    const result = await extract(fixture('sevenzip/no-checksums-some-other.cb7'), 'comic')
    expect(result.password).toBeUndefined()
    expect(kept(result)).toHaveLength(40)

    const wrong = await extract(fixture('sevenzip/no-checksums-some-other.cb7'), 'not it')
    expect(wrong.password).toBe('wrong')
  })

  it('does not take an empty entry for proof of a password', async () => {
    // One empty file with a checksum (of nothing) at the head of an
    // encrypted block: 7-Zip passes it without decrypting a byte.
    const name = 'sevenzip/no-checksums-empty-entry.cb7'
    expect(await extract(fixture(name))).toMatchObject({ password: 'needed', entries: [] })
    expect(await extract(fixture(name), 'not it')).toMatchObject({ password: 'wrong', entries: [] })

    const right = await extract(fixture(name), 'comic')
    expect(right.password).toBeUndefined()
    expect(kept(right)).toHaveLength(6)
  })

  it('cannot tell the right password when most pages are not images at all', async () => {
    // Thirty of forty hold text. Nothing distinguishes this from noise, and
    // the cautious answer is given: the limit of judging by content.
    const result = await extract(fixture('sevenzip/no-checksums-mostly-other.cb7'), 'comic')
    expect(result.password).toBe('wrong')
  })
})
