/**
 * terrain_form.spec.js — the two form dials must reach the running scene.
 *
 * The unit tests prove the blend arithmetic. This proves the wiring: that a
 * dial move lands on the real uniforms and the real water driver, that the fine
 * sliders it overwrites refresh instead of showing stale values, and that the
 * derived per-tick constants follow the new amplitudes.
 *
 * Asserted as directions and agreement-with-source, never as tuning values.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'
import { FORM_CORNERS } from '../../src/drift/terrainForm.js'

/** Drive the dials through the panel, exactly as a user would. */
async function setDials(page, ocean, mountains) {
  return page.evaluate(({ ocean, mountains }) => {
    const fire = (id, v) => {
      const el = document.getElementById(id)
      el.value = String(v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    fire('ctrl-form-ocean', ocean)
    fire('ctrl-form-mountains', mountains)
    const u = window.__d.terrain._material.uniforms
    return {
      amp0: u.uFBM0Amp.value, amp1: u.uFBM1Amp.value,
      freq0: u.uFBM0Freq.value, freq1: u.uFBM1Freq.value,
      ridgeAmt: u.uRidgeAmt.value, ridgeRound: u.uRidgeRound.value,
      relief: u.uMantleRelief.value, bias: u.uMantleBias.value,
      bedrockOct: u.uBedrockOctaves.value,
      gateLo: u.uRockGateLo.value,
      seaLow: window.__d.water.params.get('seaLow'),
      seaHigh: window.__d.water.params.get('seaHigh'),
      // what the panel is DISPLAYING for a couple of the overwritten sliders
      shownRelief: parseFloat(document.getElementById('ctrl-mantle-relief').value),
      shownAmp0: parseFloat(document.getElementById('f0-amp').value),
    }
  }, { ocean, mountains })
}

// Controls re-read what changed behind them when the panel is open (not while hidden).
const openPanel = page => page.evaluate(() => document.getElementById('debug').classList.add('visible'))

test('the dials drive the real uniforms and the real sea band', async ({ page }) => {
  await boot(page)
  const lo = await setDials(page, 0, 0)
  const hi = await setDials(page, 1, 1)

  // Mountains up → taller. Ocean up → sea band rises and landforms shrink.
  expect(hi.amp0).toBeGreaterThan(lo.amp0)
  expect(hi.seaLow).toBeGreaterThan(lo.seaLow)
  expect(hi.freq0).toBeGreaterThan(lo.freq0)
  expect(hi.amp1).toBeLessThan(lo.amp1)
})

test('each corner lands on the values the corner table holds', async ({ page }) => {
  await boot(page)
  // The blend is exact at the corners (unit-tested); this checks the APPLY step
  // did not drop or mis-route a parameter on its way to the scene. The table is
  // imported HERE, in node — the suite runs against the production preview
  // build, which serves dist/ and has no /src/ to import from in the page.
  const src = FORM_CORNERS
  const corners = [[0, 0, 0], [0, 1, 1], [1, 0, 2], [1, 1, 3]]
  for (const [o, mt, i] of corners) {
    const got = await setDials(page, o, mt)
    expect(got.amp0, `amp0 @ ${o},${mt}`).toBeCloseTo(src.fbm0Amp[i], 6)
    expect(got.amp1, `amp1 @ ${o},${mt}`).toBeCloseTo(src.fbm1Amp[i], 6)
    expect(got.ridgeAmt, `ridge @ ${o},${mt}`).toBeCloseTo(src.ridgeAmt[i], 6)
    expect(got.relief, `relief @ ${o},${mt}`).toBeCloseTo(src.mantleRelief[i], 6)
    expect(got.bias, `bias @ ${o},${mt}`).toBeCloseTo(src.mantleBias[i], 6)
    expect(got.gateLo, `gateLo @ ${o},${mt}`).toBeCloseTo(src.gateLo[i], 6)
    expect(got.seaLow, `seaLow @ ${o},${mt}`).toBeCloseTo(src.seaLow[i], 6)
    expect(got.seaHigh, `seaHigh @ ${o},${mt}`).toBeCloseTo(src.seaHigh[i], 6)
    expect(got.bedrockOct, `octaves @ ${o},${mt}`).toBe(Math.round(src.bedrockOctaves[i]))
  }
})

test('the fine sliders refresh to what the dial just wrote', async ({ page }) => {
  await boot(page)
  await openPanel(page)
  const a = await setDials(page, 0, 0)
  const b = await setDials(page, 1, 1)
  // A slider still showing its pre-dial value would misreport the scene.
  // Sliders are step-quantised, so allow one step.
  expect(Math.abs(a.shownRelief - a.relief)).toBeLessThanOrEqual(0.05)
  expect(Math.abs(b.shownRelief - b.relief)).toBeLessThanOrEqual(0.05)
  expect(Math.abs(a.shownAmp0 - a.amp0)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(b.shownAmp0 - b.amp0)).toBeLessThanOrEqual(0.5)
})

test('a control and the cloud readout follow a write that did not come from the panel', async ({ page }) => {
  await boot(page)
  await openPanel(page)
  const shown = await page.evaluate(() => {
    const c = window.__d.clouds
    // Not through the slider: a driver or a snapshot import writes the param.
    c.params.set('baseFreq', c.params.get('baseFreq') === 0.004 ? 0.006 : 0.004)
    return {
      freq: c.params.get('baseFreq'),
      sliderFreq: parseFloat(document.getElementById('ctrl-cvol-freq').value),
      label: parseFloat(document.getElementById('ctrl-cvol-freq-val').textContent),
      cell: c.getCellSize(),
      cellShown: parseFloat(document.getElementById('dbg-cvol-cell').textContent),
    }
  })
  expect(shown.sliderFreq).toBeCloseTo(shown.freq, 3)
  expect(shown.label).toBeCloseTo(shown.freq, 3)
  expect(shown.cellShown).toBeCloseTo(shown.cell, 1)
})

test('a toggle follows its param when something other than the panel flips it', async ({ page }) => {
  await boot(page)
  await openPanel(page)
  const states = await page.evaluate(() => {
    const t = window.__d.terrain
    const was = t.params.get('driftEnabled')
    t.params.set('driftEnabled', !was)
    return { was, now: document.getElementById('tog-drift').checked }
  })
  expect(states.now).toBe(!states.was)
})

test('the derived height range follows the dial, not the old amplitudes', async ({ page }) => {
  await boot(page)
  const read = async (o, m) => {
    await setDials(page, o, m)
    return page.evaluate(async () => {
      // One tick so the driver recomputes uHeightMax / uMantleDC from the amps.
      window.__d.dynamics.dispatchEvent(new CustomEvent('tick', {
        detail: { dt: 0.1, noiseTime: 1, momentum: 0.5, restlessness: 1 },
      }))
      const u = window.__d.terrain._material.uniforms
      return { heightMax: u.uHeightMax.value, amp0: u.uFBM0Amp.value, amp1: u.uFBM1Amp.value }
    })
  }
  const lo = await read(0, 0)
  const hi = await read(1, 1)
  // uHeightMax is amp sum plus an erosion margin, so it must track the dial.
  // Frozen, every biome band would sit at the wrong height after a dial move.
  expect(hi.heightMax).toBeGreaterThan(lo.heightMax)
  expect(hi.heightMax).toBeGreaterThan(hi.amp0 + hi.amp1 - 1)
})

/**
 * The dimming has to answer to the WALKER, not to the checkbox's `change`
 * event. freezeForm() flips the walk off in code, and setting `.checked` in
 * code fires no `change` — so a dimming loop wired to that event never hears
 * about it. Every visual spec's boot() calls freezeForm, so a marking that
 * missed it would leave the Driven rows dimmed and click-through while nothing
 * writes them: the panel claiming a system owns rows it does not.
 *
 * Asserted as agreement between the walker and the marking, in both
 * directions, rather than as a count of dimmed rows (which would ossify the
 * moment a row is added or moved to another tab).
 */
test('the driven marking follows the walker, including when code stops it', async ({ page }) => {
  await boot(page, { freezeForm: false })

  const state = () => page.evaluate(() => {
    const row = document.getElementById('ctrl-form-ocean').closest('.dbg-slider-row')
    const box = document.getElementById('tog-scene-drift')
    return {
      walking: window.__d.formWalker.params.get('enabled'),
      weather: window.__d.atmosphere.params.get('walking'),
      checked: box.checked,
      mixed:   box.indeterminate,
      dimmed:  row.classList.contains('sys-active'),
    }
  })

  const running = await state()
  expect(running.walking).toBe(true)
  expect(running.dimmed).toBe(true)

  // Stopped from CODE — the path with no `change` event behind it.
  await page.evaluate(() => window.__d.freezeForm())
  const frozen = await state()
  expect(frozen.walking).toBe(false)
  expect(frozen.dimmed, 'a row nothing is writing must not claim to be driven').toBe(false)
  // freezeForm stops the FORM only, so the one switch now stands in front of
  // two drivers that disagree. It must say so rather than pick one to believe.
  expect(frozen.weather, 'freezeForm must not silently stop the weather too').toBe(true)
  expect(frozen.mixed, 'a split drift state must read as indeterminate').toBe(true)
})

test('the one drift switch commits both drivers, from a split state', async ({ page }) => {
  await boot(page)                          // boot freezes the form -> split

  const read = () => page.evaluate(() => ({
    form:    window.__d.formWalker.params.get('enabled'),
    weather: window.__d.atmosphere.params.get('walking'),
  }))
  expect(await read()).toEqual({ form: false, weather: true })

  // Clicking an indeterminate box checks it, which must put BOTH on.
  await page.evaluate(() => {
    const box = document.getElementById('tog-scene-drift')
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(await read()).toEqual({ form: true, weather: true })

  await page.evaluate(() => {
    const box = document.getElementById('tog-scene-drift')
    box.checked = false
    box.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(await read()).toEqual({ form: false, weather: false })
})
