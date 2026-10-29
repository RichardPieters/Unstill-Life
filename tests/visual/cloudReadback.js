/**
 * Readbacks of the cloud target for the browser specs, installed in the page
 * as `window.__cloudRead` by helpers.js's boot(). They read the pixels of
 * `clouds._cloudRT` (the cached march image) synchronously, a GPU pipeline
 * stall that no production code should pay.
 *
 *   stats(band)            mean alpha and alpha-weighted mean colour
 *   samples(stride, band)  alpha on a coarse lattice
 *   alpha(band)            mean alpha only
 *
 * `band` is the fraction of the target height to read, from the top.
 *
 * Both stats channels, because alpha alone answers only one question: alpha is
 * `1 - transmittance`, which depends on density, so a wholly wrong light
 * volume moves the colour and leaves alpha untouched. Colour is weighted by
 * alpha so that empty sky, which still carries a colour from cloudShade's
 * thin-cloud brightness floor, does not drown out the texels that contain cloud.
 *
 * A mean cannot compare two renders pixel by pixel: a change that moves many
 * individual pixels (the detail octaves recarving edges) barely shifts the
 * average over a mostly empty sky. `samples` is for that comparison.
 *
 * Runs inside the page, so it must stay self-contained.
 */
export function installCloudReadback() {
  const read = band => {
    const { clouds, renderer } = window.__d
    const rt = clouds._cloudRT
    if (!rt) return null
    const w = rt.width
    const h = Math.max(1, Math.floor(rt.height * band))
    const buf = new Uint8Array(4 * w * h)
    // The top of the target is the END of the buffer in GL's bottom-up convention.
    renderer.readRenderTargetPixels(rt, 0, rt.height - h, w, h, buf)
    return { w, h, buf }
  }

  const stats = (band = 0.45) => {
    const px = read(band)
    if (!px) return null
    let a = 0, r = 0, g = 0, b = 0
    for (let i = 0; i < px.buf.length; i += 4) {
      const av = px.buf[i + 3] / 255
      a += av
      r += px.buf[i] * av; g += px.buf[i + 1] * av; b += px.buf[i + 2] * av
    }
    const n = px.buf.length / 4
    const wsum = a || 1
    return { alpha: a / n, r: r / wsum, g: g / wsum, b: b / wsum }
  }

  const samples = (stride = 8, band = 0.45) => {
    const px = read(band)
    if (!px) return null
    const out = []
    for (let y = 0; y < px.h; y += stride) {
      for (let x = 0; x < px.w; x += stride) out.push(px.buf[(y * px.w + x) * 4 + 3])
    }
    return out
  }

  window.__cloudRead = { stats, samples, alpha: band => { const s = stats(band); return s && s.alpha } }
}
