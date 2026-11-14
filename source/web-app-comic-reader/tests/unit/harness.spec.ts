import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { FIT_MODES } from '../../src/config'
import { rotatedFit, type Rotation } from '../../src/helpers/rotatedFit'

/**
 * docs/fit-rotation-harness.html lays pages out the way ReaderViewport.vue
 * does, so the geometry can be checked in a real browser without OpenCloud.
 * That is only worth anything while its copies of the component's styles are
 * exact, so they are compared here, mechanically. A harness that has drifted
 * passes while the app fails, which is how the original layout bug hid.
 */

const component = readFileSync(
  resolve(__dirname, '../../src/components/ReaderViewport.vue'),
  'utf8'
)
const harness = readFileSync(resolve(__dirname, '../../docs/fit-rotation-harness.html'), 'utf8')

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** The text after `start` up to the next `end`. Throws if either is missing. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0) {
    throw new Error(`could not find the text between "${start}" and "${end}"`)
  }
  return text.slice(from + start.length, to)
}

/** The object a function in `text` returns: what follows its first `return {`. */
function returned(text: string, signature: string): string {
  return between(text.slice(text.indexOf(signature)), 'return {', '\n  }')
}

describe('the layout harness mirrors ReaderViewport.vue', () => {
  it('has the same per-mode layout table, character for character', () => {
    const inComponent = between(
      component,
      'const FIT_LAYOUT: Record<FitMode, FitLayout> = ',
      '\n\nconst layout = '
    )
    const inHarness = between(
      between(harness, '/* BEGIN FIT_LAYOUT */', '/* END FIT_LAYOUT */'),
      'const FIT_LAYOUT = ',
      '\n}\n'
    )
    expect(squash(`${inHarness}\n}`)).toBe(squash(inComponent))
  })

  it('reserves the scrollbar for a sideways page the same way', () => {
    const inComponent = between(
      component,
      'const SIDEWAYS_SCROLL: Partial<Record<FitMode, CSSProperties>> = ',
      '\n}\n'
    )
    const inHarness = between(
      between(harness, '/* BEGIN SIDEWAYS_SCROLL */', '/* END SIDEWAYS_SCROLL */'),
      'const SIDEWAYS_SCROLL = ',
      '\n}\n'
    )
    expect(squash(inHarness)).toBe(squash(inComponent))
    const use = '...(isSidewaysRotation(rotation) ? SIDEWAYS_SCROLL[fitMode] : {})'
    expect(component).toContain(use)
    expect(harness).toContain(use.replace('rotation', 'rot').replace('fitMode', 'mode'))
    // Both size a sideways page from the client box, not the outer one.
    expect(component).toContain('const { clientWidth: width, clientHeight: height } = element')
    expect(harness).toContain('const box={width:vp.clientWidth,height:vp.clientHeight};')
  })

  it.each(['viewport', 'row', 'pane'])('gives the %s the same fixed styles', (level) => {
    const inComponent = between(
      component,
      `const ${level}Style = computed<CSSProperties>(() => ({`,
      `...layout.value.${level}`
    )
    const inHarness = between(harness, `const ${level}Style = (m) => ({`, `...FIT_LAYOUT[m].${level}`)
    expect(squash(inHarness)).toBe(squash(inComponent))
  })

  it('gives an upright image the same fixed styles and the same half-turn', () => {
    const inComponent = between(
      component,
      'const uprightImageStyle = computed<CSSProperties>(() => ({',
      '}))'
    )
    const inHarness = between(harness, 'const uprightImageStyle = (m, rotation) => ({', '\n})')
    expect(squash(inHarness)).toBe(squash(inComponent.replace('layout.value.image', 'FIT_LAYOUT[m].image')))
  })

  it('styles the unreadable-page placeholder the same way', () => {
    const inComponent = between(component, 'const placeholderStyle: CSSProperties = {', '\n}')
    const inHarness = between(harness, 'const placeholderStyle = {', '\n}')
    expect(squash(inHarness)).toBe(squash(inComponent))
  })

  it('sizes and places a sideways page the same way', () => {
    expect(squash(returned(harness, 'function wrapperStyle(box)'))).toBe(
      squash(returned(component, 'function wrapperStyle(page: number)'))
    )
    expect(squash(returned(harness, 'function rotatedImageStyle(box, rotation)'))).toBe(
      squash(returned(component, 'function rotatedImageStyle(page: number)'))
    )
  })

  it('positions the page-turn zones the same way', () => {
    const zones = between(harness, '/* BEGIN ZONES */', '/* END ZONES */')
    const inComponent = between(component, 'const zoneStyle = computed<CSSProperties>(() => ({', '}))')
    const inHarness = between(zones, 'const zoneStyle = (offset) => ({', '})')
    expect(squash(inHarness)).toBe(squash(inComponent.replaceAll('scrollOffset.value', 'offset')))

    // The two bindings on the buttons themselves.
    expect(component).toContain('left: `${scrollOffset.left}px`')
    expect(zones).toContain('left: `${offset.left}px`')
    expect(component).toContain('right: `calc(1rem - ${scrollOffset.left}px)`')
    expect(zones).toContain('right: `calc(1rem - ${offset.left}px)`')
  })

  it('clamps the zones to the content the same way', () => {
    const zones = between(harness, '/* BEGIN ZONES */', '/* END ZONES */')
    for (const line of [
      'top: Math.min(element.scrollTop, Math.max(0, row.scrollHeight - element.clientHeight)),',
      'left: Math.min(element.scrollLeft, Math.max(0, row.scrollWidth - element.clientWidth))'
    ]) {
      expect(component).toContain(line)
      expect(zones).toContain(line)
    }
  })

  it('lifts the retry button above the zones the same way', () => {
    const lift = 'position: relative; z-index: 1'
    expect(component).toContain(`style="${lift}"`)
    expect(harness).toContain(`'${lift}'`)
  })

  it('computes a sideways page’s size exactly as rotatedFit does', () => {
    // The harness's copy is condensed JavaScript, so it is run, not read.
    const source = between(harness, '/* BEGIN ROTATED_FIT */', '/* END ROTATED_FIT */')
    const inHarness = new Function(`${source}; return rotatedFit`)() as typeof rotatedFit

    const naturals = [
      { width: 800, height: 1200 },
      { width: 1600, height: 1200 },
      { width: 1, height: 5000 },
      { width: 0, height: 0 },
      { width: Number.NaN, height: 100 }
    ]
    const containers = [
      { width: 1280, height: 661 },
      { width: 520, height: 300 },
      { width: 300, height: 900 },
      { width: 0, height: 0 }
    ]
    let compared = 0
    for (const natural of naturals) {
      for (const container of containers) {
        for (const mode of FIT_MODES) {
          for (const rotation of [0, 90, 180, 270] as Rotation[]) {
            expect(inHarness(natural, container, mode, rotation)).toEqual(
              rotatedFit(natural, container, mode, rotation)
            )
            compared++
          }
        }
      }
    }
    expect(compared).toBe(5 * 4 * 4 * 4)
  })

  it('loads nothing from the network', () => {
    // A harness that pulled in a CSS framework would compile every class on
    // demand and pass where the app, which ships none, fails.
    expect(harness).not.toMatch(/<script[^>]+src=/i)
    expect(harness).not.toMatch(/<link[^>]+href=/i)
    expect(harness).not.toMatch(/https?:\/\/(?!www\.w3\.org)/i)
  })
})
