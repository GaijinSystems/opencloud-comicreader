/**
 * Writes tests/fixtures/sevenzip/no-checksums*.cb7: password-protected 7z
 * archives (password "comic") that record no checksum for their entries.
 *
 * 7-Zip never writes such an archive, which is why this script builds one
 * by hand. It matters because 7z has no other way to tell that a password
 * is wrong: without checksums 7-Zip's reader reports success whatever the
 * password made of the data, and the extraction loop has to judge by what
 * came out (public/vendor/sevenzip/sevenzip-extract.mjs).
 *
 * Pages each in a block of its own, stored and encrypted with AES-256
 * as 7z does it: key = SHA-256 over (password as UTF-16LE + counter) for
 * 2^cycles rounds, CBC with an IV per block, zero padding to the block size.
 *
 * Needs Node 22 or later (zlib.crc32). The output is committed.
 *
 *   node scripts/make-sevenzip-nocrc-fixture.mjs
 */
import { createCipheriv, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const PASSWORD = 'comic'
/** 2^6 rounds: quick to derive, and the reader does not care how many. */
const CYCLES = 6
const AES = Buffer.from([0x06, 0xf1, 0x07, 0x01])

/** The smallest PNG there is: one transparent pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
/** What a page holds when it is not an image at all. */
const TEXT = Buffer.from('not an image, whatever its name says\n')

/**
 * Forty pages in most: enough that judging by one of them would be judging
 * by luck. With a wrong password each page decrypts to noise of its own
 * (each block has its own IV), and noise begins like an image now and then.
 * `others` of them hold text under a .png name, for the rule that the
 * password is right when at least half the pages are what they are named as.
 */
const pages = (count, others = 0) =>
  Array.from({ length: count }, (_, index) => ({
    name: `p${String(index + 1).padStart(2, '0')}.png`,
    data: index < others ? TEXT : PNG
  }))
/** One block per file, which is how every fixture but the last is laid out. */
const blockEach = (files) => files.map((file) => [file])

/** Each fixture is a list of blocks, and each block a list of files. */
const FIXTURES = [
  { name: 'no-checksums.cb7', blocks: blockEach(pages(40)) },
  { name: 'no-checksums-some-other.cb7', blocks: blockEach(pages(40, 10)) },
  { name: 'no-checksums-mostly-other.cb7', blocks: blockEach(pages(40, 30)) },
  // An empty file that has a place in an encrypted block and a checksum
  // (of nothing: zero). 7-Zip passes it without decrypting a byte, under
  // any password, so it must not be taken for proof of one.
  {
    name: 'no-checksums-empty-entry.cb7',
    blocks: [
      [{ name: 'empty.txt', data: Buffer.alloc(0), checksum: true }, pages(1)[0]],
      ...blockEach(pages(6).slice(1))
    ]
  }
]

const u32 = (value) => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value >>> 0)
  return bytes
}
const u64 = (value) => {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64LE(BigInt(value))
  return bytes
}
/** 7z's variable-length number. (The length of the names needs two bytes.) */
function number(value) {
  let v = BigInt(value)
  let first = 0
  let mask = 0x80
  let extra = 0
  for (; extra < 8; extra++) {
    if (v < 1n << BigInt(7 * (extra + 1))) {
      first |= Number(v >> BigInt(8 * extra))
      break
    }
    first |= mask
    mask >>= 1
  }
  const out = [first]
  for (let index = 0; index < extra; index++) {
    out.push(Number((v >> BigInt(8 * index)) & 0xffn))
  }
  return Buffer.from(out)
}

function key() {
  const password = Buffer.from(PASSWORD, 'utf16le')
  const hash = createHash('sha256')
  for (let round = 0n; round < 1n << BigInt(CYCLES); round++) {
    hash.update(password)
    hash.update(u64(round))
  }
  return hash.digest()
}

/** Each block's IV, from its position, so that the output is the same every run. */
const ivFor = (index) => createHash('sha256').update(`iv ${index}`).digest().subarray(0, 16)

function encrypt(plain, iv) {
  const cipher = createCipheriv('aes-256-cbc', key(), iv)
  cipher.setAutoPadding(false)
  const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)])
  return Buffer.concat([cipher.update(padded), cipher.final()])
}

function archiveOf(blocks) {
  const files = blocks.flat()
  const packed = blocks.map((block, index) =>
    encrypt(Buffer.concat(block.map((file) => file.data)), ivFor(index))
  )
  const parts = []
  const push = (...items) =>
    parts.push(...items.map((item) => (typeof item === 'number' ? Buffer.from([item]) : item)))

  push(0x01, 0x04) // Header, MainStreamsInfo
  // PackInfo: where the packed streams start, how many, their sizes.
  push(0x06, number(0), number(blocks.length), 0x09, ...packed.map((p) => number(p.length)), 0x00)
  // UnpackInfo: one folder per block, each a single AES coder. Its 18
  // property bytes: the round count with the "has an IV" bit, the IV's
  // length less one, and the IV.
  push(0x07, 0x0b, number(blocks.length), 0x00)
  blocks.forEach((_block, index) => {
    push(number(1), AES.length | 0x20, AES, number(18), CYCLES | 0x40, 0x0f, ivFor(index))
  })
  push(
    0x0c,
    ...blocks.map((block) => number(block.reduce((total, file) => total + file.data.length, 0))),
    0x00
  )
  // SubStreamsInfo: how many files each folder holds, and the sizes of all
  // but the last in each.
  push(0x08, 0x0d, ...blocks.map((block) => number(block.length)))
  push(0x09, ...blocks.flatMap((block) => block.slice(0, -1).map((file) => number(file.data.length))))
  // Checksums: the point of this file is that there are none, bar the ones
  // a fixture asks for. A bit per file says which are present.
  if (files.some((file) => file.checksum)) {
    const present = Buffer.alloc(Math.ceil(files.length / 8))
    files.forEach((file, index) => {
      if (file.checksum) {
        present[index >> 3] |= 0x80 >> (index & 7)
      }
    })
    push(0x0a, 0x00, present, ...files.filter((file) => file.checksum).map((file) => u32(zlib.crc32(file.data))))
  }
  push(0x00, 0x00)
  // FilesInfo: the names.
  const names = Buffer.concat(files.map((file) => Buffer.from(`${file.name}\0`, 'utf16le')))
  push(0x05, number(files.length), 0x11, number(names.length + 1), 0x00, names, 0x00, 0x00)

  const header = Buffer.concat(parts)
  const body = Buffer.concat(packed)
  const start = Buffer.concat([u64(body.length), u64(header.length), u32(zlib.crc32(header))])
  return Buffer.concat([
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]),
    u32(zlib.crc32(start)),
    start,
    body,
    header
  ])
}

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'sevenzip')
for (const { name, blocks } of FIXTURES) {
  const archive = archiveOf(blocks)
  writeFileSync(resolve(directory, name), archive)
  console.log(`wrote ${name} (${archive.length} bytes)`)
}
