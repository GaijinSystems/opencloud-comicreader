import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, configure } from '@zip.js/zip.js'
import type { Resource } from '@opencloud-eu/web-client'

import { ComicReaderError, encryptedError } from '../../src/archive/types'
import {
  asBzip2,
  lockedZip,
  makeAdapter,
  openComicOptions,
  PIXEL,
  serveBytes,
  ZIP_SCHEMES
} from './helpers/fakes'
import { syntheticRar4 } from './helpers/rar4Builder'
import { shutdownZipWorkers } from '../../src/archive/zipAdapter'

/**
 * Password-protected comics through openComic. The zips are real, written
 * here and read by zip.js. For 7z both decoders are stand-ins: what is
 * checked is which one is asked, with what, and what the reader is told.
 */

const libarchiveOpen = vi.fn()
const sevenZipOpen = vi.fn()

vi.mock('../../src/archive/libarchiveAdapter', () => ({
  LibArchiveAdapter: { open: (...args: unknown[]) => libarchiveOpen(...args) }
}))
const decrypt = vi.fn()
vi.mock('../../src/archive/sevenZipAdapter', () => ({
  openSevenZip: (...args: unknown[]) => sevenZipOpen(...args),
  decryptArchive: (...args: unknown[]) => decrypt(...args)
}))
const unarrOpen = vi.fn()
vi.mock('../../src/archive/unarrAdapter', () => ({
  UnarrAdapter: { open: (...args: unknown[]) => unarrOpen(...args) }
}))
let wasmAllowed = true
vi.mock('../../src/helpers/wasm', async (original) => ({
  ...(await original<typeof import('../../src/helpers/wasm')>()),
  checkWasmAllowed: async () => wasmAllowed
}))

const { openComic, PasswordError } = await import('../../src/archive/openArchive')

configure({ useWebWorkers: false })



/** 7z signature followed by filler: enough for format detection. */
const sevenZipBytes = () => {
  const bytes = new Uint8Array(64)
  bytes.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
  return bytes
}
/** RAR5 signature followed by filler. */
const rar5Bytes = () => {
  const bytes = new Uint8Array(64)
  bytes.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
  return bytes
}

const encrypted = encryptedError
const named = (name: string) => ({ resource: { name, size: 0 } as unknown as Resource })

let fetched: number
function serve(bytes: Uint8Array) {
  fetched = 0
  serveBytes(bytes, () => fetched++)
}

/** Runs openComic and returns what it threw. */
async function failure(options: Parameters<typeof openComicOptions>[0]) {
  try {
    const opened = await openComic(openComicOptions(options))
    await opened.adapter.close()
  } catch (error) {
    return error as InstanceType<typeof PasswordError>
  }
  throw new Error('openComic did not fail')
}

beforeEach(() => {
  wasmAllowed = true
  libarchiveOpen.mockReset()
  sevenZipOpen.mockReset()
  decrypt.mockReset()
  unarrOpen.mockReset()
})
afterEach(() => vi.unstubAllGlobals())
afterAll(async () => {
  await shutdownZipWorkers()
})

describe.each(ZIP_SCHEMES)('openComic: a zip protected with %s', (_scheme, zipOptions) => {
  it('asks for a password, then opens with it without fetching the comic again', async () => {
    serve(await lockedZip(zipOptions))

    const asked = await failure({})
    expect(asked).toBeInstanceOf(PasswordError)
    expect(asked.code).toBe('password-required')
    const fetchedToAsk = fetched

    const opened = await openComic(
      openComicOptions({ password: 'comic', resolved: asked.resolved })
    )
    try {
      expect(fetched).toBe(fetchedToAsk)
      expect(opened.pages.map((page) => page.name)).toEqual(['p1.png', 'p2.png'])
      const page = new Uint8Array(await (await opened.adapter.readEntry(1)).arrayBuffer())
      expect(page).toEqual(PIXEL)
      expect(opened.resolved).toBe(asked.resolved)
    } finally {
      await opened.adapter.close()
    }
  })

  it('treats an empty password as none', async () => {
    serve(await lockedZip(zipOptions))
    expect((await failure({ password: '' })).code).toBe('password-required')
  })
})

describe('openComic: a password-protected zip', () => {
  it('says so when the password is wrong, and can be asked again', async () => {
    // AES: its check value is two bytes, so a wrong password is caught here
    // and not left to show up as unreadable pages.
    serve(await lockedZip({ encryptionStrength: 3 }))

    const wrong = await failure({ password: 'not the password' })
    expect(wrong).toBeInstanceOf(PasswordError)
    expect(wrong.code).toBe('wrong-password')

    const opened = await openComic(
      openComicOptions({ password: 'comic', resolved: wrong.resolved })
    )
    await opened.adapter.close()
    expect(opened.pages).toHaveLength(2)
  })

  it('treats the same failure as one damaged page once the password has opened another', async () => {
    // The right password, and one page it does not open (here, a page under
    // a different password; a damaged page looks the same). The comic must
    // stay open: sending it back to the prompt would lock the reader out of
    // the pages it can read, however often the right password was typed.
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add('p1.png', new Uint8ArrayReader(PIXEL), { password: 'comic', encryptionStrength: 3 })
    await writer.add('p2.png', new Uint8ArrayReader(PIXEL), { password: 'other', encryptionStrength: 3 })
    await writer.add('p3.png', new Uint8ArrayReader(PIXEL), { password: 'comic', encryptionStrength: 3 })
    serve(await writer.close())

    const opened = await openComic(openComicOptions({ password: 'comic' }))
    try {
      expect(new Uint8Array(await (await opened.adapter.readEntry(0)).arrayBuffer())).toEqual(PIXEL)
      await expect(opened.adapter.readEntry(1)).rejects.toMatchObject({ code: 'corrupt' })
      expect(new Uint8Array(await (await opened.adapter.readEntry(2)).arrayBuffer())).toEqual(PIXEL)
    } finally {
      await opened.adapter.close()
    }
  })

  it('is not fooled by a wrong password that gets past the old zip scheme\'s one-byte check', async () => {
    // One stored (uncompressed) ZipCrypto page: its one-byte check lets
    // about one wrong password in 256 through, and such a password turns
    // the page into noise without any decoding error. With too little to go
    // by, the page is decoded at open and its checksum compared.
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      password: 'comic',
      zipCrypto: true,
      level: 0
    })
    await writer.add('p1.png', new Uint8ArrayReader(new Uint8Array(200).fill(7)))
    serve(await writer.close())

    // Enough attempts that several get past the check byte.
    for (let attempt = 0; attempt < 1500; attempt++) {
      const code = await openComic(openComicOptions({ password: `wrong ${attempt}` })).then(
        async (opened) => {
          await opened.adapter.close()
          return 'opened'
        },
        (error: ComicReaderError) => error.code
      )
      expect(code, `wrong ${attempt}`).toBe('wrong-password')
    }

    const opened = await openComic(openComicOptions({ password: 'comic' }))
    await opened.adapter.close()
    expect(opened.pages).toHaveLength(1)
  })

  it.each(['Ep', 'pE', 'EEEpp', 'pEE'])(
    'does not take an empty entry for proof of a password (%s)',
    async (layout) => {
      // "E" is an empty encrypted entry, which holds nothing to decrypt and
      // so accepts any password; "p" a stored page. Were the empty ones
      // counted, any password at all would open the comic and be called
      // proved.
      const writer = new ZipWriter(new Uint8ArrayWriter(), {
        password: 'comic',
        zipCrypto: true,
        level: 0
      })
      for (const [index, kind] of [...layout].entries()) {
        await writer.add(
          `p${index + 1}.png`,
          new Uint8ArrayReader(kind === 'E' ? new Uint8Array(0) : new Uint8Array(200).fill(7))
        )
      }
      serve(await writer.close())

      for (let attempt = 0; attempt < 300; attempt++) {
        const code = await openComic(openComicOptions({ password: `wrong ${attempt}` })).then(
          async (opened) => {
            await opened.adapter.close()
            return 'opened'
          },
          (error: ComicReaderError) => error.code
        )
        expect(code, `wrong ${attempt}`).toBe('wrong-password')
      }
      const opened = await openComic(openComicOptions({ password: 'comic' }))
      await opened.adapter.close()
      expect(opened.pages).toHaveLength(layout.length)
    }
  )

  it.each([
    ['ZipCrypto', { zipCrypto: true }, 'occ'],
    ['ZipCrypto', { zipCrypto: true }, 'cco'],
    ['ZipCrypto', { zipCrypto: true }, 'coc'],
    ['ZipCrypto', { zipCrypto: true }, 'oc'],
    ['ZipCrypto', { zipCrypto: true }, 'co'],
    ['AES-256', { encryptionStrength: 3 }, 'oc'],
    ['AES-256', { encryptionStrength: 3 }, 'co']
  ])(
    'opens for good with the right password when one %s page refuses it (%s %s)',
    async (_scheme, scheme, layout) => {
      // "c" pages are under the comic's password, the "o" page under
      // another, standing in for a damaged one. The comic must open, stay
      // open, and show the odd page as unreadable: sent back to the prompt
      // by it, the reader could never get past it.
      const writer = new ZipWriter(new Uint8ArrayWriter())
      for (const [index, kind] of [...layout].entries()) {
        await writer.add(`p${index + 1}.png`, new Uint8ArrayReader(PIXEL), {
          ...(scheme as Record<string, unknown>),
          password: kind === 'c' ? 'comic' : 'other'
        })
      }
      serve(await writer.close())

      const opened = await openComic(openComicOptions({ password: 'comic' }))
      try {
        // The odd page first, as a cover or a resumed position would be.
        const odd = layout.indexOf('o')
        await expect(opened.adapter.readEntry(odd)).rejects.toMatchObject({ code: 'corrupt' })
        const good = layout.indexOf('c')
        expect(new Uint8Array(await (await opened.adapter.readEntry(good)).arrayBuffer())).toEqual(
          PIXEL
        )
      } finally {
        await opened.adapter.close()
      }
    }
  )

  it('is not put off by one page that turns the right password away', async () => {
    // A page under another password stands in for a damaged one. It is
    // outvoted at open, the password counts as proved, and reading it is
    // that page's failure, not a reason to ask again.
    const writer = new ZipWriter(new Uint8ArrayWriter())
    const add = (name: string, password: string) =>
      writer.add(name, new Uint8ArrayReader(PIXEL), { password, encryptionStrength: 3 })
    await add('p1.png', 'other')
    await add('p2.png', 'comic')
    await add('p3.png', 'comic')
    serve(await writer.close())

    const opened = await openComic(openComicOptions({ password: 'comic' }))
    try {
      await expect(opened.adapter.readEntry(0)).rejects.toMatchObject({ code: 'corrupt' })
      expect(new Uint8Array(await (await opened.adapter.readEntry(1)).arrayBuffer())).toEqual(PIXEL)
    } finally {
      await opened.adapter.close()
    }
  })

  it('refuses a password that most of the pages asked turn away', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter())
    const add = (name: string, password: string) =>
      writer.add(name, new Uint8ArrayReader(PIXEL), { password, encryptionStrength: 3 })
    await add('p1.png', 'comic')
    await add('p2.png', 'other')
    await add('p3.png', 'other')
    serve(await writer.close())

    expect((await failure({ password: 'comic' })).code).toBe('wrong-password')
  })

  const pageAdapter = () =>
    makeAdapter({
      listEntries: () => [
        { index: 0, name: 'p1.png', size: 4, isDirectory: false },
        { index: 1, name: 'p2.png', size: 4, isDirectory: false }
      ]
    })

  describe('with pages in a compression method zip.js cannot decode', () => {
    const NAMES = ['p1.png', 'p2.png']

    it('hands a zip in the old encryption to libarchive, with the password', async () => {
      serve(asBzip2(await lockedZip({ zipCrypto: true }), NAMES))
      libarchiveOpen.mockResolvedValue(pageAdapter())

      expect((await failure({})).code).toBe('password-required')
      expect(libarchiveOpen).not.toHaveBeenCalled()

      const opened = await openComic(openComicOptions({ password: 'comic' }))
      expect(opened.pages.map((page) => page.name)).toEqual(NAMES)
      const handedOver = libarchiveOpen.mock.calls[0][1]
      expect(handedOver).toMatchObject({ format: 'cbz', password: 'comic' })
      // With what libarchive needs to be held to: each encrypted entry's
      // checksum, and whether zip.js had already proved the password (it
      // had nothing it could decode to prove it by).
      expect([...handedOver.encryptedEntries.keys()]).toEqual(NAMES)
      expect(typeof handedOver.encryptedEntries.get('p1.png')).toBe('number')
      expect(handedOver.passwordProven).toBe(false)
      // libarchive decrypts these as they are read: a later page may yet
      // turn the password away.
      expect(opened.passwordSettled).toBe(false)
    })

    it('hands it over when only some pages need it, too', async () => {
      // The password is checked by zip.js against the page it can decode.
      serve(asBzip2(await lockedZip({ zipCrypto: true }), ['p1.png']))
      libarchiveOpen.mockResolvedValue(pageAdapter())

      const opened = await openComic(openComicOptions({ password: 'comic' }))
      expect(opened.warning).toBeNull()
      expect(libarchiveOpen.mock.calls[0][1]).toMatchObject({ password: 'comic' })

      expect((await failure({ password: 'not it' })).code).toBe('wrong-password')
    })

    it('asks again when libarchive is the one to find the password wrong', async () => {
      // Nothing zip.js could check it against: every entry is bzip2.
      serve(asBzip2(await lockedZip({ zipCrypto: true }), NAMES))
      libarchiveOpen.mockResolvedValue(
        makeAdapter({
          listEntries: () => [
            { index: 0, name: 'p1.png', size: 4, isDirectory: false },
            { index: 1, name: 'ComicInfo.xml', size: 40, isDirectory: false }
          ],
          readText: async () => {
            throw encrypted()
          }
        })
      )
      expect((await failure({ password: 'not it' })).code).toBe('wrong-password')
    })

    it('reports why the hand-over failed when it does and no page is readable', async () => {
      serve(asBzip2(await lockedZip({ zipCrypto: true }), NAMES))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      libarchiveOpen.mockRejectedValue(
        new ComicReaderError('backend-unavailable', 'The archive decoder stopped responding.')
      )
      expect((await failure({ password: 'comic' })).code).toBe('backend-unavailable')
      vi.restoreAllMocks()
    })

    it('decrypts an AES zip first, and hands libarchive the result with checksums off', async () => {
      // libarchive cannot undo AES. The entries are decrypted, and what it
      // gets is the zip without them encrypted.
      serve(asBzip2(await lockedZip({ encryptionStrength: 3 }), NAMES))
      const plain = new Blob(['the zip, decrypted'])
      decrypt.mockResolvedValue({ archive: plain, proven: true, unchecked: true })
      libarchiveOpen.mockResolvedValue(pageAdapter())

      const opened = await openComic(openComicOptions({ password: 'comic' }))
      expect(opened.pages.map((page) => page.name)).toEqual(NAMES)
      // Every entry was decrypted and authenticated: nothing is left to ask.
      expect(opened.passwordSettled).toBe(true)
      expect(decrypt.mock.calls[0][1]).toMatchObject({ format: 'zip', password: 'comic' })
      const [source, handedOver] = libarchiveOpen.mock.calls[0]
      expect(source).toMatchObject({ kind: 'blob', data: plain })
      // The authentication codes proved the password and stand in for the
      // checksums, which this kind of entry may not have.
      expect(handedOver).toMatchObject({ uncheckedZip: true, passwordProven: true })
      expect(handedOver.encryptedEntries).toBeUndefined()
    })

    it('asks again when decrypting an AES zip finds the password wrong', async () => {
      serve(asBzip2(await lockedZip({ encryptionStrength: 3 }), NAMES))
      decrypt.mockRejectedValue(encrypted())
      expect((await failure({ password: 'comic' })).code).toBe('wrong-password')
      expect(libarchiveOpen).not.toHaveBeenCalled()
    })

    it('says why when an AES zip cannot be decrypted, and no page is readable', async () => {
      serve(asBzip2(await lockedZip({ encryptionStrength: 3 }), NAMES))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      decrypt.mockRejectedValue(new ComicReaderError('corrupt', 'a zip in several parts'))
      const refused = await failure({ password: 'comic' })
      expect(refused.code).toBe('corrupt')
      expect(refused.message).toMatch(/several parts/)
      vi.restoreAllMocks()
    })

    it('does not ask again for a password zip.js has proved, when decrypting then refuses it', async () => {
      // One page zip.js decodes, which proves the password. The other is
      // for libarchive; its authentication failing is damage, not a wrong
      // password, and asking again would never end.
      serve(asBzip2(await lockedZip({ encryptionStrength: 3 }), ['p2.png']))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      decrypt.mockRejectedValue(encrypted())

      const opened = await openComic(openComicOptions({ password: 'comic' }))
      expect(opened.pages).toHaveLength(2)
      expect(opened.warning).toMatchObject({ code: 'unsupported-compression', count: 1 })
      expect(libarchiveOpen).not.toHaveBeenCalled()
      vi.restoreAllMocks()
    })

    it('hands an AES zip over when only some pages need it, too', async () => {
      serve(asBzip2(await lockedZip({ encryptionStrength: 3 }), ['p1.png']))
      decrypt.mockResolvedValue({ archive: new Blob(['plain']), proven: true, unchecked: false })
      libarchiveOpen.mockResolvedValue(pageAdapter())

      const opened = await openComic(openComicOptions({ password: 'comic' }))
      expect(opened.warning).toBeNull()
      // Entries that all kept their checksums are still held to them.
      expect(libarchiveOpen.mock.calls[0][1]).toMatchObject({ uncheckedZip: false })
    })
  })
})

describe('openComic: a password-protected 7z', () => {
  const page = () =>
    makeAdapter({
      format: 'cb7',
      listEntries: () => [{ index: 0, name: 'p1.png', size: 4, isDirectory: false }]
    })

  it('asks for a password when libarchive finds it encrypted, without trying 7-Zip', async () => {
    serve(sevenZipBytes())
    libarchiveOpen.mockRejectedValue(encrypted())

    const asked = await failure(named('book.cb7'))
    expect(asked).toBeInstanceOf(PasswordError)
    expect(asked.code).toBe('password-required')
    expect(asked.resolved.format).toBe('cb7')
    expect(sevenZipOpen).not.toHaveBeenCalled()
  })

  it('asks when the encryption only shows on reading ComicInfo.xml', async () => {
    serve(sevenZipBytes())
    libarchiveOpen.mockResolvedValue(
      makeAdapter({
        format: 'cb7',
        listEntries: () => [
          { index: 0, name: 'p1.png', size: 4, isDirectory: false },
          { index: 1, name: 'ComicInfo.xml', size: 40, isDirectory: false }
        ],
        readText: async () => {
          throw encrypted()
        }
      })
    )
    expect((await failure(named('book.cb7'))).code).toBe('password-required')
  })

  it('opens with 7-Zip once it has a password, without libarchive and without fetching again', async () => {
    serve(sevenZipBytes())
    libarchiveOpen.mockRejectedValue(encrypted())
    const asked = await failure(named('book.cb7'))
    const fetchedToAsk = fetched
    libarchiveOpen.mockClear()
    sevenZipOpen.mockResolvedValue(page())

    const opened = await openComic(
      openComicOptions({ ...named('book.cb7'), password: 'comic', resolved: asked.resolved })
    )

    expect(opened.pages.map((entry) => entry.name)).toEqual(['p1.png'])
    expect(fetched).toBe(fetchedToAsk)
    expect(libarchiveOpen).not.toHaveBeenCalled()
    const [archive, options] = sevenZipOpen.mock.calls[0]
    expect(archive).toBeInstanceOf(Blob)
    expect(options).toMatchObject({
      password: 'comic',
      maxEntryBytes: 1024 * 1024,
      maxEntries: 400,
      // bulkExtractLimitMb (16) x 1 MiB x the expansion limit (4)
      maxRetainedBytes: 16 * 1024 * 1024 * 4
    })
  })

  it('asks again when 7-Zip does not open it with the password', async () => {
    serve(sevenZipBytes())
    sevenZipOpen.mockRejectedValue(encrypted())
    const wrong = await failure({ ...named('book.cb7'), password: 'nope' })
    expect(wrong).toBeInstanceOf(PasswordError)
    expect(wrong.code).toBe('wrong-password')
  })

  it('reports a decoder that could not help as a failure, not as a wrong password', async () => {
    serve(sevenZipBytes())
    sevenZipOpen.mockResolvedValue(null)
    expect((await failure({ ...named('book.cb7'), password: 'comic' })).code).toBe('corrupt')
  })

  it('says WebAssembly is blocked when it is, without starting the decoder', async () => {
    serve(sevenZipBytes())
    wasmAllowed = false
    const error = await failure({ ...named('book.cb7'), password: 'comic' })
    expect(error.code).toBe('backend-unavailable')
    expect(sevenZipOpen).not.toHaveBeenCalled()
  })
})

describe('openComic: a password-protected RAR', () => {
  const pages = () =>
    makeAdapter({
      format: 'cbr',
      listEntries: () => [{ index: 0, name: 'p1.png', size: 4, isDirectory: false }]
    })
  /** What a decrypted RAR4 looks like to the header walk: a RAR4, not encrypted. */
  const rar4Bytes = () => syntheticRar4()

  it('asks for a password, like any other format, whatever the file is called', async () => {
    serve(rar5Bytes())
    libarchiveOpen.mockRejectedValue(encrypted())

    for (const name of ['book.cbr', 'book.cb7']) {
      const asked = await failure(named(name))
      expect(asked).toBeInstanceOf(PasswordError)
      expect(asked.code).toBe('password-required')
    }
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('decrypts with the password first, and gives the result to libarchive', async () => {
    serve(rar5Bytes())
    const plain = new Blob([rar5Bytes()])
    decrypt.mockResolvedValue({ archive: plain, proven: true })
    libarchiveOpen.mockResolvedValue(pages())

    const opened = await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))
    expect(opened.pages.map((page) => page.name)).toEqual(['p1.png'])
    expect(decrypt.mock.calls[0][1]).toMatchObject({ format: 'rar', password: 'comic' })
    expect(libarchiveOpen.mock.calls[0][0]).toMatchObject({ kind: 'blob', data: plain })
    expect(sevenZipOpen).not.toHaveBeenCalled()
  })

  it('asks again when decrypting finds the password wrong', async () => {
    serve(rar5Bytes())
    decrypt.mockRejectedValue(encrypted())
    const wrong = await failure({ ...named('book.cbr'), password: 'nope' })
    expect(wrong).toBeInstanceOf(PasswordError)
    expect(wrong.code).toBe('wrong-password')
    expect(libarchiveOpen).not.toHaveBeenCalled()
  })

  it('reads on as usual when the archive turns out not to be encrypted', async () => {
    serve(rar5Bytes())
    decrypt.mockResolvedValue({ archive: null, proven: true })
    libarchiveOpen.mockResolvedValue(pages())

    const opened = await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))
    expect(opened.pages).toHaveLength(1)
    expect(libarchiveOpen.mock.calls[0][0].data).not.toBeUndefined()
  })

  it('sends a decrypted RAR4 to unarr, told to step over the padding, and judges the password by what decodes', async () => {
    // RAR before version 5 keeps nothing to check a password by: it is
    // judged by what decodes. (This stand-in does not say how each entry
    // came out, as unarr does, so its pages are read; the test after next
    // covers the outcomes unarr reports.)
    serve(rar4Bytes())
    decrypt.mockResolvedValue({ archive: new Blob([rar4Bytes() as BlobPart]), proven: false })

    unarrOpen.mockResolvedValue(pages())
    const opened = await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))
    expect(opened.pages).toHaveLength(1)
    expect(opened.passwordSettled).toBe(true)
    expect(unarrOpen.mock.calls[0][1]).toMatchObject({ decrypted: true })
    expect(libarchiveOpen).not.toHaveBeenCalled()

    const close = vi.fn(async () => {})
    unarrOpen.mockResolvedValue({
      ...pages(),
      close,
      readEntry: async () => {
        throw new ComicReaderError('page-unavailable', 'noise')
      }
    })
    const wrong = await failure({ ...named('book.cbr'), password: 'nope' })
    expect(wrong.code).toBe('wrong-password')
    expect(close).toHaveBeenCalled()
  })

  it('does not call an unconfirmed password wrong while any page reads', async () => {
    serve(rar5Bytes())
    decrypt.mockResolvedValue({ archive: new Blob([rar5Bytes()]), proven: false })
    const entries = [1, 2, 3, 4].map((number, index) => ({
      index,
      name: `p${number}.png`,
      size: 4,
      isDirectory: false
    }))
    const read: number[] = []
    const reading = (readable: (index: number) => boolean) =>
      makeAdapter({
        listEntries: () => entries,
        readEntry: async (index: number) => {
          read.push(index)
          if (!readable(index)) {
            throw new ComicReaderError('corrupt', 'noise')
          }
          return new Blob(['page'])
        }
      })

    libarchiveOpen.mockResolvedValue(reading((index) => index === 1))
    const opened = await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))
    expect(opened.pages).toHaveLength(4)
    expect(read).toEqual([0, 1])

    // However many fail first: the last page reading is enough.
    read.length = 0
    libarchiveOpen.mockResolvedValue(reading((index) => index === 3))
    expect((await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))).pages).toHaveLength(4)
    expect(read).toEqual([0, 1, 2, 3])

    // None reading is what a wrong password looks like.
    libarchiveOpen.mockResolvedValue(reading(() => false))
    expect((await failure({ ...named('book.cbr'), password: 'nope' })).code).toBe('wrong-password')
  })

  it('judges an unconfirmed password by the pages that were encrypted, not by one that never was', async () => {
    // A cover left unencrypted reads under any password.
    serve(rar5Bytes())
    const entries = [1, 2, 3].map((number, index) => ({
      index,
      name: `p${number}.png`,
      size: 4,
      isDirectory: false
    }))
    const onlyCoverReads = () =>
      makeAdapter({
        listEntries: () => entries,
        readEntry: async (index: number) => {
          if (index !== 0) {
            throw new ComicReaderError('corrupt', 'noise')
          }
          return new Blob(['cover'])
        }
      })
    const decrypted = (encryptedEntries: { of: number; at: number[]; mismatched?: number[] }) => ({
      archive: new Blob([rar5Bytes()]),
      proven: false,
      unchecked: false,
      encryptedEntries
    })

    decrypt.mockResolvedValue(decrypted({ of: 3, at: [1, 2] }))
    libarchiveOpen.mockResolvedValue(onlyCoverReads())
    expect((await failure({ ...named('book.cbr'), password: 'nope' })).code).toBe('wrong-password')

    // A decoder that lists the archive differently cannot be matched up:
    // every page is then tried.
    decrypt.mockResolvedValue(decrypted({ of: 5, at: [1, 2] }))
    libarchiveOpen.mockResolvedValue(onlyCoverReads())
    expect((await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))).pages).toHaveLength(3)
  })

  it('judges by how each entry decoded, where the decoder says, and by none that was not tried', async () => {
    // unarr decodes the whole archive and reports each entry: decoded,
    // damaged, or not tried because a limit came first.
    serve(rar4Bytes())
    const entries = ['cover.png', 'notes.txt', 'p1.png', 'p2.png'].map((name, index) => ({
      index,
      name,
      size: 4,
      isDirectory: false
    }))
    const came = (outcomes: Array<boolean | undefined>) => {
      decrypt.mockResolvedValue({
        archive: new Blob([rar4Bytes() as BlobPart]),
        proven: false,
        unchecked: false,
        encryptedEntries: { of: 4, at: [1, 2, 3], mismatched: [] }
      })
      unarrOpen.mockResolvedValue(
        makeAdapter({ format: 'cbr', listEntries: () => entries, decodeOutcomes: () => outcomes })
      )
      return openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' })).then(
        () => 'opened',
        (error) => error.code
      )
    }
    // The cover never was encrypted: that it decoded says nothing.
    expect(await came([true, false, false, false])).toBe('wrong-password')
    // In a solid archive the first failure ends the pass. An entry that is
    // not a page counts as much as one that is.
    expect(await came([true, false, undefined, undefined])).toBe('wrong-password')
    // One encrypted entry that decoded is enough, whatever else is damaged.
    expect(await came([false, false, false, true])).toBe('opened')
    expect(await came([true, true, false, false])).toBe('opened')
    // Nothing tried (a limit came first) is not a wrong password.
    expect(await came([true, undefined, undefined, undefined])).toBe('opened')
  })

  it('counts a stored entry that did not match its checksum as a failure, without reading it', async () => {
    // The decrypter has compared it already. (The stand-in here would read anything.)
    serve(rar5Bytes())
    const entries = [1, 2].map((number, index) => ({ index, name: `p${number}.png`, size: 400, isDirectory: false }))
    const readsAnything = () => makeAdapter({ listEntries: () => entries })
    const decrypted = (mismatched: number[]) => ({
      archive: new Blob([rar5Bytes()]),
      proven: false,
      unchecked: false,
      encryptedEntries: { of: 2, at: [0, 1], mismatched }
    })

    decrypt.mockResolvedValue(decrypted([0, 1]))
    libarchiveOpen.mockResolvedValue(readsAnything())
    expect((await failure({ ...named('book.cbr'), password: 'nope' })).code).toBe('wrong-password')

    // One that did match, or could not be checked, still carries it.
    decrypt.mockResolvedValue(decrypted([0]))
    libarchiveOpen.mockResolvedValue(readsAnything())
    expect((await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))).pages).toHaveLength(2)
  })

  it('closes the decoder when the open is cancelled while pages are being tried', async () => {
    serve(rar5Bytes())
    decrypt.mockResolvedValue({ archive: new Blob([rar5Bytes()]), proven: false, unchecked: false })
    const controller = new AbortController()
    const close = vi.fn(async () => {})
    libarchiveOpen.mockResolvedValue(
      makeAdapter({
        listEntries: () => [
          { index: 0, name: 'p1.png', size: 4, isDirectory: false },
          { index: 1, name: 'p2.png', size: 4, isDirectory: false }
        ],
        readEntry: async () => {
          controller.abort()
          throw new ComicReaderError('corrupt', 'noise')
        },
        close
      })
    )
    const cancelled = await failure({ ...named('book.cbr'), password: 'comic', signal: controller.signal })
    expect(cancelled.name).toBe('AbortError')
    expect(close).toHaveBeenCalled()
  })

  it('does not count a page too large to show against an unconfirmed password', async () => {
    serve(rar5Bytes())
    decrypt.mockResolvedValue({ archive: new Blob([rar5Bytes()]), proven: false })
    const entries = [1, 2, 3, 4].map((number, index) => ({
      index,
      name: `p${number}.png`,
      size: 4,
      isDirectory: false
    }))
    const oversized = (readable: boolean) =>
      makeAdapter({
        listEntries: () => entries,
        readEntry: async (index: number) => {
          if (index < 3) {
            throw new ComicReaderError('page-too-large', 'too large')
          }
          if (!readable) {
            throw new ComicReaderError('corrupt', 'noise')
          }
          return new Blob(['page'])
        }
      })
    libarchiveOpen.mockResolvedValue(oversized(true))
    const opened = await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))
    expect(opened.pages).toHaveLength(4)

    // And an archive of nothing but such pages gives nothing to judge by.
    libarchiveOpen.mockResolvedValue(
      makeAdapter({
        listEntries: () => entries,
        readEntry: async () => {
          throw new ComicReaderError('page-too-large', 'too large')
        }
      })
    )
    expect((await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))).pages).toHaveLength(4)
  })

  it('checks an unconfirmed password on a RAR5 by reading its first pages', async () => {
    // A RAR5 that recorded no check value: libarchive reads it a page at a
    // time, so the first page is read now to find out.
    serve(rar5Bytes())
    decrypt.mockResolvedValue({ archive: new Blob([rar5Bytes()]), proven: false })
    libarchiveOpen.mockResolvedValue({
      ...pages(),
      readEntry: async () => {
        throw new ComicReaderError('corrupt', 'noise')
      }
    })
    expect((await failure({ ...named('book.cbr'), password: 'nope' })).code).toBe('wrong-password')

    libarchiveOpen.mockResolvedValue(pages())
    const opened = await openComic(openComicOptions({ ...named('book.cbr'), password: 'comic' }))
    expect(opened.pages).toHaveLength(1)
  })

  it('says WebAssembly is blocked when it is, without starting the decryption', async () => {
    serve(rar5Bytes())
    wasmAllowed = false
    const error = await failure({ ...named('book.cbr'), password: 'comic' })
    expect(error.code).toBe('backend-unavailable')
    expect(decrypt).not.toHaveBeenCalled()
  })
})
