import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { waitFrames } from './helpers.js'

/**
 * boot_state.spec.js — the piece opens as a still painting: dynamics is frozen
 * at momentum 0 and restlessness 0, and the clouds' eased uniforms start AT
 * their rows, so nothing in the sky moves into place after the first frame.
 */
test('the opening scene is still: no momentum, and the sky is already where its rows are', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__d && window.__d.clouds)
  const read = () => page.evaluate(() => {
    const { dynamics, clouds } = window.__d
    return {
      momentum: dynamics.momentum,
      restlessness: dynamics.restlessness,
      frozen: dynamics.isFrozen(),
      coverage: clouds._shared.uCoverage.value,
      coverageRow: clouds.params.get('coverage'),
      freq: clouds._bakeMaterial.uniforms.uBaseFreq.value,
      freqRow: clouds.params.get('baseFreq'),
    }
  })
  const first = await read()
  expect(first.frozen).toBe(true)
  expect(first.momentum).toBe(0)
  expect(first.restlessness).toBe(0)
  expect(first.coverage).toBe(first.coverageRow)
  expect(first.freq).toBe(first.freqRow)

  await page.waitForTimeout(1500)
  const later = await read()
  expect(later.coverage).toBe(first.coverage)
  expect(later.freq).toBe(first.freq)
})

/**
 * The piece opens on the start scene (src/scene/startScene.json), restored
 * before the render loop starts. A capture after the first frames must equal
 * the file: a value that differs is either never restored or overwritten by a
 * frame, and a frame showing construction values is what this guards against.
 * `render` is the window, not scene state.
 */
test('the opening frames show the start scene, not the construction values', async ({ page }) => {
  const start = JSON.parse(readFileSync(new URL('../../src/scene/startScene.json', import.meta.url), 'utf8'))
  await page.goto('/')
  await page.waitForFunction(() => window.__d && window.__d.clouds)
  await waitFrames(page, 5)
  const live = await page.evaluate(() => window.__d.captureSnapshot())

  const differences = []
  const compare = (want, got, path) => {
    if (typeof want === 'number') {
      if (!(typeof got === 'number' && Math.abs(got - want) <= 1e-6 * Math.max(1, Math.abs(want)))) differences.push(`${path}: ${want} -> ${got}`)
    } else if (want && typeof want === 'object') {
      for (const key of Object.keys(want)) compare(want[key], got?.[key], `${path}.${key}`)
    } else if (want !== got) {
      differences.push(`${path}: ${want} -> ${got}`)
    }
  }
  for (const key of Object.keys(start)) if (key !== 'render') compare(start[key], live[key], key)
  expect(differences).toEqual([])
})
