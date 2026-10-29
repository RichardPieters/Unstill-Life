import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

/**
 * The reveal/exit state machine under an attention signal that changes at any
 * moment. Attention is ultimately a microphone, so every transition can arrive
 * mid-animation — including a freeze during a dissolve and a second unfreeze
 * during one.
 *
 * The invariant these all assert: the pass is never left in a state a viewer
 * would read as broken — never both animations at once, never a frozen
 * landscape with no painting on it and no way back, never a held copy being
 * served while a reveal is supposedly growing.
 */

/** The pass's own state, as the render loop and dynamics see it. */
async function passState(page) {
  return page.evaluate(() => {
    const a = window.__d.artPass
    return {
      enabled: a.enabled,
      reveal: a.isRevealPlaying(),
      exit: a.isExitPlaying(),
      // Through the director's own query rather than a raw field: the state
      // machine lives in artPassReveal.js and the pass only delegates to it.
      held: a.isHeld(),
      exitFade: a.uniformValue('uExitFade'),
      exitProgress: a.uniformValue('uExitProgress'),
    }
  })
}

const frames = (page, n) => page.evaluate(
  n => new Promise(async res => {
    for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r))
    res()
  }), n)

test('the canvas surface is live from boot, not only during an exit', async ({ page }) => {
  await boot(page, { pause: true })
  // uExitFade multiplies the weave/crevice/high-key in artFinish.frag. Its rest
  // value is what every painting outside an exit is drawn with, so 0 here means
  // those three are switched off for the entire life of the piece.
  const s = await passState(page)
  expect(s.exitFade).toBe(1)
})

test('a full reveal→exit cycle leaves the canvas surface live for the next painting', async ({ page }) => {
  await boot(page, { pause: true })
  await page.evaluate(async () => {
    const a = window.__d.artPass
    a.params.set('revealDuration', 0.3)
    a.params.set('revealPrimeDuration', 0.05)
    a.params.set('exitDuration', 0.3)
    a.playReveal()
    while (a.isRevealPlaying()) await new Promise(r => requestAnimationFrame(r))
    a.playExit()
    while (a.enabled) await new Promise(r => requestAnimationFrame(r))
  })
  const s = await passState(page)
  expect(s.enabled).toBe(false)
  expect(s.exit).toBe(false)
  expect(s.reveal).toBe(false)
  // The exit's last write was 1 - 1 = 0. If that is what the next painting
  // inherits, it arrives with no canvas under it.
  expect(s.exitFade).toBe(1)
})

test('attention returning mid-dissolve restarts the painting instead of stranding it', async ({ page }) => {
  await boot(page, { pause: true })
  await page.evaluate(async () => {
    const a = window.__d.artPass
    a.params.set('revealDuration', 0.3)
    a.params.set('revealPrimeDuration', 0.05)
    a.params.set('exitDuration', 4)      // long enough to interrupt in the middle
    a.playReveal()
    while (a.isRevealPlaying()) await new Promise(r => requestAnimationFrame(r))
    a.playExit()
  })
  await frames(page, 4)
  expect((await passState(page)).exit).toBe(true)

  // The world re-freezes while the painting is still coming apart. The second
  // reveal gets a long duration so that what is asserted below is its STATE,
  // not a race against it finishing — a few frames of this pass can outrun a
  // sub-second animation on a loaded machine, which is a property of the test
  // host rather than of the state machine under test.
  await page.evaluate(() => {
    window.__d.artPass.params.set('revealDuration', 20)
    window.__d.artPass.playReveal()
  })
  await frames(page, 4)

  const s = await passState(page)
  expect(s.enabled).toBe(true)
  expect(s.reveal).toBe(true)
  expect(s.exit).toBe(false)     // never both at once
  expect(s.held).toBe(false)     // repainting live, not serving the dissolve's frozen copy
  expect(s.exitFade).toBe(1)     // and not still wearing the dissolve's partial fade
})

// playExit() is called directly here. In the app a reveal cannot be interrupted:
// the loop reads no attention while it plays (frameLogic.shouldAdvanceDynamics),
// so this guards playExit's own robustness, not a reachable sequence.
test('a reveal interrupted mid-flight still ends up somewhere it can leave from', async ({ page }) => {
  await boot(page, { pause: true })
  await page.evaluate(async () => {
    const a = window.__d.artPass
    a.params.set('revealDuration', 5)    // interrupt partway through
    a.params.set('revealPrimeDuration', 0.05)
    // Long enough that a handful of heavy frames cannot finish it, so the
    // assertions below read state rather than race the clock.
    a.params.set('exitDuration', 3)
    a.playReveal()
  })
  await frames(page, 4)
  expect((await passState(page)).reveal).toBe(true)

  // Attention drops before the picture ever finished arriving.
  await page.evaluate(() => window.__d.artPass.playExit())
  await frames(page, 2)
  const mid = await passState(page)
  expect(mid.reveal).toBe(false)
  expect(mid.exit).toBe(true)
  expect(mid.held).toBe(true)      // took its own hold on the way out

  // …and it still finishes and switches itself off, rather than sticking.
  await page.evaluate(async () => {
    const a = window.__d.artPass
    const until = performance.now() + 60000   // a cap, not a timing: loops on state
    while (a.enabled && performance.now() < until) await new Promise(r => requestAnimationFrame(r))
  })
  expect((await passState(page)).enabled).toBe(false)
})

test('a repeated unfreeze does not restart the dissolve', async ({ page }) => {
  await boot(page, { pause: true })
  await page.evaluate(async () => {
    const a = window.__d.artPass
    a.params.set('revealDuration', 0.3)
    a.params.set('revealPrimeDuration', 0.05)
    a.params.set('exitDuration', 4)
    a.playReveal()
    while (a.isRevealPlaying()) await new Promise(r => requestAnimationFrame(r))
    a.playExit()
  })
  await frames(page, 12)
  const before = (await passState(page)).exitProgress
  expect(before).toBeGreaterThan(0)

  await page.evaluate(() => window.__d.artPass.playExit())   // a second one arrives
  await frames(page, 2)
  // Monotonic: the picture must not snap back to full and dissolve again.
  expect((await passState(page)).exitProgress).toBeGreaterThanOrEqual(before)
})
