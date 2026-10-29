/**
 * cloud_scatter_gate.spec.js — the scatter dial is INDEPENDENT of the weather:
 * overcast never moves the dial, its readback, the walker's latent, or the
 * baseFreq it writes. `baseFreq` is a shape-rebake key, so a second continuous
 * driver on it (overcast) would make the clouds stutter.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

async function setOvercast(page, overcast) {
  await page.evaluate(o => {
    const a = window.__d.atmosphere
    a.params.set('walking', false); a.params.set('enabled', true)
    a.setChannel('overcast', o)
  }, overcast)
}

test('the raw dial position survives an overcast change unchanged', async ({ page }) => {
  await boot(page)
  // Hidden controls refresh when the panel opens, so open it before reading.
  await page.evaluate(() => document.getElementById('debug').classList.add('visible'))
  await page.evaluate(() => window.__d.applyFormPositions(
    { ocean: 0.5, mountains: 0.5, snowline: 0.7, cloudScatter: 0.8, cloudDensity: 0.5 }))

  const shownAt = () => page.evaluate(() => parseFloat(document.getElementById('ctrl-cdial-scatter').value))

  await setOvercast(page, 1)
  const atFull = await shownAt()

  await setOvercast(page, 0.2)
  const atLow = await shownAt()

  // The DIAL's own displayed value must not move just because the weather did.
  expect(atFull).toBeCloseTo(0.8, 2)
  expect(atLow).toBeCloseTo(0.8, 2)
})

test('baseFreq for a given dial position does not depend on overcast', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => window.__d.applyFormPositions(
    { ocean: 0.5, mountains: 0.5, snowline: 0.7, cloudScatter: 1, cloudDensity: 0.5 }))
  const freq = () => page.evaluate(() => window.__d.clouds.params.get('baseFreq'))

  await setOvercast(page, 1)
  const atFull = await freq()
  await setOvercast(page, 0.2)
  const atLow = await freq()

  expect(atLow).toBe(atFull)
  // Full scatter still reaches the documented ceiling.
  expect(atFull).toBeCloseTo(0.010, 3)
})

test('the WALKER\'s own latent is unaffected by overcast', async ({ page }) => {
  // The walker's latent is seeded once and advanced independently of any
  // panel readback, so its position must not drift or jump when overcast
  // changes underneath it.
  await boot(page, { freezeForm: false })
  await setOvercast(page, 1)
  const before = await page.evaluate(() => window.__d.formWalker.getPositions().cloudScatter)
  await setOvercast(page, 0.2)
  const after = await page.evaluate(() => window.__d.formWalker.getPositions().cloudScatter)
  expect(after).toBeCloseTo(before, 10)
})
