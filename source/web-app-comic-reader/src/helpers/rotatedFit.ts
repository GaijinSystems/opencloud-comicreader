import type { FitMode } from '../config'

export type Rotation = 0 | 90 | 180 | 270

/** True at 90° and 270°, where a page's displayed aspect ratio is inverted. */
export function isSidewaysRotation(rotation: Rotation): boolean {
  return rotation % 180 !== 0
}

export function nextRotation(rotation: Rotation): Rotation {
  return ((rotation + 90) % 360) as Rotation
}

export interface Size {
  width: number
  height: number
}

export interface RotatedFit {
  /** Size to set on the <img> itself, before the transform is applied. */
  image: Size
  /**
   * Size of the box the image occupies once rotated: the image size with its
   * axes swapped. The wrapper is given these dimensions so the surrounding
   * layout sees a plain, correctly sized box and never has to reason about
   * the transform — which is what keeps centring and scroll geometry right.
   */
  footprint: Size
}

/**
 * Scale for a sideways page, per fit mode.
 *
 * The modes split into two kinds, deliberately:
 *
 * **fit-page keeps the size the page already had.** Turning a magazine
 * sideways does not make it bigger, and does not make it easier or harder to
 * read; there is no reason for this reader to behave differently. So the
 * scale is the one the page would have upright. It is then clamped so the
 * rotated footprint still fits the container, because this mode promises the
 * whole page is visible and on a narrow viewport a sideways page can exceed
 * the width even at its upright scale. The clamp only ever shrinks.
 *
 * **fit-width, fit-height and original follow what is on screen.** "Fit the
 * width" means the width the reader is looking at, which after a quarter turn
 * is the page's height. Anything else would make the button lie about what it
 * does. `original` means one image pixel per screen pixel and so is unaffected
 * by orientation.
 */
function scaleFor(
  natural: Size,
  container: Size,
  fitMode: FitMode
): number {
  const usableWidth = Math.max(container.width, 1)
  const usableHeight = Math.max(container.height, 1)

  // Sideways, the page presents its height as width and vice versa.
  const displayedWidth = natural.height
  const displayedHeight = natural.width

  switch (fitMode) {
    case 'fit-width':
      return usableWidth / displayedWidth
    case 'fit-height':
      return usableHeight / displayedHeight
    case 'original':
      return 1
    case 'fit-page':
    default: {
      const upright = Math.min(usableWidth / natural.width, usableHeight / natural.height)
      const rotated = Math.min(usableWidth / displayedWidth, usableHeight / displayedHeight)
      return Math.min(upright, rotated)
    }
  }
}

/**
 * Works out how large a rotated page should be drawn.
 *
 * CSS `transform: rotate()` does not change an element's layout box: a
 * portrait image rotated 90° still *occupies* portrait dimensions while
 * *appearing* landscape. So the rotated size has to be expressed as real
 * layout, not left to a visual effect — otherwise the row centres the wrong
 * box and the scroll container reports the wrong extent, which shows up as a
 * page that is clipped on one side and cannot be scrolled to.
 *
 * See `scaleFor` for how each fit mode sizes a rotated page: fit-page keeps
 * the upright size, the others follow the on-screen orientation.
 *
 * Returns null for rotations that preserve the aspect ratio (0° and 180°),
 * where the upright sizing remains correct and none of this is needed.
 */
export function rotatedFit(
  natural: Size,
  container: Size,
  fitMode: FitMode,
  rotation: Rotation
): RotatedFit | null {
  if (!isSidewaysRotation(rotation)) {
    return null
  }
  if (
    !natural.width ||
    !natural.height ||
    !Number.isFinite(natural.width) ||
    !Number.isFinite(natural.height)
  ) {
    return null
  }

  const scale = scaleFor(natural, container, fitMode)

  if (!Number.isFinite(scale) || scale <= 0) {
    return null
  }

  return {
    image: { width: natural.width * scale, height: natural.height * scale },
    footprint: { width: natural.height * scale, height: natural.width * scale }
  }
}
