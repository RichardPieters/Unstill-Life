# Unstill Life — full technical overview

The complete technical description of the piece, module by module. It explains the whole
system top-down: what the piece does, how the code is organised, how one frame
flows through it, the mechanisms underneath (events, the parameter system,
snapshots, the render pipeline, the cost of a frame), and then one section per
module, followed by testing and the key design decisions.

How it relates to the other docs: `docs/architecture.md` is the exhaustive
structural reference (every module row, every uniform class). This overview
explains how the parts work and why they are built that way. Where the two
disagree, the code is authoritative, then `architecture.md`.

---

## 1. What the piece is

*Unstill Life* is a browser-based generative landscape painting for projection
(WebGL 2 through three.js, no server, no image or sound assets). The theme is **Vanitas**,
transience: nothing is ever finished.

The piece **watches its audience**. It opens as a still painting. A microphone
measures how restless the room is. Unrest wakes the painting into a living,
moving landscape (terrain that slowly reshapes, water, clouds, weather, a
generated soundscape). Sustained stillness lets the landscape settle, and at the
moment it freezes, a divisionist post-process grows small brush strokes over
the frozen frame until it is a painting again. Unrest dissolves the strokes
again.

Key properties:
- Everything is procedural: terrain, water, clouds, forest, sound. Noise shaped by rules.
- Nothing is placed by hand-drawn assets; variety comes from terrain logic, not from random scatter.
- The attention signal is *stillness and quietness*, not a head count, and the
  piece's own speaker output is subtracted from what the microphone hears.

---

## 2. The big picture

### 2.1 Five layers

```text
 INPUT   interaction/  the microphone becomes attention, 0 to 1
             │
             │ attention
             ▼
 STATE   dynamics/     attention becomes momentum and restlessness
             │
             ├── 'tick', every frame ───────────────► SCENE     terrain/ water/
             │                                                  clouds/ drift/
             │
             └── 'freeze' / 'unfreeze' ─► main.js ─► PAINTING  artpass/
                                            │
                                            └──────► SOUND     audio/
                                    scene state, every frame
```

- **Input** turns the room into one number, *attention*, in [0, 1].
- **State** (`dynamics`) turns attention into *momentum* (how fast the world
  changes) and *restlessness* (a countdown to the painting).
- **Scene** modules animate from the state: terrain and water drivers, form
  drift (form dials and weather), clouds.
- **Painting** (`artPass`) is a post-process that paints over a *held* frame.
- **Sound** reads a summary of what is on screen and mixes wind, trees, surf and birds.

### 2.2 Module map (folders under `src/`)

| Folder | Responsibility |
|---|---|
| `main.js` | **Composition root.** Builds every module, wires them, owns the clock and the render loop. The only place that imports more than one subsystem. |
| `shared/` | The utilities every subsystem may import: the parameter system (`paramSchema`, `paramAccess`, `uniformValue`, `uniformSerialize`), the scene-wide uniform set (`sceneUniforms`), shader include splicing, math helpers. |
| `dynamics/` | The state machine (`dynamics`) and the water/cloud pace (`animSpeed`). |
| `drift/` | **Section 4.3.** The unattended drift of the macro look: the five dials (ocean, mountains, snowline, cloud scatter, cloud density), the weather (overcast, haze) and the one walk class that moves both. |
| `terrain/`, `water/`, `clouds/` | The landscape, each with its own driver, math and shaders. `clouds/` also holds the godrays (light shafts). |
| `artpass/` | The brush-stroke post-process and its reveal/exit animation. |
| `audio/` | The generated soundscape (Web Audio). |
| `interaction/` | Microphone attention. |
| `render/` | **Section 4.2.** Sky gradient, post-processing chain, pixel-ratio cap. |
| `scene/` | **Section 4.4.** Wiring layer. The form and weather write paths, snapshot capture and restore, the per-frame decisions. |
| `panel/` | **Wiring layer.** The debug panel, generated from parameter rows. |

### 2.3 The architecture rules

1. **Subsystems never import each other.** Terrain, water, clouds, art pass,
   audio, interaction, drift import only their own helper files and `shared/`.
2. **`main.js`, `scene/` and `panel/` are the wiring.** Only these may reach
   across subsystems; `main.js` builds everything and hands each module the
   references it needs.
3. **Pure maths is separate from side effects.** `*Math.js` files have no
   three.js, DOM or wall-clock, so they are unit-tested without a GPU.
4. **Each subsystem keeps its own shaders.** Only `noise.glsl` is shared; shared
   GLSL is spliced in at compile time (`injectIncludes`).
5. **A value has one home.** A tunable value is one *row*; its default, range,
   label, uniform and panel control all derive from it (section 3.4).

Why this shape: modules can be reviewed, tested and replaced one at a time, and
`main.js` is the single place where the order of work (which matters in a render
loop) is visible.

---

## 3. Mechanisms

### 3.1 Events and the per-frame flow

`dynamics` is an `EventTarget`. It is the only shared event source:

- `tick { dt, momentum, restlessness, noiseTime }` every frame it is not frozen.
  Listeners: the terrain and water drivers, the form walker and the weather
  (both in `drift/`), and the panel readouts (in `panel/tabs/`).
- `freeze` once, when restlessness reaches 0. `main.js` turns it into
  `artPass.playReveal()`.
- `unfreeze` once, when attention drops past the threshold, but never during
  the reveal (the point of no return, section 5). `main.js` turns it into
  `artPass.playExit()`.

Not everything is event-driven. Where **order** matters, `main.js` pushes values
explicitly each frame (the sea level into terrain, the animation pace into water
and clouds, the scene summary into audio). The audio is deliberately *not* a
tick listener, because ticks stop while frozen and the soundscape must keep
running through the painting.

### 3.2 One frame, in order (`main.js`, `frame(dt)`)

1. Update the fly camera.
2. If paused (the debug pause), with nothing touched and no animation running:
   **return**. The canvas keeps its last pixels.
3. Reconcile the painting with dynamics (a painting on screen always means
   frozen), then `dynamics.update(dt, attention)`, except while the art pass
   holds the scene or its reveal is playing (attention is not read then).
4. Decide *world holding still* (`computeSceneStatic`): dynamics frozen or the
   debug pause on, the camera unmoved, and nothing touched.
5. Update `animSpeed` (water and cloud pace) from restlessness, the art pass
   and the visible overcast.
6. Unless the world holds still: render the **data-map passes** (terrain
   height, derive, forest sites), the **depth pre-pass**, the **water
   reflection pre-pass**.
7. Push the sea level to the terrain and the terrain's height range to the water;
   push the scene summary to audio (every frame, holding or not). Render the art
   pass **G-buffer** while a painting is up and the world has moved; over a held
   painting it is drawn once, then reused.
8. Update the cloud volume's wind, window and camera, and write the shared
   cloud-shadow frame (cheap, every frame).
9. Bake, light and march the clouds, then render godrays. While holding, the
   clouds finish any owed bake work at once, march once, then keep their target.
10. The composer draws the main frame: scene → godrays → clouds → art pass.
11. If the painting just went away, wake `dynamics` (`wakeAfterExit`).

Why skip work while holding: nothing the GPU passes in steps 6–9 read has
changed, so re-running them would reproduce what their render targets already
hold (section 3.6). The pushes and the cloud update still run.

### 3.3 The render pipeline, step by step

1. terrain data map (512² float: height, ridge, erosion) ─► terrain mesh
   material, together with its
   - derive pass (gradient, local means)
   - forest site pass (one texel per tree site)
2. water depth pre-pass ─► depth texture ─► water, clouds, godrays
3. water reflection pre-pass (mirrored camera) ─► water material
4. cloud volume: bake (3-D noise) + light (32 layers) ─► terrain/water shadow, godrays
5. art G-buffer (flat scene data + depth) ─► art pass
6. composer: RenderPass ─► godrays ─► clouds ─► ArtPass ─► screen

Key points:
- **Terrain is a height-map, not geometry noise.** The GPU first computes a
  height map (fBM noise + an erosion filter); the mesh is one camera-dense grid
  (fine near, coarse far) that reads its height from that map. WebGL 2 has no
  tessellation stage, hence the adaptive grid.
- **Colour comes from terrain logic.** Height, slope and moisture decide the
  biome (forest, meadow, rock, snow, riparian, shore); trees are placed by a
  lattice of sites with a per-site verdict from the terrain, not by random noise.
- **Water** is a reflective plane with a depth pre-pass (for shoreline foam) and
  a mirrored-camera reflection.
- **Clouds** are a rolling 3-D baked density volume, ray-marched, with a baked
  light volume that also casts shadows on terrain and water.
- **The art pass** works on a *frozen* frame: it samples the colour at each
  stroke's anchor point and paints soft-edged brush strokes whose pigments are
  mixed (optical mixing), grown outward from one seed over the reveal.

### 3.4 The parameter system

**Rationale.** The piece has hundreds of tunable values, and each needs a
default, a range, a shader uniform, a panel control, a snapshot entry and a
tooltip. Each value is declared **once, as a row**, and everything else is
derived from it.

**Architecture.**

```text
            row (rippleAmp)
                  │
   ┌──────────────┼──────────────┐
   ▼              ▼              ▼
 uniform       accessor        panel
 seeded      water.params     control
 from the    get / set /     generated
 default     onChange        from row
                  │
                  ▼
              snapshot
```

- **Row** (`shared/paramSchema.js`): id, owner, key, default, range, which
  uniform it writes. It lives with its owner (`water/waterParams.js`).
- **Accessor** (`shared/paramAccess.js`): every owner has an `owner.params`.
  All writers (panel, weather, form walker, snapshot restore) go through its
  `set`, so there is one write path.
- **Derived uniforms**: a uniform computed from other rows (cloud-shadow
  strength = master slider × density dial) is recomputed by the accessor
  whenever an input changes, and never set directly.
- **Uniforms without a row** are classed by who writes them: *frame* (every
  frame), *constant* (once), *integrated* (accumulates over time, such as the
  water clock and drift offsets), *shared*, *derived*.
- **Shared scene uniforms** (`shared/sceneUniforms.js`): fog, light and cloud
  shadow are one set of objects mounted into terrain, water, godrays and the
  art pass, so the shoreline shows no seam.
- **Generated panel**: the panel's controls are generated from rows and bound
  by one binder.

**Owners.** An owner is the module that holds a piece of state and answers
for it: terrain, water, clouds, godrays, the art pass, audio, dynamics, the form
dials. Each owner declares its rows, builds its uniforms from them, and builds
one accessor, `owner.params`, which is its only public door for values. Its
`exportState`/`importState` capture and restore the rows plus whatever else it
holds. Everyone else (the panel, the weather, the form walker, the snapshot
restore) reads and writes through `owner.params.get / set / onChange`, and
nobody writes an owner's uniforms directly. The owner is the one place that
knows what a value means, and `set` is the one path that keeps its side
effects consistent.

**Runtime behaviour.**

- *Moving a slider:* the panel calls `set`, which encodes and clamps the value,
  skips it if unchanged, writes the uniform, recomputes the derived uniforms,
  marks stale what must be rebuilt (a terrain data map, a cloud layer) and
  notifies listeners. The next frame rebuilds and renders. A driver follows
  the same path, and the panel follows through `onChange`, with no polling.
- *Snapshots:* an owner captures its rows by key plus its integrated uniforms
  by name. Derived, frame and constant uniforms are not captured, because the
  restore recomputes or rewrites them. Restore goes through `set`, so it
  behaves like any other write. A test fails on any uniform that is in no
  class, so a new uniform cannot silently fall out of a snapshot.

Adding a parameter is one row, its id in `panelLayout.js` and a tooltip.

### 3.5 Drivers: values that move on their own

Some rows are overwritten by code: the **form walker** (a bounded random walk of
the five dials), the **weather** (overcast and haze walk, blended between a
clear and a heavy profile for ~16 values). Each declares
the control ids it owns in the *driven registry*; the panel greys those
controls and `bindParam` drops hand edits while the driver runs. Both walks use
one class, `drift/walk.js`: a latent position moves one step toward a target, a
fresh target is drawn within ±spread on arrival, overshoot is reflected off the
ends.

### 3.6 What a frame costs

*Goal.* The piece runs for hours on whatever machine drives the projector, so
the work per frame depends on what is changing. A frame is in one of three states:

- **The landscape moves.** Every pass in the table runs.
- **The world holds still** (dynamics frozen, camera unmoved, nothing touched):
  the first held frame finishes any owed cloud work at once; after that the
  pre-passes, the art pass's scene data, the cloud bake, light and march and the
  light-shaft march are skipped, and their stored images are reused. The main scene is still
  drawn, and the composer still lays the cached clouds and the painting over it.
- **Paused, nothing touched** (fly camera off, no reveal or exit playing): the
  frame returns before any GPU work.

| Pass | Size | When |
|---|---|---|
| Terrain data map | 512 × 512 texels: noise and erosion | world moves |
| Derive map | 512 × 512 texels, 20 reads each | world moves |
| Forest site table | 704 × 704 texels, one per tree site | world moves, forest on |
| Water depth | full screen, terrain drawn without shading | world moves |
| Water reflection | half width × half height, full shading | world moves |
| Art pass scene data | full screen, flat values only | world moves, art pass on |
| Cloud light | one of 32 layers per frame | while the light is owed |
| Cloud ground shadow | one 2-D texture | world moves |
| Cloud bake | strips, rolls or the whole volume | the window moves or the shape changes |
| Cloud march | full screen, up to 96 steps | world moves |
| Light shafts | 0.65 × 0.65 of the screen, 16 steps | world moves, overcast above 0.9 |
| Main scene | full screen, 800 × 800-segment mesh | every drawn frame |
| Brush strokes | full screen | a full redraw when an input changes; in the entrance only the blocks a new stroke reaches; nothing while held |

The terrain dominates: in a moving frame its full shader runs twice (the main
view and the reflection at a quarter of the pixels), its depth once, and, while
the art pass is on, a cheap flat-value draw for it. The cloud bake and light cost
in proportion to the volume's texels, not the screen; only the march is per
pixel, and it reads two baked texels per step. The strokes cost about 23 ms for a full redraw at
1920 × 1080 and about 1.5 ms in a frame of the entrance. Every per-pixel pass
scales with the square of the pixel ratio, which the render-resolution slider
caps. The Performance tab measures each part on the target machine by
switching it off and seeing how much faster the frames get.

---

## 4. Module overview

| Module | One-sentence role |
|---|---|
| `shared/` | **Section 4.1.** The one folder every subsystem may import: parameter system, scene-wide uniforms, simplex noise. |
| `interaction/` | **Section 4.9.** Mic → attention [0, 1] (stillness and quietness, speaker leak removed). |
| `dynamics/` | **Section 5.** Attention → momentum → restlessness → freeze; the reveal runs to the end, then attention can wake it. |
| `drift/` | **Section 4.3.** Five macro dials and the weather, each walked unattended; ocean/mountains blend four tuned corner configurations bilinearly; overcast and haze blend a clear and a heavy profile. |
| `terrain/` | **Section 4.7.** Height map (fBM + erosion), biome colouring, forest lattice, adaptive mesh, camera-safety pit, a driver for drift and the derived height range. |
| `water/` | **Section 4.5.** Reflective plane, reactive sea level, foam, sparkle; its driver follows momentum. |
| `clouds/` | **Section 4.6.** Rolling baked 3-D clouds, weather map, cloud shadows, godrays. |
| `artpass/` | The painted brush strokes: reveal when the scene freezes, exit when it resumes. |
| `audio/` | **Section 4.10.** Generated wind, trees, surf, birds that follow the scene; a paint layer at the freeze; the world steps back while a painting is up. |
| `scene/`, `panel/` | **Section 4.4** (`scene/`). The form and weather write paths, snapshots, frame decisions; the generated debug panel. |
| `main.js` | **Section 4.11.** The composition root: builds every module, wires the few couplings none of them owns, runs the frame. |

### 4.1 `shared/`

The only folder every subsystem may import, and it imports none of them. Anything
two subsystems need goes here; that is what keeps the layering rule true.

| File | Role |
|---|---|
| `paramSchema.js` | The row shape and its validation; seeds uniforms from rows. |
| `paramAccess.js` | The per-owner accessor: get, set, derived uniforms, change hooks, export and import. |
| `uniformValue.js` | The one typed writer of a value into a live uniform. |
| `uniformSerialize.js` | Snapshot capture and restore of the integrated uniforms. |
| `sceneUniforms.js` | The scene-wide fog, light and cloud-shadow uniform objects, mounted into every consumer. |
| `sceneParams.js` | The rows for those scene-wide values. |
| `sceneConfig.js` | Plane size, camera framing, starting fog range. |
| `palette.js` | Every authored colour, defined once; the colour rows take it as their default. |
| `simState.js` | The `sim` owner: manual attention (fed to `dynamics` when the mic is off), simulation speed, pause. |
| `shaderCompose.js` | Splices the shared GLSL into each shader at compile time, and (for the art pass's programs) mounts the uniforms each one declares; a name found in no pool, or in two, throws. |
| `shaders/noise.glsl` | 3-D simplex noise and its exact gradient. |
| `mathUtils.js` | `clamp` and `clamp01`; NaN becomes the lower bound. |

**Noise.** Terrain heights, water ripples and clouds all use 3-D simplex noise, with
time as the third axis, so a landscape evolves instead of sliding. The terrain
needs the noise's slope for erosion and normals. It takes the exact derivative
(`snoise_grad`), computed from the same intermediate values as the noise itself,
not a finite difference (extra samples one step apart, which cost 4 evaluations
and lean to one side). The water's surface normal uses it too. The noise is
evaluated in the shader, not read from a noise texture: a texture is cheaper per
lookup, but its interpolation kinks would show in normals and erosion, and it
repeats along the time axis.

`sceneUniforms` and `sceneConfig` live here, not in `scene/`, because subsystems
import them and a subsystem may not import the wiring layer.

### 4.2 `render/`

How the finished picture reaches the screen: the sky, the composer chain scene →
godrays → clouds → art pass, and the pixel ratio the canvas is drawn at.

| File | Role |
|---|---|
| `sky.js` | The background: a gradient painted into a small canvas texture. |
| `skyParams.js` | The sky's rows: zenith, horizon, and how much of the canvas the blend spans. |
| `postprocessing.js` | The composer chain, in its fixed order. |
| `pixelRatio.js` | Pure arithmetic: the device ratio, capped and floored. |
| `display.js` | The owner of the render-resolution slider; sets the renderer's ratio. |

**Sky.** No mesh: a 2×256 canvas holds a vertical gradient that three.js draws as
the background. The canvas has far fewer rows than the screen has pixels, so
linear filtering blends adjacent rows and the gradient is smooth. The camera
holds one framing, so a screen-space gradient serves as a sky dome for a frame
that never turns. The weather drives both ends; at full overcast they meet and
the sky flattens.

**Resolution.** Cost is paid per drawn pixel, so it grows with the square of the
pixel ratio. The ratio is the device's, capped by the render-resolution slider.

### 4.3 `drift/`

The scene's slow, unattended change: the five macro dials (ocean, mountains,
snowline, cloud scatter, cloud density) and the weather (overcast, haze). Each is
one number in [0,1] that reshapes a whole region of the picture, and one
class walks them all. The folder only computes; `scene/formDriver.js` applies the
dials and `scene/weatherDriver.js` applies the weather.

| File | Role |
|---|---|
| `walkMath.js` | One walk step toward a target, drawing the next target within a range, reflected at 0 and 1. |
| `walk.js` | `Walk`: per channel the hidden value, its target and an optional readout curve; hand-set, import and export. |
| `formWalker.js`, `formWalkerParams.js` | The five dials' walk, and its rows: on switch, drift range, drift speed. |
| `terrainForm.js` | Ocean and mountains as one map onto 17 terrain and water settings. |
| `cloudDialsMath.js` | Scatter and density as maps onto the cloud, godray and shadow settings. |
| `atmosphere.js`, `atmosphereParams.js` | The weather: walks overcast and haze, holds the clear and heavy profiles, switches on and off. Rows for the walk, the grey-light window and both profiles. |
| `atmosphereMath.js` | The weather's curves: how overcast and haze move light, fog, cloud cover and sky colour between the two profiles. |

**The blend.** Four hand-tuned configurations (rolling or alpine, landmass or
islands) sit at the corners of the (ocean, mountains) square. A point inside is
their bilinear blend: exact at every corner, nothing extrapolated. The ocean dial
makes landforms smaller and drops the hills that join them, which is what turns a
continent into islands.

**The weather.** Every driven setting has a clear value and a heavy value, and
overcast or haze moves it between them along a curve. The clear value is not
fixed: it is copied from the user's own sliders when the weather switches on and
written back when it switches off, so the tuned look is exactly the clear day.
The heavy value is authored on the Sky tab. The land darkens with the light and
the sky does not, so a grey lid reads as glare above dark ground.

**The overcast curves.** One overcast number moves about ten settings, each as
`clear + (heavy - clear) × weight`, but not with one weight:

```text
weight
 1.0 │                                      ccc
     │                                   cccL
     │                              cccccLLL
     │                           ccc    L
     │                      ccccc    LLL    lll
 0.5 │                   ccc        L    lll
     │              ccccc        LLL  lll
     │           ccc            L  lll
     │      ccccc             Lllll
     │   ccc               Llll
 0.0 │ccclllllllllllllllllll
     └─────────────────────────────────────────
      0        0.25       0.5       0.75       1   overcast

 c  cloud amount          L  the light, density dial at 0.5 or more
 l  the light, density dial at 0.26
```

- **Cloud amount** follows the overcast number itself: a straight line.
- **The light** (shadow floor, light level, alpenglow, shadow blue, water glint
  and mirror) waits. It stays clear until *grey light starts* (0.5), then ramps
  straight to heavy at *grey light complete* (1). Cloud amount is far from linear
  in the overcast number (about 1% of the cloud at 0.2, a quarter at 0.5, two
  thirds at 0.75), so a light that dimmed linearly would grey a sky with almost no
  cloud in it. Cause and effect run on the same clock.
- **The density dial** scales how far the light goes: thin cloud dims less. The
  scale is 0.2 at density 0, rising to 1 at density 0.5, so a density of 0.26
  reaches about 0.6 of the way to heavy.
- **Cloud greying** follows the larger of the light and haze, so haze alone also
  greys the clouds, to milky white rather than overcast grey.
- **Haze** moves the four fog settings (reach, start, ceiling, distance greying)
  and the haze colour linearly with the haze number.

**The walk.** Each channel picks a target near where it is, creeps toward it,
then draws the next. The pace is a rate times the terrain's `noiseSpeed`, so the
walk stops when the scene freezes. The snowline walks a hidden value and shows it
through a curve, so it sits high most of the time and rarely low. The form dials
and the weather walk with their own range and speed; the cloud dials use the
weather's slower drift, because every change of cloud shape re-bakes the cloud
volume.

### 4.4 `scene/`

The wiring layer. Subsystems never import each other, so whatever must touch
several of them lives here. Nothing in this folder renders or simulates: it
decides which owner receives which write, and when. Only `main.js` and `panel/`
import it.

| File | Role |
|---|---|
| `formParams.js` | The five dial rows; each row's value is the dial's position in [0,1]. |
| `formDriver.js` | The `form` owner: holds the five positions and writes them onto terrain, water, clouds, godrays and the scene-wide uniforms. |
| `weatherDriver.js` | The weather's write path: resolves each weather-driven setting to its owner and writes one weather state through it. |
| `horizonColour.js` | The horizon colour as one row whose setter sets the sky, three's fog, the scene fog colour and the cloud sky copy. |
| `sceneModules.js` | The list of modules a snapshot saves and restores. |
| `sceneSnapshot.js` | Captures and restores the whole scene as JSON by looping over that list. |
| `frameLogic.js` | Pure per-frame decisions relating the art pass, dynamics, the pause and the camera. |
| `flyCamera.js`, `flyCameraParams.js` | The debug free-look camera (F, WASD, drag); never touches the landscape. |

**Two write paths.** The walkers in `drift/` only compute; these two files apply.
The form driver keeps each position in one place (ocean and mountains set 17
settings, so it cannot be read back). The walker's tick stores all five
positions and writes once. A hand-drag, possible only with the walker off (the
panel drops edits to controls it owns), runs that dial's writes; moving
terrain's snow-base or the cloud absorption slider moves the snowline or density
position to match. The weather driver resolves each driven setting from the
weather's own list (`owner.key`), so it is captured and restored too.

**Snapshots.** Each stateful module exports and imports its own state; the list
in `sceneModules.js` is what is looped over, so a module left off it is silently
missing from every snapshot. A restore pauses first, sets the horizon colour
before the modules (the weather's restore keeps or blends from it), then
imports each module and rebuilds the terrain data map. Reproduction is within a
tolerance, not pixel-exact. The form's entry restores the five positions and
writes nothing: terrain, water and the clouds have already restored the values
those positions produced.

**Frame logic.** Four decisions: a painting on screen means dynamics is frozen;
whether dynamics advances this frame; whether the art pass needs frames while
the loop would otherwise skip; and whether the world holds still, which is when
the cached render targets stay valid. A slider touched on a frozen scene still
takes effect because touching it rebuilds the caches once.

### 4.5 `water/`

The reflective plane over the terrain: depth-coloured water that mirrors the land
and sky, with shore foam, a sun glint, and a waterline that rises as the scene
settles.

| File | Role |
|---|---|
| `water.js` | One mesh and material, the two pre-passes, the snapshot, `water.params`. |
| `waterDriver.js` | The per-frame animation: sea level, ripple clock, foam and glint reactions. |
| `waterMath.js` | The pure maps the driver applies. |
| `waterParams.js` | The param rows and each uniform's snapshot class. |
| `shaders/water.vert`, `water.frag` | Ripple displacement and normals; the surface shading. |

**Terms.** *Sea band*: `low` and `high`, the waterline when the scene is restless
and when it has settled. *Render target*: an off-screen image a shader can read
later. *Depth texture*: the distance to the nearest surface at each pixel.

**The cycle.** On each dynamics tick the driver eases the sea level toward
`low + (high − low)(1 − restlessness)` (about 70% of the gap per second), advances the ripple
clock (frame time × wave speed × a pace that rises with momentum) and rescales foam,
glint and deep-colour depth. Then `main.js` runs the two pre-passes, passes the sea
level to terrain, and renders the frame, where `water.frag` reads both textures. A
deliberate write to the band (a slider) snaps the level to the new target at once.
The form walker writes the band every frame and must not snap, or the easing
would be pinned to the target.

**Techniques.**

- **Depth colour.** Both pre-passes re-render the rest of the scene with the water
  hidden, since it would cover the seabed in the depth pass and reflect itself in
  the mirror pass. The depth one, from the real camera, gives the seabed's distance under
  each water pixel. The shader rebuilds the seabed point along the view ray and
  takes the vertical drop to the surface. Subtracting view distances instead
  would measure the ray's path through the water, which at grazing angles is many
  times the depth. That vertical depth picks shallow-to-deep colour, in flat bands.
- **Planar reflection.** The second pre-pass renders from a camera mirrored across
  the sea level (height `2m − y`, view direction's vertical part flipped). A water
  pixel lies on the mirror plane, so projecting it through the mirror camera's
  stored matrix gives its position in that picture. The ripple normal wobbles the
  lookup, and the fresnel term (reflection grows at grazing angles) is stepped into
  sheets. The mirror pass costs one more scene draw, so it runs at a fraction of
  the canvas size (a slider) and is skipped while the world holds still.
- **Oblique near-plane clipping** (Lengyel). The seabed lies between the mirror
  camera and the water, and would block its view as dark wedges. Tilting the
  camera's near plane onto the water plane makes the GPU discard everything below
  it, with no extra shader work. Only the depth row of the projection changes, so
  the screen lookup is unaffected; the plane is scaled so the far plane does not
  cut the visible frustum.
- **Ripples.** The height is three travelling sine waves, each with its own
  direction, wavelength and speed (so the sum never visibly repeats), plus 3-D
  noise detail that evolves in place; a slider mixes the two. The vertex shader
  lifts the plane by that height and builds the normal from the exact slope: a
  cosine for each sine, `snoise_grad` for the noise. The normal matters more than
  the lift: it drives the fresnel, the reflection wobble and the glint.
- **Foam.** Depth near zero is the coastline. The band's edge is warped by noise,
  its reach widens as a wave crest arrives (sampled 0.3 s ahead so the foam keeps
  step with the crest), and it is stepped into tiers.
- **Glint.** A two-tier stepped highlight toward the scene sun (the one terrain
  shades with), anti-aliased with the screen-space derivative of the highlight.
- **Depth shares.** Foam reach and the depth of full deep colour are sliders in
  shares of the depth available (sea level minus a seabed estimated from the
  terrain's amplitude), turned into world units each tick. Fixed distances would
  leave some form-dial corners with no deep colour and others covered in foam.
- **Shared with terrain.** Fog, light level and cloud shadow are the scene-wide
  objects terrain also reads, so the shoreline shows no seam.

**Connections.** Out: sea level to terrain, godrays, audio and the overlay;
ripple time to audio (surf is timed to the foam); the depth texture to clouds and
godrays. In: terrain amplitude and wave speed each frame, the sea band from the
form walker, reflect and glint amounts from the weather, and the art pass, which
switches the surface to a flat marker.

**Parameters.** Sea band, ripple, bands, foam, reflection and colour rows in
`waterParams.js`, in the panel's sea-band and surface groups.

### 4.6 `clouds/`

The sky's cloud deck and the light shafts under it. The coarse cloud shape and
its self-shadowing are baked into two 3-D textures; each pixel then marches
through them, adding only the fine detail the textures cannot hold. The shadow
the clouds cast on the ground and in the air comes from the same baked data.

| File | Role |
|---|---|
| `cloudsVolume.js` | The renderer: bake, light and march passes, the rolling window, staleness, snapshot, `clouds.params`. |
| `cloudVolumeMath.js` | The pure math: grid limits, octave counts, window re-anchoring, the rectangles to re-bake. |
| `cloudWeatherMap.js` | The one-time weather-coverage texture. |
| `cloudParams.js` | The cloud param rows and each uniform's snapshot class. |
| `godrays.js`, `godrayParams.js` | The light shafts: a march through the cloud shadow, a composite, the weather gate. |
| `shaders/` | Bake, light, march and composite for the clouds; march and composite for the shafts; shared optics and shading includes. |

**Terms.** *Octave*: one layer of the fractal noise, each twice as fine as the last.
*Extent*: the window's side in world units. *Cell*: one texel column of the
textures, `extent / 256` world units wide (12 by default). *Optical depth*: how
much cloud lies between a point and the sun; the sun that gets through is
`exp(−depth)`. *Window*: the 256 × 256 cells of cloud space the textures currently
hold. *Scissor*: a rectangle outside which the GPU writes nothing.

#### The baked data

**Two 3-D textures hold the baked data.** The *shape* volume (256 × 256 × 32,
half-float) holds the raw signed noise of the cloud field. The *lit* volume holds,
per cell, a copy of that noise and the optical depth toward the sun, found by
marching from that cell toward the sun through the shape volume (thresholded with
coverage and density), so a cloud shades itself. The pair is stored twice, so a
relit layer can fade in.

**The cloud shape is smooth simplex noise with a Worley carve on top.** The base field
is several octaves of simplex noise added together, a smooth gradient noise that
makes round, soft lumps. (The technique this follows is called Perlin-Worley after
the older Perlin noise; simplex does the same job here.) Worley noise is the other
kind: put one random point in every cell of a grid, and for any position measure the
distance to the nearest point. That is highest at the points and falls to sharp seams
where two points' territories meet. The bake uses it to cut into the lumps: near a
point the cloud is pushed up, along the seams it is pushed down, so the lumps stand
out with bitten-away gaps between them, like the cauliflower edge of real cumulus.
The carve moves material around without changing how much cloud there is, and the
`worley amount` slider blends the plain field into the carved one. Worley has its own
scale (`worleyFreq`) and up to 3 octaves, and like the simplex octaves it has to fit
the grid: its points must be at least two cells apart.

**A small weather map decides where the sky is cloudier or clearer, on a scale of
thousands of units.** It is 512 × 512, one channel, baked once: two octaves of noise
(the first about 0.57 of a tile wide, the second 2.3 times finer), in about −1 to 1.
The march reads it at the sample's world position plus a slowly growing offset
(`weatherSpeed`), divided by `weatherScale` (2300 units per tile, the texture
repeats), times `weatherStrength` (3.5), and subtracts the result from the coverage
threshold. Where the map is positive the threshold drops and more of the field
becomes cloud; where it is negative the cloud thins to gaps. The map scrolls at its
own speed and is tied to world position, not to the wind-driven field, so the
cloudy and clear patches drift across the sky without any redraw. The light bake
reads it too, at the same world position, so a cloud's shadow thickens under the
cloudy patches and thins under the clear ones like the cloud itself. Because the map
slides against the wind-driven field, the light is relit once the map has drifted a
sixty-fourth of a tile (36 units) against it; the ground shadow is redrawn every
frame anyway. Only the marched fine octaves are still missing from the shadow.

#### The window

**The window sits around what is read, not around the camera.** The camera sees only
a wedge of the sky, so a square centred on it would hold mostly cells behind and
beside it. Three things read the volume, and the window is the box around them:

Seen from above, in cloud space, with the sun toward the right:

```text
┌──────────────────────────────────────────────────────────────────────┐
│       \                 /                           window           │
│        \  view wedge   /                                             │
│         \             /                                              │
│   ┌──────\───────────/──────┐                                        │
│   │       \         /       │  terrain plane (fixed in the world)    │
│   │        \       /        │                                        │
│   │         \     /         │  its shadow is read farther            │
│   │          \   /          │  toward the sun:  ──────────►          │
│   │           \ /           │                                        │
│   └────────────●────────────┘  the light bake reaches  ───►          │
│             camera                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

- **The march** reads a wedge in front of the camera. Its length is the draw
  distance and its angle comes from the lens and the camera's pitch; looking
  straight up or down opens it to every direction.
- **The ground shadow** reads the clouds along the sun's direction: a ground point
  is shaded by the cloud that sits toward the sun above it, so its read is shifted
  sunward by the cloud height times how flat the sun lies. The terrain plane is
  fixed, so this read does not follow the camera, and a lower sun pushes it
  farther.
- **The light bake** needs the cells between a lit cell and the sun, so it reaches
  sunward from the whole region by the length of its sun path.

Everything is in cloud space (world position plus the wind offset), so the wind
carries the region across the window, and the window follows once the region
leaves its margin.

**The draw distance decides how big the window is, and the window stays put until
the clouds being read reach its edge.** The window is a square, 1.7 times the draw
distance wide (never under 2900 units, so it always holds the terrain plane). The
box around the three reads is the region that has to fit inside it. As long as the
region stays at least 5% of the window away from every edge, nothing moves, and the
wind just slides the region through. When it gets closer than that, the window
jumps to centre itself on the region again, and only the strip of cells that came
in is redrawn. If the sun is so low that its shifts do not fit next to the wedge,
the wedge is kept and the sunward side gets what room is left.

#### Octaves and cell size

**The bake holds only the octaves the grid can show.** The bake takes one noise
sample per cell, 12 units apart at the default draw distance. To show a wave, a
sample is needed on its peak and another in its trough, so a wave shorter than two
cells (24 units) falls between the samples and shows up as a wrong pattern instead.
An octave's wavelength is `1.7 / frequency`. At scatter 0.45 the
octaves are about 235, 117, 59 and 29 units long. The first three fit and the fourth sits at the
edge (it is blended, see below); the fifth (15 units) does not. So the bake holds 4
octaves, down to a scatter of 0.78, and 3 above it. The count is worked out from the
cell size and never set: a longer draw distance means bigger cells and fewer octaves.

**The finer octaves are not dropped; the march evaluates them directly.** It takes
the same noise at each step, 6 units apart, so it can show waves down to 12 units:
the fifth octave (15 units), but not the sixth (7.5). These are the *marched*
octaves. The step grows with distance (to about 23 units at the far end), so the
waves it can show get longer: each marched octave is faded out by its wavelength
against twice the local step, the finest first.

**An octave near the baked limit is crossfaded to its marched copy, so nothing steps
when it drops.** Near the limit the texture's own filtering blurs the octave by an
amount that varies, and once it dropped from baked to marched it would turn sharp in
one step. So over the last tenth of the limit (wavelengths from 27 down to 24 units), its
baked weight falls while a marched copy of the same wave rises, and at the drop the
marched copy already carries all of it. The scatter dial reaches that point at 0.78.
The marched copy costs one more noise lookup per step, so the zone is kept narrow:
at the default settings the last baked octave sits below it and pays nothing.

**The draw distance sets the cell size, and the cell size sets how many octaves are
baked.** The textures are 256 cells wide, fixed in the code, and the draw distance
sets the window's extent (1.7 times it, at least 2900). Every baked octave is one
fewer noise call per step in the march. An octave is fully baked only below 90% of
the grid's limit; between 90% and 100% it is a mix of baked and marched.

| Draw distance | Window | Cell | Baked octaves | Last baked octave at scatter 0.45 | Marched octaves |
|---|---|---|---|---|---|
| 1500 | 2900 | 11.3 | 4 | fully baked | 1 |
| 1800 (default) | 3060 | 12.0 | 4 | fully baked | 1 |
| 2200 | 3740 | 14.6 | 4 | under 1% baked | 1 |
| 3600 | 6120 | 23.9 | 3 | fully baked | 2 |

**A longer draw distance softens the clouds.** The same 256 cells cover more sky.
A bigger texture holds finer octaves, but every redraw costs in proportion to its
texel count, so the light takes visibly longer to settle.

#### Keeping the bake current

**What a change redraws depends on what it changes.** Redrawing means running the
bake or light shader over the texels concerned. There are five cases.

- **The region leaves the window: strips.** The wind carries the region (in cloud
  space) past the window's margin, or the camera moves, so the window re-anchors:
  cells that fell off one side re-enter on the other, standing for new cloud, and
  nothing else changed. A *strip* update redraws only those cells: two thin
  rectangles along the edges that moved, in all 32 layers, in this frame, through a
  scissor so every other texel keeps its value. The light is redrawn in the same
  strips made wider, since a cell's light depends on the cells toward the sun.
- **The scatter dial moves: roll.** Cloud scale or Worley scale changed (the scale
  reaches the bake at the capped rate below), so every cell changes, but only
  slightly. A *roll* redraws whole layers, 4 per frame (about 8 frames for the 32),
  instead of one big frame. While it runs, layers hold different scales side by
  side, so it is allowed only while they stay within one cell of each other at the
  window's corner. After the shape settles the light is relit, and each relit layer
  fades in over one relight cycle instead of changing in one frame.
- **The field itself changes** (draw distance, shell level or height, curl, Worley
  amount, erosion or octave ceiling), or a scatter step too big to roll, the first
  bake, a snapshot restore, or strips covering half the volume. The whole shape and
  all 32 light layers are redrawn in one frame, a one-off cost.
- **Only the lighting changes** (the sun moves, coverage, density scale, light steps
  or light step size). The shape is untouched. The light is redrawn one layer per frame,
  in an interleaved order (0, 16, 8, 24, 4, ...), so a change reaches all 32 layers
  within 32 frames and no fresh/stale front sweeps up through the clouds. Under the
  weather, coverage moves every frame, so the light is always mid-refresh. Each layer
  stores its light twice and fades from the old copy to the new one, so nothing
  changes in one frame. The ground shadow and the shafts do not read a layer of the
  volume at all. They read the whole column's shadow from a small 2-D texture of its
  own, which the light shader redoes every frame. It reads last frame's value and
  writes an exponential ease toward the new one (`shadow smoothing`, 0.15 s), which a
  layer of the volume could not do: a layer cannot be read while it is written. A
  window shift writes only the strips that entered, fresh.
- **Shading, weather colours, wisp detail, march steps, planet curve change.**
  Nothing is redrawn; the march reads them live.

While the world holds still, every owed layer is finished in one frame and
`renderClouds` then skips all stages and keeps the cached image.

**Strips and rolls split the work differently.** A strip redraws a few texels of
every layer in one frame; a roll redraws every texel of a few layers over many
frames. While a roll runs, some layers still hold the old scale. The field zooms
about the window's centre, so a feature r units from it sits `r × (1 − f_old /
f_new)` apart between an old and a new layer, and the march blends the two into a
smear. At the window's corner, the farthest point, that offset stays under one cell
only if the scales differ by less than about 0.55%. A bigger step redraws everything
at once.

**Overcast and scatter move gradually, because a jump in either would change every
cloud pixel in one frame.** The coverage the clouds use eases toward the overcast
value (the `coverage ease` slider, 0.8 s), and the light is relit every frame while
it moves. The scale the bake uses moves toward the scatter value by at most 0.048%
per frame, so every roll stays under the one-cell limit: a 1% step takes about 21
frames, a 20% move several seconds. The rows keep the written values, and a restore
or a world that holds still snaps the drawn values to them at once.

#### The march

**Each pixel marches through the lit volume in six steps, into a cached target.**
1. Rebuild the view ray; intersect it with the cloud shell (widened downward for
   the planet's curvature). Stop at the terrain depth and at the draw distance.
2. Step along the ray from the shell entry. The step starts at `marchStepSize` (6
   units) and grows by 3% of that per step, up to 96 steps; stop once under 1% of
   the light is left.
3. At each step, find the cloud density at the step's midpoint:
   - Steps outside the shell's height range are skipped.
   - Two fetches of the lit volume, one in each of the two layers around the step's
     height, mixed by each layer's fade weight, give the baked field (R) and the
     optical depth from that point to the sun (G).
   - The fine octaves the grid cannot hold are evaluated as noise at this point and
     added to the baked field (scaled by the wisp-detail slider; see Octaves and
     cell size).
   - Density is how far the field, times the density scale, rises above the
     coverage threshold; zero means clear air. The weather map shifts the threshold
     up or down by place, and the density thins out at the shell's top and bottom.
   - To save the noise, a bound on the largest the fine octaves could add is tested
     first: where even that cannot lift the baked field over the threshold, the
     density is zero and no noise is evaluated. That is most of the sky.
4. Where there is density, the step adds in-scattered light: the sun reaching the
   cell (`exp(−depth × absorption)`), times the light still left on the ray, times
   the Henyey-Greenstein phase (a glow toward the sun), times the step length.
   Then the ray's remaining light drops by `exp(−density × step × absorption)`.
5. Brightness and opacity go through the shading tail: stepped into flat colour
   bands and opacity tiers, blended toward the sky colour as the weather greys. The
   result, a colour and an opacity per pixel, is stored in an off-screen image (the
   cached target), not drawn to the screen.
6. Every frame, the composer's cloud pass mixes that image over the rendered scene:
   `scene × (1 − opacity) + cloud colour × opacity`. It is two texture reads per
   pixel and runs even in frames where the march was skipped, so the clouds always
   sit over the current frame.

#### Light shafts

**The shafts are found by walking each view ray through the air under the deck and
adding up where the sun reaches.** Each step along the ray asks whether sunlight
gets to that point, and the pixel's brightness is the sum of the lit steps.

**The pass needs its own march because the usual screen-space trick cannot see
the clouds.** The common godray blurs the picture outward from the sun's position
on screen, which only works if the things that block the sun are in the frame. Here
the camera looks away from the sun, so neither the sun nor the clouds that shade
the visible air are on screen. A sun at the side also throws beams across the frame
instead of a burst around a disc, which reads more clearly.

**The shadow comes from the ground shadow's own texture, the one the ground reads, and
that is also why the beams are straight.** For a point in the air, the pass follows
the sun ray up to the cloud base and reads the cloud depth there, the same depth the
ground shadow uses. Beer's law turns
the depth into a lit value, and a smoothstep around a threshold sharpens it into lit
or shadowed. Every point under the deck reads one flat shadow field, shifted along
the sun's direction by its height, so an edge in that field extends downward as a
flat plane, and a plane seen in perspective is a straight line.

**Each pixel marches 16 steps and stops at the first thing in its way.**
1. **Start:** rebuild the view ray; its start is jittered by a per-pixel hash, so the
   fixed step does not draw rings around the camera.
2. **Stop:** at the terrain depth, at the water plane (worked out directly, because
   the depth texture cannot see the water surface), at `reach` (650 units), or at the
   cloud volume's usable radius. A ray that goes up stops a short way into the deck
   (`cloud blend`, 14 units).
3. **Lit value:** at each step, read the cloud depth through the sun footprint, turn
   it into a lit value with Beer's law and sharpen it with the (snapped) cut.
4. **Three factors:** multiply that lit value by
   - the *deck fade*, which goes to 0 as the ray enters the deck, so a shaft dissolves
     into its cloud instead of starting at one height;
   - the *downward dimming* (`beam falloff`), which drops with the distance below the
     deck, so a shaft is brightest where it leaves the cloud;
   - the *near fade* (`near cutoff`, 400 units), which removes the first stretch in
     front of the lens, because light picked up there covers the frame as a flat veil.
5. **Sum:** weight each step by the light that survives back to the camera, so near
   air counts most and the sum levels off.
6. **Phase:** multiply the total by the Henyey-Greenstein phase (`sun bias`), a glow
   toward the sun, which makes the shafts read as light and not as fog.

**Cut snapping makes a shaft's edge land exactly where the ground's shadow edge is.**
The ground shows cloud shadow in flat steps (with 4 shadow tiers, it changes only
where the lit fraction crosses 1/3 and 2/3). The shafts' beam threshold (0.5) would
fall in the middle of a flat band, so a beam would end at an arbitrary spot inside a
patch of ground. The cut is therefore moved to the nearest ground step, 2/3. Both
read the same cloud field, so the air goes dark exactly where the ground under it
does. `match ground shade` blends back toward the raw threshold. The edges coincide
only while the shafts' absorption (0.59) equals the ground's. The density dial sets
only the ground's (0.26 at the dial's default), so by default the edges sit near each other.

**The composite turns the march into the final shafts in four steps.** The march
runs into a private target at 0.65 of the screen size.
1. **Upsample:** the composite shader reads that target at full size.
2. **Blur:** a small blur of the continuous value (`softness`). This comes before
   snapping, because snapping first would leave noise that blurring could not undo; it
   would only mix two flat values.
3. **Snap:** into 9 flat tiers, rounding down, so air with a faint trace of beam stays
   at zero and does not lift the picture.
4. **Add:** a screen blend, `base + colour × ray × (1 − base)`. It lifts dark ground a
   lot, barely touches bright snow, and cannot push anything past white.

**The weather decides whether the pass runs at all.** Below an overcast of 0.9
(`shafts start at`) the march and the composite are switched off, which is most of
the time. From 0.9 to 1 the brightness fades up. The beams' own contrast needs no
weather term: the shadow field is uniformly bright under a clear sky and uniformly
dark under a closed lid, so beams show up only where the deck is broken.

**The order in the composer is render, shafts, clouds, art pass.** The shafts have
to come before the art pass, because the painted frame samples the composited
colour. They come before the clouds, so a cloud in front of a shaft dims it, at the
price that a cloud behind a shaft does too. The error lands mostly on sky pixels near
the horizon, because the shafts sit below the deck and are mostly seen against ground.

#### Connections

**Connections.** Out: the shadow frame to the scene uniforms (terrain, water and the
shafts read it), the draw distance as the usable radius, the composer passes. In:
the sun, the scatter and density dials, the weather's coverage, grey and sky colour,
the water depth texture, the overcast value and the sea level (shafts).

### 4.7 `terrain/`

The land: a height field computed on the GPU every frame, coloured by biome and
shaded in a painterly cel style, with a forest drawn as a lattice of tree crowns.
Everything else reads from it or writes into it: water takes its depth, the clouds
take its sun direction, the form dials move 15 of its sliders and the snow base, and the
weather sets its light terms.

| File | Role |
|---|---|
| `terrain.js` | The mesh, the five materials, the passes each frame, `terrain.params`, the snapshot. |
| `terrainDriver.js` | The tick: drift heading and offset, plus the height-range uniforms. |
| `terrainMath.js` | The driver's pure maps. |
| `terrainParams.js` | Every slider, toggle and colour as a param row; each uniform's snapshot class. |
| `terrainGeometry.js` | The plane, dense near the camera. |
| `treeSpecies.js`, `terrainUniforms.js`, `forestSites.js` | The species table, the forest uniforms no row seeds, the lattice window of the site table. |
| `shaders/heightmap`, `derive`, `terrain` | The data-map pass, the derive pass, the mesh and shading. |
| `shaders/includes/` | `fbm` (noise), `erosion`, `material` (biomes and colour), `forest`, `dataMapSample`. |

**The frame, in pass order.** This section is written pass by pass.

1. **The tick** (`terrainDriver`): drift heading and offset. Below.
2. **Data-map pass:** the custom fBM, erosion and the camera pit, into the height
   texture. Below.
3. **Derive pass:** slope and valley measures from that texture. Below.
4. **Forest site pass:** one verdict per tree-lattice site. Below.
5. **Main pass:** the adaptive plane displaced by the height texture, then cloud
   shadow, biome classification, cel shading, forest crowns and fog per pixel.
   Below.

#### 1. The tick

**Goal and connection.** The landscape must keep changing in a slowly wandering
direction without ever jumping, and stand still when the room is calm. The
driver does this once per dynamics tick and never draws. It reads the tick's
`noiseTime`, `momentum` and `dt`, and writes only
uniform values. The data-map, derive and main passes share those uniform objects,
so one write reaches every pass. `noiseTime` is the clock the landscape evolves
on. It advances by 2.5 × momentum per second, so at momentum 0 it stops.

**Drift.** *Problem.* If both noise layers scrolled together, the picture would
only slide sideways. Nothing would reshape. *Fix.* The noise is sampled at `world
position + offset`, and each of the two layers has its own heading and speed (4
units per noise-time unit each at the default), so the layers pass over each other
and the shapes change.

*Offset.* It accumulates: `offset += velocity × Δ(noiseTime)` each tick. A formula
`velocity × total time` would relocate everything already travelled when the
heading changes: after 100 units east at speed 3 the offset is +300, a flip to west
would give `−3 × 100 = −300`, a jump of 600. Accumulating keeps +300 and only
shrinks it from there. `Δ` is measured against the clock value the driver last
wrote, so a restored snapshot resumes with Δ = 0, and it is never negative, so a
clock reset does not rewind the land.

*Direction.* Each layer keeps a heading angle θ, started at 0° (east) for the first
and 117° for the second. Every tick `θ += dt × momentum × steer × 0.2 rad/s`
(`dt` capped at 0.1 s), where `steer` is a sine of `noiseTime` with a period of
about 203 noise-time units for the first layer and 242 for the second. The
velocity is `(cos θ, sin θ) × speed`. Nothing is random.

The heading does not circle. The sine sets the turn *rate*, so the layer turns one
way while the sine is positive, then the other way while it is negative, and the
heading swings back and forth. Momentum scales both the turn rate and the pace of
`noiseTime`, so it cancels: the path of headings is the same at any momentum and is
only walked faster or slower. Over one period the first layer sweeps an arc of
296° (from −94° to 202°) and the second 353° (from −235° to 117°), a swing that
takes about 85 s and 102 s at the momentum cap of 0.95. The two layers use different periods and
start angles, so they never move in step.

#### 2. The data-map pass

**What it produces.** On every frame in which the world moves, a full-screen pass
works out the ground for the whole 1500-unit plane and stores it in a texture, the
*data map*. (A *world unit* is the scene's own distance unit; the map has 512 by 512
*texels*, pixels of a texture, each covering a patch of ground about three world
units across.) The pass is skipped while the scene holds still, because its inputs
are frozen and the stored map is still right. Each texel holds four numbers:
- **height**, the only one the normal picture uses: the mesh is displaced by it, and
  a second pass (the derive pass) turns it into the slopes and hollows the biome
  colouring and shading read;
- a **ridge value**: positive on the narrow ribs between erosion gullies, negative on
  gully floors, zero where erosion did nothing (1 when erosion is off);
- the **erosion change**, the height the erosion added divided by the filter's total
  strength (roughly −1 to 1, not world units);
- a **rock-or-soil flag**: 1 where bare rock is the higher field, 0 where soil is.

The last three are written for the panel's debug views and for tests; no shader
reads them in the normal render.

**Per texel, in order.**
1. Turn the texel into a position on the plane.
2. Evaluate the custom fBM (below) for two noise instances and add them. This gives
   the height, its slope and the rock-or-soil flag, from one sample per texel.
3. Run the erosion filter on that height and slope (below).
4. Press the result down near the camera (the camera pit, below).
5. Write the four numbers.

Averaging four samples per texel would cost about 2 to 3 ms per moving frame and
makes no visible difference at the four form corners or a blend of them.

##### The custom part: two fields from one set of octaves

**Terms.** The terrain's noise is built in *octaves*: layers of smooth random bumps,
each with smaller bumps than the one before (the *lacunarity* is how much higher its
frequency is) and lower height (the *persistence* is the fraction of height each
octave keeps). The big octaves make mountains and valleys, the small ones add
roughness. Two such noise instances are added, one with large features and one with
medium ones, each read at its position plus a *drift offset* (how far the pattern has
slid) and with time as a third coordinate, so shapes change in place while the
pattern travels. Each octave's slope comes straight from the noise's own derivative,
so the erosion filter gets a slope direction without taking extra samples. It is
exact apart from the height gate's own slope (Trick 4), which is small and left out.

**The idea.** In real mountains, bare rock stands on the heights and loose soil
gathers in the hollows. The terrain imitates that with two height fields built from
the same octaves:
- **Bedrock** uses all the octaves (5 or 6), so it has the full relief and the fine
  detail.
- **Mantle**, the soil, uses only the first few (3), the big shapes, and is scaled to
  a fraction of the bedrock's height (the *relief*, between 0.4 and 0.55).

The ground height is the higher of the two. A blend would average the rock detail
away everywhere; the maximum leaves each field intact where it wins. With the default octave counts (3 for the
mantle, 6 for bedrock), split the octaves into the big ones and the fine rock ones:

```text
big  = w₀·n₀ + w₁·n₁ + w₂·n₂        the three big octaves
fine = w₃·n₃ + w₄·n₄ + w₅·n₅        the three finer, rock-only octaves

bedrock = (big + fine) / W
mantle  = relief × big / W
ground  = max(mantle, bedrock)
```

- `nᵢ` is octave `i`'s noise, shaped (folded, for the ridged octaves).
- `wᵢ` is that octave's height, `persistence^i`, with `i` counting from 0 (the rock
  octaves use their own falloff and a gate, Tricks 2 and 4).
- `W` is the total of the ordinary weights over all six octaves. It keeps both fields in
  the same range. Both divide by the same one, so the mantle is exactly `relief` times
  the bedrock's big shapes.
- `relief` is the mantle's fraction of the bedrock (0.4 to 0.55).

**How the two layers stack.** Both fields share the same big octaves, so they draw
the same mountains and valleys. Bedrock adds the fine rock octaves at full strength;
the mantle is a flattened copy of the big shapes, squeezed toward the average height.
The squeeze decides which layer is on top:
- On high ground the squeezed copy sits lower, so bedrock stands out and rock shows.
- In a valley bedrock digs to full depth but the copy is dented only a little, so the
  mantle covers it: smooth, shallow soil.

The soil line is where the two cross. It is not drawn by hand: it falls out of the
comparison, near the average height, shifted by the rock detail and by the soil level (a
constant lift of the mantle). One loop builds both layers.

**Trick 1: use the slope of the winning field.** The surface the viewer sees is
whichever field is higher at that spot, so the slope handed to the erosion filter is
that field's slope. Averaging the two would point away from the real surface,
because the two fields' slopes are only loosely related, and erosion would then carve
gullies across rock faces instead of down them. The switch is a hard one, so the
slope jumps where the fields cross, at the soil line. (Shading normals are a
different slope: the derive pass measures them from the finished height map.)

**Trick 2: rock octaves.** Bedrock has more octaves than the mantle. The extra,
finest ones (octaves 3 to 5 by default) belong to bedrock alone, and they get their own
settings, so the character of rock can be tuned without touching the soil:
- *Their own falloff.* An octave's steepness grows like `(persistence × lacunarity)^i`, so a
  finer octave adds more steepness than the one before it whenever persistence
  times lacunarity is above one, and the surface turns rough everywhere. The rock octaves fall off on a separate setting, kept below one over
  the lacunarity at every form corner, so each further octave adds less slope than
  the one before and the total levels off: more octaves give finer texture, not
  steeper ground. (The slider allows values above that limit.)
- *Their own ridging* (Trick 3), independent of how the large forms are shaped.
- *A height gate* (Trick 4) and *a joint frame* (Trick 5).

The total used for normalising ignores the rock falloff and uses the ordinary
persistence. If it used the rock falloff, moving the rock slider would change the
total and rescale the mantle's relief with it.

**Trick 3: ridged noise.** Plain noise makes round, blobby hills; mountains have
sharp crests. The ridged version replaces each noise value `n` (between −1 and 1) by
`1 − 2·|n|`, one minus twice its distance from zero. Where the noise passes through zero, which
happens along long continuous curves, the result is at its peak, so those curves
become connected crest lines. Where the noise is far from zero the result is low and
changes slowly, so the hollows stay broad and soft. How much of each octave is
folded is a blend: `shaped = (1 − ridge) × n + ridge × (1 − 2·|n|)`, where `ridge`
is 0 for plain noise and 1 for fully folded.

The fold has a sharp corner at zero, and the erosion filter carves along any place
where the slope jumps, which gives jagged little rills. So the corner is rounded: `|n|` is
replaced by `√(n² + e²)`, which is almost the same away from zero and smooth at it,
with a small number `e` (the rounding). The price is that the crest of a fully folded
octave sits at `1 − 2e` instead of at 1. At the shipped roundings (0.3 to 0.5) that is a large drop,
so the crests are broad and rounded, not knife-edged, in exchange for a slope that
passes smoothly through them. One rounding value is used for every octave. Across the
form's four corners, ridge amount and rounding move in opposite directions: the
sharpest corner, the alpine landmass, has the least rounding, and the corner with no
ridging at all has the most.

Where each part is ridged:
- The large-landform instance is never ridged on its shared octaves, so its big
  shapes stay round.
- The medium instance ridges each shared octave by the ridge amount divided by its
  octave number plus one: the full amount on the coarsest, half on the next, a third
  on the third.
- The rock octaves of both instances use a separate ridge amount, so the fine rock
  detail can be creased hard without sharpening the large forms.

**Trick 4: the height gate.** Fine rock detail would be as strong in a valley as on a
summit, which is much of why extra octaves read as noise and not as rock. Real low
ground is smooth because sediment fills it. So the rock octaves are weakened where the
mantle sits low: `strength = (1 − g) + g × smoothstep(low, high, mantleHeight)`. Here
`mantleHeight` is that noise instance's mantle at the spot, before the relief scaling
(from −1 to 1), `smoothstep` is a smooth ramp from 0 at `low` to 1 at `high`, and `g`
is how strongly the gate acts. Below `low` the rock octaves keep only `1 − g` of their
strength (a tenth to a third at the form corners); above `high` they keep all of it.
The mantle octaves are already summed when the first rock octave starts, so the gate
needs no extra noise samples.

**Trick 5: a joint frame, so rock detail lines up.** Real rock breaks along preferred
directions, so its features line up and stretch, which noise that looks the same in
every direction cannot do. Each rock octave reads the noise through a frame that
scales the position by `1/k` along one direction and by `k` across it (`k` is 1.2
to 2.0 across the form corners). The area is unchanged, so the octave keeps
the same number of features per unit area, but along the direction they are `k`
times longer and across it `k` times narrower, and a bit steeper. The direction
cycles through three orientations 60 degrees apart from one rock octave to the next,
so with three rock octaves each is used once and no single direction dominates.

##### The erosion filter

The noise is smooth, but real slopes are cut by gullies. The filter (ported from Rune
Skovbo Johansen's "Fast and gorgeous erosion filter") draws them directly instead of
simulating water flow. Each texel takes the noise's height and slope and gets up to
three layers of gullies:
1. **Gullies that run downhill.** Pivot points are scattered over the ground, one per
   square patch about 60 world units wide for the first layer (the *ero scale* slider).
   Each pivot has a wave of stripes anchored at it, a high rib beside a low gully
   floor. The stripes run along the slope at the texel being drawn, and neighbouring
   pivots' waves are blended by distance, so the stripes bend with the terrain and have
   no seams.
2. **Only where the ground is steep.** Steep ground gets the full pattern. Flat ground
   gets none: its height is pushed toward a target instead, up on summits and down on
   valley floors (the *peak sharpen* slider sets how far).
3. **Finer gullies branch off.** The next layer has gullies twice as fine and half as
   deep, with stripes running along the slope as already changed by the first layer. A
   gully's sides fall in their own directions, so new gullies branch off at an angle,
   like a drainage network, and are held back where the previous layer is flat.
4. **Outputs.** The total height change, and the ridge value (positive on ribs,
   negative on gully floors, zero where nothing happened).

The pivots are positioned relative to the large landforms, so gullies move with them.
The stripes also slide slowly sideways across the slope while the scene moves, so the
fine relief is never still.

##### The camera pit

The camera is fixed and the terrain drifts, so a peak could grow up through the lens.
The height right at the camera is therefore capped, and the cap rises with distance,
quickly at first and then flattening toward the full height range, until the pit
ends 300 world units away: `cap(r) = floor + (top − floor) × (1 − (1 − r/300)^4)`,
where `r` is the distance from the camera, `floor` the cap at the camera and `top`
the full height range. Heights above the pit floor are *rescaled* into the cap,
not cut off: a plain cut would turn the ground near the camera into the bare cap
curve, a smooth featureless bowl. A final clip catches the rare peak taller than the
expected maximum. It is done here, in the data map, so the slopes, the biome bands
and the shoreline all see the same safe height.

#### 3. The derive pass

**What it produces.** A second full-screen pass runs right after the data map, on
every frame the data map runs (both are skipped while the world holds still). It reads the data map's height and writes the *derive map*, another 512 by
512 texture with four numbers per texel: the slope of the ground in x and in z, and
the mean ground height on two rings around the texel, a *valley ring* 60 world units
out and a *gully ring* 15 units out (the *hollow radius* and *crease radius*
sliders). Each texel costs 20 texture reads. Done here, the mesh vertices and the
pixel shader read the result in one fetch instead of repeating those 20 reads in
every scene pass.

**The slope.** The height one texel to the east minus the height one texel to the
west, divided by the distance between them, gives the slope in x; north and south
give z. It is measured on the finished height, with erosion and the camera pit
included, so the lighting sees the surface the viewer sees. The heights are read
through a smoothed lookup that eases the position within a texel, so the slope has
no kinks at texel borders. The vertex shader turns the slope into the surface
normal. The slope is taken in its own pass because the height pass writes one
texel at a time and cannot see its neighbours' final values.

**The ring means.** Eight reads spread evenly around a circle are averaged. The main
pass compares that mean with the texel's own height. A mean above the height means
the ground sits in a hollow, a mean below means it stands proud. The gully ring
tells gully floors from the ribs between them; the valley ring tells valleys from
massifs. A point counts as a valley floor only where both rings agree, which keeps a
lone ridge or a coastline from reading as one. Biome choice, moisture and the forest
use this; the main pass section covers how.

#### 4. The forest site pass

**What a site is.** Trees are not geometry. The main pass draws them per pixel as
crowns on a triangular lattice of potential trees, about 3.3 world units apart at the
default (the *cell* slider is 4). Each lattice point is a *site*, named by two whole
numbers. A hash of those numbers gives the site's nudge away from the lattice point
(up to 0.8 units), its size roll and its existence roll, so a site always grows the
same tree. The lattice is laid in the drifting frame of the base noise, so the trees
travel with the ground.

**Problem.** Whether a tree exists, which species it is and how steep the ground is
under it all depend on the ground at the tree's root: the biome classification there.
A pixel near trees needs that verdict for each crown that could reach it: 25 sites at
the default settings, 3 when crowns are small. Classifying per pixel would run the classifier tens of
millions of times a frame, and the same tree would be classified again by every pixel
that sees it. **Fix.** The verdict depends on the site alone, so a pass computes it
once per site and stores it. Pixels only read it. Every pixel of a crown reads
the same verdict, so a biome border cannot slice a crown in two: a tree is whole
or absent.

**The table.** The pass draws a full-screen quad into a float texture. One texel is
one site: texel `(x, y)` holds site `(x + originX, y + originY)`. The window covers
every site a pixel of the plane can reach and moves with the drift. Its side is
rounded up to a multiple of 64 (704 at the default, 1344 at cell 2), and it is
bigger than the plane needs because it is a square of site numbers laid over a skewed
area. The pass takes under a millisecond and is skipped when the forest is off.

**Per texel, in order.**
1. Turn the texel's address into a site.
2. Find the root's position: the lattice point plus the site's nudge.
3. Read the height at the root from the data map, and the slope and ring means from
   the derive map.
4. Classify the root with the same function the ground uses, including the edge
   wobble at the root. This gives a biome and a tree probability.
5. Existence is how far that probability exceeds the site's own roll, within the
   *grow window*. A site with roll 0.7 grows a tree at probability 0.9 and not at 0.5.
6. The species follows the biome under the root: gully floors grow broadleaf trees,
   everything else conifers.
7. Write existence, species and the root's slope in x and z.

The pass compiles the main pass's own shader file with a switch, so the classifier
exists once and the forest cannot disagree with the biomes about where trees stand.

#### 5. The main pass

**Goal and connection.** This is the pass that draws the picture. It receives three
things from the passes before it: the height map, the derive map and the forest site
table. One mesh and one shader turn them into a coloured, lit pixel. The mesh gives
each point of ground its height. The pixel shader then answers five questions in
dependency order, and each answer feeds the next:

1. **Which ground is this?** The classifier picks a biome and a tree probability.
2. **Where are the trees?** The forest canopy adds crowns, which change the lighting
   normal and decide the colour of covered pixels.
3. **How bright is it?** The normal is compared with the sun and stepped into tone
   bands, and cloud shadow is applied.
4. **What colour is it?** The material, shore sand or crown species gives a sunlit
   colour, and the tone gives the shadow blend.
5. **How much haze is in front of it?** Light level and distance fog.

##### The mesh and the vertex shader

The mesh is one flat plane of 800 by 800 segments. Columns are evenly spaced. Rows
are spaced in proportion to their distance from the camera, so near ground is dense
and far ground coarse. The height comes from a texture, so the mesh only has to be
fine enough to show it, and near ground covers many pixels per triangle while far
ground covers few.

Each vertex reads its height from the data map and lifts itself to it. It reads the
slope from the derive map and turns it into the surface normal. The rasteriser blends
this normal linearly across each triangle, so the lighting normal has the resolution
of the mesh and not of the map. The vertex also passes along its position shifted by
the drift, so colour noise travels with the land.

##### 1. Which ground is this? The classifier

The classifier reads the *ground field* at the pixel: the slope and the two ring means
from the derive map, taken at the pixel's own spot and not from the values blended
across the mesh triangle. The forest site pass classifies tree roots from the same
map. If the pixel used the mesh values the two would disagree on crests, where the
mesh is coarser than the map, and trees would stand on ground painted as snow. The
pixel's height is still the one from the mesh. The lighting normal also stays the
mesh's, because nothing else needs to agree with it.

It asks a list of questions from top to bottom, and the first yes decides the
material.
1. Above the snow line? Snow. The snow line sits higher on slopes that face the sun,
   lower in hollows where snow collects, and higher on steep ground, which sheds it.
2. In the rock belt just below the snow line? Rock.
3. Too steep for soil? Rock.
4. Under the sea? Seabed.
5. A convex, wind-scoured rib? Rock, or meadow if it is flat.
6. Above the tree line? Meadow. The tree line also follows the sun side, drops on
   exposed ribs and rises in sheltered hollows.
7. The floor of a deep gully? Lush riparian ground.
8. A flat pocket? Meadow.
9. Otherwise forest. Forest is the default of the mid-slopes, and every other biome
   is carved out of it by one condition.

A small noise shifts each threshold, so borders are ragged lines and not contours.

The same questions give the *tree probability*: the first yes also sets a likelihood
between 0 and 1 that a tree grows there. Forest gets 1, gully floors are capped at 1,
and ground above the snow or tree line gets the value of a slider such as *on rock* or
*on meadow*. Beyond a border the value thins out over a short distance, and more so on
ridges and steep ground, so trees fray outward from the forest and are not cut off in
a line. The forest site pass uses this probability to decide which trees exist. In the
main pass it only fills dense stands and decides the far view (stage 2).

##### 2. Where are the trees? The forest canopy

Trees are never geometry. A tree is a dome of *height* that the pixel shader works
out for itself and uses in three ways: to light the pixel, to decide whether it is
covered, and to pick its colour. The outline of the land against the sky is never
changed.

**Which crowns.** The pixel visits the lattice sites around it (25 at the default,
3 when crowns are small) and skips every site whose crown cannot reach it. For each
site left it reads existence, species and root slope from the site table.

**One crown's shape.** Everything is measured from the tree's root, in the frame of
the slope under it, so every pixel under one crown agrees on its shape.
- *Size.* The species' radius, varied tree to tree by a size roll, and capped so
  the crown stays within the sites the pixel visits.
- *Slope.* On a slope the crown is stretched along the fall line and leans, so a
  tree on a hillside reads as a standing spire. Both mostly fade out on flat ground
  (the *slope gating* slider, 0.75 by default), where the fall line has no meaning, so
  flat-ground crowns are close to round.
- *Profile.* Height is zero at the rim and rises to the middle. The species sets how
  round the dome is, from a rounded dome to a cone with a rounded tip, and how fast
  it falls away from the top. The rim is faded to zero height and zero slope so the
  crown joins the ground without a crease.
- *Ragged outline.* A band of waves of different orders, with weights and a rotation
  drawn per tree, bites into the edge so no crown is a clean ellipse. The bite only
  ever shrinks the crown, and it is weaker on steep ground, where the crown is seen
  nearly edge-on.
- *Height.* The species' height, scaled by a roll per tree, by flatness (tall on
  flat ground, stunted on cliffs) and by existence. Existence rises from 0 to 1
  across the *grow window*, so a tree grows in gradually as the terrain morphs and
  does not pop.

**Combining crowns.** The first crown to reach the pixel sets the height and slope.
Every further crown is folded in with a smooth maximum of fixed width 0.4 (a
constant, no slider). The slopes are mixed with the same weights. A plain maximum would
leave a crease across every overlap.

**What the trees change on the pixel.**
- *Normal.* The crown slope is converted to a change of the lighting normal and
  added to the ground's slope. Its size is set in tone bands, not world units: one
  *tone depth* is the number of cel bands a crown may swing. The change fades out with
  distance. Only lighting sees it. Classification keeps the ground's own normal,
  because classifying at crown scale would speckle the biomes.
- *Colour.* The crown the pixel lies deepest inside, as a fraction of the way from
  rim to middle, owns the colour. That measure ignores height, so a taller tree does
  not take a neighbour's colour.
- *Coverage.* Any pixel under a crown is covered and takes its species' colour.
- *Underwater.* No trees are drawn under the waterline.

**Two cases with no crown under the pixel.**
- *Dense stands.* Above a high tree probability the gaps between crowns are filled,
  so a deep stand reads as one mass. Inside the forest belt the probability is 1, so
  every forest pixel is covered this way and no bare forest ground shows. Snow is
  excluded, so trees on snow keep the snow between them. The gaps take the species
  the ground itself would grow.
- *Far away.* When a crown is smaller than a pixel, "is there a tree here" has no
  answer. The shader then asks how much of the ground the trees would cover at this
  probability, and a mostly-wooded area becomes solid forest. Majority wins, so a thin
  scatter of trees does not turn into a green hillside at a distance. The crown relief
  fades out over the same distance.

##### 3. How bright is it? Light

The normal, with the crowns' change added, is compared with the sun direction. The
result is remapped through two sliders so the whole range of tones is used, then
stepped into a few flat tone bands. Each band edge is blurred over about one pixel,
which keeps the edges from crawling as the land drifts (the renderer has no
multisampling). The shadow of the clouds is multiplied in after the bands, so it keeps
its own hard edges and a shadowed patch still falls to each material's own darkest
tone. Ground just under the waterline is lit softly, without bands.

##### 4. What colour is it? Material and colour

Each material has one *sunlit* colour. Its shadow colour is derived from it by one
transform for every material: desaturated, darkened and pushed toward violet. The
tone from stage 3 blends between the two, and a per-material setting decides how far
a material's shadow may fall (snow stays bright, forest drops to dark mass). Near the
waterline, flat damp ground is first replaced by sand. A pixel under a crown then takes
its species' colour, with the forest ground's glow and shadow settings.

##### 5. How much haze? Light level and fog

The colour is scaled by how bright the day is. With distance it is then washed toward
grey and melted into the sky colour. The water shader uses the same curve, so land and
water fade together.

### 4.8 `artpass/`

The painting: a post-process that turns the finished frame into a picture made of
brush strokes, and the entrance and exit animations that bring it and take it away.

| File | Role |
|---|---|
| `artPass.js` | The render-chain pass: frame order, `artPass.params`, the snapshot. |
| `artPrepass.js` | The edge field, the ground blur and the reveal's growth field. |
| `artStrokes.js` | The strokes: the lattice tables, the incremental redraw, the ground laid under them. |
| `artHold.js` | The held picture, the exit dissolve and the count of strokes that have left. |
| `artGBuffer.js` | The scene data the strokes are painted from: surface normal, water flag, coverage and depth, drawn in a second pass. |
| `artPassReveal.js` | The entrance, exit and hold state machine. No graphics code. |
| `artPassMath.js` | The pure helpers: reveal and exit timing, jump-flood steps, prepass size, relief scale. |
| `artPigments.js` | The eleven pigments, the weight solve and the lookup texture. |
| `artPassMaterials.js`, `artPassTargets.js` | The shader materials and the render targets. |
| `artPassParams.js` | Every slider, colour, toggle and radio as a param row. |
| `shaders/` | Edge field, ground blur, reveal growth field, stroke birth table, dirty mask, stroke paint, compose, finish, dissolve; `includes/` holds colour, lattice, stroke, orientation, scene, paint-format and exit-rule helpers. |

#### Position

The art pass is the last pass of the render chain: scene, godrays, clouds, then the art
pass. It therefore paints the finished picture, sky and clouds included, and sees only
a colour texture. A stroke also has to know how far away the ground under it is,
whether it is sky, water or land, and which way the ground slopes, and none of that
survives in the colour frame. So the scene is drawn a second time into a small
texture, the *G-buffer*: the horizontal part of the surface slope, a water flag, a
"surface here" flag (sky stays empty) and the real depth. Terrain and water each have a
switch that makes their pixel shaders return those values at once, skipping
classification, forest, lighting and fog, so the second draw is cheap. It is redrawn
only while the world moves; a held painting reuses it.

Dynamics decides when the pass is on. When the room goes still, the freeze starts the
entrance. When it wakes, the unfreeze starts the exit. A pass that is switched off
costs nothing.

#### Canvas lattice

*Goal.* The painting must read as a still picture that does not crawl while the
landscape underneath it changes. *Problem.* Strokes placed by world position, or drawn
at random each frame, would shimmer. *Fix.* Strokes belong to the canvas. It is
divided into square cells (18 pixels at the reference screen, scaled to the real one so that the 16:9 picture always holds the same number of strokes), and every property of a stroke is
a pure function of its cell's two whole numbers and of the frame at the stroke's anchor
point: its offset from the cell centre (up to 0.28 of a cell along each axis), size, colour,
orientation, shape, thickness and paint order. Nothing carries over between frames, so
wherever the frame has not changed the strokes are identical.

The pixel-valued sliders (stroke size, weave scale, relief detail) are set at a
reference screen, a 2940-pixel-wide drawing buffer, and the shaders get them times
the largest 16:9 rectangle that fits the real buffer over that width, so a
projector, a retina laptop and a small window show the same painting at different
sharpness. The edge and ground prepasses run at the same design-relative
resolution, so a large buffer does not make them dearer.

The stroke pass draws the strokes alone, with no ground under them; a separate cheap pass (compose) puts the
ground underneath. The ground fades, the weave arrives and the weather shifts the
ground colour while the strokes stand still, so those changes cost that one pass and
not a redraw of every stroke.

A pixel looks at the cells around it and tests whether each cell's stroke covers it.
Jitter and stretched strokes reach past the neighbouring cells, so the default tests a
block of 5 by 5, 25 cells. Paint is opaque: of the covering strokes the top two by
paint order are composited, and the order is a fixed hash, so the stack never
reshuffles. Thicknesses are summed over every stroke that reaches the pixel, so the
relief has no jump at a stroke's rim.

A *second sitting* lays the same lattice again, shifted by half a cell with its own
randomness, over the first. The slider (0.75 by default) sets how many of its cells
fire. Cells are switched on by comparing a fixed per-cell number with the slider, so a
rising slider adds strokes one at a time and does not reshuffle which exist. An
optional finer in-fill lattice, off by default, keeps far ground from showing holes
when strokes shrink with distance.

#### Colour

*Goal.* The picture is broken into strokes of raw pigment, yet its average must come
out as the true colour, as in divisionist painting. *Problem.* Colours picked at
random from a palette shift the average. *Fix.*
1. A stroke reads the frame's colour once, at its anchor, as the *target* `C`.
2. A table baked on the CPU gives, for each target on a coarse colour grid, up to four
   pigments of the eleven in the palette and an area share for each. The shares are
   chosen so that the shares-weighted mean of those pigments equals `C`. A slider
   moves the choice between the single nearest pigment pair and an even spread over
   as many pigments as possible; pigments with a negligible share are dropped.
3. The stroke picks one of those pigments, using a fixed per-cell number against the
   cumulative shares, so over many strokes each pigment appears in proportion to its
   share.

The stroke's colour is then

```
stroke colour = C + k × (pigment − mean)
```

`C` is the target, `pigment` the one picked, `mean` the shares-weighted mean of the
chosen pigments, and `k` the spread. Because the pigments are picked in proportion to
their shares, the average of the strokes is `C` whatever the palette and whatever `k`
is. This holds even though the table is read at the nearest grid colour and so only
approximates `C`: the formula measures from `mean`, not from `C`, so the table decides
only which pigments take part. The palette decides which directions the colour
scatters in, and `k` how far.

`k` differs by segment (sky 0.18, water 0.16, near land 0.35, far land 0.1 at the
defaults), so sky and land can each be tuned, and falls toward the darks, which stay
quiet. Each family also varies a little toward white and toward its raw pigment, with
draws that average to zero. All mixing is done in linear light, because optical mixing
is an average of radiance.

#### Direction and surface

*Direction.* Every stroke has one angle, taken at its anchor. On land it runs along the
contour, perpendicular to the slope. On water it is horizontal. In sky each cell takes
one of two crossed angles by its hash. Near an occlusion edge the stroke turns to run
along the edge, so a tree line reads as a line and does not dissolve into the sky.

The edge comes from depth. A pixel is an edge where its depth differs from a
neighbour's by more than a fixed share of the distance (10% by default), so one
threshold works near and far, and a surface against the sky always counts. Those pixels
are *seeds*. A *jump flood*, about a dozen passes, tells every pixel its nearest seed
and its distance. A fit to the seeds around the pixel gives a smooth edge direction.
These three passes run at 1470 pixels across the 16:9 frame (half the reference
screen), whatever the real buffer is. A stroke within reach of an edge
(its own radius times 1.9, shortened by the stroke's elongation) blends its angle toward the edge's, using double angles so
that opposite directions do not cancel.

*Surface.* Each stroke has a thickness profile: a flat core, a rim, a scoop in the
middle and bristle grooves along its length, with a per-stroke load. The thicknesses of
all the strokes at a pixel add up and are stored in the paint texture's alpha. The
finish pass turns that height into a normal (a Sobel filter over a radius of about one
pixel), and lights it with a lamp fixed to the canvas, not to the depicted sun, so the
relief belongs to the painting. The weave of the canvas shows only where the paint is
thin. The relief height follows the stroke size, so changing the size does not change
how thick the paint looks.

#### Entrance and exit

The lifecycle runs rest, revealing, held, exiting, rest.

*Entrance.* It runs on a wall clock, not on the simulation's, so a slow machine does
not play it in slow motion. It has two beats. In the first (1.5 s) the canvas arrives:
the weave fades in and the frame washes toward the toned ground. In the second (25.5 s
by default) the marks arrive. Their order comes from a *growth field* solved once, at
the start, from the frame at that moment. A 32 by 32 reduction picks the darkest block
as the seed (a block mean, so one dark pixel cannot win). The score then spreads
outward from it in the same halving-step passes as the jump flood, repeated three
times, and is discounted more where the colour changes. So growth stays inside a
colour and crosses a border late. Each mark's birth time is `1 − score`, pulled
earlier for dark and edge marks, and a mark appears whole in a single frame. Raw, these
times bunch: the front crosses a flat colour in a narrow range and then waits at a border,
so marks arrive in bursts. The *even pace* slider (0.6 by default; 1 is fully even) replaces each time by
the share of marks born at or before it, which keeps the order and gives a constant
number of marks per second; the sound follows that painted share, not the clock. At
the start of an entrance the pass reads back from the GPU, blocking, the 32 by 32 seed
grid and the lattice tables that even pace evens out. The
silhouettes are drawn first by default, up to a depth limit (0.7 of the fog
range); edges beyond it arrive with the growth like any other mark. The relief trails the marks: it starts a quarter of the
way in and finishes last.

*How a frame is drawn.* A mark stays once it has appeared, so a frame differs from the
last only around the marks born in between. Whenever the strokes are redrawn whole (normally
once, at the start) the pass bakes a small table per lattice, one texel per cell: the cell's birth time and where its stroke is anchored. Each
frame a mask, one texel per cell-sized block, marks the blocks that a newly born stroke
can reach. The stroke pass draws only those blocks into the same target and leaves every
other pixel as the last frame left it. A redrawn pixel is computed over every mark born
so far, so the result is exactly what a full redraw would give (a test compares the two
pixel by pixel). Anything a stroke is made of, such as a stroke slider or a moving
scene, throws the strokes away and the next frame redraws them whole. At 1920 by 1080 a
whole redraw takes about 23 ms and an entrance frame about 1.5 ms.

*Hold.* When the marks have all arrived, the pass copies the paint, the stroke ids and
the source frame, and stops repainting. A finished painting then costs almost nothing.
A slider that changes the look thaws it for one frame, and it holds again. A slider that
only the ground or the canvas surface reads leaves the strokes in place, so the thaw
reruns the prepasses and the ground pass, and every stroke stays as it was.

*Exit.* When the room wakes, the landscape moves again and the held picture has to go.
The dissolve (16 s by default) lets each stroke leave when the colour at its anchor has
drifted from the held frame beyond a threshold, so the picture comes apart where the
scene is busy. A random mode gives every stroke its own moment instead. A first beat
(15% of the exit) takes the bare surface between strokes over to the live frame. A
stroke goes whole, in a few frames, never as a slow fade, and a ratchet stops one that
has gone from reappearing. Drift never fires on a calm passage, so at 40% of the exit
the survivors switch to a random moment each and leave one by one until none is left.
After the last frame the pass switches itself off. The rule for when a stroke goes is
one function shared by two programs: the dissolve applies it to every pixel of the held
picture, and a count pass applies it to every stroke of the lattice. The count is read
back asynchronously (about 18,000 texels at 16:9, a frame or two late) and gives the share of
strokes that have left, which the soundscape turns into cracks. A burst of strokes
going is therefore a burst of cracks, even though the drift rule makes the timing
unpredictable.

#### Connections

- **In:** the composited frame from the chain; the G-buffer (`artGBuffer.js`) for depth, slope and the water flag; the scene-wide set for the fog range; `dynamics` through `main.js` (freeze starts `playReveal`, unfreeze starts `playExit`).
- **Out:** `getPaintedFraction()` and `getRemovedFraction()`, which `main.js` hands to the soundscape so the sound follows the strokes that are really on screen; `isRevealPlaying()` and `isExitPlaying()`, which `frameLogic.js` reads to decide when the world's clocks stop and when a wake is allowed.
- **Inside:** `ArtPass` runs the frame order and owns the params; `ArtPrepass`, `ArtStrokes` and `ArtHold` each own their render targets and the programs that fill them. `RevealDirector` only returns numbers; `ArtPass` copies them into the shared uniforms. Every program's uniforms are mounted from what its own shader declares, so a name that is in no pool, or in two, fails at construction.

#### Parameters

Every control is a row in `artPassParams.js`, and its `invalidates` class says what a change redoes: `thaw` (strokes and live frame), `compose` (prepasses and ground pass: ground colours, weave, weather colours; the strokes stand), nothing (the exit sliders and the finish-only rows), `lut` (the pigment table) or `resize`. The groups are the lattice (cell size, jitter, second sitting), colour (spread, palette, ground), stroke shape and surface, the reveal (durations, order, even pace) and the exit (duration, threshold, softness, final sweep).

---

### 4.9 `interaction/` — how still is the room

`interaction` turns the microphone into one number, attention between 0 and 1,
that `dynamics` uses to speed the landscape up or settle it. It measures how
still and quiet the room is, not how many people stand in it. With no
microphone (denied, not yet enabled) its own reading is a neutral 0.5, but the
panel then feeds `dynamics` the manual attention slider (1 by default) instead,
so the piece stays a painting.

| File | Role |
|---|---|
| `interaction.js` | The sensor: builds the audio chain, runs one analysis step per window and reports restlessness and attention. |
| `interactionMath.js` | The pure formulas: level, flux, the leak model, the easing and the restlessness-to-attention curve. |
| `interactionParams.js` | The seven mic sliders. |
| `micProbe.js`, `micProbeMath.js` | A console measuring tool, `__d.micProbe.run()`: it walks a person through recordings and fits the speaker-leak model. |

**Terms.**

| Term | Meaning |
|---|---|
| flux | How much the sound's spectrum rose since the last window, averaged over the 100–4000 Hz bins (voice, footsteps). A steady sound has almost none. |
| level | The microphone's loudness (RMS) in decibels. |
| leak | The installation's own sound reaching its microphone. |
| restlessness | The room's activity, 0 to 1, eased toward its target. |

**One analysis step** (every 2048 samples, about 46 ms; a timer of its own, not
the render loop, so a slow frame does not leave audio unread):

1. Read the loudness (level) and the spectrum, as byte data: WebKit's float
   analyser reads return zeros on a correctly wired graph, and the byte reads
   are precise enough for relative change.
2. Take the flux, scaled and corrected for the piece's own sound (below).
3. Restlessness eases (2 s) toward the larger of flux × 200 and the level excess
   over a 25 dB span.

```
attention = 1 - restlessness ^ 1.6
```

**Why the piece's own sound is not read as people.** The speakers share the room
with the microphone. Left alone, the wind, waves and birds would raise the
level, an empty room would read as busy, and the landscape would never settle.
Worse, it would be a loop: the sound follows the landscape and the landscape
follows the sound. The piece always plays, so the analysis has to run while its
sound runs. Three measures break the loop:

- **Flux is the main signal, not loudness.** Flux only counts how much the
  spectrum rose between two windows. The piece's sound is steady apart from
  slow filter sweeps, so it adds little; a voice, a step or a clap adds a lot.
  The level term stays as the second input, so a loud but steady room (a fan)
  still counts.
- **The leak is predicted and subtracted.** The installation knows its own
  output level. Measured on the development machine, the microphone's loudness
  follows the output as `1.8 × output + the quiet room` (r² 0.96). The
  prediction uses the output from 50 ms ago, the trip through the air. The level
  term counts only the decibels above the prediction, so an empty room reads
  about 0 dB excess.
- **Flux is scaled by what the prediction cannot explain.** That share is
  `1 − predicted / measured`: 0 when the microphone hears only leak, towards 1
  when something far louder than the leak is present. This matters because the
  piece's own movement makes up most of the raw flux (about 0.04 against 0.001 in
  a silent room).

What gets through: a sound much louder than the leak (a clap) passes at full
strength. What can hide: a very quiet voice under loud speakers. The leak gain
(1.8) and the quiet floor were measured on one machine, so both are sliders, and
"calibrate empty room" re-measures the floor with the piece playing. The 50 ms
delay is a physical estimate; the probe could only bound it to one frame.

**Connections.** `main.js` hands it the audio output level. The start click turns
the microphone on through the panel's toggle; `controls.attention()` returns its
attention (or the manual slider when the microphone is off), and `main.js` passes
that to `dynamics.update`. Disabling stops the track, so the operating system's
microphone indicator goes off.

---

### 4.10 `audio/` — the landscape heard

`audio` is the sound of the piece, and none of it is recorded. Wind, trees, surf
and birds are built live out of filtered noise and a few oscillators, and their
loudness, brightness and rhythm follow what the scene is doing. A fifth layer,
the paint, scores the painting arriving and coming apart. No layer repeats on a
fixed schedule, except that the surf's swell timing comes round about every
minute of water time.

| File | Role |
|---|---|
| `audio.js` | The orchestrator: owns the audio context, receives the scene state every frame, hands each voice its drive, and moves the world away while a painting is up. Also the Sound tab's solo, test buttons, meter and event log. |
| `audioNoise.js` | The raw material, built once at start: pink-noise beds and the reverb impulse. |
| `audioGraph.js` | The fixed node graph: buses, the distance stage, the reverb and the paint path. |
| `audioVoices.js` | The four natural voices: wind, trees, surf, birds. |
| `audioPaint.js` | The paint voice. |
| `audioMath.js` | The pure arithmetic: the random walks, the scene-to-sound maps, the distance cues. |
| `audioParams.js` | The 17 Sound-tab rows. |

**Terms.**

| Term | Meaning |
|---|---|
| pink noise | Noise whose energy falls 3 dB per octave: the natural hiss of wind, water and leaves. |
| bed | A looping buffer of pink noise that a voice filters into its sound. |
| walk | A random value pulled back toward a centre (an Ornstein–Uhlenbeck walk), which is what natural gusting looks like. A few slow sine waves would instead settle into a regular wobble. |
| one-shot | A short sound created on its own: a bird call, a wave break, a brush stroke, a crack. |

### How the sounds are made

**The raw material.** Everything starts as three pink-noise beds of about 28
seconds, made once. They are independent of each other (the same buffer played
at two speeds would comb when summed), and each loop's tail is crossfaded into
its head so the seam does not click. Wind, trees and the paint draw on the first
bed at random offsets, the surf on the second and the birds on the third. A voice never plays a bed on its own, because mono noise
sounds like a speaker, not like outdoors. It plays it as a *stereo bed*: two
reads of the same buffer half a buffer apart, panned hard left and right. The
two are uncorrelated, which is what a natural diffuse field does at the two
ears. The reverb is a synthetic 1.4 s impulse of decaying noise that darkens as
it decays, with independent channels.

**The graph has two paths.** The four natural voices share one acoustic, so they
can be pushed away together; the paint joins after it.

```text
   wind   trees   surf   birds                     paint
     │      │       │      │                         │
     └──────┴───┬───┴──────┘                         │
                ▼                                    ▼
           world bus ───► world send ──┐         paint bus
                │                      ▼             │
                │                   reverb           │
                │                      │             │
                ▼                      │             │
        distance lowpass ◄─────────────┘             │
                │                                    │
                ▼                                    │
             dry gain                                │
                └───────────────┬────────────────────┘
                                ▼
                             master
```

Surf breaks and bird calls also send straight into the reverb. The reverb's
return re-enters at the distance lowpass, so its tail is darkened and faded
along with the dry world. The paint bus never touches the reverb; it adds two
early reflections (11 and 19 ms) to the master, a small hard room, so the
picture sounds close.

**Wind.** A stereo pink bed through a rumble cut at 130 Hz, a lowpass whose
cutoff slides between 650 Hz and 4.2 kHz, a mid resonance and a high shelf. One
gust walk drives the loudness, the lowpass cutoff and the shelf together,
because real gusts get louder and brighter at once; driven separately it sounds
like a volume knob on a hiss. A second, broad band between 260 Hz and 1.7 kHz
slides on its own walk, independent of the gust, and is the cue for air tearing past an edge. The
band is broad on purpose: a narrow one whistles.

**Trees.** The same kind of bed, filtered to the leaf band: a highpass between
about 0.7 and 1.25 kHz (lower with more forest, about 1.1 kHz at a typical
wooded frame) and a fixed lowpass at 9 kHz. The cue that makes it leaves instead
of a fan is the flutter: a fast amplitude flicker made by low-passing noise with
a cutoff that rises from 7 to 13 Hz with the gust, and feeding it straight into
the gain at audio rate. A slower walk adds the 0.2–2 Hz breathing of
a canopy. The trees follow the wind's gust, delayed: the level follows it up
quickly (about 0.4 s) and down slowly (a 1.95 s time constant), because leaves
keep moving after the air stops.

**Surf.** Two noise bands, because water is two sounds: a low body (cutoff 420 Hz
to 1.3 kHz) and a bright foam (2.4 kHz to 1.1 kHz) that surges much harder.
Each band is amplitude-modulated by two slow oscillators, so it breathes without
a regular pulse. The swell they follow is not a clock of the sound's own: it is
the same three sines the water shader uses for its waves, evaluated on the
water's own clock. So the surf keeps the foam's tempo: its swell rises and
falls with the swell on screen. Only the timing is shared: the sound does not
know where the shoreline is. Two triggers on that swell create one-shots: a high one gives the
loud breaks (about 8 a minute of water time on a clear sea), and a low one that
re-arms only after a deep trough gives the rarer quiet arrivals (about 3). A one-shot is one
bandpass filter whose centre rises and then falls, which is a wave approaching,
cresting and receding.

**Birds.** A cast of six individuals, redrawn slowly (each stays 35–110 s). Each
has a fixed base pitch between 1.4 and 3.8 kHz (its calls sweep up to about twice
that), a call motif (two-note, rising ask,
chatter, trill or scold), a pan position, a distance and a throat resonance.
Because they persist, you hear animals, not random notes. Calls arrive as a
random process whose rate comes from the scene. A syllable is a sine whose pitch
follows a curve, a second sine just over an octave above it that grows
through the syllable, a tiny vibrato, and a few milliseconds of filtered noise
at the start that arrives just before the tone. Farther birds are quieter,
duller and get more reverb.

**Paint.** It plays only while the picture is being made or taken apart,
following the art pass's own progress. *Priming*: one long dry sweep of noise
as the canvas is toned. *Marks*: brush grains, which are broad noise bursts of
60–250 ms rather than clicks, clustered into strokes that share a drifting
centre frequency, with a canvas-weave rasp underneath; the grain rate climbs from
4 to 50 per second, and during the opening blocking-in beat the marks are
sparser and darker. *Relief*: a quiet low body once the paint has depth.
*Dissolve*: about 70 cracks over a whole exit, more of them early, paced by the
share of strokes that have left; each is a
wideband snap, two or three small fixed-pitch fractures, a scrape and sometimes
a falling flake.

### How the scene shapes the sound

Every frame `main.js` hands `audio` a small set of values; none of them is a
sound. Each voice turns them into drives, and the rule is that each quantity
moves one thing.

| Scene value | What it does |
|---|---|
| mountains dial | The wind's standing level: more exposed ground, more wind. Also how hard the weather bites. |
| snowline dial | A cold, low snowline brightens the top of the wind a little. |
| overcast (the shaped one, as the picture sees it) | Wind: moves the gust walk's *centre* up, so a grey sky blows harder, and sharpens the mids. Surf: raises "chop", so the sea breaks more, foams more and breathes faster, but is not louder. Birds: individual birds go quiet one by one as the sky greys (each has its own threshold); the last one holds on. |
| ocean dial | How much water you hear; exactly 0 with no sea, so there is no roar without water. |
| forest cover | The bird call rate and how full and loud the canopy is. A proxy, not a measurement: the share of the terrain's height range between the sea and the tree or snow line, assuming heights are spread evenly. |
| terrain pace (how fast the land is reshaping) | The wind's unsteadiness: how often gusts come, and how hard a gust hits (35% to 100%). The weather, not the pace, sets the centre the wind returns to. |
| wave pace (the water and cloud speed) | Part of the chance that a swell crossing becomes a break (the larger of wave pace and chop counts). |
| restlessness | Thins the birds as the scene settles. |
| water clock | The surf's swell, shared with the shader. |
| haze | Pushes the world away a little, like a painting does. |
| painting progress | Moves the whole world away (below) and drives the paint layer. |

The default level sliders put the surf highest (1.3), then the wind (0.7); the
trees and birds sit far back (0.1 each), and birds call about once every five
seconds at a typical wooded frame. The paint's slider is the highest (1.5), but it
only plays during a reveal or exit.

The two paces are kept apart, not averaged: the land can be racing while the
sea is glassy, and added together the two would cancel. They are combined only
for the overall level, as the louder of the two (so a still sea under a racing
sky is not a quiet scene): the three continuous voices play between 45% and 100%
of their level, and everything else about them is per voice.

**The world steps back when a painting is up.** The distance amount is `0.6 ×
how fully the picture is up + 0.35 × haze`, capped at 1. At the default, a full
painting moves it to 0.6. That one amount moves three things together, because
that is what distance does in air: the lowpass cutoff falls from 18 kHz toward
760 Hz (about 2.7 kHz at 0.6), the dry gain falls along a quarter cosine (0.59 at 0.6) while the reverb send
rises from 0.03 toward 0.53 (0.43 at 0.6). The paint
bypasses all of it, which is the contrast the layer exists for: the picture
arrives close and dry while the landscape it depicts goes distant. An optional
"room" setting also drains the world's dry level to about 5%; the reverb tails
of the surf and birds remain.

While a painting is up the land is not reshaping, so the wind sits near its
floor and the birds are silent. The world is muffled and distant, and once the
painting has finished forming the paint sounds stop too, leaving near silence.

---

### 4.11 `main.js` — the composition root

`main.js` is the one file that knows every module. It creates them, hands each
what it needs, connects the few pairs that no module may know about each other,
and runs the frame loop. It holds no algorithm of its own: if a rule is about
one subsystem, it lives in that subsystem, and `main.js` only calls it.

**Terms.** *Composition root*: the single place objects are built and connected,
so the modules themselves import only their own folder and `shared/`. *World
holding still*: nothing moves and nothing was touched this frame (paused or
frozen, camera unmoved, no panel control changed). *Dirty*: a panel control or a
test touched something since the last frame.

**Boot, in order.**
1. A WebGL renderer as large as the window, and a camera whose shape follows it.
   The picture was composed at 16:9, so the camera never shows less than that:
   a wider window adds ground and sky at the sides, a taller one widens the
   vertical field of view so the 16:9 width stays in view (`fovFor`). The cloud
   window, the water mirror and the light shafts read the camera's aspect, so
   only `main.js` knows the window shape.
2. The scene-wide uniform set (fog, light level, cloud shadows), then terrain,
   water, clouds, sky, audio, the art pass with its G-buffer, godrays and the
   composer. Terrain, water, godrays and the art pass all receive that one
   set, so one write reaches all of them.
3. The weather's write path, the form dials, then the debug panel. The panel
   comes before the weather and the form walker because they need its
   `controls`; it binds their sliders once they exist.
4. The weather and the form walker, the snapshot's module list, and the
   `window.__d` handle that tests use. The weather is built first because the
   walker's cloud channels read the weather's spread and rate while seeding.
5. The start screen: the opening painting under a light veil, with a placard
   (the title, two lines on how the piece reacts, why the browser will ask for
   the microphone) and two buttons, *Begin* and *Begin in fullscreen*. Web
   Audio and the microphone may only start from a user gesture, so the click
   switches both on; the veil then fades. The control bar shows only while the
   pointer is near the bottom edge or the debug panel is open. If the
   microphone is refused, attention comes from the control bar's slider
   instead (1 by default, above the settling threshold), so the opening
   painting stays until someone lowers it.

**Couplings made here** (neither side knows the other):
- Dynamics' freeze starts the art pass's entrance, its unfreeze starts the exit.
- One horizon-colour setter fans out to sky, fog, scene uniforms and clouds. The
  art pass is left out on purpose: its ground colour is authored, and the
  weather drives it separately.
- The speakers' output level goes to the microphone, so it can tell its own
  sound from the room.
- When the exit's last frame has gone, the world is woken to full restlessness.

**The frame.** `frame(dt)` does nothing at all while paused with nothing
touched, the fly camera off and no reveal or exit playing. Otherwise it runs named steps in the order of section 3.2. Three decisions sit in `main.js` itself:
- *World holding still* gates the pre-passes, the art pass's G-buffer, the cloud
  volume and godrays. Their inputs are frozen, so re-running them would only
  reproduce what their targets hold.
- Values that two modules depend on are pushed every frame, not on change:
  the sea level to the terrain, the terrain's height range to the water, the
  cloud shadow frame into the scene uniforms. A push on change would go stale
  whichever control moved the value.
- Audio is fed from the frame, not from a dynamics event, because dynamics stops
  ticking while the scene is frozen, which is when the painting animation plays
  and the sound has the most to do. The call is wrapped, so a sound fault is
  logged once and never stops a frame from drawing.

**Connections.** In: every module's public surface (`params`, getters). Out: the
returned `controls` of the panel, which main reads for pause, speed and
attention. Events: it subscribes to dynamics' `freeze` and `unfreeze` only.

## 5. `dynamics/` — from attention to painting

`dynamics` is the piece's state machine. It takes one number, how still the
room is, and decides how fast the landscape changes and when it settles into a
painting or wakes up again. Every animated part of the piece listens to it.

### Files

| File | Role |
|---|---|
| `dynamics.js` | The state machine: attention in; a pace of change, a countdown to the painting and the `tick`, `freeze` and `unfreeze` events out. |
| `animSpeed.js` | A second, separate pace for water ripples and cloud drift. |
| `dynamicsParams.js` | The slider rows of both. |

### Terms

| Term | Meaning |
|---|---|
| attention | How still and quiet the room is, from the microphone or a slider, 0 to 1. 1 = very still. |
| momentum | How quickly the landscape is changing right now. Follows `1 − attention` smoothly, so a restless room means fast change. |
| noise time | The landscape's clock. Advances by `2.5 × momentum` per second. |
| restlessness | A countdown to the painting: 1 = living, 0 = painting. |
| threshold | Attention 0.9: above it the room is calm enough to settle; below it the painting wakes. |

### The cycle, starting from the painting

```text
 ┌────────────────────────────┐
 │       STILL PAINTING       │
 │     frame held, brush      │
 │       strokes on top       │
 └────────────────────────────┘
     │                    ▲
     │ room gets          │ room stays calm
     │ restless           │ (attention > 0.9)
     │ (attention < 0.9)  │ until restlessness
     │                    │ reaches 0, about
     ▼                    │ 15 s
 ┌────────────────────────────┐
 │      LIVING LANDSCAPE      │
 │   terrain, water, clouds   │
 │      and weather move      │
 └────────────────────────────┘
```

1. **Still painting.** Restlessness is 0. Nothing moves, the frame is held, the
   brush strokes sit on top, and `dynamics` sends no ticks.
2. **The room gets restless** (attention drops below 0.9). The painting wakes:
   restlessness jumps back to 1, momentum starts from 0, ticks resume and the
   art pass dissolves the strokes.
3. **The landscape comes alive.** Momentum eases toward `1 − attention`, so the
   noise clock runs faster in a restless room. Terrain, water, clouds and
   weather all follow that clock or the ticks.
4. **The room calms** (attention rises above 0.9). Restlessness starts to fall,
   but only as fast as the landscape has calmed down: while momentum is still
   high the countdown runs slowly, at most `1/15` per second. If the room stirs
   again before it reaches 0, it climbs back toward 1, so a short lull does not
   freeze the scene.
5. **The landscape settles.** In the last tenth of restlessness the published
   momentum is scaled down in proportion, so motion fades out and stops
   exactly as the freeze lands, with no snap.
6. **Freeze and paint: the point of no return.** Restlessness reaches 0. Ticks
   stop, `freeze` fires, and the art pass paints the brush strokes over the held
   frame. The world has to be frozen first because the strokes are painted from
   that one held frame. From here the painting is painted to the end: attention is not even
   read until it is complete, so a room that turns restless during the reveal
   changes nothing. Once the painting is finished, a restless room wakes the
   landscape at once. Back to step 1.

### The algorithm, per frame

- **Momentum:** `target = 1 − attention` (capped at 0.95),
  `momentum += (target − momentum) × (1 − e^(−dt/τ))` with `τ = 8 s`. This is
  exponential smoothing in its exact form, so the ease is the same at 60 fps
  and at 5 fps.
- **Noise time:** `t += 2.5 × momentum × dt`. The terrain's height is 3-D
  simplex noise sampled at `(x·f, z·f, t)`, so advancing `t` morphs the
  landscape in place rather than scrolling it. Because `t` is *integrated*
  from the current speed, changing the speed never makes the landscape jump.
- **Restlessness:** while attention is above the threshold it falls by
  `(1 − momentum) / 15` per second, so the landscape must have calmed before it
  can settle. Otherwise it rises by `1/15` per second.
- **Freeze:** restlessness 0 → momentum and speed 0, `freeze` event.
- **Point of no return:** while the reveal plays, the frame loop skips the
  attention poll (`shouldAdvanceDynamics`). Dynamics is frozen throughout, so
  nothing else is lost; the first frame after the reveal polls again.

### `animSpeed`: pace of water and clouds

Momentum sets how fast the terrain reshapes. Water ripples and cloud drift use
their own pace, `speed = 0.6 × restlessness`, so they slow with the countdown
and stop exactly at the freeze. While a painting is up the pace is 0. When the
painting dissolves, the pace eases back up over a few seconds instead of
jumping. A grey sky speeds waves and clouds up a little
(`× (1 + gain × overcast)`, gains 0.25 and 0.65).

### Connections

- **In:** attention, handed over by `main.js` each frame (the microphone in mic
  mode, a slider otherwise). `dynamics` never imports `interaction`.
- **Out:** `tick` to the terrain and water drivers, the form walker, the weather
  and the panel readouts. `freeze` and `unfreeze` go only to `main.js`, which
  starts the art pass's reveal or exit.
- While frozen there are no ticks, so everything that follows ticks stops with
  the scene, including the weather. Audio is pushed by `main.js` instead and
  keeps playing under the painting.

### Parameters

| Slider | Default | Effect |
|---|---|---|
| attention inertia (`τ`) | 8 s | How slowly momentum follows attention. |
| decay pace at max attention | 15 s | How long a full settle takes in a perfectly still room. |
| resume threshold | 0.9 | The attention level that separates settling from waking. |
| wave/cloud speed | 0.6 | Water and cloud pace at full restlessness. |
| weather gains | 0.25 / 0.65 | How much a grey sky speeds up waves / clouds. |

### Tests

`dynamics.test.js` checks the cycle (freeze, unfreeze, the `tick` payload),
momentum direction and frame-rate independence. `animSpeed.test.js` checks the
pace, hold and resume. Both are plain unit tests with no GPU.

---

## 6. Testing and quality

*Goal.* A generative piece can break in ways nobody sees until the frame is
wrong: a shader that fails to compile blanks the scene, a uniform left out of
the snapshot silently stops restoring, a slider with no tooltip ships unexplained.
The tests are built to catch those mechanical failures. They do not judge whether
the piece is beautiful.

#### Three layers, by what each can reach

- **Unit tests** (vitest, Node, no GPU, about 1150 cases in 61 files, a few
  seconds). They cover everything that is plain JavaScript: the `*Math.js`
  helpers, the state machines (`dynamics`, the art pass's reveal director), the
  parameter system and the scene snapshot. Logic that is mixed with graphics or
  the DOM is first split so its pure core can be tested here.
- **Signal tests** (Playwright with a float render target, 5 files). A shader
  cannot be called from Node, so the page is booted headless, a known surface
  such as a tilted plane or a paraboloid replaces the height map, one value
  (normal, flatness, concavity, biome, shading) is drawn into a float texture
  and read back exactly. The expected value comes from the surface's own
  mathematics (a plane tilted by `a` has a normal that follows from `a`), never
  from a copy of the shader's formula, since a copy changes whenever the shader
  does and then tests nothing.
- **Browser specs** (Playwright, over 30 files, a few minutes). They start the
  real piece and check behaviour: it loads without WebGL errors, the frame is
  neither blank nor a flat colour, the art pass reveals and exits, the weather
  gates the light shafts, a snapshot restores the scene exactly. They read the
  page through `window.__d`, the handle `main.js` exposes with every module.

The frame-time budget is a separate spec that runs alone on one worker, because
it measures the machine and would fail whenever other tests load the GPU.

#### Completeness tests: the build fails when something is forgotten

Several tests exist to stop one specific omission, and this is the main design
idea of the suite:
- Every uniform of terrain, water, clouds, godrays and the art pass must be
  classified (a row, derived, integrated, per-frame or constant). A new uniform
  without a class fails, which is what keeps it from dropping out of snapshots.
- Every module listed for snapshots must actually be captured and restored, and
  an unknown key in a snapshot is reported, not ignored.
- Inside one owner, a uniform name is one shared object in every shader program.
  Programs and their includes may not declare one name twice (a duplicate stops
  the whole terrain rendering).
- Every panel row appears in the layout exactly once, every layout entry names a
  row, and every control has a tooltip and every tooltip matches a control.
- Names that an owner removed must not reappear in the source.

#### What makes a test last

- **Assert what survives tuning:** an exact analytic value, a property (the
  concavity does not depend on the sample radius), an ordering (a basin is more
  hollow than flat ground, which is more hollow than a dome), or an invariant
  (moisture stays in 0 to 1). No pixel snapshots and no tuned thresholds, so
  retuning a colour or constant does not turn the suite red.
- **Pin every input and vary one:** the probe fixes sun, noise time, sea level
  and the pause before reading, then changes a single thing.
- **Never depend on machine speed:** tests wait for a number of frames or for a
  state, never a fixed sleep. A rate is measured with a fake clock that gives
  every frame an exact step, and the art pass's reveal clock can be injected to
  look at "40% in". Whether a pass ran is checked by counting its draw calls,
  not its time.
- **Check that a test can fail:** a test written for one regression is run once
  against the broken code to see it go red. For example, shrinking a stroke's
  reach by 60% makes the art pass's incremental-redraw test fail.

#### Limits

The suite cannot say whether the painting looks good, whether a palette or a
frequency is well chosen, or catch a mistake in the generative maths that still
looks plausible. Those stay with the author. Continuous integration runs the
unit tests, the build, the browser specs and, as an advisory step, the frame-time
spec.

## 7. Key decisions

| Decision | Choice | Why | Section |
|---|---|---|---|
| Terrain detail | A height map computed on the GPU, read by one mesh that is dense near the camera | WebGL 2 has no tessellation stage; each vertex costs two texture reads (height and derive map) | 4.7 |
| Rock and soil | Two height fields from one set of octaves, the higher one wins | The soil line follows the landform; no mask to author | 4.7 |
| Gullies | An erosion filter, not a flow simulation | Runs per texel every frame, with no state to carry | 4.7 |
| Trees | Crowns drawn per pixel on a lattice, one verdict per site | No geometry; a tree is whole or absent, never cut by a biome border | 4.7 |
| Clouds | A baked, rolling 3-D volume; the octaves too fine for the grid are added in the march | The cost is paid when the window moves, not on every pixel | 4.6 |
| Reflection | A second render from a mirrored camera, clipped at the water | A sky tint cannot show the mountains | 4.5 |
| Painting | Strokes on a canvas lattice; colour `C + k × (pigment − mean)` | Still strokes over a moving scene; the average is the true colour | 4.8 |
| Attention | Microphone spectral flux and level, each with the piece's predicted own sound taken out | Stillness, not a head count, is what the piece measures | 4.9 |
| State | A restlessness countdown; the landscape clock integrated from momentum | Brief lulls do nothing, and speed changes never make the land jump | 5 |
| Sound | Synthesis only; the surf runs on the water's clock | Nothing repeats, and a break is heard when the foam is seen | 4.10 |
| Code shape | Subsystems never import each other; one row per value | Each module can be read, tested and replaced alone | 2.3, 3.4 |
