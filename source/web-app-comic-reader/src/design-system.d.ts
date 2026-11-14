/**
 * Types the host's components (`oc-button`, `oc-icon`, ...) in templates, so
 * that `npm run check:types` checks the props given to them. Without this a
 * template can pass a value the real component does not take and nothing
 * says so: `<oc-button type="submit">` type-checked, and rendered something
 * that was not a button.
 *
 * In a file of its own: the import makes this a module, and src/shims.d.ts
 * has to stay a script for its ambient declarations to apply.
 *
 * The declarations are those of the design system installed here (a dev
 * dependency for this purpose alone; the app does not bundle it), not of
 * the OpenCloud the app is deployed into.
 */
import type {} from '@opencloud-eu/design-system/types'
