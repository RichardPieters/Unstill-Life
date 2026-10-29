/**
 * sea_bounds.spec.js — the sea-level band's two controls must actually reach the
 * water. All three ways they were dead are checked end to end, through the real
 * panel wiring rather than the driver in isolation:
 *
 *   · the sliders showed index.html's attributes (-14 / 6) while the driver held
 *     -10.9 / 9.1, so the handles started wrong and the first drag jumped
 *   · a drag eased in at 0.02 per tick, needing ~115 ticks to become visible
 *   · the settled bound contributes only (1 - restlessness), and restlessness rests
 *     near 1, so at rest it moved the waterline by fractions of a unit
 *
 * Asserted as "the mesh moved where it was told", never as a specific height —
 * the bounds are tuning constants.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('the sea sliders load showing the value the driver actually holds', async ({ page }) => {
  await boot(page)
  // Hidden controls refresh when the panel opens, so open it before reading.
  await page.evaluate(() => document.getElementById('debug').classList.add('visible'))
  const r = await page.evaluate(() => {
    const el = id => document.getElementById(id)
    return {
      lowSlider: parseFloat(el('ctrl-sea-low').value),
      lowActual: window.__d.water.params.get('seaLow'),
      highSlider: parseFloat(el('ctrl-sea-high').value),
      highActual: window.__d.water.params.get('seaHigh'),
      lowLabel: el('ctrl-sea-low-val').textContent.trim(),
    }
  })
  // Sliders are integer-stepped, so allow the rounding but nothing more.
  expect(Math.abs(r.lowSlider - r.lowActual)).toBeLessThanOrEqual(1)
  expect(Math.abs(r.highSlider - r.highActual)).toBeLessThanOrEqual(1)
  expect(r.lowLabel).not.toBe('')
})

// The driver caches the restlessness it last SAW ON A TICK, so these dispatch a
// real tick at the restlessness under test rather than assigning the field — which
// would leave the driver snapping against the previous frame's value.
const tickAt = restlessness => ({ restlessness })

test('dragging the calm bound moves the water immediately', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(({ st }) => {
    const { water, dynamics } = window.__d
    dynamics.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 0.5, ...st } }))
    const before = water.mesh.position.y
    water.params.set('seaLow', water.params.get('seaLow') - 25)
    const after = water.mesh.position.y      // read with NO further ticks
    return { before, after, bound: water.params.get('seaLow') }
  }, { st: tickAt(1.0) })
  // The whole point: no waiting. At restlessness 1 the target IS the calm bound,
  // so the mesh is already there rather than 115 ticks away.
  expect(r.after).toBeLessThan(r.before - 20)
  expect(r.after).toBeCloseTo(r.bound, 3)
})

test('the settled bound reaches the water once restlessness falls', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(({ st }) => {
    const { water, dynamics } = window.__d
    dynamics.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 0.5, ...st } }))
    water.params.set('seaHigh', water.params.get('seaLow') + 40)
    return { y: water.mesh.position.y, high: water.params.get('seaHigh') }
  }, { st: tickAt(0.0) })
  expect(r.y).toBeCloseTo(r.high, 3)
})

test('the settled bound is inert at rest — by design, not by breakage', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(({ st }) => {
    const { water, dynamics } = window.__d
    dynamics.dispatchEvent(new CustomEvent('tick', { detail: { dt: 0.1, momentum: 0.5, ...st } }))
    // Snap to the exact target first, by writing the calm bound away and back
    // (a write equal to the current value does nothing). Without this `before`
    // is still part-way through the easing, and the snap that the next call
    // performs would show up as movement the high bound did not cause.
    const low = water.params.get('seaLow')
    water.params.set('seaLow', low - 1)
    water.params.set('seaLow', low)
    const before = water.mesh.position.y
    water.params.set('seaHigh', low + 60)
    return { before, after: water.mesh.position.y }
  }, { st: tickAt(1.0) })
  // Documents the semantics that made it look broken: the band is weighted by
  // (1 - restlessness), so at full restlessness the settled bound contributes nothing
  // at all. This is why the slider is labelled "sea · settled".
  expect(r.after).toBeCloseTo(r.before, 6)
})

test('the bounds cannot be crossed from the panel', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(() => {
    const { water } = window.__d
    water.params.set('seaHigh', -500)        // shove the top under the bottom
    const a = { lo: water.params.get('seaLow'), hi: water.params.get('seaHigh') }
    water.params.set('seaLow', 500)          // and the bottom over the top
    const b = { lo: water.params.get('seaLow'), hi: water.params.get('seaHigh') }
    return { a, b }
  })
  expect(r.a.hi).toBeGreaterThanOrEqual(r.a.lo)
  expect(r.b.lo).toBeLessThanOrEqual(r.b.hi)
})
