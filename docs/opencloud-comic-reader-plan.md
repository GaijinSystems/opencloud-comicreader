# OpenCloud Comic Reader — Implementation Plan

> **Historical: the plan written before any code existed.** It is kept to show
> what was intended and why, not what was built. The reader diverged from it in
> ways the plan could not have known:
>
> - There is no single archive worker. zip.js and libarchive.js bring their own
>   workers, and unarr (a second RAR decoder) and 7-Zip's 7z reader run in
>   workers of the app's own.
> - libarchive does not read solid RAR4, which the plan assumed it would.
> - The plan's CSP needs (`worker-src blob:`) turned out not to apply; the app
>   needs only `'wasm-unsafe-eval'` in `script-src`.
> - Touch and mobile support, next/previous comic, the sidebar panel,
>   translations and Playwright tests were not built.
>
> For the reader as it is, read the READMEs, `docs/CHANGELOG.md` and
> `SECURITY.md`.

A web app for OpenCloud that registers itself as the default viewer for `.cbz`, `.cbr`, `.cb7` and `.c7z` files, so a click in the file manager opens the comic in an in-browser reader.

---

## 1. Goals and scope

**Must have (v1.0)**
- Click a comic archive in the Files app → reader opens in the app viewport, no download step.
- Formats: CBZ (zip), CBR (rar4 + rar5), CB7 / C7Z (7-zip).
- Page-by-page reading with keyboard, mouse, and touch navigation.
- Fit modes (fit width / fit height / fit page / original), single and two-page spread, right-to-left (manga) mode.
- Natural sort of pages (`page2.jpg` before `page10.jpg`), skips non-image entries and `__MACOSX` junk.
- Works for logged-in users and on public links (`authContext: 'hybrid'`).
- Remembers last-read page per file.
- Reasonable memory behaviour on 300–600 MB archives.

**Should have (v1.x)**
- `ComicInfo.xml` metadata (title, series, issue, page type → cover/bookmarks, `Manga` flag → auto-RTL).
- Thumbnail strip / page grid for jumping.
- "Next / previous comic in this folder."
- Right-sidebar panel showing cover + metadata in the file manager.

**Out of scope for this plan (noted as possible follow-ups)**
- Server-side thumbnails for comic files in the file list (requires a change to the Go thumbnails service in `opencloud-eu/opencloud`).
- Editing / re-packing archives.
- Cross-device sync of reading position (no suitable per-user settings API for third-party apps at present).

---

## 2. How it plugs into OpenCloud

OpenCloud Web apps are separate packages built against `@opencloud-eu/web-pkg` and dropped into `$OC_DATA_DIR/web/assets/apps/<app-name>/`. The runtime discovers them automatically; no server rebuild is needed. The two pieces of the extension system this app uses:

1. **File-type routing** — `appInfo.extensions[]` entries map a file extension to a route inside the app. This is what makes left-click in the Files app open the reader, and adds "Open in Comic Reader" to the context menu / "Open with" for those extensions.
2. **`AppWrapperRoute`** — wraps the reader component, resolves `driveAliasAndItem` from the URL into a `space` + `resource`, handles auth context, and gives the component the resource it should render.

Optional, later:
3. **`sidebarPanel` extension** at extension point `app.files.sidebar` for the metadata panel.

### `src/index.ts` (sketch)

```ts
import { AppWrapperRoute, defineWebApplication } from '@opencloud-eu/web-pkg'
import { useGettext } from 'vue3-gettext'
import translations from '../l10n/translations.json'
import ComicReader from './App.vue'

export default defineWebApplication({
  setup({ applicationConfig }) {
    const { $gettext } = useGettext()
    const appId = 'comic-reader'

    const routes = [
      {
        name: 'comic-reader',
        path: '/:driveAliasAndItem(.*)?',
        component: AppWrapperRoute(ComicReader, {
          applicationId: appId,
          // Do NOT let the wrapper preload the body as text; we stream it ourselves.
          // (Verify exact option name against the current web-pkg AppWrapperRoute source.)
          fileContentOptions: { responseType: 'arraybuffer' }
        }),
        meta: { authContext: 'hybrid', title: $gettext('Comic Reader'), patchCleanPath: true }
      }
    ]

    const comicExt = (extension: string, mimeType: string) => ({
      extension,
      mimeType,
      routeName: 'comic-reader',
      label: $gettext('Open in Comic Reader'),
      hasPriority: true // become the default handler for these extensions
    })

    return {
      appInfo: {
        name: $gettext('Comic Reader'),
        id: appId,
        icon: 'book-read',            // remixicon name
        color: '#5b3fd9',
        defaultExtension: 'cbz',
        extensions: [
          comicExt('cbz', 'application/vnd.comicbook+zip'),
          comicExt('cbr', 'application/vnd.comicbook-rar'),
          comicExt('cb7', 'application/x-cb7'),
          comicExt('c7z', 'application/x-cb7')
        ]
      },
      routes,
      translations,
      extensions: [] // sidebar panel added in phase 4
    }
  }
})
```

Notes:
- Routing is by **extension**, so it does not matter whether the server assigns a mime type to `.cbz`; the mime fields are informational.
- `hasPriority: true` makes the reader the default on left-click. Without it the user would get "Open with…". Make this configurable (`config.registerAsDefault`, default `true`).
- The whole reader lives under `applicationConfig` for admin-tunable settings (see §8).

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ App.vue  (AppWrapperRoute → receives space + resource)           │
│   ├─ useComicArchive()   ── opens archive, exposes page list      │
│   ├─ useReaderState()    ── page index, fit mode, spread, RTL     │
│   ├─ useReadingProgress()── persist last page                     │
│   └─ <ReaderViewport/> <ReaderToolbar/> <PageStrip/> <ErrorState/>│
└───────────────┬──────────────────────────────────────────────────┘
                │ postMessage (transferable ArrayBuffers)
┌───────────────▼──────────────────────────────────────────────────┐
│ archive.worker.ts                                                 │
│   ArchiveAdapter interface                                        │
│     ├─ ZipAdapter      (zip.js, HTTP range reader → lazy pages)   │
│     ├─ RarAdapter      (libarchive.js WASM, full download)        │
│     └─ SevenZipAdapter (libarchive.js WASM, full download)        │
│   PageCache (LRU of decoded entry bytes)                          │
└──────────────────────────────────────────────────────────────────┘
                │ fetch / Range requests (bearer or public-link auth)
        OpenCloud WebDAV (dav/spaces/… or dav/public-files/…)
```

### 3.1 The `ArchiveAdapter` contract

```ts
interface ArchiveEntry { index: number; name: string; size: number; mime: string }

interface ArchiveAdapter {
  open(source: ArchiveSource): Promise<void>       // parse directory / headers
  listEntries(): ArchiveEntry[]                    // all entries, unsorted
  readEntry(index: number): Promise<ArrayBuffer>   // raw bytes of one entry
  readText(name: string): Promise<string | null>   // ComicInfo.xml etc.
  close(): void
}

type ArchiveSource =
  | { kind: 'range'; url: string; size: number; headers: Record<string,string> }
  | { kind: 'buffer'; data: ArrayBuffer }
```

The UI never touches archive libraries; it only sees sorted page descriptors and blob URLs. This keeps the format zoo isolated and unit-testable.

### 3.2 Format strategy

| Format | Library | Strategy | Notes |
|---|---|---|---|
| CBZ | **zip.js** (BSD-3) | `HttpRangeReader`: fetch the central directory from the tail, then fetch each page's bytes on demand with HTTP `Range`. | No full download; first page appears in ~2 round-trips even on a 500 MB file. Falls back to full download if the server refuses ranges or the file is < `rangeThresholdMb`. |
| CBR | **libarchive.js** (MIT, wraps libarchive — BSD, own RAR4/RAR5 reader, not the RARLAB unrar licence) | Download whole file into the worker, open from memory. | RAR solid archives are common in comics; libarchive decodes sequentially, so pre-decode ahead and cache. |
| CB7 / C7Z | **libarchive.js** | Same as CBR. | 7z is almost always solid; extracting page *n* means decompressing pages `0..n`. Decode the whole archive in the background after first page, or in chunks, and store decoded entries in the LRU. |

Why one WASM library for both RAR and 7z: a single ~1.5 MB `.wasm` payload loaded lazily only when a non-zip file is opened, one licence to review, one set of edge cases. `7z-wasm` (LGPL) is a fallback candidate if libarchive's 7z support proves incomplete (e.g. BCJ2 filters — test early).

**Size guards**: `maxArchiveSizeMb` (default 1024) for buffer-mode formats; friendly error with a "Download instead" button above it. The zip range path has no hard cap.

### 3.3 Fetching bytes from OpenCloud

- Get the download URL for the resource via the client service (`clientService.webdav` / `getFileUrl` in `web-pkg` — the same mechanism the built-in preview and pdf-viewer apps use), so both authenticated (`Authorization: Bearer`) and public-link (`public-token`, optional link password) cases are handled by existing helpers.
- For range mode, pass the resolved URL + auth headers into the worker and let zip.js issue `Range` requests. OpenCloud/reva's DAV download handler supports byte ranges (required for video seeking in the preview app already); verify `Accept-Ranges` during Phase 1 spike.
- For buffer mode, fetch with progress (`ReadableStream` reader) so the UI can show a determinate progress bar; transfer the `ArrayBuffer` to the worker (zero-copy).
- Public link with password: web-pkg helpers append the necessary header; nothing special needed beyond using them.

### 3.4 Page pipeline

1. `listEntries()` → filter by extension/magic: `jpg jpeg png gif webp avif bmp` (+ `jxl` only if `config.enableJxl` and a decoder is bundled; otherwise skip with a notice).
2. Drop entries under `__MACOSX/`, hidden files, zero-byte files, and anything `ComicInfo.xml` marks as `Deleted`.
3. Natural sort (`Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`) on full path so nested-folder chapters stay ordered.
4. Page `n` requested → worker `readEntry` → bytes → main thread `new Blob([bytes], {type})` → `URL.createObjectURL`.
5. **Prefetch** `n+1 … n+prefetchCount` (default 3, both directions when in spread mode). **Evict** blob URLs beyond `cacheRadius` (default 8) with `URL.revokeObjectURL` — this is the single biggest lever for keeping tab memory flat.
6. Optional: decode via `createImageBitmap` in the worker and transfer the bitmap, to keep large JPEG decoding off the main thread.

### 3.5 Reader UI

- **Viewport**: single page or two-page spread; spread logic respects cover-alone, RTL page order, and "double page" images (width > height → shown alone).
- **Navigation**: `→ ← Space Shift+Space Home End`, `f` (toggle fit), `d` (spread), `r` (RTL), `Esc` (close → back to folder); click/tap zones left/right/center; swipe on touch; mouse wheel = next/prev in fit-page mode, scroll in fit-width mode.
- **Toolbar** (auto-hides): page `12 / 148`, slider, fit mode, spread, direction, thumbnails, fullscreen, download original, close. Reuse `OcButton`, `OcIcon`, `OcSelect`, `OcDrop` from the design system so it matches the rest of Web and inherits themes.
- **States**: loading (with progress for full-download formats), error (unsupported/ corrupt / too large / no images), empty.
- **Accessibility**: focus management on open, `aria-live` page announcements, all controls keyboard reachable, respects `prefers-reduced-motion`.
- **Mobile**: toolbar collapses to a bottom bar; pinch-zoom via CSS `touch-action` + a lightweight pan/zoom composable (no heavy dependency).

### 3.6 Reading progress

- v1: `localStorage` key `comic-reader:progress:<space.id>:<resource.fileId>` → `{ page, total, updatedAt }`. Keyed by `fileId` (stable across rename/move), pruned to the 500 most recent.
- Restore on open with a small "Resume at page 37?" toast rather than silently jumping.
- Later option: write a `<comic>.progress.json` sidecar only if the admin enables it (`config.progressSidecar`), since it pollutes folders and needs write permission.

---

## 4. Repository layout

Mirrors `opencloud-eu/web-app-skeleton` and the `web-extensions` monorepo conventions (`packages/web-app-*`), so it can later be upstreamed or listed in `awesome-apps` with no restructuring.

```
web-app-comic-reader/
├─ package.json                # name: @opencloud-eu/web-app-comic-reader (or own scope)
├─ vite.config.ts              # defineConfig from @opencloud-eu/extension-sdk
├─ tsconfig.json
├─ README.md / CHANGELOG.md / LICENSE (AGPL-3.0, same as web-extensions)
├─ l10n/                       # translations.json + .pot; wire to Transifex later
├─ public/
│  └─ wasm/                    # libarchive .wasm copied at build (lazy loaded)
├─ src/
│  ├─ index.ts                 # defineWebApplication (§2)
│  ├─ App.vue                  # top-level, receives space/resource from wrapper
│  ├─ config.ts                # typed applicationConfig with defaults
│  ├─ components/
│  │  ├─ ReaderViewport.vue
│  │  ├─ ReaderToolbar.vue
│  │  ├─ PageStrip.vue
│  │  ├─ ComicMetaPanel.vue    # phase 4 sidebar panel
│  │  └─ ErrorState.vue
│  ├─ composables/
│  │  ├─ useComicArchive.ts    # talks to the worker, exposes pages
│  │  ├─ useReaderState.ts
│  │  ├─ usePageCache.ts
│  │  ├─ useReadingProgress.ts
│  │  ├─ useFolderSiblings.ts  # phase 3
│  │  └─ useKeyboardNav.ts
│  ├─ archive/
│  │  ├─ types.ts              # ArchiveAdapter, ArchiveEntry, messages
│  │  ├─ zipAdapter.ts
│  │  ├─ libarchiveAdapter.ts  # rar + 7z
│  │  ├─ sort.ts               # natural sort + filtering
│  │  ├─ comicInfo.ts          # ComicInfo.xml parser
│  │  └─ archive.worker.ts
│  └─ helpers/
│     └─ fileUrl.ts            # resolve download URL + headers via web-pkg
├─ tests/
│  ├─ unit/                    # vitest: sort, comicInfo, adapters against fixtures
│  ├─ fixtures/                # tiny cbz/cbr/cb7 (public-domain pages, <200 KB each)
│  └─ e2e/                     # playwright against a docker-compose OpenCloud
└─ dev/
   └─ docker-compose.yml       # opencloud + this app mounted into web/assets/apps
```

Build output (`dist/`) must contain `manifest.json` + `index.js` + assets; the extension-sdk Vite config produces this. The lazy-loaded WASM must be emitted with a stable relative path (`import.meta.url`-based loading) because the app is served from `/assets/apps/comic-reader/`, not from the site root.

---

## 5. Phased delivery

### Phase 0 — Spike (2–3 days)
Goal: retire the unknowns before writing UI.
- Scaffold from `web-app-skeleton`; confirm the app appears in the app switcher on a local `opencloud-compose` (rolling image).
- Confirm `AppWrapperRoute` can be prevented from preloading the file body, or bypass it and load via the client service directly.
- Confirm DAV supports `Range` on authenticated and public-link downloads; measure time-to-first-page on a 300 MB CBZ with zip.js `HttpRangeReader`.
- Confirm libarchive.js WASM loads under OpenCloud's default **CSP** (needs `script-src 'wasm-unsafe-eval'` and `worker-src blob:` or same-origin). If the default CSP blocks it, document the `csp.yaml` override for admins (proxy service `PROXY_CSP_CONFIG_FILE_LOCATION`) and treat it as a known install step.
- Open one solid RAR5 and one solid 7z (with BCJ2) via libarchive.js; if either fails, evaluate `7z-wasm` / `node-unrar-js` as a backup.

Exit criteria: a page from each of the four formats renders in an `<img>` inside the OpenCloud viewport.

### Phase 1 — MVP reader (1–2 weeks)
- Worker + `ArchiveAdapter` for zip (range + buffer) and libarchive (buffer).
- Filtering, natural sort, page cache with blob URL eviction.
- Single-page viewport, fit modes, keyboard + click navigation, toolbar, loading/error states, size guard with download fallback.
- Registration as default handler for the four extensions; "Open with" entry.
- Unit tests for `sort.ts`, `comicInfo.ts` (stub), adapters against fixtures.
- Dev docker-compose, README with install steps.

### Phase 2 — Reading experience (1 week)
- Two-page spread with cover-alone and wide-page detection; RTL mode.
- Touch: swipe, pinch-zoom, mobile toolbar.
- Prefetch tuning, `createImageBitmap` off-main-thread decoding.
- Reading progress persistence + resume toast.
- Fullscreen, page slider, `Esc` back-to-folder.
- Accessibility pass.

### Phase 3 — Library niceties (1 week)
- `ComicInfo.xml`: title/series/number in the toolbar/title, `Manga: YesAndRightToLeft` → auto-RTL, `Pages[Type=FrontCover]` → cover, `Bookmark` → jump list.
- Thumbnail strip / grid (lazily decoded, downscaled in the worker).
- Next/previous comic in folder: list the parent folder via WebDAV, filter comic extensions, natural sort, keyboard `]` `[`.
- Optional JXL support behind a flag if a small decoder is acceptable.

### Phase 4 — File-manager integration & polish (3–5 days)
- `sidebarPanel` extension (`app.files.sidebar`) that appears for comic files: cover thumbnail (reads only the first image entry via range request for CBZ; skipped for RAR/7z unless file < N MB), page count, series/issue from `ComicInfo.xml`.
- Translations wired into the l10n pipeline; German + English at minimum.
- Playwright e2e: open each format, navigate, resume, public link.
- Release workflow (tag → CI builds → zip of `dist/` attached to GitHub release), CHANGELOG, submit to `opencloud-eu/awesome-apps`, consider a PR to `web-extensions`.

### Later / upstream ideas
- Server-side cover thumbnails: extend the OpenCloud thumbnails service (Go) with a CBZ handler using `archive/zip` — cheap and gives real thumbnails in the file list. RAR/7z would need cgo or a Go port; likely CBZ-only.
- Store reading progress in OpenCloud once a per-user key/value or app-settings API exists for third-party apps.

---

## 6. Testing strategy

- **Fixtures**: build `sample.cbz` and `sample.cb7`/`sample.c7z` in CI with `7z`; commit a hand-made `sample.cbr` (rar4) and `sample-rar5.cbr` once, since creating RAR needs the proprietary tool. Use public-domain scans (e.g. Digital Comic Museum) downscaled to keep each fixture under ~200 KB. Include awkward cases: nested chapter folders, `__MACOSX`, mixed case extensions, a `.txt` and `ComicInfo.xml`, a landscape double-page, non-sequential numbering.
- **Unit (vitest)**: sorting/filtering, ComicInfo parsing, adapter `open/list/read` per fixture, cache eviction behaviour, spread pairing logic (table-driven).
- **Component (vitest + web-test-helpers)**: toolbar state, keyboard handling, RTL rendering order.
- **E2E (playwright)**: against docker-compose OpenCloud with the built app mounted; open via left-click, via "Open with", via public link; navigate; reload resumes; oversized-file error path.
- **Performance budget**: first page < 1.5 s on a 300 MB CBZ over a LAN; steady-state heap < 250 MB while paging through 200 pages; verified with a scripted playwright run collecting `performance.memory`.

---

## 7. Security and robustness

- All decoding happens in a worker on bytes the user already has access to; no server-side component, no new attack surface on the server.
- **Decompression bombs**: cap per-entry uncompressed size (`maxPageBytes`, default 64 MB) and total page count (`maxPages`, default 5000); refuse beyond that with a clear message.
- **SVG entries** are never treated as pages (script execution risk); only raster formats.
- Blob URLs are revoked deterministically; the worker is terminated on route leave.
- Never log or persist download URLs/tokens; progress storage holds only ids and page numbers.
- WASM and worker files are served same-origin from the app folder; document required CSP directives explicitly.
- Corrupt archives: catch adapter errors per entry, skip unreadable pages with a badge rather than failing the whole book.

---

## 8. Configuration (admin)

Via `$OC_CONFIG_DIR/apps.yaml` (recommended) or `config.json` in the app folder:

```yaml
comic-reader:
  config:
    registerAsDefault: true      # hasPriority for cbz/cbr/cb7/c7z
    maxArchiveSizeMb: 1024       # buffer-mode formats (cbr/cb7/c7z)
    rangeThresholdMb: 8          # cbz smaller than this is downloaded whole
    prefetchPages: 3
    cacheRadius: 8
    defaultFitMode: fit-page     # fit-page | fit-width | fit-height | original
    defaultSpread: auto          # single | double | auto (by viewport width)
    enableJxl: false
    progressSidecar: false
```

Reasonable defaults mean a zero-config install works.

---

## 9. Install and distribution

1. Download the release zip → extract to `$OC_DATA_DIR/web/assets/apps/comic-reader/` (with `opencloud-compose`: `config/opencloud/apps/comic-reader/`).
2. If needed, adjust CSP per README.
3. `docker compose restart` → the app shows up; `.cbz/.cbr/.cb7/.c7z` open in the reader.

Versioning follows the `web-extensions` convention (`comic-reader-vX.Y.Z` tags), with a compatibility line in the README stating the minimum OpenCloud Web version (the one the spike was validated on).

---

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Default CSP blocks WASM/workers | RAR/7z unusable | Detect in Phase 0; document CSP override; zip path still works without WASM. |
| DAV range requests unsupported in some path (e.g. public links) | Full download for CBZ | Automatic fallback to buffer mode; still functional, just slower. |
| libarchive.js gaps (RAR5 features, 7z BCJ2/ARM filters) | Some files fail | Test matrix in Phase 0; secondary library behind the same adapter interface. |
| `AppWrapperRoute` API differences between Web versions | Breakage on upgrade | Pin minimum Web version; e2e in CI against `rolling` and latest stable images. |
| Large solid 7z on low-memory mobile | Tab crash | Size guard scaled by `navigator.deviceMemory`; download fallback. |
| Upstream extension API changes | Maintenance | Keep OpenCloud-specific code confined to `index.ts` and `helpers/fileUrl.ts`. |

---

## 11. Rough effort

| Phase | Effort (one developer) |
|---|---|
| 0 Spike | 2–3 days |
| 1 MVP | 1–2 weeks |
| 2 Reading UX | 1 week |
| 3 Library features | 1 week |
| 4 Integration, tests, release | 3–5 days |
| **Total** | **~4–6 weeks** to a polished 1.0 |

The MVP at the end of Phase 1 is already usable day to day; Phases 2–4 are what make it feel like a real reader rather than an image viewer with a zip in front of it.
