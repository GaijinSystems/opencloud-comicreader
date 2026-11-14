/**
 * What the reader takes from OpenCloud's `@opencloud-eu/web-pkg`, for the
 * demo, which runs without OpenCloud. The same four the unit tests stand in
 * for (tests/unit/app.spec.ts). The demo's build points the package's name
 * here (vite.demo.config.ts); the reader's code is unchanged.
 */
import { ref } from 'vue'

export const useConfigStore = () => ({ serverUrl: `${window.location.origin}/` })
export const useDocumentTitle = () => {}
export const useRequestHeaders = () => ({ headers: ref({}) })
export const useUserStore = () => ({ user: { id: 'demo' } })
