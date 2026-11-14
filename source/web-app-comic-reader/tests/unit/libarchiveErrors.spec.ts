import { describe, it, expect } from 'vitest'
import { encryptionErrorFrom } from '../../src/archive/libarchiveAdapter'

/**
 * libarchive's own check for encryption, made at open, misses a 7z archive
 * that keeps its file names readable. The only signal left is the message it
 * gives when a read is refused, so the wordings are pinned here. Both were
 * taken from the real module, reading 7z-encrypted.cb7 and rar5-encrypted.cbr
 * from the format matrix. `npm run verify:formats` reads the same pattern
 * (src/archive/encryptionMessages.json) and checks it against that module.
 */
describe('encryptionErrorFrom', () => {
  it.each([
    'The file content is encrypted, but currently not supported',
    'Reading encrypted data is not currently supported',
    'Passphrase required for this entry',
    'Incorrect passphrase'
  ])('recognises "%s"', (message) => {
    expect(encryptionErrorFrom(new Error(message))).toMatchObject({ code: 'encrypted' })
  })

  it.each([
    'Truncated 7-Zip file body',
    'Damaged 7-Zip archive',
    'Worker call did not respond within 120000ms',
    ''
  ])('leaves "%s" alone', (message) => {
    expect(encryptionErrorFrom(new Error(message))).toBeNull()
  })

  it('copes with things that are not errors', () => {
    expect(encryptionErrorFrom(undefined)).toBeNull()
    expect(encryptionErrorFrom('The file content is encrypted')).toMatchObject({ code: 'encrypted' })
  })

  it('keeps the original error as the cause', () => {
    const original = new Error('Reading encrypted data is not currently supported')
    expect(encryptionErrorFrom(original)?.cause).toBe(original)
  })
})
