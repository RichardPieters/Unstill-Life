import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

/**
 * mic_attention.spec.js — in mic mode the microphone sets attention, so the
 * control bar's manual Attention slider is hidden; leaving mic mode shows it.
 * Chromium's fake capture device stands in for a real microphone.
 */
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--enable-webgl', '--use-gl=angle', '--no-sandbox',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

test('mic mode hides the attention slider, manual mode shows it', async ({ page }) => {
  await boot(page, { pause: true })
  const setMic = on => page.evaluate(on => {
    const box = document.getElementById('int-src-mic')
    if (box.checked !== on) box.click()
  }, on)

  // The start click turns the mic on (main.js), so the page opens in mic mode.
  await page.waitForFunction(() => document.getElementById('int-src-mic').checked)
  await expect(page.locator('#attention')).toBeHidden()
  await setMic(false)
  await expect(page.locator('#attention')).toBeVisible()
  await setMic(true)
  await expect(page.locator('#attention')).toBeHidden()
})
