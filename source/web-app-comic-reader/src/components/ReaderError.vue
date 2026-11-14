<template>
  <div class="flex size-full flex-col items-center justify-center gap-4 p-8 text-center">
    <oc-icon :name="icon" size-class="size-12" :color="iconColor" />
    <div>
      <p class="text-lg font-medium" v-text="headline" />
      <p class="mt-1 max-w-prose text-sm opacity-80" v-text="detail" />
    </div>

    <div class="flex flex-wrap items-center justify-center gap-2">
      <!--
        A download button on every failure path. Whatever went wrong in the
        browser, the file itself is still there and a desktop reader will
        almost certainly open it.
      -->
      <oc-button v-if="downloadUrl" type="a" appearance="filled" :href="downloadUrl" :download="fileName">
        <oc-icon name="download" fill-type="line" />
        {{ $gettext('Download comic') }}
      </oc-button>
      <oc-button v-if="retryable" appearance="outline" @click="$emit('retry')">
        <oc-icon name="refresh" fill-type="line" />
        {{ $gettext('Try again') }}
      </oc-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useGettext } from 'vue3-gettext'
import type { ComicReaderError } from '../archive/types'
import { WorkerTimeoutError } from '../helpers/wasm'

const { error, fileName, downloadUrl } = defineProps<{
  error: ComicReaderError
  fileName: string
  downloadUrl?: string | null
}>()

defineEmits<{ (e: 'retry'): void }>()

const { $gettext } = useGettext()

/** Only transient failures are worth offering a retry for. */
const retryable = computed(() => ['network', 'backend-unavailable'].includes(error.code))

/**
 * `backend-unavailable` covers two different situations: WebAssembly being
 * blocked by the page's policy, and a decoder that started and then stopped
 * answering. Only the first is something an administrator can fix in the CSP.
 */
const decoderTimedOut = computed(
  () => error.code === 'backend-unavailable' && error.cause instanceof WorkerTimeoutError
)

const icon = computed(() => {
  switch (error.code) {
    case 'encrypted':
      return 'lock'
    case 'too-large':
    case 'too-many-pages':
      return 'scales-3'
    case 'network':
      return 'cloud-off'
    default:
      return 'file-damage'
  }
})

const iconColor = computed(() =>
  error.code === 'network' ? 'var(--oc-role-on-surface-variant)' : 'var(--oc-role-error)'
)

const headline = computed(() => {
  switch (error.code) {
    case 'unsupported-format':
      return $gettext('This is not a comic archive')
    case 'unsupported-compression':
      return $gettext('Unsupported compression')
    case 'too-large':
      return $gettext('This comic is too large to open here')
    case 'encrypted':
      // Not normally shown: a password-protected comic gets the password
      // prompt instead (ReaderPassword.vue).
      return $gettext('This comic is password protected')
    case 'no-pages':
      return $gettext('No pages found')
    case 'solid-rar-unsupported':
      return $gettext('Solid RAR archive')
    case 'too-many-pages':
      return $gettext('Too many pages')
    case 'network':
      return $gettext('The comic could not be fetched')
    case 'backend-unavailable':
      return decoderTimedOut.value
        ? $gettext('The archive decoder stopped responding')
        : $gettext('The archive decoder could not start')
    default:
      return $gettext('This comic could not be opened')
  }
})

const detail = computed(() => {
  if (decoderTimedOut.value) {
    return $gettext(
      'The decoder did not answer in time. Trying again may work; if it never does, the decoder\'s files may be blocked or missing on the server (an administrator can check the browser console). You can also download the file to read it in a desktop comic reader.'
    )
  }
  if (error.code === 'backend-unavailable') {
    // Names the exact directive. This is almost always a server CSP setting,
    // and "ask your administrator" without the specifics just moves the
    // guesswork one person along. ZIP/CBZ files keep working regardless.
    return $gettext(
      'Reading CBR, CB7 and C7Z files needs WebAssembly, which this page is not allowed to run. An administrator can fix this by adding \'wasm-unsafe-eval\' to script-src in the server\'s content security policy. CBZ files are unaffected.'
    )
  }
  if (error.code === 'solid-rar-unsupported') {
    return $gettext(
      'This comic is a solid RAR archive. The in-browser decoder cannot read these, so none of its pages can be shown. Download the file to read it in a desktop comic reader.'
    )
  }
  if (error.code === 'unsupported-compression') {
    // This path is only reached when the libarchive fallback could not run,
    // which in practice means WebAssembly is blocked. Say that: it is the
    // thing an administrator can actually change. (A zip opened with a
    // password never takes that fallback; openArchive.ts gives it an error
    // of its own, with its own message.)
    return $gettext(
      'This comic uses a zip compression method that needs WebAssembly to decode, and this page is not allowed to run it. An administrator can fix this by adding \'wasm-unsafe-eval\' to script-src in the server\'s csp.yaml. Alternatively, download the file to read it in a desktop comic reader.'
    )
  }
  if (error.code === 'too-large') {
    return $gettext('Download it instead to read it in a desktop comic reader.')
  }
  return error.message
})
</script>
