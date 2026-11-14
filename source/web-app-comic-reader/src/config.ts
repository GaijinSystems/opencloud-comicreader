import type { AppConfigObject } from '@opencloud-eu/web-pkg'

export const FIT_MODES = ['fit-page', 'fit-width', 'fit-height', 'original'] as const
export const SPREAD_MODES = ['single', 'double', 'auto'] as const
export type FitMode = (typeof FIT_MODES)[number]
export type SpreadMode = (typeof SPREAD_MODES)[number]

export interface ComicReaderConfig {
  /** Become the default handler on left-click for comic extensions. */
  registerAsDefault: boolean
  /** Hard cap for formats that must be downloaded in full. */
  maxArchiveSizeMb: number
  /** Zip files below this size are downloaded rather than range-read. */
  rangeThresholdMb: number
  /** Above this, a solid RAR/7z is not bulk-extracted into memory. */
  bulkExtractLimitMb: number
  /** Pages kept decoded on each side of the current page. */
  cacheRadius: number
  /** Pages fetched ahead of the reading position. */
  prefetchPages: number
  /** Refuse absurd page counts rather than locking up the tab. */
  maxPages: number
  /** Per-page uncompressed ceiling, a decompression-bomb guard. */
  maxPageSizeMb: number
  defaultFitMode: FitMode
  defaultSpread: SpreadMode
  /** JPEG XL has partial browser support, so it is opt-in. */
  enableJxl: boolean
  /** Remember the last page read, per file, in local storage. */
  rememberPosition: boolean
  /** Override for where `public/` assets are served from. */
  assetBaseUrl: string | null
}

export const DEFAULT_CONFIG: ComicReaderConfig = {
  registerAsDefault: true,
  maxArchiveSizeMb: 1024,
  rangeThresholdMb: 8,
  bulkExtractLimitMb: 256,
  cacheRadius: 8,
  prefetchPages: 3,
  maxPages: 5000,
  maxPageSizeMb: 64,
  defaultFitMode: 'fit-page',
  defaultSpread: 'auto',
  enableJxl: false,
  rememberPosition: true,
  assetBaseUrl: null
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(parsed, min), max)
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/**
 * Reads admin configuration, clamping every value into a sane range.
 *
 * Config comes from `apps.yaml` or a `config.json` an admin edits by hand, so
 * it is treated as untrusted input: a typo should degrade to a default rather
 * than produce a reader that allocates unbounded memory.
 */
export function readConfig(raw: AppConfigObject | undefined | null): ComicReaderConfig {
  const config = (raw ?? {}) as Record<string, unknown>

  return {
    registerAsDefault: asBoolean(config.registerAsDefault, DEFAULT_CONFIG.registerAsDefault),
    maxArchiveSizeMb: clampNumber(config.maxArchiveSizeMb, DEFAULT_CONFIG.maxArchiveSizeMb, 1, 8192),
    rangeThresholdMb: clampNumber(config.rangeThresholdMb, DEFAULT_CONFIG.rangeThresholdMb, 0, 1024),
    bulkExtractLimitMb: clampNumber(
      config.bulkExtractLimitMb,
      DEFAULT_CONFIG.bulkExtractLimitMb,
      0,
      2048
    ),
    cacheRadius: clampNumber(config.cacheRadius, DEFAULT_CONFIG.cacheRadius, 1, 64),
    prefetchPages: clampNumber(config.prefetchPages, DEFAULT_CONFIG.prefetchPages, 0, 16),
    maxPages: clampNumber(config.maxPages, DEFAULT_CONFIG.maxPages, 1, 100000),
    maxPageSizeMb: clampNumber(config.maxPageSizeMb, DEFAULT_CONFIG.maxPageSizeMb, 1, 512),
    defaultFitMode: asEnum(config.defaultFitMode, FIT_MODES, DEFAULT_CONFIG.defaultFitMode),
    defaultSpread: asEnum(config.defaultSpread, SPREAD_MODES, DEFAULT_CONFIG.defaultSpread),
    enableJxl: asBoolean(config.enableJxl, DEFAULT_CONFIG.enableJxl),
    rememberPosition: asBoolean(config.rememberPosition, DEFAULT_CONFIG.rememberPosition),
    assetBaseUrl: typeof config.assetBaseUrl === 'string' ? config.assetBaseUrl : null
  }
}

export const MB = 1024 * 1024

/**
 * How many entries an archive may list per page the reader allows. Pages are
 * capped by `maxPages`; this leaves room for folders, metadata and junk
 * without letting a hostile archive list entries without bound.
 */
export const ENTRIES_PER_PAGE_LIMIT = 4

/**
 * How far an archive may expand, as a multiple of its own size, before a
 * back end that unpacks it in one pass refuses or stops. Page images barely
 * compress, so a real comic sits near 1; a much larger ratio is a
 * decompression bomb.
 */
export const EXPANSION_LIMIT = 4

/** Ceiling for small text members such as ComicInfo.xml; real ones are a few KB. */
export const MAX_TEXT_BYTES = MB
