
import { installCloudReadback } from './cloudReadback.js'

/**
 * Shared Playwright helpers for the visual test suite.
 *
 * Pixel reads go through page.screenshot() (compositor capture) because the
 * WebGL canvas is created without preserveDrawingBuffer — an in-page
 * drawImage(canvas) blit yields blank pixels after the buffer swap.
 */

/**
 * Put a freshly loaded app in the state the specs were written against: live
 * sim, art pass off. The app itself boots as a frozen, fully painted frame
 * (Dynamics constructs frozen; ART_ENABLED_DEFAULT). Switching the pass off
 * and calling dynamics.wake() skips the animated exit. Call after the start overlay is dismissed.
 */
export async function liveBaseline(page) {
  await page.evaluate(() => {
    const { dynamics, artPass, animSpeed } = window.__d
    artPass.enabled = false
    dynamics.wake()                        // running at full restlessness, momentum eases up from 0
    dynamics.momentum = 0.5
    // animSpeed saw the painting leave and is mid "climb back" from 0 — land it
    // on its settled value so specs read a calm running scene, not a ramp.
    animSpeed._resuming = false
    animSpeed._wasHolding = false          // else its next update re-arms the climb
    animSpeed._speed = animSpeed._target
    // The attention slider ships at 1, which decays restlessness and re-freezes
    // the sim (and starts a painting) a few seconds later. 0.5 is below the
    // unfreeze threshold, so the scene stays live for the whole spec.
    const att = document.getElementById('attention')
    att.value = '0.5'
    att.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * Dial positions with a wide visible sea (captured from a walk), for the specs
 * that measure the sea itself.
 */
const FORM_WITH_SEA = { ocean: 0.8828859079080752, mountains: 0.3148997563885995 }

/** Specs that measure the sea itself restore these positions first. */
export async function restoreSeaForm(page) {
  await page.evaluate(form => window.__d.applyFormPositions(
    { ...window.__d.readForm(), ...form }, { snapSea: true }), FORM_WITH_SEA)
}

/**
 * Boot the app: dismiss the start overlay, collect console/page errors.
 *
 * `freezeForm` (default on) stops the form walker and puts the macro dials back
 * where they loaded. Without it the walker drifts the ocean/mountains/snowline
 * for the second or so before this returns, so every spec that assumes a fixed
 * landscape — height range, sea bounds, the driver golden — reads a form that
 * has already moved. Pass false only when the drift is what you are testing.
 *
 * `fakeClock` (default off) installs Playwright's fake clock before load, so
 * timers, rAF and performance.now only move when the spec calls
 * `page.clock.runFor(ms)` — every frame then gets an exact, fixed dt however
 * loaded the machine is. Use it for specs that measure a RATE over time. It
 * is opt-in because an in-page `await requestAnimationFrame` never resolves
 * under it unless the spec is driving the clock from outside.
 *
 * `liveUnpainted` (default on) puts the app back in the state every spec was
 * written against: running sim, art pass off. The app itself now boots as a
 * frozen, fully painted frame (Dynamics constructs frozen; ART_ENABLED_DEFAULT), so
 * without this every pixel/animation assertion reads a held painting. Pass
 * false only for specs about that startup state itself.
 */
export async function boot(page, { pause = true, settleMs = 800, freezeForm = true, liveUnpainted = true, fakeClock = false } = {}) {
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message))
  await page.setViewportSize({ width: 1600, height: 900 })
  if (fakeClock) await page.clock.install()
  const wait = ms => fakeClock ? page.clock.runFor(ms) : waitFrames(page, Math.max(3, Math.round(ms / 80)))
  await page.goto('/')
  if (fakeClock) await page.clock.runFor(500)
  await page.waitForFunction(() => !!window.__d, null, fakeClock ? { polling: 100 } : {})
  await page.evaluate(installCloudReadback)
  await page.mouse.click(800, 450)            // dismiss the start overlay
  // The veil fades for 0.7 s and then leaves the page; a pixel read while it is
  // still there would measure the veil.
  if (fakeClock) await page.clock.runFor(1100)
  else await page.waitForSelector('#start-overlay', { state: 'detached' })
  // The specs were tuned at the stroke density of a 1600 px buffer, not at the
  // paint scale this window size gives.
  await page.evaluate(() => window.__d.artPass.pinPaintScale(1))
  if (liveUnpainted) await liveBaseline(page)
  await wait(settleMs)                        // let terrain/sea settle
  if (freezeForm) await page.evaluate(() => window.__d.freezeForm())
  if (pause) await page.evaluate(() => window.__d.pause())
  await wait(100)
  return errors
}

/**
 * Decode a screenshot of the scene canvas inside the page (2D canvas, no
 * Node image dependency) and return raw RGBA data, downsampled to `size`.
 */
export async function screenshotPixels(page, size) {
  // #scene-canvas, not a bare 'canvas' tag selector: the debug panel's
  // mic-flux-graph and cam-overlay canvases put 3 <canvas> elements on the
  // page, and page.locator('canvas') requires exactly one match (Playwright
  // strict mode) for actions like .screenshot() — this failed every spec that
  // went through here (8 of them) the moment those two debug canvases existed.
  const canvas = page.locator('#scene-canvas')
  const buf    = await canvas.screenshot()
  return page.evaluate(async ({ b64, size }) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const off = document.createElement('canvas')
    off.width  = size || img.width
    off.height = size || img.height
    const ctx = off.getContext('2d')
    ctx.drawImage(img, 0, 0, off.width, off.height)
    return Array.from(ctx.getImageData(0, 0, off.width, off.height).data)
  }, { b64: buf.toString('base64'), size })
}

/** Pixel statistics over RGB channels. Returns { mean, variance }. */
export async function canvasPixelStats(page) {
  const data = await screenshotPixels(page, 256)
  const values = []
  for (let i = 0; i < data.length; i += 4) {
    values.push(data[i], data[i + 1], data[i + 2])
  }
  const mean     = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return { mean, variance }
}

/** Small sampled hash of the scene — detects whether the frame changed. */
export async function canvasFingerprint(page) {
  const data = await screenshotPixels(page, 64)
  let sum = 0
  for (let i = 0; i < data.length; i += 16) sum += data[i]
  return sum
}

/**
 * Replace the art pass's reveal/exit clock with one the spec advances by hand,
 * so "N ms into the reveal" is exact however slowly frames arrive under load.
 * Install right after boot(), before any playReveal()/playExit().
 */
export async function useRevealClock(page) {
  await page.evaluate(() => {
    window.__revealNow = performance.now()
    window.__d.artPass.setClock(() => window.__revealNow)
  })
}

/**
 * Advance the manual reveal clock by `ms`, then wait for two real frames so
 * render() has written the uniforms for the new time. Waits on frames, never
 * on wall-clock time.
 */
export async function advanceReveal(page, ms) {
  await page.evaluate(async ms => {
    window.__revealNow += ms
    for (let i = 0; i < 2; i++) {
      window.__d.markDirty()
      await new Promise(r => requestAnimationFrame(r))
    }
  }, ms)
}

/**
 * Wait for `n` real rendered frames, marking the scene dirty before each so a
 * paused loop still draws. The load-proof replacement for a fixed sleep: a busy
 * machine takes longer per frame, but the spec still sees the same number.
 */
export async function waitFrames(page, n = 3) {
  await page.evaluate(async n => {
    for (let i = 0; i < n; i++) {
      window.__d.markDirty()
      await new Promise(r => requestAnimationFrame(r))
    }
  }, n)
}
