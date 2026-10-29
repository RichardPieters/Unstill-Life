# Tests — layout, principles, and how to add one

Reference for this repo's tests: layout, how to run them, the principles they
follow, and how to add one. Several obvious approaches (pixel snapshots,
re-implementing a shader formula as ground truth) are ruled out below, each
with its reason.

---

## Layout

- **`tests/unit/`** — Vitest, pure JS, no GPU. About 60 files, named after the module they cover (dynamics, terrainMath, artPass, audioMath, …).
  - Completeness guards, which fail when something is forgotten:
    - `uniformClasses` — every uniform of every owner is classified for snapshots
    - `uniformSharing` — one uniform name is one shared object inside an owner
    - `shaderUniforms` — the composed GLSL declares each uniform once
    - `shaderMount` — a program's uniforms are mounted from its own source
    - `paramRows` — every param row is valid and has a tooltip, its uniform is declared in a shader, and a built owner holds its row defaults
    - `panelLayout` — every control is placed once, every placement names a row
    - `sceneSnapshot` — every listed module is captured and restored
    - `snapshotFormat` — integrated uniforms round-trip
  - `sourceScan.js`, `paramTestHelpers.js` — shared helpers, not tests
- **`tests/signals/`** — Playwright, one GLSL value read back as floats vs analytic truth.
  - `signalRegistry.js` — one row per signal under test (the index)
  - `fixtures.js` — analytic surfaces and their independent ground truth
  - `probe.js` — harness that pins the state, applies the fixture and reads the float RT back
  - `geometric`, `curvature`, `classify`, `shading`, `invariant` `.spec.js`
- **`tests/visual/`** — Playwright, the real piece, headless, read through `window.__d`.
  - `helpers.js` — boot, waitFrames, liveBaseline, reveal clock, pixel stats
  - one spec per behaviour, e.g. art_pass*, atmosphere, boot_state, clouds and godrays, scene_snapshot, static_scene_gating, tooltips, driven_registry, …
- **`tests/performance/`** — `frametime.spec.js`, the frame-time budget, run alone
- **`tests/tools/`** — standalone scripts, not run by any gate

## Pipeline

Two runners, split by capability. Vitest owns `*.test.js`; Playwright owns
`*.spec.js` (config builds + `vite preview` on :4173 first, ANGLE WebGL flags).
New `*.spec.js` anywhere under `tests/` is picked up automatically.

```sh
npm test               # vitest run — unit only, fast, no browser
npm run test:visual    # playwright test — signals + visual
npm run test:all       # both
npm run test:perf      # frame-time benchmark, alone, 1 worker
```

Run a subset: `npx playwright test tests/signals/`.
Before reporting any change done: `npm test` **and** `npm run test:visual`.

---

## Three layers (the pyramid, by what each can reach)

| Layer | Reaches | Use it when |
|---|---|---|
| **unit** (vitest) | pure JS extracted from a module | the logic is analytically checkable and side-effect-free (tick math, state machines). Extract the pure core, test that. |
| **signals** (playwright + float RT) | a per-fragment/vertex GLSL value | you add or change a shader-computed signal (normal, concavity, classification, shading). This is the only layer that reaches inside the shader. |
| **visual** (playwright + screenshot) | the composited frame | you need "it renders / it isn't blank / it reacts", not a specific value. |

Prefer the lowest layer that can see what you changed. A shader signal can't be
unit-tested (it's on the GPU) → signals layer. A pure helper shouldn't need a
browser → extract it and unit-test it.

---

## Design principles (load-bearing — do not skip)

1. **Ground truth is INDEPENDENT math, never a mirror.** The expected value
   comes from the analytic math of the fixture surface (a tilted plane's normal
   *is* `normalize(-ax, 1, -az)`), stated directly in `fixtures.js`. NEVER
   re-implement the signal's own shader formula in the test — a re-implementation
   drifts in lockstep with the shader and tests nothing. If you can't predict a
   value independently (normalized concavity, composite moisture), you MUST NOT
   assert its value — use a property/ordering/invariant instead (below).

2. **Non-ossifying assertions.** The artist retunes constants constantly. A test
   that pins a threshold or a pixel value goes red on every legitimate tweak and
   gets deleted. Assert things that survive tuning:
   - **exact** — an analytic value the math fixes (plane normal). Tight eps.
   - **near-exact** — analytic value with a bounded numerical residue (height:
     `eps = 0.12·|∇h|·texel + floatFloor`). Slope-scaled eps.
   - **property** — a relation that must hold regardless of tuning
     (concaveSmall is radius-independent; sweep the radius, value unchanged).
   - **ordering** — a rank/sign (basin > flat > dome; steep → rock; ≥4 tonal
     buckets). No absolute number.
   - **invariant** — range + monotonic response to a swept control (moisture in
     [0,1], rises with basin-ness).
   A visual-regression screenshot baseline was explicitly REJECTED for this
   reason — it fails on every hand-tune. Don't reintroduce it.

3. **Control variables — pin the full state.** A signal's value is only ground
   truth if every input is pinned. `probe.js` takes the slider surface at its row defaults (`terrainParams.js`)
   and pins an explicit list on top (sun azimuth/elevation, `uBandNoiseAmt=0`,
   `uEnableTimeAxis=false`, sea level, `uHeightMax`, freeze, pause). Vary ONE
   thing per test (the fixture, or one swept
   control); hold the rest. Adding a new terrain uniform that a signal reads?
   Pin it in the probe.

4. **Fixtures exercise the REAL path.** `terrain.setFixtureHeightfield(fn)`
   injects an analytic height map into the actual data-map slot and still runs
   the derive pass, so the real vertex-normal / ring-mean code runs on known
   input — not a stand-in. It only writes the R (height) channel; the erosion
   channels (G/B) are zero, so **erosion-fed signals (ridge/delta) cannot be
   fixture-tested** — they need the live pipeline (deferred).

5. **Float RT, not screenshot decode, for signal values.** Signal tests read raw
   floats from a `FloatType` RT (`uProbeRaw` makes debug views emit the raw
   value, not the display ramp). RGBA8's 1/255 quantization would void the tight
   eps — the geometric spec asserts float-RT support as a precondition and skips
   rather than silently degrading. (The *visual* layer still uses screenshot
   decode — never `drawImage` the WebGL canvas, it's blank without
   `preserveDrawingBuffer`.)

6. **Prove a test has teeth.** For a test guarding a specific regression, confirm
   it actually fails when that regression is present (mutate the shader, watch it
   go red, revert). A green test that can't go red is worse than none.

---

## HOWTO: add a signal test (a new GLSL signal / debug view)

1. **Expose it as a debug view** in `terrain.frag` if it isn't one: add a branch
   that sets `rawProbe` (the raw value; `vec3(scalar)` or the signed vec) and a
   display ramp. The probe reads `rawProbe` via `uProbeRaw`.
2. **Add a registry row** in `signalRegistry.js`:
   `{ id, debugViewId, scalar, tier }`.
3. **Pick the tier** (principle 2). Can you predict the value from fixture math
   without copying the shader? → `exact`/`near-exact`. Otherwise → `property` /
   `ordering` / `invariant`.
4. **Add ground truth** in `fixtures.js` — a pure analytic fn of the fixture, or
   a new fixture surface if needed (add its height formula to the `heightAt`
   switch in `probe.js` too).
5. **Write the spec** — `probeGrid(page, { fixture, debugViewId, controls })`
   returns `{ samples: [{x, z, v:[…]}] }`. Assert per the tier. Pin every input
   the signal reads via `controls` (principle 3).
6. Run `npx playwright test tests/signals/` and, if it guards a regression,
   mutation-check it (principle 6).

## HOWTO: add a unit test (new pure logic)

1. If the logic lives inside a class with THREE/DOM/wall-clock deps, **extract
   the pure part** to a side-effect-free helper (see `terrainMath.js`) taking
   explicit scalars. That's the precondition for unit-testing it.
2. Add cases to the matching `tests/unit/*.test.js`. Prefer property/behaviour
   assertions over snapshotting numbers.
3. `npm test`.

## HOWTO: add a fixture surface

Add the height formula to the `heightAt` switch in `probe.js` (page-side, one
place) AND a constructor + any analytic ground truth in `fixtures.js`. Keep the
formula self-contained. Existing: `plane`, `paraboloid`, `saddle`, `gaussian`.

---

## Which change needs which test

The binding table is `docs/process/agent_rules.md`, "Tests are part of done": a test lands in the
same commit as the change it covers.

---

## Strategy: what each kind of test is for

The project has two zones with different strategies, and the tests enforce both.

**Pure logic gets ordinary TDD.** `dynamics`, the `*Math.js` helpers and the other extracted cores are side-effect-free, so they are unit-tested in Node. Extract the pure part of anything that mixes in THREE, the DOM or wall-clock time, then test that.

**Shaders do not throw when they are wrong; they produce the wrong pixels.** So they are tested in a headless browser, at two levels: a fast structural check (the frame is not black, not solid, not blown out, the console has no WebGL error) and the signal layer above, which reads raw values out of a float render target.

**Frame time is advisory.** `performance/frametime.spec.js` measures the frame time in the browser, so it runs on its own (`npm run test:perf`, one worker): it measures the machine, and would fail whenever the gate loads the GPU. It logs the average and warns above the 16.67 ms budget; it fails only above 100 ms.

**No test may depend on how fast the machine is.** The gate runs in parallel, and every worker renders at once, so a frame can take several times longer than it does alone. A spec that sleeps a fixed number of milliseconds and then asserts what "should" have happened by then is a flake waiting for a busy machine. Instead:
- **Waiting for a render?** `waitFrames(page, n)` (helpers.js) — waits for n real frames, however long they take.
- **Waiting for a state?** Loop on the state itself (`waitForFunction`, or an in-page `while (!cond) await rAF`), with a cap only as a safety net.
- **Measuring something AT a point in time** (a reveal 40% in)? The art pass's reveal clock is injectable: `useRevealClock` + `advanceReveal(page, ms)`.
- **Measuring a RATE** (drift per second)? `boot(page, { fakeClock: true })` + `page.clock.runFor(ms)` — every frame gets an exact dt.
- Read pixels back in the same task that rendered them (`readRenderTargetPixels`) when comparing two renders; a canvas screenshot captures whatever the loop presented last.
The global timeout is 120 s for the same reason: it only bounds a hung test, never a slow one.

### Rules for testing the art without ossifying it

A test goes stale when it pins a value that the artist is allowed to retune. In addition to the principles above:

1. Never assert appearance: no hex values, no thresholds, no fixed screen pixel.
2. Read the quantity, not the look. Data debug views emit the measurement itself (material id, height, shade factor in the R channel), not a styled colour.
3. Assert aggregates, not points. Sample a grid, reduce it to population statistics, and assert orderings, modes or relations with a margin.
4. Compare relations at the same fragment, e.g. a material's shadow against its own lit colour, so a retune moves both sides together.
5. Kill dynamism: pause and fix the noise time for a deterministic frame, and where it matters advance the drift, read back again and require the invariant at every phase, so the result is structural and not a lucky frame.
6. Dodge boundaries: aggregates downweight seams and drop mismatches next to material borders, so the test covers belts, not edges.
7. Screenshot snapshots are advisory at most, never a gate (see principle 2).

### What the tests cannot do

Assert that the piece is beautiful, validate artistic parameter choices (palette, frequencies, decay curves), or catch semantic mistakes in the generative math that still look plausible. The tests catch mechanical and structural regressions; creative judgment stays with the author.
