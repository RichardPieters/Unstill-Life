# Unstill Life – A Shifting Landscape

Unstill Life is a procedural landscape painting that reacts to the sound of the
room. It runs in the browser with three.js and WebGL 2 and does not require a
server. Terrain, water, clouds, forest and sound are all generated at runtime.

![One cycle of Unstill Life, from painting to landscape and back](docs/unstill-life.mp4)

**[Live version](https://unstill-life.richardpieters.de)** · [Full technical overview](docs/architecture_guide.md) · [Seminar paper (German)](docs/seminar_paper.pdf)

## About

At first glance, Unstill Life appears to be a quiet landscape painting. However,
as soon as there is sound in the room, the painting dissolves and a procedural
landscape wakes up beneath it. The land drifts between mountain ranges and
islands while clouds gather and disperse. When the room falls silent, the world
slows down, freezes and settles stroke by stroke back into a divisionist
painting. Since anyone who wants to see the painting has to stay silent, that
silence also ends the living landscape. In the tradition of the vanitas still
life, the piece therefore asks whether stillness preserves the landscape or
ends it.

## Features

### Listening

The piece analyses the microphone spectrum every 46 ms. For each window, it
computes the loudness and the spectral flux, which measures how much the
100–4000 Hz band rose since the previous window. The larger of the two decides
how restless the room is. Voices and footsteps raise the flux, whereas steady
noise only counts through its loudness. Additionally, the piece predicts how
much of its own output reaches the microphone, and only sound above that
prediction counts. From the restlessness, the piece derives an attention value
between 0 and 1, which is high when the room is quiet. Low attention speeds the
landscape up, and sustained high attention starts a countdown to the freeze.

### Terrain

The height map is computed on the GPU from two fractional Brownian motion (fBM)
fields that share their octaves. One field describes the bedrock and the other
the soil, and the surface follows the higher of the two. Rune Skovbo Johansen's
[erosion filter](https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html)
then carves gullies analytically instead of simulating water
flow. Since WebGL 2 has no tessellation stage, the mesh is built on the CPU and
displaced by the height map. Its vertex spacing grows with the distance from
the camera.

### Biomes and forest

The biomes snow, scree, cliff, meadow, forest, riparian and sand are placed
according to height, slope, sun-facing aspect and hollowness. Noise only
makes the borders between them irregular. Trees are crowns that are drawn per pixel on
a lattice. Because each lattice site decides only once whether it holds a tree,
no tree is cut in half by a biome border.

### Clouds and weather

Cloud density is baked into a wraparound 3D texture. As the wind moves the
sampled region, only the newly exposed strips are rebaked. While the scene
moves, a ray march renders the clouds and adds finer noise octaves along the
way. A 32-layer light volume handles self-shadowing and additionally casts
cloud shadows and light shafts onto the landscape. The weather is described by
two values. Overcast controls the light, the sky colour and the cloud cover,
whereas haze controls the fog. Both values drift only while the landscape
moves.

### Water

The water is a reflective plane that is rendered from a mirrored camera, with a
depth pre-pass for the shoreline. As the countdown runs down, the sea level
rises.

### The painting

When the world freezes, brush strokes grow over the frozen frame on a lattice.
Each stroke uses one of eleven pigments. In each area, up to four pigments are
mixed so that their average in linear light matches the scene colour there.
Sound in the room dissolves the strokes again.

### Sound

Wind, trees, surf and birds are synthesised live from filtered noise and
oscillators, so no samples are used. These layers follow the landform, the
amount of forest, the weather and the pace of the scene. A fifth layer plays as
the paint arrives and comes apart.

The [full technical overview](docs/architecture_guide.md) describes each part in
detail, and [docs/architecture.md](docs/architecture.md) contains the module
map.

## Getting started

The piece runs in current desktop versions of Chrome, Safari and Firefox. A
microphone is optional.

```sh
npm install
npm run dev        # development server with shader hot-reload
npm run build      # production build into dist/
npm run preview    # serve the production build
```

### Controls

The piece starts with a click. To show the control bar, the pointer has to be
moved to the bottom edge of the window. Without a microphone, or with the
"use microphone" switch turned off in the debug panel, the Attention slider in
the control bar sets the attention by hand. Pressing `D` opens the debug panel,
which contains the artistic parameters.

The microphone signal is analysed in the browser and is never recorded or sent
anywhere.

## How it was made

Unstill Life was made for the HPI seminar *3D-Rendering & Computational Art* in
the summer semester 2026, supervised by Prof. Dr. Jürgen Döllner. The seminar
asked for development with generative AI. I designed the concept and the
algorithms of the piece, and the code was generated from them with Claude Code
between May and October 2026. Excluding comments and blank lines, it comprises
about 12,400 lines of JavaScript and GLSL.

My designs include the height generation, in which two independently moving
noise fields form a bedrock and a soil layer, the higher of which is the
surface, and in which the bedrock noise grows stronger with height and is
combined with ridged noise. They also include the forest as a lattice of trees
that only change the surface normal for shading, the attention and restlessness
model with its countdown to the freeze, the brush strokes with their pigment
mixing, the moving cloud window and the prediction of the piece's own sound in
the microphone. The biome rules were developed under my guidance.

I specified the algorithms step by step in conversation with the agent and
checked the results visually, with debug views, by having the agent explain the
system and by reading the code. For example, the clouds changed abruptly when
the frequency of the cloud noise rose above a certain value. I traced this to the number of
noise octaves that the 3D texture can store, which drops by one at that point,
and proposed a crossfade between the stored and the ray-marched octave. Values
that have no analytically correct answer became sliders, which I tuned by eye
and ear. The rules that the agents followed are documented in
[docs/process/agent_rules.md](docs/process/agent_rules.md). For example, every
technical claim is passed to a second agent whose task is to refute it, and
every change with a testable surface is committed together with its test.

## Testing

```sh
npm test               # unit tests, a few seconds
npm run test:visual    # signal and browser tests, a few minutes
npm run test:perf      # frame-time budget, advisory, run alone
```

Because the code was generated, the tests are the main check on it. They fall
into four groups.

Unit tests use Vitest and run without a GPU. They cover the plain JavaScript
logic, such as the maths helpers, the state machines and the parameter system.

Signal tests replace the height map with a known surface, such as a tilted
plane, and render one shader value, for example the normal or the biome, into a
float texture. This value is then compared with the value derived from the
surface's own geometry and never with a copy of the shader formula.

Browser tests use Playwright to run the real piece headless. They check that it
renders without WebGL errors, that the painting appears and dissolves, and that
a snapshot restores the scene.

Completeness tests fail the build when something has been forgotten, such as an
unclassified uniform, a control without a tooltip or a uniform that is declared
twice.

All tests check properties that survive retuning, such as exact analytic
values, orderings and invariants. Therefore, they avoid pixel snapshots and
tuned thresholds, and they wait for frames or states rather than for elapsed
time. Further details are given in [tests/README.md](tests/README.md).

## Licence

© 2026 Richard Pieters, licensed under [CC BY-NC-SA 4.0](LICENSE). Third-party
code keeps its own licence, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
