import { test, expect } from '@playwright/test'

// Advisory in CI — logs result, warns but does not hard-fail above budget.

test('frame time — 60-frame average at 1280×720', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.waitForTimeout(1500) // warm up: shader compile + first frames

  const avgFrameMs = await page.evaluate(() => {
    return new Promise(resolve => {
      const times = []
      let last = performance.now()
      let count = 0
      function frame() {
        const now = performance.now()
        times.push(now - last)
        last = now
        if (++count < 60) {
          requestAnimationFrame(frame)
        } else {
          resolve(times.reduce((a, b) => a + b, 0) / times.length)
        }
      }
      requestAnimationFrame(frame)
    })
  })

  console.log(`Average frame time: ${avgFrameMs.toFixed(2)}ms  (budget: 16.67ms)`)

  // Advisory warning — not a hard assertion yet
  if (avgFrameMs > 16.67) {
    console.warn(`Frame time ${avgFrameMs.toFixed(2)}ms exceeds 60fps budget — investigate`)
  }

  // Hard floor: something is very wrong if average is over 100ms
  expect(avgFrameMs).toBeLessThan(100)
})
