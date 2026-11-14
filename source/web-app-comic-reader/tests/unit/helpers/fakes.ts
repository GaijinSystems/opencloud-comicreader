import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { vi } from 'vitest'

import type { OpenComicOptions } from '../../../src/archive/openArchive'
import type { ArchiveAdapter, ComicPage } from '../../../src/archive/types'
import type { WorkerLike } from '../../../src/archive/workerRequest'
import { MB } from '../../../src/config'

/**
 * Stand-ins shared by the specs, so a change to the interfaces they imitate
 * is made in one place.
 */

/** A page body, as every back end returns one. */
export const body = (...values: number[]) => new Blob([new Uint8Array(values)])

/** An adapter that lists nothing and reads every entry as a one-byte Blob. */
export function makeAdapter(overrides: Partial<ArchiveAdapter> = {}): ArchiveAdapter {
  return {
    format: 'cbz',
    dropped: null,
    unsupportedEntries: () => new Set<number>(),
    listEntries: () => [],
    readEntry: async (index: number) => body(index),
    readText: async () => null,
    close: async () => {},
    ...overrides
  }
}

/** `count` pages in reading order, each mapped to the entry of the same index. */
export function makePages(count: number, overrides: Partial<ComicPage> = {}): ComicPage[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    entryIndex: index,
    name: `page${index}.png`,
    size: 100,
    mimeType: 'image/png',
    ...overrides
  }))
}

/** Options for openComic with small limits and no credentials. */
export function openComicOptions(overrides: Partial<OpenComicOptions> = {}): OpenComicOptions {
  return {
    space: {} as SpaceResource,
    resource: { name: 'book.cbz', size: 0 } as unknown as Resource,
    getUrlForResource: async () => 'https://files.example/book.cbz',
    getHeaders: () => ({}),
    trustedOrigins: [],
    rangeThresholdBytes: 8 * MB,
    maxDownloadBytes: 64 * MB,
    maxPages: 100,
    maxPageBytes: MB,
    enableJxl: false,
    bulkExtractLimitMb: 16,
    ...overrides
  }
}

/**
 * A stand-in for OpenCloud's button (OcButton), which the host supplies.
 * It keeps the real button's two props apart, as OcButton does: `type` is
 * the element to render and `submit` the native button type, which defaults
 * to "button", not "submit". A more lenient stand-in once let a prompt ship
 * whose button did nothing; tests/unit/passwordFlow.spec.ts mounts the real
 * one for that reason.
 */
export const OcButtonStub = {
  props: {
    type: { default: 'button' },
    submit: { default: 'button' },
    disabled: Boolean,
    href: String
  },
  template:
    '<component :is="type" class="oc-button" :href="href" ' +
    ':type="type === \'button\' ? submit : undefined" :disabled="disabled"><slot /></component>'
}

/** The first bytes of a PNG: all a page needs to be in these tests. */
export const PIXEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

/** A zip of two pages under the password "comic", encrypted as `options` say. */
export async function lockedZip(options: Record<string, unknown>): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { password: 'comic', ...options })
  await writer.add('p1.png', new Uint8ArrayReader(PIXEL))
  await writer.add('p2.png', new Uint8ArrayReader(PIXEL))
  return writer.close()
}

/** Answers every fetch with `bytes`, and says so each time. */
export function serveBytes(bytes: Uint8Array, onFetch: () => void = () => {}) {
  vi.stubGlobal('fetch', async () => {
    onFetch()
    return new Response(bytes as BodyInit)
  })
}

/** A scripted decoder worker: records what it is sent, and answers when told to. */
export class FakeWorker<Answer> implements WorkerLike<Answer> {
  onmessage: WorkerLike<Answer>['onmessage'] = null
  onerror: WorkerLike<Answer>['onerror'] = null
  terminated = false
  posted: unknown[] = []

  postMessage(message: unknown) {
    this.posted.push(message)
  }
  terminate() {
    this.terminated = true
  }
  reply(data: Answer | { type: 'progress' } | { type: 'error'; message: string }) {
    this.onmessage?.({ data } as MessageEvent<Answer>)
  }
}

/** The two ways zip encrypts, as options for zip.js's writer. */
export const ZIP_SCHEMES: Array<[string, Record<string, unknown>]> = [
  ['AES-256', { encryptionStrength: 3 }],
  ['ZipCrypto', { zipCrypto: true }]
]

/**
 * Rewrites the compression method of the named entries to bzip2, in both
 * of each entry's headers. For an AES entry the method lives in the AES
 * extra field (the header itself says 99), so it is rewritten there. The
 * data is left as it was, which no test here goes on to decode.
 */
export function asBzip2(zipBytes: Uint8Array, names: string[]): Uint8Array {
  const bytes = zipBytes.slice()
  const view = new DataView(bytes.buffer)
  const decoder = new TextDecoder()
  for (let offset = 0; offset + 46 <= bytes.length; offset++) {
    const signature = view.getUint32(offset, true)
    const local = signature === 0x04034b50
    if (!local && signature !== 0x02014b50) {
      continue
    }
    const methodAt = offset + (local ? 8 : 10)
    const nameLength = view.getUint16(offset + (local ? 26 : 28), true)
    const extraLength = view.getUint16(offset + (local ? 28 : 30), true)
    const nameStart = offset + (local ? 30 : 46)
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    if (!names.includes(name)) {
      continue
    }
    if (view.getUint16(methodAt, true) !== 99) {
      view.setUint16(methodAt, 12, true)
      continue
    }
    // AES: find extra field 0x9901; its last two bytes are the method.
    const extraEnd = nameStart + nameLength + extraLength
    for (let field = nameStart + nameLength; field + 4 <= extraEnd; ) {
      const size = view.getUint16(field + 2, true)
      if (view.getUint16(field, true) === 0x9901) {
        view.setUint16(field + 4 + size - 2, 12, true)
      }
      field += 4 + size
    }
  }
  return bytes
}
