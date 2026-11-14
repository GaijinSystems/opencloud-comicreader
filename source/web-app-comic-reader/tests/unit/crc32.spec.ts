import { describe, it, expect } from 'vitest'
import { crc32 } from '../../src/helpers/crc32'

describe('crc32', () => {
  const of = (text: string) => crc32(new TextEncoder().encode(text))

  it('matches the standard check values', () => {
    expect(of('')).toBe(0)
    expect(of('123456789')).toBe(0xcbf43926)
    expect(of('data')).toBe(0xadf3f363)
  })

  it('is unsigned', () => {
    expect(of('123456789')).toBeGreaterThan(0x7fffffff)
  })
})
