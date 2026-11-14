/** Side-effect stylesheet imports carry no types of their own. */
declare module '*.css'

/** Hash of everything in public/vendor/, set at build time; see scripts/lib/vite-plugins.mjs. */
declare const __VENDOR_VERSION__: string
