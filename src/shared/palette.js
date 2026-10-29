/**
 * palette.js — the scene's colours, as pure data (hex ints and scalars), each
 * defined once. The param rows that hold a colour take their default from here,
 * so the scene starts in these colours with nothing written over it.
 *
 * Only the SUNLIT colour of each material is authored. The terrain shader
 * derives every shadow colour by one global transform (desaturate, darken, push
 * toward light.shadowHue) and warms highlights toward light.glowHue, so no
 * material hue is multiplied by a light hue (no mud). The transform is in
 * src/terrain/shaders/includes/material.glsl.
 *
 *   sky.horizon   horizon, fog and background colour; also the aerial target,
 *                 the water's sky reflection and the cloud tint
 *   sky.zenith    the clear-weather colour overhead (the weather blends away)
 *   terrain.*     sunlit material colours, value-laddered dark to light
 *   crown.*       the tree species' crown colours; forest and riparian ground
 *                 take the same values
 *   glow.*        per-material alpenglow susceptibility [0,1]
 *   shade.*       per-material shadow floor [0,1]: 1 drops fully to the derived
 *                 shadow colour, 0 ignores shade (snow stays luminous, forest is
 *                 the dark mass)
 *   water.*       deep, shallow, sun glint
 *   light.*       shadowHue (blue-violet), glowHue (warm pink-gold), shaft (the
 *                 godrays' pale warm cream)
 */

const CONIFER = 0x4f7d40
const BROADLEAF = 0x76a63e

export const PALETTE = {
  sky:     { zenith: 0x4e7cb7, horizon: 0xc7e0ff },
  terrain: {
    forest:   CONIFER,
    meadow:   0x9ec95e,  // pasture green
    snow:     0xfbfcff,
    rock:     0x9c8f7e,  // warm grey cliff and scree
    sand:     0xe9dca6,  // shore
    riparian: BROADLEAF, // lush streamside
  },
  crown:   { conifer: CONIFER, broadleaf: BROADLEAF },
  glow:    { forest: 0.0, meadow: 0.05, snow: 1.0, rock: 0.55, sand: 0.1, riparian: 0.0 },
  shade:   { forest: 1.0, meadow: 0.8, snow: 0.4, rock: 0.9, sand: 0.55, riparian: 0.9 },
  water:   { deep: 0x1e5a88, shallow: 0x6ec8cf, spec: 0xeaf6ff },
  light:   { shadowHue: 0x3b4a7a, glowHue: 0xffd9a8, shaft: 0xfff0dd },
}

/** A palette colour as the '#rrggbb' string the colour rows hold. */
export const hexString = n => '#' + n.toString(16).padStart(6, '0')
