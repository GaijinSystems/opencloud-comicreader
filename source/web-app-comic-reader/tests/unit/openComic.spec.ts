import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter, configure } from '@zip.js/zip.js'

import { openComic } from '../../src/archive/openArchive'
import { openComicOptions } from './helpers/fakes'
import { shutdownZipWorkers } from '../../src/archive/zipAdapter'

/**
 * openComic end to end over a zip built here, with the network stubbed. The
 * helpers it composes are tested on their own; these pin the wiring between
 * them, which is where an index quietly ends up applied to the wrong list.
 */

configure({ useWebWorkers: false })

afterEach(() => vi.unstubAllGlobals())
afterAll(async () => {
  await shutdownZipWorkers()
})

async function buildZip(members: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const [name, content] of Object.entries(members)) {
    await writer.add(
      name,
      typeof content === 'string' ? new TextReader(content) : new Uint8ArrayReader(content)
    )
  }
  return writer.close()
}

const PIXEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

const options = openComicOptions

describe('openComic', () => {
  it('applies ComicInfo page indices to the list before deleted pages are removed', async () => {
    // Image 0 is deleted and image 2 is a double page. Once page 0 is gone
    // the double page sits at position 1, not 2.
    const bytes = await buildZip({
      'p1.png': PIXEL,
      'p2.png': PIXEL,
      'p3.png': PIXEL,
      'p4.png': PIXEL,
      'ComicInfo.xml': `<ComicInfo><Pages>
        <Page Image="0" Type="Deleted" />
        <Page Image="2" DoublePage="true" />
      </Pages></ComicInfo>`
    })
    vi.stubGlobal('fetch', async () => new Response(bytes as BodyInit))

    const opened = await openComic(options())
    try {
      expect(opened.pages.map((page) => page.name)).toEqual(['p2.png', 'p3.png', 'p4.png'])
      expect([...opened.widePages]).toEqual([1])
      expect(opened.pages[1].name).toBe('p3.png')
    } finally {
      await opened.adapter.close()
    }
  })

  it('reports a connection that fails as a network error, not a corrupt file', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(openComic(options())).rejects.toMatchObject({ code: 'network' })
  })

  it('reports a failure to resolve the download location as a network error', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('must not fetch')
    })
    await expect(
      openComic({
        ...options(),
        getUrlForResource: async () => {
          throw new Error('PROPFIND failed')
        }
      })
    ).rejects.toMatchObject({ code: 'network' })
  })
})
