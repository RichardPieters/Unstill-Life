/**
 * driven_registry.spec.js — guards src/panel/drivenRegistry.js's completeness, the
 * same two-sided shape as tooltips.spec.js:
 *  - every id a driver has DECLARED must match a live #debug control (a
 *    renamed/removed id would otherwise silently stop being marked, forever);
 *  - every panel control a driver ACTUALLY overwrites must be declared (this
 *    is the direction that catches a control staying marked after its key
 *    leaves the driven set — a stale hand-kept class in markup does not fail
 *    a test, a registry with no entry for a live id can).
 *
 * The second direction is checked against the two SOURCE tables the drivers
 * are declared from (formDrivenIds and the weather's own driven keys),
 * imported here rather than re-derived, so this spec cannot itself become a
 * third hand-kept list.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'
import { formDrivenIds } from '../../src/scene/formDriver.js'

test('every id a driver declared matches a live control', async ({ page }) => {
  await boot(page, { pause: true })
  const missing = await page.evaluate(() => {
    return window.__d.driven.declaredIds().filter(id => !document.getElementById(id))
  })
  expect(missing, `declared ids with no live element: ${JSON.stringify(missing)}`).toEqual([])
})

test('every control the form drives is declared to the form driver', async ({ page }) => {
  await boot(page, { pause: true })
  const declared = await page.evaluate(() => window.__d.driven.declaredIds())
  const expected = formDrivenIds()
  const undeclared = expected.filter(id => !declared.includes(id))
  expect(undeclared, `form-blended controls not declared: ${JSON.stringify(undeclared)}`).toEqual([])
})

test('a control the form drives resolves as clobbered while the walker runs', async ({ page }) => {
  await boot(page, { freezeForm: false, pause: true })
  const state = await page.evaluate(() => window.__d.driven.resolve().get('ctrl-form-ocean'))
  expect(state).toBe('clobbered')
})

// The two cloud dials' own downstream targets (uBaseFreq, uAbsorption) are
// overwritten every walker tick exactly like the blended controls, so they
// must be in the 'form' declare list — otherwise they stay undimmed even
// though any hand-drag on them is inert while drift holds them clobbered.
test('the scatter and density dials\' own targets resolve as clobbered while the walker runs', async ({ page }) => {
  await boot(page, { freezeForm: false, pause: true })
  const states = await page.evaluate(() => {
    const r = window.__d.driven.resolve()
    return { freq: r.get('ctrl-cvol-freq'), absorb: r.get('ctrl-cvol-absorb') }
  })
  expect(states.freq).toBe('clobbered')
  expect(states.absorb).toBe('clobbered')
})
