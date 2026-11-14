import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import {
  AppWrapperRoute,
  defineWebApplication,
  type ApplicationInformation,
  type ApplicationSetupOptions,
  type Extension
} from '@opencloud-eu/web-pkg'
import '@opencloud-eu/extension-sdk/tailwind.css'

import translations from '../l10n/translations.json'
import ComicReader from './App.vue'
import { readConfig } from './config'
import { setAssetBaseUrl } from './helpers/assetUrl'

const appId = 'comic-reader'
const routeName = 'comic-reader'

export default defineWebApplication({
  setup({ applicationConfig }: ApplicationSetupOptions) {
    const { $gettext } = useGettext()
    const config = readConfig(applicationConfig)
    setAssetBaseUrl(config.assetBaseUrl)

    const routes = [
      {
        path: '/:driveAliasAndItem(.*)?',
        name: routeName,
        component: AppWrapperRoute(ComicReader, {
          applicationId: appId
          // Deliberately no urlForResourceOptions: the reader resolves its own
          // download URL so it can issue Range requests. Asking the wrapper for
          // an inline URL would make it download the whole archive as a blob.
        }),
        meta: {
          // 'hybrid' so public links open the reader too, not just sessions.
          authContext: 'hybrid',
          title: $gettext('Comic Reader'),
          patchCleanPath: true
        }
      }
    ]

    /**
     * The four registered extensions. Routing is by extension rather than mime
     * type because servers rarely have a mapping for comic archives, but the
     * mime types are declared too so icons and "open with" read correctly.
     */
    const fileExtensions = [
      { extension: 'cbz', mimeType: 'application/vnd.comicbook+zip' },
      { extension: 'cbr', mimeType: 'application/vnd.comicbook-rar' },
      { extension: 'cb7', mimeType: 'application/x-cb7' },
      { extension: 'c7z', mimeType: 'application/x-cb7' }
    ].map(({ extension, mimeType }) => ({
      extension,
      mimeType,
      routeName,
      label: () => $gettext('Open in Comic Reader'),
      // Without priority the reader is only offered under "Open with" rather
      // than being the default on left-click. Admins can turn this off.
      hasPriority: config.registerAsDefault
    }))

    const appInfo: ApplicationInformation = {
      name: $gettext('Comic Reader'),
      id: appId,
      icon: 'book-read',
      color: '#5b3fd9',
      defaultExtension: 'cbz',
      extensions: fileExtensions
    }

    return {
      appInfo,
      routes,
      translations,
      extensions: computed<Extension[]>(() => [])
    }
  }
})
