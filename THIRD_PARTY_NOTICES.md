# Third-party code

Unstill Life is built on the code below. The full licence texts are in
[LICENSES/](LICENSES/). Each notice here was taken from the upstream project's own
files, not rewritten. `npm run build` copies this file, `COPYRIGHT.md` and
`LICENSES/` into `dist/`, so the notices are served next to the built page.

## Simplex noise: webgl-noise (MIT)

`src/shared/shaders/noise.glsl` is adapted from the webgl-noise simplex noise
(Ian McEwan, Ashima Arts; maintained by Stefan Gustavson). Upstream:
<https://github.com/ashima/webgl-noise>, <https://github.com/stegu/webgl-noise>.
The upstream header and the MIT licence travel in the shader's own comment and in
[LICENSES/webgl-noise-MIT.txt](LICENSES/webgl-noise-MIT.txt). The terrain, water
and cloud shaders take their base noise from this file. The test tool
`tests/tools/snoise_wavelength.mjs` ports the same noise to JavaScript and
carries the same notice; it is not part of the build.

## Hash without Sine (MIT)

`canHash4` in `src/terrain/shaders/includes/forest.glsl` is David Hoskins'
`hash42` from "Hash without Sine" (<https://www.shadertoy.com/view/4djSRW>),
copyright (c) 2014 David Hoskins, MIT licence:
[LICENSES/hash-without-sine-MIT.txt](LICENSES/hash-without-sine-MIT.txt). The
notice is repeated in the shader's comment above the function. The forest uses it
to place, size and thin out its trees.

## Erosion filter and Phacelle noise (MPL-2.0)

`src/terrain/shaders/includes/erosion.glsl` is a port of Rune Skovbo Johansen's
"Advanced Terrain Erosion Filter" and its Phacelle noise (Shadertoy
<https://www.shadertoy.com/view/wXcfWn>; write-up
<https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html>).
Both parts are copyright (c) 2025 Rune Skovbo Johansen and are licensed under the
Mozilla Public License 2.0, whose text is in
[LICENSES/MPL-2.0.txt](LICENSES/MPL-2.0.txt). The MPL applies per file: the ported
`erosion.glsl`, with this project's changes, stays under the MPL-2.0, its licence
headers are kept in the file, and its source is the file itself, which must stay
available to anyone who receives the built piece. The build embeds the file's full
text, headers included, in its JavaScript, and the file is in this repository at
`src/terrain/shaders/includes/erosion.glsl`. The erosion constants in
`src/terrain/shaders/heightmap.frag` are the demo's default values. The rest of
the project is not
affected by it.

## three.js (MIT)

The renderer, the effect composer and the full-screen pass helpers come from
three.js, copyright 2010-2024 three.js authors. The water reflection's oblique
near-plane clipping (`_clipNearPlaneToWater` in `src/water/water.js`) is adapted
from three.js's `Reflector`. Licence:
[LICENSES/three-MIT.txt](LICENSES/three-MIT.txt). Its notice has to be shipped
with any build that bundles it.

## Cormorant Garamond (SIL OFL 1.1)

`src/fonts/CormorantGaramond-SemiBold.woff2`, the start screen's title font, is a
latin subset of Cormorant Garamond SemiBold by Christian Thalmann (Catharsis Fonts),
copyright 2015 the Cormorant Project Authors
(<https://github.com/CatharsisFonts/Cormorant>), licensed under the SIL Open Font
License 1.1. The upstream licence file, with its copyright line, is
[LICENSES/cormorant-garamond-OFL.txt](LICENSES/cormorant-garamond-OFL.txt).

## Credited without a licence notice

These are short published snippets or public-domain code. They need no notice
and are credited in the comment above the code:

- Mulberry32 random numbers (`src/audio/audioMath.js`), Tommy Ettinger, public domain.
- Pink noise filter (`src/audio/audioNoise.js`), Paul Kellet.
- Interleaved gradient noise (`src/clouds/shaders/godrays.frag`), Jorge Jimenez.
- The sine hash under the cloud Worley noise (`cloudVolumeBake.frag`,
  `_worleyHash`), Inigo Quilez's hash33 constants.
- Polynomial smooth maximum (`forest.glsl`, `canSmoothMax`) and smoothed texture
  coordinates (`dataMapSample.glsl`), after Inigo Quilez's articles.

## Development tools

Vite, Vitest and Playwright are used to build and test the piece and are not part
of what a viewer receives.
