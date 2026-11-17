<template>
  <div class="demo">
    <template v-if="!open">
      <header class="demo-top">
        <div class="demo-brand">
          <oc-icon name="book-read" fill-type="line" />
          <span>OpenCloud Comic Reader</span>
        </div>
        <a class="demo-link" :href="repository" rel="noopener">
          <oc-icon name="github" fill-type="fill" size="small" />
          Source on GitHub
        </a>
      </header>

      <main class="demo-main">
        <section class="demo-intro">
          <h1>Try it</h1>
          <p>
            This is the reader as it runs inside OpenCloud, on a mock file list. Click a comic to
            open it. Everything happens in your browser: the comics are downloaded and unpacked
            here, and nothing is sent anywhere.
          </p>
          <p class="demo-muted">
            The comics are made up for this demo, one in each format. The locked one's password
            is <code>comic</code>.
          </p>
        </section>

        <section class="demo-files" aria-label="Comics">
          <div class="demo-crumbs">
            <span class="demo-muted">Personal</span>
            <oc-icon name="arrow-right-s" size="small" />
            <strong>Comics</strong>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th class="demo-narrow">Format</th>
                <th class="demo-narrow demo-right">Size</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="comic in comics" :key="comic.name">
                <td>
                  <a :href="`#/read/${encodeURIComponent(comic.name)}`" class="demo-file">
                    <oc-icon :name="comic.locked ? 'lock' : 'book-read'" fill-type="line" />
                    <span>{{ comic.name }}</span>
                  </a>
                  <span v-if="comic.locked" class="demo-tag">password: comic</span>
                </td>
                <td class="demo-narrow">{{ comic.format }}</td>
                <td class="demo-narrow demo-right">{{ comic.sizeText }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <p class="demo-muted demo-small">
          OpenCloud Comic Reader is free software under the GNU AGPL, version 3 or later. Its decoders'
          licences are in <a :href="`${base}THIRD-PARTY-NOTICES.txt`">THIRD-PARTY-NOTICES.txt</a>.
          This demo stands in for OpenCloud: the real thing opens comics from your own files.
        </p>
      </main>
    </template>

    <template v-else>
      <div class="demo-appbar">
        <a href="#/" class="demo-close" aria-label="Close">
          <oc-icon name="close" />
        </a>
        <oc-icon name="book-read" fill-type="line" size="small" />
        <span class="demo-appname">{{ open.name }}</span>
      </div>
      <div class="demo-reader">
        <ComicReader
          :key="open.name"
          :application-config="{}"
          :space="space"
          :resource="resourceOf(open)"
          :get-url-for-resource="urlFor"
          :revoke-url="() => {}"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Resource, SpaceResource } from '@opencloud-eu/web-client'
import ComicReader from '../src/App.vue'
import { formatBytes } from '../src/helpers/format'

interface Comic {
  name: string
  size: number
}
/** The comics in demo/comics/, set at build time (vite.demo.config.ts). */
declare const __DEMO_COMICS__: Comic[]

const repository = 'https://github.com/GaijinSystems/opencloud-comicreader'
const base = import.meta.env.BASE_URL
const issue = (comic: Comic) => Number(/#(\d+)/.exec(comic.name)?.[1] ?? 0)
const formats: Record<string, string> = { cbz: 'CBZ (zip)', cbr: 'CBR (RAR)', cb7: 'CB7 (7-Zip)' }

// In the order a reader would take them: by issue, the locked copy after its original.
const comics = [...__DEMO_COMICS__]
  .sort((a, b) => issue(a) - issue(b) || a.name.length - b.name.length)
  .map((comic) => ({
  ...comic,
  locked: comic.name.includes('(locked)'),
  format: formats[comic.name.split('.').pop()!.toLowerCase()] ?? '',
  sizeText: formatBytes(comic.size)
}))

const space = { id: 'demo', driveType: 'personal' } as unknown as SpaceResource
const resourceOf = (comic: Comic) =>
  ({ id: comic.name, fileId: comic.name, name: comic.name, size: comic.size }) as unknown as Resource
const urlFor = async (_space: SpaceResource, resource: Resource) =>
  new URL(`${base}comics/${encodeURIComponent(resource.name)}`, window.location.href).href

const route = ref(window.location.hash)
const onHash = () => {
  route.value = window.location.hash
}
onMounted(() => window.addEventListener('hashchange', onHash))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash))

const open = computed(() => {
  const match = /^#\/read\/(.+)$/.exec(route.value)
  const name = match ? decodeURIComponent(match[1]) : null
  return comics.find((comic) => comic.name === name) ?? null
})
</script>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  font-family: var(--oc-font-family, sans-serif);
  background: var(--oc-role-surface-container, #f4f6f7);
  color: var(--oc-role-on-surface, #191c1d);
}
</style>

<style scoped>
.demo {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.demo-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: var(--oc-role-chrome, #20434f);
  color: var(--oc-role-on-chrome, #fff);
}
.demo-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 1.15rem;
  font-weight: 600;
}
.demo-link {
  display: flex;
  align-items: center;
  gap: 6px;
  color: inherit;
  text-decoration: none;
  font-size: 0.9rem;
}
.demo-link:hover {
  text-decoration: underline;
}
.demo-main {
  width: 100%;
  max-width: 920px;
  margin: 0 auto;
  padding: 24px;
  box-sizing: border-box;
}
.demo-intro h1 {
  margin: 8px 0 8px;
  font-size: 1.6rem;
}
.demo-intro p {
  line-height: 1.5;
  margin: 0 0 8px;
}
.demo-muted {
  color: var(--oc-role-on-surface-variant, #5c6670);
}
.demo-small {
  font-size: 0.8rem;
  line-height: 1.5;
  margin-top: 24px;
}
code {
  background: var(--oc-role-surface-container-high, #e6eaec);
  padding: 1px 6px;
  border-radius: 4px;
}
.demo-files {
  margin-top: 20px;
  background: var(--oc-role-surface, #fff);
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}
.demo-crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th {
  text-align: left;
  font-weight: 600;
  padding: 8px;
  border-bottom: 1px solid var(--oc-role-outline-variant, #dde3e6);
}
td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--oc-role-outline-variant, #eef1f3);
}
tr:last-child td {
  border-bottom: none;
}
tbody tr:hover {
  background: var(--oc-role-surface-container-low, #f3f6f7);
}
.demo-narrow {
  white-space: nowrap;
  width: 1%;
}
.demo-right {
  text-align: right;
}
.demo-file {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: inherit;
  text-decoration: none;
}
.demo-file:hover span {
  text-decoration: underline;
}
.demo-tag {
  margin-left: 10px;
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--oc-role-secondary-container, #e2eef2);
}
.demo-appbar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 16px;
  background: var(--oc-role-surface-container, #f4f6f7);
}
.demo-close {
  display: flex;
  color: inherit;
}
.demo-appname {
  font-size: 0.95rem;
}
.demo-reader {
  flex: 1;
  min-height: 0;
  margin: 0 8px 8px;
  background: var(--oc-role-surface, #fff);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
