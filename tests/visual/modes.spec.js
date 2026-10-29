/**
 * Render gate: the material system and each debug view must produce a
 * non-degenerate frame with zero console errors. Screenshots land in
 * test-results/modes/ as review artifacts — the numbers below catch
 * mechanical breakage (black screen, NaN blowout, uniform mismatch);
 * artistic judgment on the artifacts stays human.
 */
import { test, expect } from '@playwright/test'
import { boot, canvasPixelStats, waitFrames } from './helpers.js'

const OUT = 'test-results/modes'

const VIEWS = [
  { name: 'material', view: 0 },
  { name: 'moisture', view: 1 },
  { name: 'exposure', view: 2 },
]

for (const { name, view } of VIEWS) {
  test(`${name} view renders without errors`, async ({ page }) => {
    const errors = await boot(page)
    await page.evaluate(v => window.__d.terrain.params.set('debugView', v), view)
    await waitFrames(page, 3)
    await page.screenshot({ path: `${OUT}/view-${name}.png` })

    const relevant = errors.filter(e => /webgl|shader|gl_|three|PAGEERROR/i.test(e))
    expect(relevant, relevant.join('\n')).toHaveLength(0)

    const { mean, variance } = await canvasPixelStats(page)
    expect(variance).toBeGreaterThan(300)  // not a solid color
    expect(mean).toBeGreaterThan(5)        // not all black
    expect(mean).toBeLessThan(250)         // not all white / NaN blowout
  })
}
