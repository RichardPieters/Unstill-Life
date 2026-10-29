import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

/**
 * fullscreen.spec.js — the control bar hides until the pointer reaches the
 * bottom edge, in a window and in fullscreen; the Fullscreen button fills the
 * screen and closes the debug panel; there the cursor hides after a pause.
 */

// The bar fades by a CSS transition; wait for its end state, whatever its length.
const uiOpacityReaches = (page, v) => page.waitForFunction(
  v => getComputedStyle(document.getElementById('ui')).opacity === v, v)
const toBottom = async page => page.mouse.move(200, await page.evaluate(() => window.innerHeight - 10))

test('in a window the bar hides until the pointer nears the bottom edge', async ({ page }) => {
  await boot(page, { pause: true })
  await page.mouse.move(200, 100)
  await uiOpacityReaches(page, '0')
  await toBottom(page)
  await uiOpacityReaches(page, '1')
  await page.mouse.move(200, 100)
  await uiOpacityReaches(page, '0')
})

test('the bar stays shown while the debug panel is open', async ({ page }) => {
  await boot(page, { pause: true })
  await toBottom(page)
  await page.click('#toggle-debug')
  await page.mouse.move(200, 100)
  await uiOpacityReaches(page, '1')
  await page.keyboard.press('d')
  await uiOpacityReaches(page, '0')
})

test('fullscreen hides the bar until the pointer nears the bottom edge', async ({ page }) => {
  await boot(page, { pause: true })
  await toBottom(page)
  await page.click('#toggle-debug')
  await page.click('#fullscreen')
  await page.waitForFunction(() => document.fullscreenElement !== null)

  const state = () => page.evaluate(() => ({
    fullscreen: document.body.classList.contains('fullscreen'),
    debugOpen: document.getElementById('debug').classList.contains('visible'),
    uiOpacity: getComputedStyle(document.getElementById('ui')).opacity,
    label: document.getElementById('fullscreen').textContent,
  }))

  await page.mouse.move(200, 100)
  await uiOpacityReaches(page, '0')
  let s = await state()
  expect(s.fullscreen).toBe(true)
  expect(s.debugOpen).toBe(false)
  expect(s.label).toBe('Exit fullscreen')

  const h = await page.evaluate(() => window.innerHeight)
  await page.mouse.move(200, h - 10)
  await uiOpacityReaches(page, '1')

  const cursorAt = () => page.evaluate(() => getComputedStyle(document.elementFromPoint(200, 100)).cursor)
  expect(await cursorAt()).not.toBe('none')
  await page.waitForTimeout(2200)   // past the idle delay
  expect(await cursorAt()).toBe('none')

  await toBottom(page)
  await page.click('#fullscreen')
  await page.waitForFunction(() => document.fullscreenElement === null)
  s = await state()
  expect(s.fullscreen).toBe(false)
  expect(s.label).toBe('Fullscreen')
})
