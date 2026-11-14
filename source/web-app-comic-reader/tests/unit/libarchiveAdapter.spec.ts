import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * What the adapter does with a listing, checked against a stand-in for
 * libarchive.js: the real one needs a worker and WebAssembly, which the test
 * environment has neither of. The stand-in answers the worker's own calls,
 * which is what the adapter uses; `npm run verify:libarchive` checks that the
 * real worker answers them the same way, hostile names included.
 */

interface Listed {
  path: string
  size: number
  type: string
}
let listing: Listed[] = []
/** What a bulk pass returns: the listing's files with their bytes. */
let unpacked: Array<Listed & { fileData: Uint8Array }> = []
const extractSingleFile = vi.fn(async (path: string) => new File(['data'], path))
const extractFiles = vi.fn(async () => unpacked)
const closeReader = vi.fn(async () => {})
const usePassword = vi.fn(async (_password: string) => {})
const openReader = vi.fn(async () => {})
let hasEncryptedData = false
/** Every decoder started, in order. */
const startDecoder = vi.fn(async () => ({
  open: openReader,
  usePassword,
  hasEncryptedData: async () => hasEncryptedData,
  client: { listFiles: async () => listing, extractFiles },
  extractSingleFile,
  close: closeReader
}))

vi.mock('libarchive.js', () => ({
  Archive: { init: () => {}, open: () => startDecoder() }
}))
vi.mock('../../src/helpers/wasm', async (original) => ({
  ...(await original<typeof import('../../src/helpers/wasm')>()),
  checkWasmAllowed: async () => true
}))

const { LibArchiveAdapter } = await import('../../src/archive/libarchiveAdapter')

const file = (path: string, size: number): Listed => ({ path, size, type: 'FILE' })
const open = (options = {}) =>
  LibArchiveAdapter.open(
    { kind: 'blob', data: new Blob(['archive']), name: 'book.cb7' },
    { format: 'cb7', maxEntryBytes: 1000, ...options }
  )

beforeEach(() => {
  extractSingleFile.mockReset().mockImplementation(async (path: string) => new File(['data'], path))
  extractFiles.mockClear()
  closeReader.mockClear()
  usePassword.mockClear()
  openReader.mockReset().mockResolvedValue(undefined)
  startDecoder.mockClear()
  hasEncryptedData = false
  unpacked = []
})

describe('LibArchiveAdapter: the listing', () => {
  it('lists files by their full path, and leaves directories out', async () => {
    listing = [
      { path: 'Chapter 1/', size: 0, type: 'DIR' },
      file('Chapter 1/001.png', 4),
      file('/rooted.png', 4)
    ]
    const adapter = await open()
    expect(adapter.listEntries().map((entry) => entry.name)).toEqual([
      'Chapter 1/001.png',
      'rooted.png'
    ])
    // The decoder is asked by its own path, slash and all.
    await adapter.readEntry(1)
    expect(extractSingleFile).toHaveBeenCalledWith('/rooted.png')
  })

  it('takes a directory called __proto__ as a name like any other', async () => {
    listing = [file('__proto__/polluted.png', 4), file('constructor/prototype/x.png', 4)]
    const adapter = await open()
    expect(adapter.listEntries().map((entry) => entry.name)).toEqual([
      '__proto__/polluted.png',
      'constructor/prototype/x.png'
    ])
    expect('polluted.png' in {}).toBe(false)
  })
})

describe('LibArchiveAdapter: sizes the decoder cannot be trusted with', () => {
  // The module hands sizes over as signed 32-bit numbers: 2 GiB arrives as
  // -2147483648 and 4 GiB - 1 as -1. Passing one back would have the decoder
  // allocate by it.
  it.each([-1, -1073741824, -2147483648, Number.NaN, 1.5])(
    'lists an entry of size %s with no size, and never asks the decoder for it',
    async (size) => {
      listing = [file('001.png', size), file('002.png', 4)]
      const adapter = await open()

      expect(adapter.listEntries().map((entry) => entry.size)).toEqual([0, 4])
      await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'page-unavailable' })
      expect(extractSingleFile).not.toHaveBeenCalled()
      // Its neighbour is unaffected.
      expect((await adapter.readEntry(1)).size).toBe(4)
      expect(extractSingleFile).toHaveBeenCalledWith('002.png')
    }
  )

  it('refuses an entry that declares more than a page may be, before reading it', async () => {
    listing = [file('001.png', 1001), file('002.png', 1000)]
    const adapter = await open()

    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'page-too-large' })
    expect(extractSingleFile).not.toHaveBeenCalled()
    await adapter.readEntry(1)
    expect(extractSingleFile).toHaveBeenCalledTimes(1)
  })
})

describe('LibArchiveAdapter: entries that share a name', () => {
  // The decoder is asked for an entry by path and returns the first match,
  // by that one's size, whichever of them was meant.
  it('lists each, and reads only the first: asking for a later one would return the first', async () => {
    listing = [file('001.png', 8), file('001.png', 4), file('002.png', 4)]
    const adapter = await open()

    expect(adapter.listEntries().map((entry) => `${entry.name}:${entry.size}`)).toEqual([
      '001.png:8',
      '001.png:0',
      '002.png:4'
    ])
    await adapter.readEntry(0)
    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'page-unavailable' })
    expect(extractSingleFile.mock.calls).toEqual([['001.png']])
  })

  it.each([
    ['too large', 1001, 'page-too-large'],
    ['of a size it cannot be trusted with', -1, 'page-unavailable']
  ])('reads none of them when the first is %s', async (_what, size, code) => {
    listing = [file('001.png', size), file('001.png', 4)]
    const adapter = await open()

    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code })
    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'page-unavailable' })
    expect(extractSingleFile).not.toHaveBeenCalled()
  })
})

describe('LibArchiveAdapter: an entry that is not a file', () => {
  // A socket, a device or a directory can carry a path and a declared size
  // like any file. The decoder matches a read by path whatever the type.
  it('makes a file of the same path unreadable when it comes first', async () => {
    listing = [{ path: 'a.png', size: 9999, type: 'SOCKET' }, file('a.png', 4), file('b.png', 4)]
    const adapter = await open()

    expect(adapter.listEntries().map((entry) => entry.name)).toEqual(['a.png', 'b.png'])
    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'page-unavailable' })
    expect(extractSingleFile).not.toHaveBeenCalled()
    expect((await adapter.readEntry(1)).size).toBe(4)
  })

  it('leaves the file readable when the file comes first', async () => {
    listing = [file('a.png', 4), { path: 'a.png', size: 9999, type: 'SOCKET' }]
    const adapter = await open()
    await adapter.readEntry(0)
    expect(extractSingleFile).toHaveBeenCalledWith('a.png')
  })
})

describe('LibArchiveAdapter: unpacking a solid archive in one pass', () => {
  // A read slower than the adapter's threshold is its sign of a solid
  // archive. The first read only sets the baseline; the second triggers.
  const bytes = (length: number) => new Uint8Array(length).fill(7)
  const slow = () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 2000))
  }
  async function readTwice(adapter: Awaited<ReturnType<typeof open>>) {
    await adapter.readEntry(0)
    await adapter.readEntry(0)
    // The pass was started by that read, not awaited by it; a read of a page
    // not yet held waits for it to finish.
    await adapter.readEntry(1).catch(() => {})
  }

  it('keeps the pages, matched to the listing by position, and lets the decoder go', async () => {
    slow()
    listing = [file('001.png', 4), file('ComicInfo.xml', 10), file('002.png', 6)]
    unpacked = [
      { ...listing[0], fileData: bytes(4) },
      { ...listing[1], fileData: bytes(10) },
      { ...listing[2], fileData: bytes(6) }
    ]
    const adapter = await open()
    await readTwice(adapter)
    vi.restoreAllMocks()

    expect(extractFiles).toHaveBeenCalledTimes(1)
    expect(closeReader).toHaveBeenCalledTimes(1)
    extractSingleFile.mockClear()
    expect((await adapter.readEntry(0)).size).toBe(4)
    expect((await adapter.readEntry(2)).size).toBe(6)
    // From what the pass kept: the decoder is gone.
    expect(extractSingleFile).not.toHaveBeenCalled()
    // Only pages are kept.
    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'page-unavailable' })
  })

  it('keeps nothing where position and path disagree', async () => {
    slow()
    listing = [file('001.png', 4), file('002.png', 6)]
    unpacked = [
      { path: 'd/', size: 0, type: 'DIR', fileData: bytes(0) },
      { ...listing[1], fileData: bytes(6) },
      { ...listing[0], fileData: bytes(4) }
    ]
    const adapter = await open()
    await readTwice(adapter)
    vi.restoreAllMocks()

    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'page-unavailable' })
    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'page-unavailable' })
    expect(closeReader).toHaveBeenCalledTimes(1)
  })

  it('keeps no page larger than the page limit, by its real size', async () => {
    slow()
    listing = [file('001.png', 4), file('002.png', 6)]
    unpacked = [
      { ...listing[0], fileData: bytes(4) },
      // Declared 6, came back over the limit of 20.
      { ...listing[1], fileData: bytes(21) }
    ]
    const adapter = await open({ maxEntryBytes: 20 })
    await readTwice(adapter)
    vi.restoreAllMocks()

    expect((await adapter.readEntry(0)).size).toBe(4)
    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'page-unavailable' })
  })

  it('goes back to reading page by page, on a fresh decoder, when the pass fails', async () => {
    slow()
    listing = [file('001.png', 4), file('002.png', 6)]
    extractFiles.mockRejectedValueOnce(new Error('Damaged 7-Zip archive'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onBulkExtractStart = vi.fn()
    const onBulkExtractDone = vi.fn()
    const adapter = await open({ onBulkExtractStart, onBulkExtractDone })
    await readTwice(adapter)

    expect(onBulkExtractStart).toHaveBeenCalledTimes(1)
    expect(onBulkExtractDone).toHaveBeenCalledTimes(1)
    // The decoder the pass failed in is let go, and another started.
    expect(closeReader).toHaveBeenCalledTimes(1)
    expect(startDecoder).toHaveBeenCalledTimes(2)
    // Pages not read before the pass are still readable, one at a time.
    extractSingleFile.mockClear()
    expect((await adapter.readEntry(1)).size).toBe(4)
    expect(extractSingleFile).toHaveBeenCalledWith('002.png')
    // And the pass is not tried a second time, slow as the reads still are.
    await adapter.readEntry(0)
    await adapter.readEntry(1)
    expect(extractFiles).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()

    await adapter.close()
    expect(closeReader).toHaveBeenCalledTimes(2)
  })

  it('says pages are unavailable, at once, when no decoder can be started after a failed pass', async () => {
    slow()
    listing = [file('001.png', 4), file('002.png', 6)]
    extractFiles.mockRejectedValueOnce(new Error('Damaged 7-Zip archive'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = await open()
    // The decoder that is started after the pass fails to open the archive.
    openReader.mockRejectedValueOnce(new Error('out of memory'))
    await readTwice(adapter)
    vi.restoreAllMocks()

    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'page-unavailable' })
    // The one that failed to open was closed too: its worker must not linger.
    expect(closeReader).toHaveBeenCalledTimes(2)
  })

  it('does not start a decoder for an archive closed while the pass was failing', async () => {
    slow()
    listing = [file('001.png', 4), file('002.png', 6)]
    let failPass: (reason: Error) => void = () => {}
    extractFiles.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (failPass = reject))
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = await open()
    await adapter.readEntry(0)
    await adapter.readEntry(0)
    await vi.waitFor(() => expect(extractFiles).toHaveBeenCalledTimes(1))
    const closing = adapter.close()
    failPass(new Error('Damaged 7-Zip archive'))
    await closing
    await new Promise((resolve) => setTimeout(resolve, 0))
    vi.restoreAllMocks()

    expect(startDecoder).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['one entry must not be asked for', [file('001.png', 4), file('002.png', 4), file('notes.txt', -1)]],
    ['one entry is over the page limit', [file('001.png', 4), file('002.png', 4), file('big.bin', 1001)]],
    ['two entries share a name', [file('001.png', 4), file('002.png', 4), file('002.png', 4)]],
    [
      'an entry that is not a file declares data',
      [file('001.png', 4), file('002.png', 4), { path: 'd/', size: 5000, type: 'DIR' }]
    ]
  ])('does not happen when %s: the pass would ask the decoder for everything', async (_why, entries) => {
    slow()
    listing = entries
    const adapter = await open()
    await readTwice(adapter)
    vi.restoreAllMocks()

    expect(extractFiles).not.toHaveBeenCalled()
    expect(closeReader).not.toHaveBeenCalled()
  })
})

describe('LibArchiveAdapter: an archive listing too many entries', () => {
  it('is refused, and its decoder let go', async () => {
    listing = [file('1.png', 1), file('2.png', 1), file('3.png', 1)]
    await expect(open({ maxEntries: 2 })).rejects.toMatchObject({ code: 'too-many-pages' })
    expect(closeReader).toHaveBeenCalledTimes(1)
  })

  it('counts entries of every kind, not only files', async () => {
    listing = [file('1.png', 1), { path: 'a/', size: 0, type: 'DIR' }, { path: 'b/', size: 0, type: 'DIR' }]
    await expect(open({ maxEntries: 2 })).rejects.toMatchObject({ code: 'too-many-pages' })
  })

  it('is opened at exactly the limit, and when no limit is given', async () => {
    listing = [file('1.png', 1), file('2.png', 1)]
    expect((await open({ maxEntries: 2 })).listEntries()).toHaveLength(2)
    expect((await open()).listEntries()).toHaveLength(2)
  })
})

describe('LibArchiveAdapter: a zip handed over with its password', () => {
  const encryptedRead = () => new Error('Incorrect passphrase')

  it('gives the decoder the password before opening, and does not refuse the archive as encrypted', async () => {
    listing = [file('001.png', 4)]
    hasEncryptedData = true
    const adapter = await open({ format: 'cbz', password: 'comic' })

    expect(usePassword).toHaveBeenCalledWith('comic')
    expect(usePassword.mock.invocationCallOrder[0]).toBeLessThan(
      openReader.mock.invocationCallOrder[0]
    )
    expect((await adapter.readEntry(0)).size).toBe(4)
  })

  it('still refuses an encrypted archive it has no password for', async () => {
    listing = [file('001.png', 4)]
    hasEncryptedData = true
    await expect(open()).rejects.toMatchObject({ code: 'encrypted' })
    expect(usePassword).not.toHaveBeenCalled()
  })

  it('reports a password the decoder turns away as encrypted, until a page has been read with it', async () => {
    listing = [file('001.png', 4), file('002.png', 4), file('003.png', 4)]
    const adapter = await open({ format: 'cbz', password: 'nearly' })

    extractSingleFile.mockRejectedValueOnce(encryptedRead())
    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'encrypted' })

    // A page that reads proves the password; a later refusal is that page's.
    expect((await adapter.readEntry(1)).size).toBe(4)
    extractSingleFile.mockRejectedValueOnce(encryptedRead())
    await expect(adapter.readEntry(2)).rejects.toMatchObject({ code: 'corrupt' })
  })

  // CRC-32 of the four bytes "data", which is what the stand-in decoder reads.
  const CRC_OF_DATA = 0xadf3f363

  it('takes only an entry the zip directory lists as encrypted as proof of the password', async () => {
    listing = [file('cover.png', 4), file('001.png', 4), file('002.png', 4)]
    const adapter = await open({
      format: 'cbz',
      password: 'nearly',
      encryptedEntries: new Map([
        ['001.png', CRC_OF_DATA],
        ['002.png', CRC_OF_DATA]
      ])
    })

    // The cover needed no password, so reading it says nothing about one:
    // the encrypted entries then all refusing it still means it is wrong.
    expect((await adapter.readEntry(0)).size).toBe(4)
    extractSingleFile.mockRejectedValue(encryptedRead())
    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'encrypted' })
    extractSingleFile.mockReset().mockImplementation(async (path: string) => new File(['data'], path))

    expect((await adapter.readEntry(2)).size).toBe(4)
    extractSingleFile.mockRejectedValueOnce(encryptedRead())
    await expect(adapter.readEntry(1)).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('does not take a read that came back as noise for proof: the checksum has to match', async () => {
    // libarchive does not compare a zip entry's checksum. A wrong password
    // that gets past the one-byte check "reads" the entry, as noise.
    listing = [file('001.png', 4), file('002.png', 4)]
    const adapter = await open({
      format: 'cbz',
      password: 'lucky',
      encryptedEntries: new Map([
        ['001.png', 0x12345678],
        ['002.png', 0x9abcdef0]
      ])
    })
    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'encrypted' })
  })

  it('does not take an empty entry, or one without a checksum, for proof', async () => {
    listing = [file('empty.png', 0), file('odd.png', 4), file('001.png', 4)]
    extractSingleFile.mockImplementation(
      async (path: string) => new File([path === 'empty.png' ? '' : 'data'], path)
    )
    const adapter = await open({
      format: 'cbz',
      password: 'lucky',
      encryptedEntries: new Map<string, number | undefined>([
        ['empty.png', 0],
        ['odd.png', undefined],
        ['001.png', CRC_OF_DATA]
      ])
    })
    await adapter.readEntry(0)
    await adapter.readEntry(1)
    // Still unproved: a refusal now is the password's, not the page's.
    extractSingleFile.mockRejectedValueOnce(encryptedRead())
    await expect(adapter.readEntry(2)).rejects.toMatchObject({ code: 'encrypted' })
  })

  it('lets another entry vouch for the password when the first one read is damaged', async () => {
    // The right password, and a damaged cover. Read first, it must not send
    // the reader back to the prompt, where the same thing would happen again.
    listing = [file('cover.png', 4), file('001.png', 4), file('002.png', 4)]
    const entries = new Map([
      ['cover.png', CRC_OF_DATA],
      ['001.png', CRC_OF_DATA],
      ['002.png', CRC_OF_DATA]
    ])
    const adapter = await open({ format: 'cbz', password: 'comic', encryptedEntries: entries })
    extractSingleFile.mockRejectedValueOnce(new Error('bzip2 decompression failed'))
    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'corrupt' })
    // 001.png was read to settle it.
    expect(extractSingleFile).toHaveBeenCalledWith('001.png')

    // With every entry failing, it is the password.
    const wrong = await open({ format: 'cbz', password: 'nope', encryptedEntries: entries })
    extractSingleFile.mockRejectedValue(encryptedRead())
    await expect(wrong.readEntry(0)).rejects.toMatchObject({ code: 'encrypted' })
  })

  it('counts any failure to read an encrypted entry against an unproved password', async () => {
    // What the same lucky password looks like on a compressed entry.
    listing = [file('001.png', 4), file('002.png', 4)]
    const entries = new Map([
      ['001.png', CRC_OF_DATA],
      ['002.png', CRC_OF_DATA]
    ])
    const adapter = await open({ format: 'cbz', password: 'lucky', encryptedEntries: entries })
    extractSingleFile.mockRejectedValue(new Error('bzip2 decompression failed'))
    await expect(adapter.readEntry(0)).rejects.toMatchObject({ code: 'encrypted' })
    extractSingleFile.mockReset().mockImplementation(async (path: string) => new File(['data'], path))

    // Told the password is already proved, the same failure is the page's.
    const proved = await open({
      format: 'cbz',
      password: 'comic',
      encryptedEntries: entries,
      passwordProven: true
    })
    extractSingleFile.mockRejectedValueOnce(new Error('bzip2 decompression failed'))
    await expect(proved.readEntry(0)).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('gives the password to the decoder it starts after a failed pass, too', async () => {
    vi.spyOn(Date, 'now').mockImplementation(
      (() => {
        let now = 0
        return () => (now += 2000)
      })()
    )
    listing = [file('001.png', 4), file('002.png', 6)]
    extractFiles.mockRejectedValueOnce(new Error('Damaged archive'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = await open({ format: 'cbz', password: 'comic' })
    await adapter.readEntry(0)
    await adapter.readEntry(0)
    await adapter.readEntry(1)
    vi.restoreAllMocks()

    expect(startDecoder).toHaveBeenCalledTimes(2)
    expect(usePassword).toHaveBeenCalledTimes(2)
  })
})

