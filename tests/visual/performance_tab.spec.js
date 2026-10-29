/**
 * performance_tab.spec.js — the Performance tab's "Measure costs" run.
 *
 * The measurement logic itself (scheduling, paired medians, recovering known
 * costs) is unit-tested in tests/unit/perfMath.test.js. What only a real page
 * can show is the wiring: that a run reaches the end, reports a finite cost for
 * every part it was given, and leaves every part switched back on — a part left
 * off would silently strip clouds or forest from the scene.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('measure costs reports every part and restores the scene', async ({ page }) => {
  test.setTimeout(180_000)
  await boot(page, { pause: false })
  const before = await page.evaluate(() => {
    document.getElementById('debug').classList.add('visible')
    const d = window.__d
    return { clouds: d.clouds.params.get('enabled'), forest: d.terrain.params.get('forest') }
  })
  await page.evaluate(() => document.getElementById('perf-measure').click())
  await expect(page.locator('#perf-measure-status')).toContainText('Measuring')
  await page.waitForFunction(() => document.getElementById('perf-measure').textContent === 'Measure costs',
    null, { timeout: 150_000, polling: 500 })

  const rows = await page.evaluate(() => [...document.querySelectorAll('#perf-costs .dbg-row')].map(r => ({
    name: r.querySelector('.dbg-label').textContent,
    ms: parseFloat(r.querySelector('.dbg-val').textContent),
  })))
  const names = rows.map(r => r.name)
  for (const part of ['terrain data map', 'water depth pass', 'water reflection']) expect(names).toContain(part)
  if (before.clouds) expect(names).toContain('clouds')
  if (before.forest) expect(names).toContain('forest')
  for (const r of rows) expect(Number.isFinite(r.ms), `${r.name} cost is not a number`).toBe(true)

  const after = await page.evaluate(() => ({
    clouds: window.__d.clouds.params.get('enabled'), forest: window.__d.terrain.params.get('forest'),
  }))
  expect(after.clouds).toBe(before.clouds)
  expect(after.forest).toBe(before.forest)
})
