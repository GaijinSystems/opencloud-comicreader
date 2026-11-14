import { defineConfig } from '@opencloud-eu/extension-sdk'
import { defineVendorVersion, dropPrebuiltLibarchiveWorker } from './scripts/lib/vite-plugins.mjs'

export default defineConfig({
  name: 'comic-reader',
  plugins: [dropPrebuiltLibarchiveWorker, defineVendorVersion]
})
