/**
 * Works out which pages sit side by side in two-page mode.
 *
 * The rules look arbitrary but all come from how print comics are laid out:
 *
 * - The cover is a single outer page, so pairing it with page 2 puts every
 *   subsequent spread out of phase with the printed book.
 * - Some scans store a genuine double-page spread as one wide image. Pairing
 *   that with a neighbour would show three pages at once, so wide images take
 *   a row to themselves and re-phase everything after them.
 * - Right-to-left reading only reverses the order *within* a row. The sequence
 *   of rows is unchanged, because page numbers still increase.
 */

export interface SpreadOptions {
  /** Indices known to be wider than they are tall. */
  widePages?: ReadonlySet<number>
  /** Show page 0 on its own. True for most western and manga releases. */
  coverAlone?: boolean
  /** Reverse the order of pages within each row. */
  rightToLeft?: boolean
}

export type Spread = number[]

export function buildSpreads(
  pageCount: number,
  { widePages, coverAlone = true, rightToLeft = false }: SpreadOptions = {}
): Spread[] {
  const spreads: Spread[] = []
  let index = 0

  if (pageCount <= 0) {
    return spreads
  }

  if (coverAlone) {
    spreads.push([0])
    index = 1
  }

  while (index < pageCount) {
    const isWide = widePages?.has(index)
    if (isWide) {
      spreads.push([index])
      index += 1
      continue
    }

    const next = index + 1
    // A wide page cannot be the right half of a pair, so the current page is
    // left alone and the wide one starts its own row on the next iteration.
    if (next < pageCount && !widePages?.has(next)) {
      spreads.push(rightToLeft ? [next, index] : [index, next])
      index += 2
    } else {
      spreads.push([index])
      index += 1
    }
  }

  return spreads
}

/** Index of the spread containing a given page. */
export function spreadIndexOfPage(spreads: Spread[], page: number): number {
  for (let i = 0; i < spreads.length; i++) {
    if (spreads[i].includes(page)) {
      return i
    }
  }
  return 0
}

/** Lowest page number in a spread, used to report reading position. */
export function leadPageOfSpread(spread: Spread | undefined): number {
  if (!spread || !spread.length) {
    return 0
  }
  return Math.min(...spread)
}
