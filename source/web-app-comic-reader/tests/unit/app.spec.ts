import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref, shallowRef, nextTick } from 'vue'

import { ComicReaderError } from '../../src/archive/types'
import { OcButtonStub } from './helpers/fakes'

/**
 * App.vue's own wiring around a password-protected comic: which screen is
 * shown, what the prompt's answer is handed to, where the keyboard focus
 * ends up, and that typing a password does not operate the reader.
 *
 * The archive is a stand-in whose state the tests set directly; the host's
 * composables are stubbed. The prompt is the real component.
 */

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({
    $gettext: (message: string) => message,
    $ngettext: (one: string) => one
  })
}))
vi.mock('@opencloud-eu/web-pkg', () => ({
  useConfigStore: () => ({ serverUrl: 'https://cloud.example/' }),
  useDocumentTitle: () => {},
  useRequestHeaders: () => ({ headers: ref({}) }),
  useUserStore: () => ({ user: { id: 'reader' } })
}))

/** The archive composable's state, for the tests to drive. */
function makeArchive() {
  return {
    loading: ref(false),
    error: shallowRef<ComicReaderError | null>(null),
    progress: shallowRef(null),
    pageCount: ref(0),
    info: shallowRef(null),
    warning: shallowRef(null),
    bulkExtracting: ref(false),
    failedPages: ref({}),
    declaredWidePages: shallowRef(new Set<number>()),
    open: vi.fn(async () => {}),
    unlock: vi.fn(async (_password: string) => {}),
    destroy: vi.fn(async () => {}),
    pageUrl: vi.fn(async () => 'blob:page'),
    retryPage: vi.fn(),
    cachedPageUrls: vi.fn(() => ({})),
    setReadingPosition: vi.fn()
  }
}
let archive = makeArchive()
vi.mock('../../src/composables/useComicArchive', () => ({
  useComicArchive: () => archive
}))

const { default: App } = await import('../../src/App.vue')

const passwordRequired = () =>
  new ComicReaderError('password-required', 'This comic is password protected.')
const wrongPassword = () =>
  new ComicReaderError('wrong-password', 'That password did not open this comic.')

/** The comic opens to the password prompt. */
const asksForPassword = () =>
  archive.open.mockImplementation(async () => {
    archive.error.value = passwordRequired()
  })

let mounted: ReturnType<typeof mount> | null = null

async function mountApp() {
  const wrapper = mount(App, {
    attachTo: document.body,
    props: {
      applicationConfig: {},
      space: {},
      resource: { id: 'file-1', name: 'book.cb7' },
      getUrlForResource: async () => 'https://cloud.example/download/book.cb7',
      revokeUrl: () => {}
    } as never,
    global: {
      mocks: { $gettext: (message: string) => message },
      stubs: {
        'oc-button': OcButtonStub,
        'oc-icon': true,
        'oc-spinner': true,
        ReaderViewport: { template: '<div class="viewport" />' },
        ReaderToolbar: { template: '<div class="toolbar" />' },
        PageStrip: true
      }
    }
  })
  mounted = wrapper
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  archive = makeArchive()
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
})

describe('App: a password-protected comic', () => {
  it('shows the prompt, not the error screen, when a password is asked for', async () => {
    asksForPassword()
    const wrapper = await mountApp()

    expect(archive.open).toHaveBeenCalledTimes(1)
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('This comic is password protected')
  })

  it('hands the typed password to unlock, as a string, and does not open the comic afresh', async () => {
    asksForPassword()
    const wrapper = await mountApp()

    await wrapper.get('input').setValue('comic')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(archive.unlock).toHaveBeenCalledTimes(1)
    expect(archive.unlock).toHaveBeenCalledWith('comic')
    expect(archive.open).toHaveBeenCalledTimes(1)
  })

  it('says the password was wrong, and keeps the caret in the field', async () => {
    asksForPassword()
    // What the composable does on an unlock: the spinner while it tries,
    // then the prompt's error again.
    archive.unlock.mockImplementation(async () => {
      archive.loading.value = true
      archive.error.value = null
      await nextTick()
      archive.error.value = wrongPassword()
      archive.loading.value = false
    })
    const wrapper = await mountApp()

    await wrapper.get('input').setValue('not it')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('did not open this comic')
    const input = wrapper.get('input')
    // A new prompt, empty, holding the focus: the next attempt can be typed.
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(input.element)
  })

  it('returns the focus to the reader once the comic has opened, so the shortcuts work', async () => {
    asksForPassword()
    archive.unlock.mockImplementation(async () => {
      archive.loading.value = true
      archive.error.value = null
      await nextTick()
      archive.pageCount.value = 3
      archive.loading.value = false
    })
    const wrapper = await mountApp()

    await wrapper.get('input').setValue('comic')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    expect(wrapper.find('.viewport').exists()).toBe(true)
    expect(document.activeElement).toBe(wrapper.element)
  })

  it('leaves the keys typed into the password alone', async () => {
    asksForPassword()
    const wrapper = await mountApp()
    const input = wrapper.get('input')

    // The keys the reader takes for itself when they are pressed on it (the
    // next test). Its letter shortcuts go through the same guard; they
    // cancel nothing, so there is nothing of theirs to observe here.
    for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      input.element.dispatchEvent(event)
      // Not taken by the reader: the browser's own handling (typing the
      // letter, moving the caret) goes ahead.
      expect(event.defaultPrevented, key).toBe(false)
    }
    expect(archive.setReadingPosition).not.toHaveBeenCalled()
  })

  it('still takes those keys when they are pressed on the reader itself', async () => {
    archive.open.mockImplementation(async () => {
      archive.pageCount.value = 3
    })
    const wrapper = await mountApp()

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    wrapper.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens afresh, with no password, on "Try again" from an error screen', async () => {
    archive.open.mockImplementation(async () => {
      archive.error.value = new ComicReaderError('network', 'The comic could not be fetched.')
    })
    const wrapper = await mountApp()

    const retry = wrapper.findAll('button').find((button) => button.text().includes('Try again'))
    await retry!.trigger('click')
    await flushPromises()

    expect(archive.open).toHaveBeenCalledTimes(2)
    expect(archive.unlock).not.toHaveBeenCalled()
  })
})
