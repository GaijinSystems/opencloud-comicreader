import { describe, it, expect } from 'vitest'
import {
  isSidewaysRotation,
  nextRotation,
  rotatedFit,
  type Rotation
} from '../../src/helpers/rotatedFit'

// A tall page in a landscape reading area: the ordinary case.
const portrait = { width: 800, height: 1200 }
const landscapeArea = { width: 1000, height: 600 }

describe('rotation cycling', () => {
  it('advances a quarter turn clockwise and wraps', () => {
    let r: Rotation = 0
    const seen: Rotation[] = []
    for (let i = 0; i < 5; i++) {
      seen.push(r)
      r = nextRotation(r)
    }
    expect(seen).toEqual([0, 90, 180, 270, 0])
  })

  it('is sideways only at a quarter and three-quarter turn', () => {
    expect(isSidewaysRotation(0)).toBe(false)
    expect(isSidewaysRotation(90)).toBe(true)
    // 180 preserves the aspect ratio, so the normal CSS path stays correct.
    expect(isSidewaysRotation(180)).toBe(false)
    expect(isSidewaysRotation(270)).toBe(true)
  })
})

describe('rotatedFit: geometry that does not need computing', () => {
  it('returns nothing for rotations that preserve the aspect ratio', () => {
    expect(rotatedFit(portrait, landscapeArea, 'fit-page', 0)).toBeNull()
    expect(rotatedFit(portrait, landscapeArea, 'fit-page', 180)).toBeNull()
  })

  it('returns nothing before the image has reported its size', () => {
    expect(rotatedFit({ width: 0, height: 0 }, landscapeArea, 'fit-page', 90)).toBeNull()
    expect(rotatedFit({ width: NaN, height: 100 }, landscapeArea, 'fit-page', 90)).toBeNull()
  })

  it('treats 270 exactly like 90, since both swap the axes', () => {
    expect(rotatedFit(portrait, landscapeArea, 'fit-page', 270)).toEqual(
      rotatedFit(portrait, landscapeArea, 'fit-page', 90)
    )
  })
})

describe('rotatedFit: fit-page keeps the size the page already had', () => {
  it('draws the page at its upright scale, not larger', () => {
    // Upright in 1000x600 the page fits at 600/1200 = 0.5. Turning it sideways
    // must not make it bigger: a magazine does not grow when you turn it.
    const fit = rotatedFit(portrait, landscapeArea, 'fit-page', 90)!
    expect(fit.image.width).toBeCloseTo(400)
    expect(fit.image.height).toBeCloseTo(600)
    // The footprint is that box with its axes swapped.
    expect(fit.footprint).toEqual({ width: 600, height: 400 })
  })

  it('shrinks rather than clipping when the rotated page would not fit', () => {
    // A narrow reading area: upright scale is 0.75, but the rotated footprint
    // would then be 900 wide in a 600-wide box. fit-page promises the whole
    // page is visible, so it shrinks.
    const narrow = { width: 600, height: 1000 }
    const fit = rotatedFit(portrait, narrow, 'fit-page', 90)!
    expect(fit.footprint.width).toBeLessThanOrEqual(narrow.width + 0.01)
    expect(fit.footprint.height).toBeLessThanOrEqual(narrow.height + 0.01)
  })

  it('never clips, for any page and area shape', () => {
    const areas = [
      { width: 1000, height: 600 },
      { width: 600, height: 1000 },
      { width: 900, height: 900 },
      { width: 320, height: 240 }
    ]
    const pages = [
      { width: 800, height: 1200 },
      { width: 1600, height: 1200 },
      { width: 1000, height: 1000 },
      { width: 100, height: 150 }
    ]
    for (const area of areas) {
      for (const page of pages) {
        const fit = rotatedFit(page, area, 'fit-page', 90)!
        expect(fit.footprint.width).toBeLessThanOrEqual(area.width + 0.01)
        expect(fit.footprint.height).toBeLessThanOrEqual(area.height + 0.01)
      }
    }
  })

  it('never grows beyond the upright scale', () => {
    const areas = [
      { width: 1000, height: 600 },
      { width: 2000, height: 1800 },
      { width: 600, height: 1000 }
    ]
    for (const area of areas) {
      const upright = Math.min(area.width / portrait.width, area.height / portrait.height)
      const fit = rotatedFit(portrait, area, 'fit-page', 90)!
      const scale = fit.image.width / portrait.width
      expect(scale).toBeLessThanOrEqual(upright + 1e-9)
    }
  })
})

describe('rotatedFit: the other modes follow what is on screen', () => {
  it('fit-width fills the width the reader is looking at', () => {
    // Sideways, the displayed width is the page's height: 1200 -> 1000.
    const fit = rotatedFit(portrait, landscapeArea, 'fit-width', 90)!
    expect(fit.footprint.width).toBeCloseTo(landscapeArea.width)
    // The other axis is free to overflow and scroll.
    expect(fit.footprint.height).toBeGreaterThan(landscapeArea.height)
  })

  it('fit-height fills the height the reader is looking at', () => {
    const fit = rotatedFit(portrait, landscapeArea, 'fit-height', 90)!
    expect(fit.footprint.height).toBeCloseTo(landscapeArea.height)
    expect(fit.footprint.width).toBeCloseTo(900)
  })

  it('original stays one image pixel per screen pixel', () => {
    const fit = rotatedFit(portrait, landscapeArea, 'original', 90)!
    expect(fit.image).toEqual(portrait)
    expect(fit.footprint).toEqual({ width: 1200, height: 800 })
  })

  it('fit-width and fit-height may exceed the area, which is what scrolling is for', () => {
    // Deliberately contrasted with fit-page, which clamps. These two do not:
    // the viewport enables the matching scroll axis for exactly this reason.
    const narrow = { width: 600, height: 1000 }
    const w = rotatedFit(portrait, narrow, 'fit-width', 90)!
    expect(w.footprint.width).toBeCloseTo(narrow.width)
    const h = rotatedFit(portrait, narrow, 'fit-height', 90)!
    expect(h.footprint.height).toBeCloseTo(narrow.height)
  })
})

describe('rotatedFit: degenerate input', () => {
  it('survives a reading area that has collapsed to zero', () => {
    const fit = rotatedFit(portrait, { width: 0, height: 0 }, 'fit-page', 90)
    expect(fit).not.toBeNull()
    expect(fit!.image.width).toBeGreaterThan(0)
    expect(Number.isFinite(fit!.image.width)).toBe(true)
  })
})
