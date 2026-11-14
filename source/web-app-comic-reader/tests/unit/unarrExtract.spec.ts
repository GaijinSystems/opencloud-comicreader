import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ExtractLimits, ExtractedEntry } from '../../src/archive/unarrAdapter'

/**
 * The real unarr WebAssembly module and the extraction loop the worker runs,
 * driven here under Node against the RAR fixtures. This is the same file the
 * browser loads, so what passes here is what ships.
 */

type Entry = ExtractedEntry<unknown>
interface Result {
  supported: boolean
  truncated: boolean
  entries: Entry[]
}

const vendor = (name: string) => resolve(__dirname, '../../public/vendor/unarr', name)
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, '../fixtures', name)))

let copyToHeap: (Module: unknown, bytes: { byteLength: number }) => number
let extractBlob: (blob: Blob) => Promise<Result>
let extract: (
  bytes: Uint8Array,
  limits?: Partial<ExtractLimits>,
  store?: (data: Uint8Array) => unknown
) => Promise<Result>

beforeAll(async () => {
  // The module is built from native/unarr, not committed. Say so plainly
  // rather than failing on a missing file.
  if (!existsSync(vendor('unarr-rar.wasm')) || !existsSync(vendor('unarr-rar.mjs'))) {
    throw new Error(
      'The unarr module has not been built. Run `npm run build:native` (needs podman or docker).'
    )
  }
  // Imported by URL so the bundler leaves these plain modules alone.
  const { default: createModule } = await import(
    /* @vite-ignore */ pathToFileURL(vendor('unarr-rar.mjs')).href
  )
  const { extractRar, copyBlobToHeap, ...rest } = await import(
    /* @vite-ignore */ pathToFileURL(vendor('unarr-extract.mjs')).href
  )
  copyToHeap = rest.copyToHeap
  extract = async (bytes, limits = {}, store) => {
    // A fresh instance per archive, as the worker does. In the browser the
    // module finds its .wasm beside itself; here it is told where the file is.
    const Module = await createModule({
      locateFile: () => vendor('unarr-rar.wasm'),
      printErr: () => {}
    })
    return extractRar(
      Module,
      copyToHeap(Module, bytes),
      bytes.byteLength,
      {
        maxEntryBytes: 1024 * 1024,
        maxEntries: 100,
        maxTotalBytes: 16 * 1024 * 1024,
        maxRetainedBytes: 16 * 1024 * 1024,
        solid: true,
        keepExtensions: ['png', 'jpg'],
        keepNames: ['comicinfo.xml'],
        ...limits
      },
      { store }
    )
  }
  extractBlob = async (blob) => {
    const Module = await createModule({
      locateFile: () => vendor('unarr-rar.wasm'),
      printErr: () => {}
    })
    return extractRar(
      Module,
      await copyBlobToHeap(Module, blob),
      blob.size,
      {
        maxEntryBytes: 1024 * 1024,
        maxEntries: 100,
        maxTotalBytes: 16 * 1024 * 1024,
        maxRetainedBytes: 16 * 1024 * 1024,
        solid: true,
        keepExtensions: ['png', 'jpg'],
        keepNames: ['comicinfo.xml']
      },
      {}
    )
  }
})

const isPng = (data?: unknown) =>
  data instanceof Uint8Array &&
  data[0] === 0x89 &&
  data[1] === 0x50 &&
  data[2] === 0x4e &&
  data[3] === 0x47

describe('unarr extraction', () => {
  it('reads every entry of a solid RAR4, which libarchive cannot', async () => {
    const result = await extract(fixture('rar/rar4-solid.cbr'))

    expect(result.supported).toBe(true)
    expect(result.truncated).toBe(false)
    expect(result.entries.map((entry) => entry.name).sort()).toEqual([
      'a.png',
      'b.png',
      'notes.txt',
      'sub/c.png'
    ])
    const pages = result.entries.filter((entry) => entry.name.endsWith('.png'))
    expect(pages.every((page) => isPng(page.data))).toBe(true)
  })

  it('produces the same bytes from a solid archive as from a plain one', async () => {
    const solid = await extract(fixture('rar/rar4-solid.cbr'))
    const plain = await extract(fixture('rar/rar4-plain.cbr'))
    for (const name of ['a.png', 'b.png', 'sub/c.png']) {
      const fromSolid = solid.entries.find((entry) => entry.name === name)?.data
      const fromPlain = plain.entries.find((entry) => entry.name === name)?.data
      expect(fromSolid, name).toBeDefined()
      expect(fromSolid, name).toEqual(fromPlain)
    }
  })

  it('keeps only pages and ComicInfo, but still lists the rest', async () => {
    const result = await extract(fixture('sample.cbr'))
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]))

    expect(byName.get('notes.txt')).toBeDefined()
    expect(byName.get('notes.txt')?.data).toBeUndefined()
    expect(isPng(byName.get('Chapter 1/page1.png')?.data)).toBe(true)
    expect(new TextDecoder().decode(byName.get('ComicInfo.xml')?.data as Uint8Array)).toContain(
      '<ComicInfo>'
    )
  })

  it('reports RAR5 as unsupported rather than failing', async () => {
    const result = await extract(fixture('rar/rar5-solid.cbr'))
    expect(result).toEqual({ supported: false, entries: [], truncated: false })
  })

  it('reports bytes that are not RAR at all as unsupported', async () => {
    const result = await extract(new TextEncoder().encode('this is not an archive, not even close'))
    expect(result.supported).toBe(false)
  })

  it('lists an entry over the per-entry cap without keeping its bytes', async () => {
    // Every fixture page is ~75 bytes.
    const result = await extract(fixture('rar/rar4-solid.cbr'), { maxEntryBytes: 10 })
    expect(result.entries).toHaveLength(4)
    expect(result.entries.every((entry) => entry.data === undefined)).toBe(true)
    // Oversized entries are still decoded, to keep the solid state, so the
    // pass itself completes.
    expect(result.truncated).toBe(false)
  })

  it('stops listing at the entry cap', async () => {
    const result = await extract(fixture('rar/rar4-solid.cbr'), { maxEntries: 2 })
    expect(result.entries).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('stops decoding at the total budget but keeps listing', async () => {
    const result = await extract(fixture('rar/rar4-solid.cbr'), { maxTotalBytes: 100 })
    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(4)
    const decoded = result.entries.filter((entry) => entry.data)
    expect(decoded.length).toBeGreaterThan(0)
    expect(decoded.length).toBeLessThan(3)
  })

  it('hands each kept entry to the store callback, as the worker does to make Blobs', async () => {
    const stored: number[] = []
    const result = await extract(fixture('rar/rar4-solid.cbr'), {}, (data) => {
      stored.push(data.byteLength)
      return new Blob([data as BlobPart])
    })
    const kept = result.entries.filter((entry) => entry.data)
    // Three pages; notes.txt is listed but never stored.
    expect(stored).toHaveLength(3)
    expect(kept.every((entry) => (entry.data as unknown) instanceof Blob)).toBe(true)
  })

  it('reads the same archive when it is copied in from a Blob, as the worker does', async () => {
    const bytes = fixture('rar/rar4-solid.cbr')
    const fromBlob = await extractBlob(new Blob([bytes as BlobPart]))
    const fromBytes = await extract(bytes)
    expect(fromBlob).toEqual(fromBytes)
    expect(fromBlob.entries.filter((entry) => entry.data)).toHaveLength(3)
  })

  it('stops keeping pages at the retained-bytes cap, without ending the pass', async () => {
    // Pages are ~75 bytes each, so 100 bytes has room for exactly one.
    const result = await extract(fixture('rar/rar4-solid.cbr'), { maxRetainedBytes: 100 })
    expect(result.entries).toHaveLength(4)
    expect(result.entries.filter((entry) => entry.data)).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  describe('a damaged entry', () => {
    // sample.cbr stores its members uncompressed, so each PNG sits in the
    // archive as is and one of them can be damaged in place.
    function damageSecondPng(): Uint8Array {
      const bytes = fixture('sample.cbr')
      const starts: number[] = []
      for (let i = 0; i + 4 <= bytes.length; i++) {
        if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47) {
          starts.push(i)
        }
      }
      expect(starts.length).toBeGreaterThanOrEqual(3)
      bytes[starts[1] + 20] ^= 0xff
      return bytes
    }

    const pagesWithData = (result: Result) =>
      result.entries.filter((entry) => /\.(png|jpg)$/i.test(entry.name) && isPng(entry.data)).length

    it('costs only that entry in a non-solid archive', async () => {
      const intact = await extract(fixture('sample.cbr'), { solid: false })
      const damaged = await extract(damageSecondPng(), { solid: false })

      expect(damaged.truncated).toBe(true)
      expect(damaged.entries).toHaveLength(intact.entries.length)
      expect(pagesWithData(damaged)).toBe(pagesWithData(intact) - 1)
    })

    it('ends the pass in a solid archive, where nothing after it can be reached', async () => {
      const damaged = await extract(damageSecondPng(), { solid: true })
      expect(damaged.truncated).toBe(true)
      // Everything is still listed; only the first page was decoded.
      expect(pagesWithData(damaged)).toBe(1)
    })
  })

  it('refuses an archive too large for the module to address', async () => {
    const { default: createModule } = await import(
      /* @vite-ignore */ pathToFileURL(vendor('unarr-rar.mjs')).href
    )
    const Module = await createModule({
      locateFile: () => vendor('unarr-rar.wasm'),
      printErr: () => {}
    })
    expect(() => copyToHeap(Module, { byteLength: 2 ** 31 })).toThrow(/too large/)
    expect(() => copyToHeap(Module, { byteLength: 2 ** 32 + 8 })).toThrow(/too large/)
  })

  it('survives a truncated archive', async () => {
    const whole = fixture('rar/rar4-solid.cbr')
    const result = await extract(whole.slice(0, Math.floor(whole.length * 0.6)))
    expect(result.supported).toBe(true)
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries.length).toBeLessThanOrEqual(4)
  })
})
