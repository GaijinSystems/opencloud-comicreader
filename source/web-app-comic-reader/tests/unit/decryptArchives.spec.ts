import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BlobReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  configure,
  terminateWorkers
} from '@zip.js/zip.js'

/**
 * The decryption that makes password-protected RAR archives, and AES zips in
 * the methods zip.js lacks, readable by the reader's other decoders: the
 * real sevenzip module and the two routines the worker runs, under Node.
 *
 * What is checked here is what the routines produce. That the decoders then
 * read it is checked with the real unarr module below for RAR4, and for
 * RAR5 and zip (which need libarchive, and so a worker) by
 * `npm run verify:formats`.
 */

configure({ useWebWorkers: false })
afterAll(() => terminateWorkers())

const vendor = (...path: string[]) => resolve(__dirname, '../../public/vendor', ...path)
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, '../fixtures', name)))
const load = (...path: string[]) => import(/* @vite-ignore */ pathToFileURL(vendor(...path)).href)

interface Result {
  status: 'decrypted' | 'not-encrypted' | 'wrong-password' | 'unsupported'
  archive?: Blob
  proven?: boolean
  unchecked?: boolean
  encryptedEntries?: { of: number; at: number[]; mismatched: number[] }
  reason?: string
}
/** decrypt-common.mjs, for the helpers the tests borrow to edit archives. */
let common: {
  crc32(bytes: Uint8Array): number
  u32(bytes: Uint8Array, at: number): number
  putU32(bytes: Uint8Array, at: number, value: number): void
  u16(bytes: Uint8Array, at: number): number
  putU16(bytes: Uint8Array, at: number, value: number): void
  concat(...arrays: Uint8Array[]): Uint8Array
}
let decryptRar: (bytes: Uint8Array, password: string) => Promise<Result>
let decryptZip: (bytes: Uint8Array, password: string) => Promise<Result>
/** unarr over a RAR4, as the reader runs it on one that was decrypted. */
let unarr: (bytes: Uint8Array) => Promise<Array<{ name: string; data?: Uint8Array; decoded?: boolean }>>

/** The decrypted archive's bytes. */
const joined = async (result: Result) => new Uint8Array(await result.archive!.arrayBuffer())
const isPng = (data?: Uint8Array) =>
  Boolean(data && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
/** Whether `bytes` holds `needle` anywhere: how a stored entry's contents are looked for. */
const contains = (bytes: Uint8Array, needle: Uint8Array) => {
  outer: for (let at = 0; at + needle.length <= bytes.length; at++) {
    for (let index = 0; index < needle.length; index++) {
      if (bytes[at + index] !== needle[index]) {
        continue outer
      }
    }
    return true
  }
  return false
}
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const NOTES = new TextEncoder().encode('a line of notes, repeated\n')

beforeAll(async () => {
  for (const file of [vendor('sevenzip', 'sevenzip.wasm'), vendor('unarr', 'unarr-rar.wasm')]) {
    if (!existsSync(file)) {
      throw new Error('The decoders have not been built. Run `npm run build:native`.')
    }
  }
  const { default: createModule } = await load('sevenzip', 'sevenzip.mjs')
  const { sourceFromBytes } = await load('sevenzip', 'sevenzip-extract.mjs')
  common = await load('sevenzip', 'decrypt-common.mjs')
  const rar = await load('sevenzip', 'decrypt-rar.mjs')
  const zip = await load('sevenzip', 'decrypt-zip.mjs')
  const instance = () =>
    createModule({ locateFile: () => vendor('sevenzip', 'sevenzip.wasm'), printErr: () => {} })
  decryptRar = async (bytes, password) =>
    rar.decryptRar(common, await instance(), sourceFromBytes(bytes), password)
  decryptZip = async (bytes, password) =>
    zip.decryptZip(common, await instance(), sourceFromBytes(bytes), password)

  const { default: createUnarr } = await load('unarr', 'unarr-rar.mjs')
  const loop = await load('unarr', 'unarr-extract.mjs')
  unarr = async (bytes) => {
    const Module = await createUnarr({
      locateFile: () => vendor('unarr', 'unarr-rar.wasm'),
      printErr: () => {}
    })
    return loop.extractRar(Module, loop.copyToHeap(Module, bytes), bytes.byteLength, {
      maxEntryBytes: 1024 * 1024,
      maxEntries: 100,
      maxTotalBytes: 16 * 1024 * 1024,
      maxRetainedBytes: 16 * 1024 * 1024,
      solid: true,
      decrypted: true,
      keepExtensions: ['png', 'txt'],
      keepNames: []
    }).entries
  }
})

describe('decrypting RAR4 (fixtures made by rar 5.50, password "comic")', () => {
  it.each(['rar4.cbr', 'rar4-stored.cbr', 'rar4-solid.cbr', 'rar4-headers.cbr'])(
    'turns %s into an archive unarr reads in full',
    async (name) => {
      const result = await decryptRar(fixture(`rar-encrypted/${name}`), 'comic')
      expect(result.status).toBe('decrypted')

      const entries = await unarr(await joined(result))
      expect(entries.map((entry) => entry.name).sort()).toEqual([
        'a.png',
        'b.png',
        'notes.txt',
        'sub/c.png'
      ])
      // Every entry decoded, which for unarr includes matching its checksum.
      expect(entries.every((entry) => entry.data)).toBe(true)
      expect(entries.filter((entry) => entry.name.endsWith('.png')).every((e) => isPng(e.data))).toBe(
        true
      )
    }
  )

  it('produces the same pages as the archive that never was encrypted', async () => {
    const plain = await unarr(fixture('rar/rar4-solid.cbr'))
    const decrypted = await unarr(await joined(await decryptRar(fixture('rar-encrypted/rar4-solid.cbr'), 'comic')))
    for (const name of ['a.png', 'b.png', 'sub/c.png']) {
      const expected = plain.find((entry) => entry.name === name)?.data
      expect(expected, name).toBeDefined()
      expect(decrypted.find((entry) => entry.name === name)?.data, name).toEqual(expected)
    }
  })

  it('knows the right password where the archive gives something to check it by', async () => {
    // Encrypted headers carry a checksum; a stored entry's checksum is of
    // exactly what was decrypted.
    expect((await decryptRar(fixture('rar-encrypted/rar4-headers.cbr'), 'comic')).proven).toBe(true)
    expect((await decryptRar(fixture('rar-encrypted/rar4-stored.cbr'), 'comic')).proven).toBe(true)
    // A header that does not decrypt is a wrong password at once. Stored
    // entries that do not match their checksums could be damage, so that
    // is left unproven (see "damaged entries" below).
    expect((await decryptRar(fixture('rar-encrypted/rar4-headers.cbr'), 'not it')).status).toBe('wrong-password')
    expect(await decryptRar(fixture('rar-encrypted/rar4-stored.cbr'), 'not it')).toMatchObject({
      status: 'decrypted',
      proven: false
    })
  })

  it('cannot know for compressed entries, says so, and leaves noise that does not decode', async () => {
    // RAR before version 5 keeps no check value: decrypting with a wrong
    // password just gives the wrong bytes. `proven: false` is the reader's
    // cue to judge by whether anything decodes.
    for (const name of ['rar4.cbr', 'rar4-solid.cbr']) {
      const right = await decryptRar(fixture(`rar-encrypted/${name}`), 'comic')
      expect(right.proven, name).toBe(false)

      const wrong = await decryptRar(fixture(`rar-encrypted/${name}`), 'not it')
      expect(wrong, name).toMatchObject({ status: 'decrypted', proven: false })
      const entries = await unarr(await joined(wrong))
      expect(entries.some((entry) => entry.data), name).toBe(false)
    }
  })
})

describe('decrypting RAR5 (fixtures made by rar 7.11, password "comic")', () => {
  const NAMES = ['rar5.cbr', 'rar5-stored.cbr', 'rar5-solid.cbr', 'rar5-headers.cbr']

  it.each(NAMES)('decrypts %s, with the password confirmed by the archive', async (name) => {
    const result = await decryptRar(fixture(`rar-encrypted/${name}`), 'comic')
    expect(result).toMatchObject({ status: 'decrypted', proven: true })
    const plain = await joined(result)
    // Still a RAR5, and nothing in it says "encrypted" any more: decrypting
    // it again finds nothing to do.
    expect([...plain.subarray(0, 8)]).toEqual([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
    expect((await decryptRar(plain, 'comic')).status).toBe('not-encrypted')
  })

  it.each(NAMES)('refuses a wrong password for %s', async (name) => {
    for (const password of ['not it', 'Comic', 'comic ', '']) {
      expect((await decryptRar(fixture(`rar-encrypted/${name}`), password)).status).toBe(
        'wrong-password'
      )
    }
  })

  it('leaves a stored entry as the bytes that went in, with its real checksum', async () => {
    const plain = await joined(await decryptRar(fixture('rar-encrypted/rar5-stored.cbr'), 'comic'))
    expect(contains(plain, PNG_SIGNATURE)).toBe(true)
    expect(contains(plain, NOTES)).toBe(true)
    // And not before decrypting.
    expect(contains(fixture('rar-encrypted/rar5-stored.cbr'), PNG_SIGNATURE)).toBe(false)
  })

  it('shows the file names that encrypted headers were hiding', async () => {
    const name = new TextEncoder().encode('notes.txt')
    expect(contains(fixture('rar-encrypted/rar5-headers.cbr'), name)).toBe(false)
    const plain = await joined(await decryptRar(fixture('rar-encrypted/rar5-headers.cbr'), 'comic'))
    expect(contains(plain, name)).toBe(true)
  })
})

describe('decrypting RAR: what it leaves alone', () => {
  it('says an archive without a password has nothing to decrypt', async () => {
    for (const name of ['rar/rar4-plain.cbr', 'rar/rar4-solid.cbr', 'rar/rar5-plain.cbr']) {
      expect(await decryptRar(fixture(name), 'comic'), name).toEqual({ status: 'not-encrypted' })
    }
  })

  /**
   * Flips a bit in the checksum of the password check value of every
   * encryption record, and mends the checksum of the header around it: an
   * archive whose check value reads as damaged, and is then not used.
   */
  function withDamagedCheckValue(original: Uint8Array) {
    const file = original.slice()
    const vint = (at: number): [number, number] => {
      let value = 0
      for (let shift = 0; ; shift += 7) {
        const byte = file[at++]
        value += (byte & 127) * 2 ** shift
        if (!(byte & 128)) {
          return [value, at]
        }
      }
    }
    for (let at = 8; at < file.length - 7; ) {
      const [size, afterSize] = vint(at + 4)
      const end = afterSize + size
      const [type, afterType] = vint(afterSize)
      let [flags, next] = vint(afterType)
      let extra = 0
      let data = 0
      if (flags & 1) {
        ;[extra, next] = vint(next)
      }
      if (flags & 2) {
        ;[data, next] = vint(next)
      }
      if (type === 4) {
        // The archive's own encryption header: everything after it is encrypted.
        file[end - 1] ^= 1
        common.putU32(file, at, common.crc32(file.subarray(at + 4, end)))
        break
      }
      if (type === 2 && extra) {
        for (let record = end - extra; record < end; ) {
          const [recordSize, afterRecordSize] = vint(record)
          if (vint(afterRecordSize)[0] === 1) {
            file[afterRecordSize + recordSize - 1] ^= 1
          }
          record = afterRecordSize + recordSize
        }
        common.putU32(file, at, common.crc32(file.subarray(at + 4, end)))
      }
      if (type === 5) {
        break
      }
      at = end + data
    }
    return file
  }

  it('does not call the right password wrong for damaged entries', async () => {
    // RAR4, stored: an entry's checksum is what could confirm the password.
    // A mismatch is damage or a wrong password, and settles nothing: the
    // entries that are whole still prove the right one.
    const stored = fixture('rar-encrypted/rar4-stored.cbr')
    stored[600] ^= 1
    expect(await decryptRar(stored, 'comic')).toMatchObject({ status: 'decrypted', proven: true })
    // Under a wrong password none matches. That is left unproven, for the
    // reader to find out by whether any page decodes; none does.
    const wrong = await decryptRar(stored, 'not it')
    expect(wrong).toMatchObject({ status: 'decrypted', proven: false })
    expect((await unarr(await joined(wrong))).some((entry) => entry.data)).toBe(false)

    // RAR5: a damaged salt makes the entry's own check refuse the password.
    // In a later entry, after the password is proved, and in the first,
    // where the header's checksum gives the damage away.
    for (const offset of [199, 62]) {
      const damaged = fixture('rar-encrypted/rar5.cbr')
      damaged[offset] ^= 1
      await expect(decryptRar(damaged, 'comic'), `offset ${offset}`).rejects.toThrow(/damaged/)
    }
  })

  it('does not take a RAR5 password as confirmed when the check value is damaged and so goes unused', async () => {
    // 7-Zip, like RAR, then accepts any password without a word. Nothing
    // has checked it, and the answer must say so.
    const entries = withDamagedCheckValue(fixture('rar-encrypted/rar5.cbr'))
    for (const password of ['comic', 'not it']) {
      expect(await decryptRar(entries, password)).toMatchObject({ status: 'decrypted', proven: false })
    }
    // With encrypted headers there is still their checksum to go by.
    const headers = withDamagedCheckValue(fixture('rar-encrypted/rar5-headers.cbr'))
    expect(await decryptRar(headers, 'comic')).toMatchObject({ status: 'decrypted', proven: true })
    expect(await decryptRar(headers, 'not it')).toMatchObject({ status: 'wrong-password' })
  })

  it('says a file that is not RAR is not something it handles', async () => {
    expect(await decryptRar(fixture('sample.cbz'), 'comic')).toMatchObject({ status: 'unsupported' })
    expect(await decryptRar(new Uint8Array(3), 'comic')).toMatchObject({ status: 'unsupported' })
  })

  it('fails, without hanging or reading out of bounds, on an archive cut short', async () => {
    const whole = fixture('rar-encrypted/rar5.cbr')
    for (const length of [20, 100, whole.length - 40, whole.length - 1]) {
      const outcome = await decryptRar(whole.slice(0, length), 'comic').then(
        (result) => result.status,
        (error: Error) => `error: ${error.message}`
      )
      // Either what was there decrypted, or a plain error; never a crash.
      expect(typeof outcome, String(length)).toBe('string')
    }
  })
})

describe('decrypting the AES entries of a zip', () => {
  const PAGE = Uint8Array.from({ length: 5000 }, (_, index) => (index * 31) & 0xff)

  async function aesZip(options: Record<string, unknown> = {}) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      password: 'comic',
      encryptionStrength: 3,
      ...options
    })
    await writer.add('p1.png', new Uint8ArrayReader(PAGE), { level: 0 })
    await writer.add('p2.png', new Uint8ArrayReader(PAGE), { level: 6 })
    await writer.add('dir/p3.png', new Uint8ArrayReader(new Uint8Array(0)))
    return writer.close()
  }

  /** Reads a zip with zip.js and no password at all. */
  async function readPlain(bytes: Uint8Array) {
    const reader = new ZipReader(new BlobReader(new Blob([bytes as BlobPart])))
    const out: Record<string, Uint8Array> = {}
    for (const entry of await reader.getEntries()) {
      expect(entry.encrypted, entry.filename).toBe(false)
      if (!entry.directory && 'getData' in entry) {
        out[entry.filename] = await entry.getData(new Uint8ArrayWriter())
      }
    }
    await reader.close()
    return out
  }

  it.each([
    ['256-bit keys', { encryptionStrength: 3 }],
    ['128-bit keys', { encryptionStrength: 1 }]
  ])('gives back a zip that reads without a password (%s)', async (_label, options) => {
    const result = await decryptZip(await aesZip(options), 'comic')
    expect(result.status).toBe('decrypted')

    const entries = await readPlain(await joined(result))
    expect(Object.keys(entries).sort()).toEqual(['dir/p3.png', 'p1.png', 'p2.png'])
    expect(entries['p1.png']).toEqual(PAGE)
    expect(entries['p2.png']).toEqual(PAGE)
    expect(entries['dir/p3.png']).toHaveLength(0)
  })

  it('refuses a wrong password', async () => {
    const zip = await aesZip()
    for (const password of ['not it', 'Comic', '']) {
      expect((await decryptZip(zip, password)).status).toBe('wrong-password')
    }
  })

  it('says when entries are written without a checksum of their data, and only then', async () => {
    // zip.js writes the second version of the scheme, which stores none.
    // A stored entry's is computed here; a compressed entry's cannot be.
    const stored = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', encryptionStrength: 3 })
    await stored.add('p1.png', new Uint8ArrayReader(PAGE), { level: 0 })
    const allStored = await decryptZip(await stored.close(), 'comic')
    expect(allStored).toMatchObject({ status: 'decrypted', proven: true, unchecked: false })

    expect(await decryptZip(await aesZip(), 'comic')).toMatchObject({ proven: true, unchecked: true })
  })

  it('takes an empty entry with AES markings for what it is: nothing to decrypt', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', encryptionStrength: 3 })
    await writer.add('empty.png', new Uint8ArrayReader(new Uint8Array(0)))
    await writer.add('p1.png', new Uint8ArrayReader(PAGE))
    const result = await decryptZip(await writer.close(), 'comic')
    expect(result.status).toBe('decrypted')
    const entries = await readPlain(await joined(result))
    expect(entries['empty.png']).toHaveLength(0)
    expect(entries['p1.png']).toEqual(PAGE)

    // On its own, too, it is not a kind of zip to refuse.
    const alone = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', encryptionStrength: 3 })
    await alone.add('empty.png', new Uint8ArrayReader(new Uint8Array(0)), { level: 0 })
    expect((await decryptZip(await alone.close(), 'comic')).status).not.toBe('unsupported')
  })

  it('leaves an entry that does not decrypt as it is, and goes by the ones that do', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', encryptionStrength: 3 })
    for (const name of ['p1.png', 'p2.png', 'p3.png']) {
      await writer.add(name, new Uint8ArrayReader(PAGE), { level: 0 })
    }
    const zip = await writer.close()
    // A byte of the first entry's data: its authentication code no longer fits.
    zip[200] ^= 1

    const result = await decryptZip(zip, 'comic')
    expect(result).toMatchObject({ status: 'decrypted', proven: true })
    const reader = new ZipReader(new BlobReader(new Blob([(await joined(result)) as BlobPart])))
    const entries = await reader.getEntries()
    expect(entries.map((entry) => [entry.filename, entry.encrypted])).toEqual([
      ['p1.png', true],
      ['p2.png', false],
      ['p3.png', false]
    ])
    const second = entries[1]
    expect('getData' in second && (await second.getData!(new Uint8ArrayWriter()))).toEqual(PAGE)
    await reader.close()

    // With a wrong password every entry refuses, which is the answer.
    expect((await decryptZip(zip, 'not it')).status).toBe('wrong-password')
  })

  it('tells entries that are all damaged from a wrong password', async () => {
    // The verification bytes accept the password; the data then fails its
    // authentication code. Asking for the password again would never end.
    const writer = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', encryptionStrength: 3 })
    await writer.add('p1.png', new Uint8ArrayReader(PAGE), { level: 0 })
    await writer.add('empty.png', new Uint8ArrayReader(new Uint8Array(0)), { level: 0 })
    const zip = await writer.close()
    zip[200] ^= 1
    await expect(decryptZip(zip, 'comic')).rejects.toThrow(/damaged/)
    expect((await decryptZip(zip, 'not it')).status).toBe('wrong-password')
  })

  it('refuses a zip whose directory names one entry many times over', async () => {
    // Each record would be decrypted and written out: an archive made to
    // grow to any size.
    const writer = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', encryptionStrength: 3 })
    await writer.add('p1.png', new Uint8ArrayReader(PAGE), { level: 0 })
    const zip = await writer.close()
    let end = zip.length - 22
    while (common.u32(zip, end) !== 0x06054b50) {
      end--
    }
    const offset = common.u32(zip, end + 16)
    const size = common.u32(zip, end + 12)
    const record = zip.subarray(offset, offset + size)
    const COPIES = 50
    const tail = zip.slice(end, end + 22)
    tail[8] = tail[10] = COPIES
    common.putU32(tail, 12, size * COPIES)
    const bomb = common.concat(zip.subarray(0, offset), ...Array.from({ length: COPIES }, () => record), tail)
    await expect(decryptZip(bomb, 'comic')).rejects.toThrow(/overlap/)
  })

  it('leaves an entry in the old scheme as it was, sizes after its data and all', async () => {
    // With its sizes after the data, the old scheme checks a password
    // against a different byte, and the flag is what says so.
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add('aes.png', new Uint8ArrayReader(PAGE), { password: 'comic', encryptionStrength: 3 })
    await writer.add('old.png', new Uint8ArrayReader(PAGE), {
      password: 'comic',
      zipCrypto: true,
      dataDescriptor: true
    })
    const result = await decryptZip(await writer.close(), 'comic')
    expect(result.status).toBe('decrypted')

    const reader = new ZipReader(new BlobReader(new Blob([(await joined(result)) as BlobPart])))
    const entries = await reader.getEntries()
    const read = async (name: string, password?: string) => {
      const entry = entries.find((candidate) => candidate.filename === name)!
      return 'getData' in entry ? entry.getData!(new Uint8ArrayWriter(), { password }) : null
    }
    expect(await read('aes.png')).toEqual(PAGE)
    expect(await read('old.png', 'comic')).toEqual(PAGE)
    await expect(read('old.png', 'not it')).rejects.toThrow()
    await reader.close()
  })

  it('takes a password of any length', async () => {
    // 7-Zip's routine stops at 99 bytes; the scheme does not.
    for (const length of [64, 65, 99, 100, 300]) {
      const long = 'pässword '.repeat(40).slice(0, length)
      const writer = new ZipWriter(new Uint8ArrayWriter(), { password: long, encryptionStrength: 3 })
      await writer.add('p1.png', new Uint8ArrayReader(PAGE))
      const zip = await writer.close()
      const result = await decryptZip(zip, long)
      expect(result.status, `${length} characters`).toBe('decrypted')
      expect((await readPlain(await joined(result)))['p1.png']).toEqual(PAGE)
      expect((await decryptZip(zip, `${long}x`)).status).toBe('wrong-password')
    }
  })

  it('reads and writes a zip64 archive', async () => {
    // zip.js writes the zip64 records on request, however small the archive.
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      password: 'comic',
      encryptionStrength: 3,
      zip64: true
    })
    await writer.add('p1.png', new Uint8ArrayReader(PAGE), { level: 0 })
    await writer.add('p2.png', new Uint8ArrayReader(PAGE), { level: 6 })
    const plain = new Uint8Array(100).fill(7)
    await writer.add('plain.txt', new Uint8ArrayReader(plain), { password: undefined })
    const zip = await writer.close()

    const result = await decryptZip(zip, 'comic')
    expect(result.status).toBe('decrypted')
    const entries = await readPlain(await joined(result))
    expect(entries['p1.png']).toEqual(PAGE)
    expect(entries['p2.png']).toEqual(PAGE)
    expect(entries['plain.txt']).toEqual(plain)
    expect((await decryptZip(zip, 'not it')).status).toBe('wrong-password')
  })

  it('writes zip64 records of its own for a directory of more than 65,534 entries', async () => {
    // Too many entries for the old end record: the count has to go in a
    // zip64 one, whether or not the archive came with one.
    const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 })
    await writer.add('p1.png', new Uint8ArrayReader(PAGE), { password: 'comic', encryptionStrength: 3 })
    const empty = new Uint8Array(0)
    for (let index = 0; index < 65_540; index++) {
      await writer.add(`e${index}`, new Uint8ArrayReader(empty), { extendedTimestamp: false })
    }
    const result = await decryptZip(await writer.close(), 'comic')
    expect(result.status).toBe('decrypted')

    const reader = new ZipReader(new BlobReader(result.archive!))
    const entries = await reader.getEntries()
    expect(entries).toHaveLength(65_541)
    const first = entries[0]
    expect(first.encrypted).toBe(false)
    expect('getData' in first && (await first.getData!(new Uint8ArrayWriter()))).toEqual(PAGE)
    await reader.close()
  }, 120_000)

  it('leaves a zip with no AES entries alone, whatever else it has', async () => {
    const plain = new ZipWriter(new Uint8ArrayWriter())
    await plain.add('p1.png', new Uint8ArrayReader(PAGE))
    expect(await decryptZip(await plain.close(), 'comic')).toEqual({ status: 'not-encrypted' })

    const old = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', zipCrypto: true })
    await old.add('p1.png', new Uint8ArrayReader(PAGE))
    expect(await decryptZip(await old.close(), 'comic')).toEqual({ status: 'not-encrypted' })
  })

  it('copies entries that are not AES-encrypted as they are', async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter())
    await writer.add('plain.png', new Uint8ArrayReader(PAGE))
    await writer.add('locked.png', new Uint8ArrayReader(PAGE), {
      password: 'comic',
      encryptionStrength: 3
    })
    const result = await decryptZip(await writer.close(), 'comic')
    const entries = await readPlain(await joined(result))
    expect(entries['plain.png']).toEqual(PAGE)
    expect(entries['locked.png']).toEqual(PAGE)
  })

  it('finds the end of a zip that has bytes after it, or a look-alike in its comment', async () => {
    const zip = await aesZip()
    const padded = new Uint8Array(zip.length + 4)
    padded.set(zip)
    expect((await decryptZip(padded, 'comic')).status).toBe('decrypted')

    // A comment that holds what looks like an end record of its own.
    const comment = new Uint8Array(30)
    comment.set([0x50, 0x4b, 0x05, 0x06])
    const commented = new Uint8Array(zip.length + comment.length)
    commented.set(zip)
    commented.set(comment, zip.length)
    commented[zip.length - 2] = comment.length
    expect((await decryptZip(commented, 'comic')).status).toBe('decrypted')
  })

  it('fails plainly on something that is not a zip', async () => {
    await expect(decryptZip(fixture('sample.cb7'), 'comic')).rejects.toThrow(/not a zip/)
  })
})

describe('finding where the compressed data of a RAR5 entry ends', () => {
  let Rar5Blocks: new () => { feed(bytes: Uint8Array): void; dataBytes(packed: number): number | null }
  beforeAll(async () => {
    ;({ Rar5Blocks } = await load('sevenzip', 'decrypt-rar.mjs'))
  })
  /** A block: its header (flags, check byte, length) and that many bytes of filler. */
  const block = (length: number, last: boolean, lengthBytes = 1) => {
    const flags = ((lengthBytes - 1) << 3) | (last ? 0x40 : 0)
    const size = Array.from({ length: lengthBytes }, (_, index) => (length >> (8 * index)) & 0xff)
    const check = size.reduce((value, byte) => value ^ byte, 0x5a ^ flags)
    return Uint8Array.from([flags, check, ...size, ...new Array(length).fill(0xee)])
  }
  const padded = (data: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(data.length / 16) * 16).fill(0x77)
    out.set(data)
    return out
  }
  const measure = (bytes: Uint8Array, step: number) => {
    const blocks = new Rar5Blocks()
    for (let at = 0; at < bytes.length; at += step) {
      blocks.feed(bytes.subarray(at, at + step))
    }
    return blocks.dataBytes(bytes.length)
  }

  it('follows the blocks to the last, however the data is cut into chunks', () => {
    const data = common.concat(block(300, false, 2), block(0, false), block(70_000, false, 3), block(9, true))
    for (const step of [1, 2, 7, 16, 4096, 1 << 20]) {
      expect(measure(padded(data), step), `in chunks of ${step}`).toBe(data.length)
    }
    // With no padding to cut, too.
    const exact = common.concat(block(13, true))
    expect(exact.length % 16).toBe(0)
    expect(measure(exact, 5)).toBe(exact.length)
  })

  it('says nothing where the chain does not hold', () => {
    const data = common.concat(block(40, false), block(9, true))
    const broken = padded(data)
    broken[1] ^= 1
    expect(measure(broken, 16)).toBeNull()
    // An end that is a whole cipher block or more short of the entry's is not padding.
    const early = new Uint8Array(data.length + 40).fill(0x77)
    early.set(data)
    expect(measure(early, 16)).toBeNull()
    // No block marked last.
    expect(measure(padded(block(40, false)), 16)).toBeNull()
    // Noise, as a wrong password leaves.
    const noise = Uint8Array.from({ length: 256 }, (_, index) => (index * 37 + 11) & 0xff)
    expect(measure(noise, 16)).toBeNull()
  })

  it('leaves no padding after the entries of a decrypted solid archive', async () => {
    // libarchive cannot read a solid RAR5 past padding; that it reads this
    // one is checked by `npm run verify:formats`. Here: what is written is
    // shorter than what went in by more than the encryption records alone.
    const original = fixture('rar-encrypted/rar5-solid.cbr')
    const result = await decryptRar(original, 'comic')
    expect(result.status).toBe('decrypted')
    const plain = await joined(result)
    // Every file's data now ends exactly where its last block does.
    const vint = (at: number): [number, number] => {
      let value = 0
      for (let shift = 0; ; shift += 7) {
        const byte = plain[at++]
        value += (byte & 127) * 2 ** shift
        if (!(byte & 128)) {
          return [value, at]
        }
      }
    }
    let files = 0
    for (let at = 8; at < plain.length - 7; ) {
      const [size, afterSize] = vint(at + 4)
      const end = afterSize + size
      const [type, afterType] = vint(afterSize)
      let [flags, next] = vint(afterType)
      let data = 0
      if (flags & 1) {
        ;[, next] = vint(next)
      }
      if (flags & 2) {
        ;[data] = vint(next)
      }
      if (type === 2 && data > 0) {
        files++
        expect(measure(plain.subarray(end, end + data), 16)).toBe(data)
      }
      if (type === 5) {
        break
      }
      at = end + data
    }
    expect(files).toBe(4)
  })
})

describe('decrypting RAR 2.x encryption (a fixture written by scripts/rar_writer.py, checked with unrar)', () => {
  const NAMES = ['Chapter 1/page1.png', 'Chapter 1/page10.png', 'Chapter 1/page2.PNG', 'Chapter 2/page2.png']
  const pngs = (entries: Array<{ name: string; data?: Uint8Array }>) =>
    entries.filter((entry) => /\.png$/i.test(entry.name) && !entry.name.startsWith('__MACOSX'))

  it('turns it into an archive unarr reads, with the password confirmed by the stored checksums', async () => {
    const result = await decryptRar(fixture('rar2-encrypted.cbr'), 'comic')
    expect(result).toMatchObject({ status: 'decrypted', proven: true })
    const entries = pngs(await unarr(await joined(result)))
    expect(entries.map((entry) => entry.name).sort()).toEqual(NAMES)
    expect(entries.every((entry) => isPng(entry.data))).toBe(true)
  })

  it('leaves a wrong password unconfirmed, and nothing that decodes', async () => {
    // The cipher has no check of its own, and no checksum matched.
    const result = await decryptRar(fixture('rar2-encrypted.cbr'), 'not it')
    expect(result).toMatchObject({ status: 'decrypted', proven: false })
    expect(pngs(await unarr(await joined(result))).some((entry) => entry.data)).toBe(false)
  })

  it('does not take the checksum of a byte or two for proof of a password', async () => {
    // One stored file of one byte: one password in 256 decrypts it to
    // something with the same checksum.
    const tiny = fixture('rar2-tiny.cbr')
    for (let attempt = 0; attempt < 600; attempt++) {
      const result = await decryptRar(tiny, `guess ${attempt}`)
      expect(result, `guess ${attempt}`).toMatchObject({ status: 'decrypted', proven: false })
    }
    expect(await decryptRar(tiny, 'comic')).toMatchObject({ status: 'decrypted', proven: false })
  })

  it('says which files were encrypted, by their place among the files a decoder lists', async () => {
    /** The blocks of a RAR4 after its marker: each a header and its data. */
    const blocksOf = (bytes: Uint8Array) => {
      const blocks: Uint8Array[] = []
      for (let at = 7; at + 7 <= bytes.length; ) {
        const hasData = bytes[at + 2] === 0x74 || common.u16(bytes, at + 3) & 0x8000
        const length = common.u16(bytes, at + 5) + (hasData ? common.u32(bytes, at + 7) : 0)
        blocks.push(bytes.subarray(at, at + length))
        at += length
      }
      return blocks
    }
    const locked = blocksOf(fixture('rar2-encrypted.cbr'))
    const open = blocksOf(fixture('sample.cbr'))
    // The same archive with its first and third files left unencrypted.
    const plain = [0, 2]
    const mixed = common.concat(
      fixture('sample.cbr').subarray(0, 7),
      ...locked.map((block, index) => (plain.includes(index - 1) ? open[index] : block))
    )
    const files = locked.length - 2 // all but the main header and the end block

    const result = await decryptRar(mixed, 'not it')
    expect(result).toMatchObject({ status: 'decrypted', proven: false })
    expect(result.encryptedEntries!.of).toBe(files)
    expect(result.encryptedEntries!.at).toEqual(
      Array.from({ length: files }, (_, index) => index).filter((index) => !plain.includes(index))
    )
    // Which is how unarr lists them: as many, in that order. (The first is
    // plain and decodes; under this wrong password no encrypted one does.)
    const entries = await unarr(await joined(result))
    expect(entries).toHaveLength(files)
    expect(Boolean(entries[0].data)).toBe(true)
    expect(result.encryptedEntries!.at.some((index) => entries[index].data)).toBe(false)
    // And unarr says how each came out: the plain one decoded, the first
    // encrypted one did not, and (the pass being told the archive is
    // solid) nothing after that was tried.
    expect(entries.map((entry) => entry.decoded)).toEqual([true, false, ...Array(files - 2).fill(undefined)])
  })

  it('says so when the encryption is older still', async () => {
    // Unpacker version 1.5: a cipher 7-Zip does not have.
    const older = fixture('rar2-encrypted.cbr')
    // The first file header follows the 7-byte marker and the 13-byte main header.
    const at = 7 + 13
    older[at + 24] = 15
    const size = common.u16(older, at + 5)
    common.putU16(older, at, common.crc32(older.subarray(at + 2, at + size)) & 0xffff)
    expect(await decryptRar(older, 'comic')).toMatchObject({
      status: 'unsupported',
      reason: expect.stringMatching(/before RAR 2/)
    })
  })
})

describe('the archive being written', () => {
  let Output: new () => {
    size: number
    write(part: Uint8Array | Blob): void
    reserve(): void
    discard(): void
    fill(bytes: Uint8Array): void
    finish(): Blob
    folded: Blob[]
    pending: Array<Uint8Array | Blob>
  }
  beforeAll(async () => {
    ;({ Output } = await load('sevenzip', 'decrypt-common.mjs'))
  })
  const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer())
  const filled = (length: number, value: number) => new Uint8Array(length).fill(value)

  it('puts a header held back in its place, and counts it once it is there', async () => {
    const out = new Output()
    out.write(filled(2, 1))
    out.reserve()
    out.write(filled(3, 3))
    expect(out.size).toBe(5)
    out.fill(filled(2, 2))
    expect(out.size).toBe(7)
    expect([...(await bytesOf(out.finish()))]).toEqual([1, 1, 2, 2, 3, 3, 3])
  })

  it('gathers what has piled up into a Blob, in order, but not past a place being held', async () => {
    const MiB = 1024 * 1024
    const out = new Output()
    out.write(filled(20 * MiB, 1))
    expect(out.folded).toHaveLength(0)
    out.reserve()
    out.write(filled(20 * MiB, 3))
    out.write(filled(32 * MiB, 3))
    // Enough has piled up behind the place being held: that much is
    // gathered, and the place stays open.
    expect(out.folded).toHaveLength(0)
    expect(out.pending.slice(2).every((part) => part instanceof Blob)).toBe(true)
    out.fill(filled(1, 2))
    // With nothing held, what came before the place can go too.
    out.write(filled(12 * MiB, 3))
    expect(out.folded).toHaveLength(1)
    out.write(new Blob([filled(1, 4)]))

    const whole = await bytesOf(out.finish())
    expect(whole.length).toBe(84 * MiB + 2)
    expect([whole[0], whole[20 * MiB - 1], whole[20 * MiB], whole[20 * MiB + 1], whole[84 * MiB], whole[84 * MiB + 1]]).toEqual([
      1, 1, 2, 3, 3, 4
    ])
  })

  it('does not keep an archive of entries each written behind a held header in memory', async () => {
    // Every entry of an all-encrypted archive is written that way.
    const MiB = 1024 * 1024
    const out = new Output()
    for (let entry = 0; entry < 60; entry++) {
      out.reserve()
      for (let chunk = 0; chunk < 3; chunk++) {
        out.write(filled(MiB, entry))
      }
      out.fill(filled(30, 255))
    }
    const held = out.pending.reduce((total, part) => total + (part instanceof Uint8Array ? part.length : 0), 0)
    expect(out.folded.length).toBeGreaterThan(0)
    expect(held).toBeLessThan(70 * MiB)
    expect(out.size).toBe(60 * (3 * MiB + 30))
    const whole = await bytesOf(out.finish())
    expect(whole.length).toBe(out.size)
    expect([whole[0], whole[30], whole[3 * MiB + 30], whole[3 * MiB + 60], whole[whole.length - 1]]).toEqual([
      255, 0, 255, 1, 59
    ])
  })

  it('lets go of a held place and everything written behind it', async () => {
    const out = new Output()
    out.write(filled(2, 1))
    out.reserve()
    out.write(filled(40 * 1024 * 1024, 9))
    out.discard()
    expect(out.size).toBe(2)
    out.write(filled(1, 2))
    expect([...(await bytesOf(out.finish()))]).toEqual([1, 1, 2])
  })

  it('refuses to finish, or to hold a second place, while one is held', () => {
    const out = new Output()
    out.reserve()
    expect(() => out.reserve()).toThrow(/already/)
    expect(() => out.finish()).toThrow(/never filled/)
  })
})
