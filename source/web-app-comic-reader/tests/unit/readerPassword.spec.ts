import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { OcButtonStub } from './helpers/fakes'

vi.mock('vue3-gettext', () => ({
  useGettext: () => ({ $gettext: (message: string) => message })
}))

const { default: ReaderPassword } = await import('../../src/components/ReaderPassword.vue')

/** The password prompt, through the real component. */
function render(props: { wrong?: boolean; downloadUrl?: string | null } = {}) {
  return mount(ReaderPassword, {
    attachTo: document.body,
    props: { wrong: false, fileName: 'book.cbz', ...props },
    global: {
      mocks: { $gettext: (message: string) => message },
      stubs: {
        'oc-button': OcButtonStub,
        'oc-icon': true
      }
    }
  })
}

describe('ReaderPassword', () => {
  it('puts the caret in a password field that hides what is typed', () => {
    const wrapper = render()
    const input = wrapper.get('input')
    expect(input.attributes('type')).toBe('password')
    // Not "off", which browsers ignore on a password field.
    expect(input.attributes('autocomplete')).toBe('new-password')
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('hands over the password on submit', async () => {
    const wrapper = render()
    await wrapper.get('input').setValue('comic')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['comic']])
    wrapper.unmount()
  })

  it('has a button that really is a submit button, so a click sends the form', async () => {
    const wrapper = render()
    const button = wrapper.get('button')
    expect(button.attributes('type')).toBe('submit')
    await wrapper.get('input').setValue('comic')
    // happy-dom submits the form of a clicked submit button, as browsers do.
    await button.trigger('click')
    expect(wrapper.emitted('submit')).toEqual([['comic']])
    wrapper.unmount()
  })

  it('submits on Enter in the field, without relying on the browser to do it', async () => {
    const wrapper = render()
    const input = wrapper.get('input')
    await input.setValue('comic')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true })
    input.element.dispatchEvent(enter)
    expect(wrapper.emitted('submit')).toEqual([['comic']])
    // Cancelled, so the browser does not go on to submit the form itself
    // and hand the password over twice.
    expect(enter.defaultPrevented).toBe(true)
    wrapper.unmount()
  })

  it('does not submit an empty password', async () => {
    const wrapper = render()
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toBeUndefined()
    wrapper.unmount()
  })

  it('says so, to assistive technology too, when the last password was wrong', () => {
    const quiet = render()
    expect(quiet.find('[role="alert"]').exists()).toBe(false)
    expect(quiet.get('input').attributes('aria-invalid')).toBe('false')
    quiet.unmount()

    const wrapper = render({ wrong: true })
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('did not open this comic')
    const input = wrapper.get('input')
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(input.attributes('aria-describedby')).toBe(alert.attributes('id'))
    wrapper.unmount()
  })

  it('offers the download beside the prompt when there is a link', () => {
    const without = render()
    expect(without.find('a').exists()).toBe(false)
    without.unmount()

    const wrapper = render({ downloadUrl: 'https://files.example/book.cbz' })
    expect(wrapper.get('a').attributes('href')).toBe('https://files.example/book.cbz')
    wrapper.unmount()
  })
})
