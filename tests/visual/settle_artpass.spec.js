/**
 * settle_artpass.spec.js — the settle pipeline's freeze/unfreeze ↔ the art
 * pass, wired in main.js (dynamics.js itself has no reference to artPass, and
 * artPass has none back — see main.js's two dynamics.addEventListener calls
 * right after both are constructed).
 *
 * Drives dynamics.update() directly rather than waiting out real seconds —
 * momentum starts AT its attention=1 target (0) so restlessness decays at
 * exactly 1/interval per second, the same determinism tests/unit/dynamics.test.js uses.
 *
 * Unfreeze calls artPass.playExit(), not `.enabled = false` — an ANIMATED
 * dissolve that leaves `.enabled` true for its own duration (it measures each
 * stroke against how far the live scene drifts since it was painted, so it
 * needs the scene moving, not gone) and only clears `.enabled` once it
 * finishes. "Unfrozen" is therefore asserted as isExitPlaying() having
 * started, not as `.enabled` having gone false — synchronously driving
 * dynamics.update() here never lets a real wall-clock exit animation
 * complete, so waiting for `.enabled` to go false would never pass.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test.beforeEach(async ({ page }) => {
  await boot(page, { freezeForm: false })
})

test('freezing turns the art pass on; falling attention past threshold turns it back off', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { dynamics, artPass } = window.__d
    dynamics.momentum  = 0
    dynamics.restlessness = 1
    dynamics.params.set('settleIntervalAtMaxAttention', 30)
    dynamics.params.set('unfreezeAttention', 0.3)

    const before = { frozen: dynamics.isFrozen(), artOn: artPass.enabled, exiting: artPass.isExitPlaying() }
    for (let i = 0; i < 30 * 60 + 5; i++) dynamics.update(1 / 60, 1.0)
    const atFreeze = { frozen: dynamics.isFrozen(), artOn: artPass.enabled, exiting: artPass.isExitPlaying() }

    dynamics.update(1 / 60, 0.0) // attention drops well below the threshold
    const afterUnfreeze = { frozen: dynamics.isFrozen(), artOn: artPass.enabled, exiting: artPass.isExitPlaying() }

    return { before, atFreeze, afterUnfreeze }
  })

  expect(r.before).toEqual({ frozen: false, artOn: false, exiting: false })
  expect(r.atFreeze).toEqual({ frozen: true, artOn: true, exiting: false })
  // Dynamics itself has already unfrozen; the art pass is mid-exit, not gone.
  expect(r.afterUnfreeze).toEqual({ frozen: false, artOn: true, exiting: true })
})

test('staying above the unfreeze threshold keeps the art pass on', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { dynamics, artPass } = window.__d
    dynamics.momentum  = 0
    dynamics.restlessness = 1
    dynamics.params.set('settleIntervalAtMaxAttention', 30)
    dynamics.params.set('unfreezeAttention', 0.3)
    for (let i = 0; i < 30 * 60 + 5; i++) dynamics.update(1 / 60, 1.0)

    for (let i = 0; i < 120; i++) dynamics.update(1 / 60, 0.9) // above 0.3
    return { frozen: dynamics.isFrozen(), artOn: artPass.enabled }
  })
  expect(r).toEqual({ frozen: true, artOn: true })
})

test('the real render loop: momentum is 0 under a painting and resumes from 0 after it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { dynamics, artPass } = window.__d
    dynamics.momentum = 0.0
    dynamics.restlessness = 1
    dynamics.params.set('settleIntervalAtMaxAttention', 3)   // fast, real settle within a couple seconds
    artPass.params.set('revealPrimeDuration', 0.3)           // a short reveal: the point of no return waits it out
    artPass.params.set('revealDuration', 4)
    window.__d.pause()                      // un-pause
    const setAttention = v => {
      const el = document.getElementById('attention')
      el.value = String(v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setAttention(1)

    // Wait on the STATE, not a fixed time: under load frames are long and the
    // sim's per-frame dt is clamped, so sim time can trail wall time badly.
    const frame = () => new Promise(r => requestAnimationFrame(r))
    const until = async cond => { const cap = performance.now() + 60000; while (!cond() && performance.now() < cap) await frame() }
    const frames = async n => { for (let i = 0; i < n; i++) await frame() }
    await until(() => dynamics.isFrozen())

    const atFreeze = { frozen: dynamics.isFrozen(), momentum: dynamics.momentum, noiseSpeed: dynamics.noiseSpeed, artOn: artPass.enabled }
    await frames(5)
    const stillHeld = { momentum: dynamics.momentum, noiseSpeed: dynamics.noiseSpeed }

    // The room turns restless while the painting is still being painted: the
    // reveal is the point of no return, so the scene must stay frozen and no
    // exit may start until the reveal is complete.
    setAttention(0)
    let revealing = artPass.isRevealPlaying()
    let frozenThroughReveal = true
    let exitedDuringReveal = false
    const revealCap = performance.now() + 60000
    while (artPass.isRevealPlaying() && performance.now() < revealCap) {
      if (!dynamics.isFrozen()) frozenThroughReveal = false
      if (artPass.isExitPlaying()) exitedDuringReveal = true
      await frame()
    }
    await until(() => !dynamics.isFrozen())
    const afterUnfreeze = dynamics.momentum

    window.__d.pause()   // pause again
    return { atFreeze, stillHeld, afterUnfreeze, revealing, frozenThroughReveal, exitedDuringReveal }
  })

  expect(r.atFreeze.frozen).toBe(true)
  expect(r.atFreeze.artOn).toBe(true)
  expect(r.atFreeze.momentum).toBe(0)
  expect(r.atFreeze.noiseSpeed).toBe(0)
  expect(r.stillHeld).toEqual({ momentum: 0, noiseSpeed: 0 })
  // The point of no return: a restless room during the reveal changes nothing
  // until the painting is complete, and only then wakes the scene.
  expect(r.revealing).toBe(true)
  expect(r.frozenThroughReveal).toBe(true)
  expect(r.exitedDuringReveal).toBe(false)
  // Eased up from 0, a few frames at most: far below the attention-0 level 0.95.
  expect(r.afterUnfreeze).toBeGreaterThanOrEqual(0)
  expect(r.afterUnfreeze).toBeLessThan(0.1)
})

test('a painting switched on by hand holds the world, and attention cannot dissolve it', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { dynamics, artPass } = window.__d
    const frame = () => new Promise(r => requestAnimationFrame(r))
    const frames = async n => { for (let i = 0; i < n; i++) await frame() }
    // The checkbox still shows the boot painting's "on" (liveBaseline turns the
    // pass off directly), so set it explicitly rather than toggling.
    const setArt = on => {
      const el = document.getElementById('tog-artpass')
      el.checked = on
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    window.__d.pause()                      // un-pause; liveBaseline left attention at 0.5
    setArt(true)
    await frames(30)
    const held = { frozen: dynamics.isFrozen(), held: dynamics.isHeld(), artOn: artPass.enabled, exiting: artPass.isExitPlaying(), momentum: dynamics.momentum }
    setArt(false)
    await frames(3)
    const released = { frozen: dynamics.isFrozen(), held: dynamics.isHeld(), artOn: artPass.enabled }
    window.__d.pause()
    return { held, released }
  })
  expect(r.held).toEqual({ frozen: true, held: true, artOn: true, exiting: false, momentum: 0 })
  expect(r.released).toEqual({ frozen: false, held: false, artOn: false })
})

test('restlessness snaps back to 1 the instant the exit dissolve finishes', async ({ page }) => {
  // main.js's own catch (prevArtPassEnabled true->false), not dynamics.js's
  // gradual post-unfreeze climb: the scene should read as provably back at
  // full pace the moment the painting is gone, not still easing up under it.
  const r = await page.evaluate(async () => {
    const { dynamics, artPass } = window.__d
    dynamics.momentum = 0.0
    dynamics.restlessness = 1
    dynamics.params.set('settleIntervalAtMaxAttention', 3)
    artPass.params.set('exitDuration', 0.3)   // short, so the exit finishes within the wait below
    artPass.params.set('revealPrimeDuration', 0.3)   // short reveal: the exit starts only once it is complete
    artPass.params.set('revealDuration', 1)
    window.__d.pause()
    document.getElementById('attention').value = '1'
    document.getElementById('attention').dispatchEvent(new Event('input', { bubbles: true }))

    // Wait on the STATE, not a fixed time: under load frames are long and the
    // sim's per-frame dt is clamped, so sim time can trail wall time badly.
    const frame = () => new Promise(r => requestAnimationFrame(r))
    const until = async cond => { const cap = performance.now() + 60000; while (!cond() && performance.now() < cap) await frame() }
    const frames = async n => { for (let i = 0; i < n; i++) await frame() }
    await until(() => dynamics.isFrozen() && artPass.enabled)   // frozen, art pass on
    const atFreeze = { frozen: dynamics.isFrozen(), artOn: artPass.enabled }

    document.getElementById('attention').value = '0'
    document.getElementById('attention').dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => artPass.isExitPlaying())   // the reveal is the point of no return: the exit starts once it is complete
    await frames(1)         // unfreeze has fired; still mid-exit, still climbing on its own
    const rightAfterUnfreeze = { exiting: artPass.isExitPlaying(), artOn: artPass.enabled }

    await until(() => !artPass.enabled)   // the shortened exit finishes
    await frames(2)         // and main.js's true->false catch has run
    const afterExit = { restlessness: dynamics.restlessness, artOn: artPass.enabled }

    window.__d.pause()
    return { atFreeze, rightAfterUnfreeze, afterExit }
  })

  expect(r.atFreeze).toEqual({ frozen: true, artOn: true })
  expect(r.rightAfterUnfreeze).toEqual({ exiting: true, artOn: true })
  expect(r.afterExit).toEqual({ restlessness: 1, artOn: false })
})
