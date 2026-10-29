/**
 * tooltips.spec.js — guards debugPanel.js's tooltip completeness (tooltips.js).
 * Two-sided, mirroring the sceneSnapshot "unknown key" pattern:
 *  - every interactive control in #debug must end up with a non-empty title
 *    (a new slider/toggle/radio/color added without a TOOLTIPS entry fails
 *    this, not just a missed prose reminder in agent_rules.md);
 *  - every TOOLTIPS selector must match something live (a renamed/removed id
 *    would otherwise silently lose its tooltip forever).
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('every interactive #debug control has a non-empty tooltip', async ({ page }) => {
  await boot(page, { pause: true })
  const missing = await page.evaluate(() => {
    const els = document.querySelectorAll(
      '#debug input[type=range], #debug input[type=checkbox], #debug input[type=radio], #debug input[type=color]'
    )
    const bad = []
    for (const el of els) {
      if (!el.title || !el.title.trim()) {
        bad.push(el.id || el.outerHTML.slice(0, 80))
      }
    }
    return bad
  })
  expect(missing, `controls missing a tooltip: ${JSON.stringify(missing)}`).toEqual([])
})

test('no tooltips.js selector is orphaned (matches nothing live)', async ({ page }) => {
  const warnings = []
  page.on('console', m => { if (m.type() === 'warning' && m.text().includes('[tooltips]')) warnings.push(m.text()) })
  await boot(page, { pause: true })
  expect(warnings).toEqual([])
})
