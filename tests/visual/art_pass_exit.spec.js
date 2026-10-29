import { test, expect } from '@playwright/test'
import { boot as bootApp, useRevealClock, advanceReveal, waitFrames } from './helpers.js'

/**
 * The exit counts the strokes that have gone (artExitCount.frag), so the sound
 * can follow them. Under the random rule each stroke has its own moment drawn
 * flat between the ground beat and the end, so the share gone at progress p is
 * known independently: (p - beat) / (1 - beat). The count must land on it, and
 * must be 0 outside an exit and never fall within one.
 */
async function bootHeld(page) {
  await bootApp(page)
  await useRevealClock(page)
  await page.evaluate(() => {
    const a = window.__d.artPass
    a.params.set('revealDuration', 0.3)
    a.params.set('revealPrimeDuration', 0)
    a.params.set('revealPrimeLighten', 0)
    a.params.set('exitDuration', 10)
    a.params.set('exitRandom', true)
    a.params.set('exitGroundBeat', 0.2)
    a.playReveal()
  })
  await advanceReveal(page, 600)
  await waitFrames(page, 3)
}

const removed = page => page.evaluate(() => window.__d.artPass.getRemovedFraction())

/** The count is read back asynchronously, and under load the read takes a
 *  number of frames to land: after the clock moves, give it plenty, then read. */
async function settledRemoved(page) {
  await waitFrames(page, 30)
  return removed(page)
}

test('the removed share follows the exit rule and only rises', async ({ page }) => {
  await bootHeld(page)
  expect(await removed(page), 'not exiting').toBe(0)

  await page.evaluate(() => window.__d.artPass.playExit())
  const seen = []
  for (const stepMs of [1000, 1000, 1000, 1000, 1000]) {   // progress 0.1 … 0.5
    await advanceReveal(page, stepMs)
    seen.push(await settledRemoved(page))
  }
  // Before the ground beat (0.2) no stroke has gone.
  expect(seen[0]).toBeLessThan(0.05)
  // At progress 0.6 the share is (0.6 - 0.2) / 0.8 = 0.5.
  await advanceReveal(page, 1000)
  const mid = await settledRemoved(page)
  expect(mid).toBeGreaterThan(0.4)
  expect(mid).toBeLessThan(0.6)
  seen.push(mid)
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])

  await advanceReveal(page, 3900)   // progress 0.99
  expect(await settledRemoved(page)).toBeGreaterThan(0.95)
})

test('an exit that never started reports nothing removed', async ({ page }) => {
  await bootHeld(page)
  expect(await removed(page)).toBe(0)
})
