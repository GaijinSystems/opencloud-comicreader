<template>
  <div
    ref="strip"
    class="comic-strip flex gap-2 border-t border-role-outline-variant bg-role-surface-container p-2"
    :style="{ overflowX: 'auto' }"
    role="listbox"
    :aria-label="$gettext('Pages')"
  >
    <button
      v-for="page in pageCount"
      :key="page - 1"
      v-memo="[urls[page - 1], currentPage === page - 1]"
      :data-page="page - 1"
      role="option"
      :aria-selected="currentPage === page - 1"
      class="relative rounded transition-colors"
      :style="{
        width: '64px',
        height: '96px',
        flex: '0 0 auto',
        border: '2px solid',
        borderColor: currentPage === page - 1 ? 'var(--oc-role-primary)' : 'transparent'
      }"
      @click="$emit('go-to-page', page - 1)"
    >
      <img
        v-if="urls[page - 1]"
        :src="urls[page - 1] as string"
        :alt="''"
        class="size-full object-cover"
        loading="lazy"
      />
      <span
        v-else
        class="flex size-full items-center justify-center bg-role-surface-container-highest text-xs tabular-nums opacity-70"
        v-text="page"
      />
      <span
        class="absolute inset-x-0 bottom-0 text-center text-xs"
        :style="{ background: 'color-mix(in srgb, var(--oc-role-surface) 80%, transparent)' }"
        v-text="page"
      />
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useGettext } from 'vue3-gettext'

const { pageCount, currentPage, urls } = defineProps<{
  pageCount: number
  currentPage: number
  /**
   * Only pages already in the cache get a thumbnail. Decoding every page to
   * fill this strip would defeat the point of the cache, so uncached pages
   * show their number instead and fill in as the reader passes them.
   */
  urls: Record<number, string | null | undefined>
}>()

defineEmits<{ (e: 'go-to-page', page: number): void }>()

const { $gettext } = useGettext()
const strip = ref<HTMLElement | null>(null)

// Looked up by attribute rather than a v-for ref array. Vue does not guarantee
// those arrays follow source order, so indexing one by page number can scroll
// a different thumbnail into view.
watch(
  () => currentPage,
  async () => {
    await nextTick()
    strip.value
      ?.querySelector<HTMLElement>(`[data-page="${currentPage}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' })
  },
  { immediate: true }
)
</script>
