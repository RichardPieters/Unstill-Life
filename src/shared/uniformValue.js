/**
 * uniformValue.js — write one value into a live uniform, by the kind of value
 * the uniform already holds.
 *
 *   number, boolean  assigned; a number or a boolean is accepted (GLSL bool
 *                    uniforms take either, as do the 0/1 float toggles)
 *   THREE.Color      mutated in place from '#rrggbb' or a 0xRRGGBB integer
 *                    (colour-managed: three.js converts sRGB to linear)
 *   THREE.Vector3    mutated in place from '#rrggbb' as three bytes / 255,
 *                    with NO colour management: the 'rawRgb' encode, for a
 *                    pass that works in the frame's own values (the art pass)
 *   THREE.Vector2    mutated in place from anything with numeric x and y
 *   array            element-wise, up to the shorter length; number, boolean
 *                    and Color elements, by the same rules
 *
 * Anything else is REJECTED and leaves the uniform untouched: a number aimed
 * at a Color, a colour string aimed at a number, any value aimed at a texture
 * slot, a Vector4, a matrix or a typed array, anything but '#rrggbb' aimed at
 * a Vector3. A Color, Vector or array is never replaced, only mutated,
 * because uniform objects are shared by reference between materials and a
 * replaced value would reach one of them only.
 *
 * Users: uniformSerialize.js (snapshot restore) and paramAccess.js (every
 * owner's key → uniform accessor).
 */

const isScalar = v => typeof v === 'number' || typeof v === 'boolean'
const isHexString = s => typeof s === 'string' && s[0] === '#'
const isHexInt = n => Number.isInteger(n) && n >= 0 && n <= 0xffffff
const isRawHex = s => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s)
const byte = (s, at) => parseInt(s.slice(at, at + 2), 16)

/** A Vector3 written from '#rrggbb' (the 'rawRgb' encode), back as '#rrggbb'. */
export function rawRgbHex(v) {
  const hex = c => Math.round(c * 255).toString(16).padStart(2, '0')
  return '#' + hex(v.x) + hex(v.y) + hex(v.z)
}

// Mutate `color` from a colour string or int; false if `s` is neither.
function writeColor(color, s) {
  if (isHexString(s)) { color.set(s); return true }
  if (isHexInt(s))    { color.setHex(s); return true }
  return false
}

/**
 * Write `s` into `uniform` ({ value }) by the kind of its current value.
 * @returns {boolean} true if anything was written, false if `s` was rejected
 */
export function writeUniformValue(uniform, s) {
  const v = uniform.value
  if (isScalar(v)) {
    if (!isScalar(s)) return false
    uniform.value = s
    return true
  }
  if (v && v.isColor) return writeColor(v, s)
  if (v && v.isVector3) {
    if (!isRawHex(s)) return false
    v.set(byte(s, 1) / 255, byte(s, 3) / 255, byte(s, 5) / 255)
    return true
  }
  if (v && v.isVector2) {
    if (!s || typeof s.x !== 'number' || typeof s.y !== 'number') return false
    v.set(s.x, s.y)
    return true
  }
  if (Array.isArray(v)) {
    if (!Array.isArray(s)) return false
    let wrote = false
    for (let i = 0; i < s.length && i < v.length; i++) {
      if (isScalar(v[i]) && isScalar(s[i])) { v[i] = s[i]; wrote = true }
      else if (v[i] && v[i].isColor) wrote = writeColor(v[i], s[i]) || wrote
    }
    return wrote
  }
  return false
}
