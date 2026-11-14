import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({
    $gettext: (message: string, values: Record<string, string> = {}) =>
      message.replace(/%\{(\w+)\}/g, (_match, key: string) => values[key] ?? '')
  })
}))

const { default: ReaderViewport } = await import('../../src/components/ReaderViewport.vue')

/**
 * The unreadable-page placeholder and its "Try again" button, through the
 * real component. Where the button sits relative to the page-turn zones is a
 * layout question and is checked in a browser by the harness; this covers
 * when it is offered and what a click on it does.
 */
function render(failed: Record<number, 'retryable' | 'permanent'>, spread = [0]) {
  return mount(ReaderViewport, {
    props: {
      spread,
      urls: {},
      failed,
      fitMode: 'fit-page' as const,
      pageCount: 10,
      rotation: 0 as const
    },
    global: {
      mocks: { $gettext: (message: string) => message },
      stubs: {
        // Stand-ins for the design system's components, which the host
        // supplies. The button has to stay a real, clickable element.
        'oc-button': { template: '<button class="oc-button"><slot /></button>' },
        'oc-icon': true,
        'oc-spinner': true
      }
    }
  })
}

const retryButton = (wrapper: ReturnType<typeof render>) =>
  wrapper.findAll('button.oc-button').find((button) => button.text().includes('Try again'))

describe('ReaderViewport: a page that could not be read', () => {
  it('offers "Try again" when reading it again could help', () => {
    const wrapper = render({ 0: 'retryable' })
    expect(wrapper.text()).toContain('This page could not be read')
    expect(retryButton(wrapper)).toBeDefined()
  })

  it('does not offer it when it cannot', () => {
    const wrapper = render({ 0: 'permanent' })
    expect(wrapper.text()).toContain('This page could not be read')
    expect(retryButton(wrapper)).toBeUndefined()
  })

  it('shows a spinner, not the failure, for a page that is merely still loading', () => {
    const wrapper = render({})
    expect(wrapper.find('[aria-label="Loading page"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('This page could not be read')
    expect(retryButton(wrapper)).toBeUndefined()
  })

  it('asks for that page again on a click, without also toggling the toolbar', async () => {
    const wrapper = render({ 0: 'permanent', 1: 'retryable' }, [0, 1])
    await retryButton(wrapper)!.trigger('click')

    expect(wrapper.emitted('retry-page')).toEqual([[1]])
    // The viewport's own click handler toggles the toolbar; the button's
    // click must not reach it.
    expect(wrapper.emitted('toggle-chrome')).toBeUndefined()
    expect(wrapper.emitted('navigate')).toBeUndefined()
  })

  it('lifts the button above the page-turn zones', () => {
    const style = retryButton(render({ 0: 'retryable' }))!.attributes('style') ?? ''
    expect(style).toContain('position: relative')
    expect(style).toContain('z-index: 1')
  })

  it('still turns the page from the zones at either edge', async () => {
    const wrapper = render({ 0: 'retryable' })
    const zones = wrapper.findAll('button[aria-label]')
    expect(zones.map((zone) => zone.attributes('aria-label'))).toEqual(['Previous page', 'Next page'])
    await zones[0].trigger('click')
    await zones[1].trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['left'], ['right']])
    expect(wrapper.emitted('toggle-chrome')).toBeUndefined()
  })
})
