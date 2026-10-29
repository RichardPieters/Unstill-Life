import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

/**
 * The holding-still gates: while nothing in the world is moving, the passes
 * that re-derive it must not run — and must come straight back the instant
 * anything changes.
 *
 * Asserted by COUNTING CALLS, not by timing. A frame-time threshold is a
 * machine-speed measurement and goes red under load; whether a pass ran at all is exact, and it is the actual contract.
 *
 * The cloud volume is counted by spying on its march quad, which renders once
 * per frame that renderClouds() does work — the early-return leaves it alone.
 * Counting the march itself observes the real work rather than a tally kept
 * alongside it, so the count cannot go stale.
 */

/**
 * Freeze the world the way the piece does: attention up, wait for the event,
 * then let the painting finish arriving.
 *
 * The reveal is cut to a fraction of its 12s default first — this spec is about
 * what runs on a motionless world, and waiting out the real entrance animation
 * would spend the whole test budget watching paint arrive.
 */
async function freezeWorld(page) {
  await page.evaluate(async () => {
    const { dynamics, artPass } = window.__d
    artPass.params.set('revealDuration', 0.5)
    artPass.params.set('revealPrimeDuration', 0.1)
    dynamics.params.set('settleIntervalAtMaxAttention', 0.3)
    document.getElementById('attention').value = '1'
    document.getElementById('attention').dispatchEvent(new Event('input'))
    await new Promise(resolve => {
      const onFreeze = () => { dynamics.removeEventListener('freeze', onFreeze); resolve() }
      dynamics.addEventListener('freeze', onFreeze)
    })
    // Let the reveal finish so the painting is held and the world is fully at rest.
    while (window.__d.artPass.isRevealPlaying()) await new Promise(r => requestAnimationFrame(r))
  })
}

/** Install call counters, run `frames` frames, return the counts. */
async function countOverFrames(page, frames, duringSrc = '') {
  return page.evaluate(async ({ frames, duringSrc }) => {
    const d = window.__d
    const counts = { dataMap: 0, waterDepth: 0, waterReflect: 0, cloudFrames: 0 }
    const marchQuad = d.clouds._marchQuad
    const orig = {
      dataMap: d.terrain.renderDataMap.bind(d.terrain),
      waterDepth: d.water.depthPrePass.bind(d.water),
      waterReflect: d.water.reflectionPrePass.bind(d.water),
      march: marchQuad.render.bind(marchQuad),
    }
    d.terrain.renderDataMap = (...a) => { counts.dataMap++; return orig.dataMap(...a) }
    d.water.depthPrePass = (...a) => { counts.waterDepth++; return orig.waterDepth(...a) }
    d.water.reflectionPrePass = (...a) => { counts.waterReflect++; return orig.waterReflect(...a) }
    marchQuad.render = (...a) => { counts.cloudFrames++; return orig.march(...a) }

    // eslint-disable-next-line no-new-func
    if (duringSrc) new Function('d', duringSrc)(d)
    for (let i = 0; i < frames; i++) await new Promise(r => requestAnimationFrame(r))

    d.terrain.renderDataMap = orig.dataMap
    d.water.depthPrePass = orig.waterDepth
    d.water.reflectionPrePass = orig.waterReflect
    marchQuad.render = orig.march
    return counts
  }, { frames, duringSrc })
}

test('a world holding still re-derives nothing', async ({ page }) => {
  const errors = await boot(page, { pause: false })
  await freezeWorld(page)

  const c = await countOverFrames(page, 20)
  expect(c.dataMap).toBe(0)
  expect(c.waterDepth).toBe(0)
  expect(c.waterReflect).toBe(0)
  expect(c.cloudFrames).toBe(0)
  expect(errors).toEqual([])
})

test('touching a control brings every pass straight back', async ({ page }) => {
  await boot(page, { pause: false })
  await freezeWorld(page)

  // A slider moved over a frozen landscape is the case the dirty flag exists
  // for: before it was threaded through, this rendered a frame with the data
  // map skipped and the change never reached the screen.
  const c = await countOverFrames(page, 6, `
    const el = document.getElementById('ctrl-ero-strength')
    el.value = String(parseFloat(el.value) + 0.1)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  `)
  expect(c.dataMap).toBeGreaterThan(0)
  expect(c.waterDepth).toBeGreaterThan(0)
  expect(c.waterReflect).toBeGreaterThan(0)
  expect(c.cloudFrames).toBeGreaterThan(0)
})

test('the world resuming brings every pass back and keeps it back', async ({ page }) => {
  await boot(page, { pause: false })
  await freezeWorld(page)

  // Attention drops past the threshold: dynamics unfreezes, the painting starts
  // dissolving, and the landscape has to be live again for the exit to read it.
  const c = await countOverFrames(page, 20, `
    document.getElementById('attention').value = '0'
    document.getElementById('attention').dispatchEvent(new Event('input'))
  `)
  // Not "> 0" but "most frames": a resumed world is not allowed to coast.
  expect(c.dataMap).toBeGreaterThan(10)
  expect(c.waterDepth).toBeGreaterThan(10)
  expect(c.cloudFrames).toBeGreaterThan(10)
})
