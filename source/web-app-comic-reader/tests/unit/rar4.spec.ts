import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspectRar4 } from '../../src/archive/rar4'
import { syntheticRar4 } from './helpers/rar4Builder'

const fixture = (name: string) => resolve(__dirname, '../fixtures/rar', name)

function bytes(path: string): Uint8Array {
  const data = readFileSync(path)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

describe('inspectRar4', () => {
  it('counts the file entries of a non-solid RAR4', async () => {
    // a.png, b.png, sub/c.png, notes.txt. The archive also holds a symlink,
    // which must not be counted — see the next test.
    expect(await inspectRar4(bytes(fixture('rar4-plain.cbr')))).toEqual({
      entryCount: 4,
      solid: false,
      encrypted: false
    })
  })

  it('excludes symlinks, which libarchive does not surface', async () => {
    // rar4-plain.cbr has five headers, one of them link.png -> a.png.
    // libarchive enumerates four. Counting the symlink would report a
    // shortfall of one and warn about a perfectly intact archive; every
    // non-solid mismatch seen across libarchive's own RAR corpus was this.
    expect((await inspectRar4(bytes(fixture('rar4-plain.cbr'))))?.entryCount).toBe(4)
  })

  it('flags a solid RAR4 and counts what it should contain', async () => {
    // The detector's only true positive: libarchive returns 1 of these 4.
    expect(await inspectRar4(bytes(fixture('rar4-solid.cbr')))).toEqual({
      entryCount: 4,
      solid: true,
      encrypted: false
    })
  })

  it('returns null for RAR5, a different container libarchive handles', async () => {
    expect(await inspectRar4(bytes(fixture('rar5-plain.cbr')))).toBeNull()
    expect(await inspectRar4(bytes(fixture('rar5-solid.cbr')))).toBeNull()
  })

  it('counts a multi-entry RAR4 built by the fixture writer', async () => {
    const path = resolve(__dirname, '../fixtures/sample.cbr')
    if (!existsSync(path)) {
      return
    }
    const result = await inspectRar4(bytes(path))
    expect(result?.entryCount).toBe(9)
    expect(result?.solid).toBe(false)
  })

  it('returns null for things that are not RAR4', async () => {
    expect(
      await inspectRar4(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    ).toBeNull()
    expect(await inspectRar4(new Uint8Array(4))).toBeNull()
    expect(await inspectRar4(new Uint8Array(0))).toBeNull()
  })

  it('resolves rather than rejecting on a truncated archive', async () => {
    const full = bytes(fixture('rar4-plain.cbr'))
    for (const cut of [20, 40, 100, 200]) {
      await expect(inspectRar4(full.slice(0, cut))).resolves.not.toThrow()
    }
  })

  it('does not hang on a header claiming an absurd size', async () => {
    const bad = new Uint8Array(64)
    bad.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
    bad[7 + 2] = 0x74
    await expect(inspectRar4(bad)).resolves.toBeNull()
  })
})

describe('inspectRar4 flags', () => {
  it('reports a password-protected archive', async () => {
    expect(await inspectRar4(syntheticRar4({ encrypted: true }))).toEqual({
      entryCount: 3,
      solid: false,
      encrypted: true
    })
  })

  it('reports an archive whose encryption starts after the first entry', async () => {
    // libarchive checks the first entry only and unarr none, so without this
    // such a comic opens as a run of unreadable pages with no explanation.
    expect(await inspectRar4(syntheticRar4({ encrypted: 1 }))).toMatchObject({ encrypted: true })
  })

  it('skips a file block’s data even when its header does not flag a data area', async () => {
    // Otherwise the walk would read the data as headers. Clear the flag on
    // the first file header and fill its data with what looks like a solid,
    // encrypted file header: neither must be believed.
    const data = syntheticRar4({ members: 2, packedBytes: 64 })
    const firstFile = 7 + 13
    new DataView(data.buffer).setUint16(firstFile + 3, 0, true)
    const dataArea = firstFile + 32 + 'page0.png'.length
    data[dataArea + 2] = 0x74
    new DataView(data.buffer).setUint16(dataArea + 3, 0x0014, true)
    new DataView(data.buffer).setUint16(dataArea + 5, 32, true)

    expect(await inspectRar4(data)).toEqual({ entryCount: 2, solid: false, encrypted: false })
  })

  it('reports solid and encrypted independently', async () => {
    expect(await inspectRar4(syntheticRar4({ solid: true, encrypted: true }))).toMatchObject({
      solid: true,
      encrypted: true
    })
    expect(await inspectRar4(syntheticRar4({ solid: true }))).toMatchObject({
      solid: true,
      encrypted: false
    })
  })
})

describe('inspectRar4 over a Blob', () => {
  // The reader hands it the downloaded Blob, read a window at a time, so the
  // archive is never pulled into memory just to count its headers.
  it.each(['rar4-plain.cbr', 'rar4-solid.cbr', 'rar5-plain.cbr'])(
    'agrees with the in-memory walk for %s',
    async (name) => {
      const data = bytes(fixture(name))
      expect(await inspectRar4(new Blob([data as BlobPart]))).toEqual(await inspectRar4(data))
    }
  )

  it('reads only small windows, never the whole file', async () => {
    // Members of 300 kB put the headers several windows apart.
    const data = syntheticRar4({ members: 5, packedBytes: 300_000 })
    const blob = new Blob([data as BlobPart])
    const sliced: number[] = []
    const slice = blob.slice.bind(blob)
    blob.slice = (start?: number, end?: number) => {
      sliced.push((end ?? blob.size) - (start ?? 0))
      return slice(start, end)
    }

    expect(await inspectRar4(blob)).toEqual({ entryCount: 5, solid: false, encrypted: false })
    expect(await inspectRar4(data)).toEqual({ entryCount: 5, solid: false, encrypted: false })
    expect(Math.max(...sliced)).toBeLessThanOrEqual(64 * 1024)
    // One read per header, give or take; nowhere near the 1.5 MB file.
    expect(sliced.reduce((total, size) => total + size, 0)).toBeLessThan(data.length / 2)
  })

  it('resolves to null when the Blob cannot be read', async () => {
    const blob = new Blob([bytes(fixture('rar4-plain.cbr')) as BlobPart])
    blob.slice = () => {
      throw new Error('gone')
    }
    expect(await inspectRar4(blob)).toBeNull()
  })
})
