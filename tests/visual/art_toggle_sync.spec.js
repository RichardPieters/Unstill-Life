/**
 * art_toggle_sync.spec.js — the "paint the frame" checkbox mirrors the art
 * pass's real state, including changes the system makes on its own (a freeze
 * paints, an exit ends the painting), not only the user's own clicks.
 */
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('the art pass checkbox follows the pass when the system turns it on and off', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(async () => {
    const { artPass } = window.__d
    document.getElementById('debug').classList.add('visible')
    const box = document.getElementById('tog-artpass')
    const frame = () => new Promise(res => requestAnimationFrame(res))
    const frames = async n => { for (let i = 0; i < n; i++) await frame() }
    window.__d.pause()                 // un-pause so frames render
    await frames(2)
    const off = box.checked            // liveBaseline switched the pass off directly
    artPass.playReveal()               // as a freeze would
    await frames(2)
    const on = box.checked
    artPass.enabled = false            // as the end of an exit would
    await frames(2)
    const offAgain = box.checked
    window.__d.pause()
    return { off, on, offAgain }
  })
  expect(r).toEqual({ off: false, on: true, offAgain: false })
})

test('the frozen readout shows held / no for a painting switched on by hand', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(async () => {
    document.getElementById('debug').classList.add('visible')
    const box = document.getElementById('tog-artpass')
    const readout = document.getElementById('val-frozen')
    const frame = () => new Promise(res => requestAnimationFrame(res))
    const frames = async n => { for (let i = 0; i < n; i++) await frame() }
    const setArt = on => { box.checked = on; box.dispatchEvent(new Event('change', { bubbles: true })) }
    window.__d.pause()
    await frames(2)
    const running = readout.textContent
    setArt(true)
    await frames(3)
    const held = readout.textContent
    setArt(false)
    await frames(3)
    const released = readout.textContent
    window.__d.pause()
    return { running, held, released }
  })
  expect(r).toEqual({ running: 'no', held: 'held', released: 'no' })
})
