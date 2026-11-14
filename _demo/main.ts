import { createApp } from 'vue'
import { createGettext } from 'vue3-gettext'
import DesignSystem from '@opencloud-eu/design-system'
import './style.css'

import DemoApp from './DemoApp.vue'

const app = createApp(DemoApp)
app.use(createGettext({ translations: {}, silent: true }))
// OpenCloud's own buttons and icons, as the reader gets them inside OpenCloud.
app.use(DesignSystem, { iconUrlPrefix: import.meta.env.BASE_URL })
app.mount('#app')
