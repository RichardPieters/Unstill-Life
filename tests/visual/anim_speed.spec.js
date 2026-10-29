/**
 * anim_speed.spec.js — the ambient-motion speed (water ripples + cloud
 * drift, animSpeed.js) ↔ the real live dynamics + art pass, wired in main.js.
 *
 * Speed is directly proportional to dynamics.restlessness (no separate ramp), so
 * these drive the real dynamics.update() loop rather than faking a wall clock.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test.beforeEach(async ({ page }) => {
  await boot(page, { freezeForm: false })
})

test('settle mode freezing the scene fades speed proportional to restlessness, reaching exactly 0 with it', async ({ page }) => {
  const r = await page.evaluate(() => {
    const { dynamics, animSpeed, artPass, water } = window.__d
    animSpeed.params.set('targetSpeed', 2)
    dynamics.momentum  = 0
    dynamics.restlessness = 1
    dynamics.params.set('settleIntervalAtMaxAttention', 30)

    const rows = []
    for (let i = 0; i < 30 * 60 + 5; i++) {
      dynamics.update(1 / 60, 1.0)
      animSpeed.update(1 / 60)
      if (i % (15 * 60) === 0) rows.push({ restlessness: dynamics.restlessness, speed: animSpeed.getSpeed() })
    }
    // water.setAnimSpeed(animSpeed.getSpeed()) is a one-liner in main.js's
    // render loop, which isn't running here (paused) — call it ourselves,
    // exactly what that line does, to prove the wiring itself (not just the
    // AnimSpeed class in isolation) reaches water.
    water.setAnimSpeed(animSpeed.getSpeed())
    return {
      rows,
      frozeArt: artPass.enabled,
      finalStability: dynamics.restlessness,
      finalSpeed: animSpeed.getSpeed(),
      waterMirrorsIt: water._driver._animSpeed === animSpeed.getSpeed(),
    }
  })

  expect(r.frozeArt).toBe(true)
  expect(r.finalStability).toBe(0)
  expect(r.finalSpeed).toBe(0)
  expect(r.waterMirrorsIt).toBe(true)
  // Proportional throughout the decay, not just at the endpoint.
  for (const row of r.rows) expect(row.speed).toBeCloseTo(2 * row.restlessness, 6)
})

test('leaving the painted state climbs speed back up on the art pass\'s exitResumeEase knob', async ({ page }) => {
  // Drives the real artPass + dynamics singletons directly (enabled + restlessness
  // are plain fields on both) rather than the full decay-to-freeze dance — that
  // dance is already covered by the proportional-fade test above; this one
  // isolates the CLIMB specifically, the same way the unit tests do, just
  // against the real wired instances instead of fakes.
  const climbAfterLeaving = (page, resumeEase) => page.evaluate(ease => {
    const { dynamics, animSpeed, artPass } = window.__d
    animSpeed.params.set('targetSpeed', 2)
    dynamics.restlessness = 1
    artPass.params.set('exitResumeEase', ease)

    artPass.enabled = true
    animSpeed.update(1 / 60)   // held: enabled, not exiting
    const held = animSpeed.getSpeed()

    artPass.enabled = false    // generic deactivation, no exit animation at all
    for (let i = 0; i < 60; i++) animSpeed.update(1 / 60)   // 1s into the climb
    return { held, afterOneSecond: animSpeed.getSpeed() }
  }, resumeEase)

  const fast = await climbAfterLeaving(page, 1)
  const slow = await climbAfterLeaving(page, 14)
  expect(fast.held).toBe(0)
  expect(slow.held).toBe(0)
  expect(fast.afterOneSecond).toBeGreaterThan(slow.afterOneSecond)   // shorter ease climbs back faster
  expect(fast.afterOneSecond).toBeLessThan(2)   // still genuinely easing, not snapping
})

test('the real render loop pushes animSpeed into water every frame, unprompted', async ({ page }) => {
  // Unlike the tests above (which drive AnimSpeed directly to stay
  // deterministic), this one proves main.js's OWN per-frame wiring runs —
  // resuming the loop for a couple of real frames with nothing else touching
  // water.setAnimSpeed at all.
  const r = await page.evaluate(async () => {
    const { water, animSpeed, dynamics } = window.__d
    dynamics.params.set('momentumTau', 0)   // snap, so one real frame is enough
    window.__d.artPass.params.set('exitResumeEase', 0)   // the climb now rides this knob
    animSpeed.params.set('targetSpeed', 2)      // a value nothing already holds
    window.__d.pause()               // un-pause (toggles the click-bound button)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    window.__d.pause()               // pause again
    return { pushed: water._driver._animSpeed, wave: animSpeed.getWaveSpeed(),
             speed: animSpeed.getSpeed(), restlessness: dynamics.restlessness }
  })
  // Speed tracks target * restlessness (restlessness may have drifted a little
  // during the real frames), and water gets the WAVE speed (speed x the
  // weather's wave factor), not the raw speed.
  expect(r.speed).toBeCloseTo(2 * r.restlessness, 5)
  expect(r.speed).toBeGreaterThan(0)
  expect(r.pushed).toBeCloseTo(r.wave, 9)
})
