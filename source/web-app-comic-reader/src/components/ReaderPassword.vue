<template>
  <form
    class="flex size-full flex-col items-center justify-center gap-4 p-8 text-center"
    @submit.prevent="submit"
  >
    <oc-icon name="lock" size-class="size-12" />
    <div>
      <p class="text-lg font-medium" v-text="$gettext('This comic is password protected')" />
      <p
        class="mt-1 max-w-prose text-sm opacity-80"
        v-text="
          $gettext(
            'Enter its password to read it. The password is used in this browser tab to unlock the pages; it is not sent to the server, and the reader does not save it.'
          )
        "
      />
    </div>

    <div class="flex flex-col items-center gap-1">
      <label class="text-sm" :for="inputId" v-text="$gettext('Password')" />
      <!--
        A plain input: nothing else in the reader takes text, and this one
        has to stay out of the reader's own keyboard shortcuts (see onKeydown
        in App.vue), which a native input makes simple to recognise.
        autocomplete="new-password": this is the password of a file, not of
        the account on this site. Browsers ignore "off" on a password field,
        and would offer the saved account password here; "new-password" is
        what stops that. A browser may still offer to save what is typed,
        which the reader cannot prevent; the two data attributes ask the
        common password managers to leave the field alone.
      -->
      <input
        :id="inputId"
        ref="input"
        v-model="password"
        type="password"
        autocomplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        class="rounded border px-2 py-1"
        :style="{
          background: 'var(--oc-role-surface)',
          color: 'var(--oc-role-on-surface)',
          borderColor: wrong ? 'var(--oc-role-error)' : 'var(--oc-role-outline)'
        }"
        :aria-invalid="wrong"
        :aria-describedby="wrong ? errorId : undefined"
        @keydown.enter.prevent="submit"
      />
      <!--
        Enter is handled above and not left to the browser's implicit form
        submission, so that it does not depend on what the host's button
        component renders. `.prevent` is what keeps the browser from then
        submitting the form a second time.
      -->
      <p
        v-if="wrong"
        :id="errorId"
        role="alert"
        class="max-w-prose text-sm"
        :style="{ color: 'var(--oc-role-error)' }"
        v-text="
          $gettext(
            'That password did not open this comic. Check it and try again. (A damaged file can look the same.)'
          )
        "
      />
    </div>

    <div class="flex flex-wrap items-center justify-center gap-2">
      <!--
        `submit`, not `type`: on the design system's button `type` names the
        element to render (button, a, router-link) and `submit` is the
        button's native type. `type="submit"` renders something that is not
        a button at all, and a click on it submits nothing.
      -->
      <oc-button submit="submit" appearance="filled" :disabled="!password">
        <oc-icon name="lock-unlock" fill-type="line" />
        {{ $gettext('Open comic') }}
      </oc-button>
      <oc-button v-if="downloadUrl" type="a" appearance="outline" :href="downloadUrl" :download="fileName">
        <oc-icon name="download" fill-type="line" />
        {{ $gettext('Download comic') }}
      </oc-button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useGettext } from 'vue3-gettext'

const { wrong, fileName, downloadUrl } = defineProps<{
  /** The password tried last did not work. */
  wrong: boolean
  fileName: string
  downloadUrl?: string | null
}>()

const emit = defineEmits<{ (e: 'submit', password: string): void }>()

const { $gettext } = useGettext()

// Fixed ids: there is only ever one prompt on the page. (Vue's useId would
// do, but Vue comes from the OpenCloud shell at run time, and this keeps the
// prompt working on a shell whose Vue predates it.)
const inputId = 'comic-reader-password'
const errorId = 'comic-reader-password-error'

const password = ref('')
const input = ref<HTMLInputElement | null>(null)

onMounted(() => input.value?.focus())

function submit() {
  if (password.value) {
    emit('submit', password.value)
  }
}
</script>
