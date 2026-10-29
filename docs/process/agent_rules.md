# Agent rules

The rules the AI coding agent (Claude Code) followed while developing this
repository. They set the conventions, the workflow and the checks every change
had to pass before it counted as done.

## What this is

A browser-based procedural art piece. It is not an application with users — it is a painting that watches its audience. Aesthetic intent overrides technical convenience. When in doubt, choose the option that serves the visual or acoustic quality of the piece.

Stack: Vite, three.js (WebGL 2), `EffectComposer` plus custom passes (`artPass.js`, godrays, clouds), Web Audio (native), microphone input, GLSL composed as strings. No server.

## Read order

1. [docs/REQUIREMENTS.md](../REQUIREMENTS.md) — what the piece does and why
2. This file — coding standards, workflow, behavioural rules
3. [docs/architecture.md](../architecture.md) — module map, coupling, event payloads, GLSL layout (structure only)
4. The header comment of the module you are about to touch — its algorithm, constants and reasoning live there and nowhere else

Design reasoning is never duplicated into a separate document, because a second copy drifts from the first. Put a module's reasoning, and its accepted limits, in its own header comment.

## Conventions

- GLSL uniforms `uCamelCase`, varyings `vCamelCase`; includes are imported with Vite `?raw` and spliced by `shaderCompose.js`.
- One folder per subsystem under `src/` (see `docs/architecture.md`, "Source layout"); JS modules `camelCase.js`; shaders `name.vert` / `name.frag` / `includes/name.glsl` in the owning subsystem's `shaders/`.
- Constants `UPPER_SNAKE_CASE` in the module that owns them.
- Artistic values with no analytically correct answer become a debug-panel slider (plus a tooltip row), not a guessed constant.

## Common mistakes

- WebGL 2 has no tessellation stage; the adaptive mesh is built on the CPU (`terrainGeometry.js`).
- The state variables are `momentum` and `restlessness` (see `dynamics.js`).
- Subsystems (terrain, water, clouds, art pass, audio, interaction, drift) do not import each other; `main.js` constructs them and hands values across. Any module doing its own GPU pre-pass receives the renderer and must restore the render target it used.
- What needs the artist's input is scope and direction, not numbers — see "Scope confirmation" and "Ask before changing shader function signatures" below.

## Coding standards

Follow [docs/process/coding_guidelines.md](coding_guidelines.md) — naming,
functions, comments, SOLID / Clean Architecture, DRY / single-source-of-truth,
the project's shared-uniform invariants, testing, and refactoring discipline.
Read it before writing non-trivial code. The behavioural rules below are the
subset that matters most in practice, kept inline.

## Workflow

- Commit with explicit pathspecs: `git commit -m "..." -- <paths>`. Never `git commit -a` / `-am`, which sweeps in every modified file, including unrelated unfinished edits. A new file needs `git add <path>` first, run in the same command as its commit.
- After every multi-file change, run `npx vite build` to verify shaders compile before reporting done.
- Shader hot-reload is live in dev (`npm run dev`): editing any `.glsl`/`.vert`/`.frag` rebuilds the materials in place (uniforms preserved), no manual restart. Implemented via `import.meta.hot` + `terrain.rebuildShaders()` in `src/terrain/terrain.js`. A GLSL compile error just logs to the console; the old program keeps running. (`npx vite build` / `npm run preview` are still full builds with no HMR.)
- Keep commits small and atomic. One logical change per commit.

## Behavioural rules

**Scope confirmation**
If a request could be interpreted as narrow ("set defaults") or broad ("redesign the system"), state your intended scope before touching more than ~2 files and wait for confirmation. Do not use a narrow request as implicit permission for related improvements.

**Ask before changing shader function signatures**
Any change to a function signature in a `.glsl` file (renamed param, new argument, different overload) requires first grepping for every call site and verifying the overload exists. Shader compile errors are silent until runtime and break the entire render.

**Constant dependencies**
When changing an amplitude or frequency constant, immediately grep for all derived constants that depend on it (e.g. `HEIGHT_MAX` = sum of amplitudes). Update them in the same commit.

**Display requests — confirm the target**
When asked to "display the current value," name the specific element you plan to add and confirm before creating it. Do not infer.

**Smoothing / tuning constants → prefer sliders**
For smoothing factors, timing constants, or artistic thresholds that have no analytically correct value, add a debug slider rather than hardcoding. The value is then tuned by eye instead of by repeated edits.

**Cross-check after multi-file changes**
After any change touching ≥3 files: verify every `getElementById` call has a matching id in HTML; every uniform declared in a shader has a matching entry in the JS uniforms object; no tick listener reads a span that was removed. This is part of done.

**Adversarial check on every proposal or technical claim**
Before presenting a non-trivial idea, design, or technical claim — especially about math, shader or algorithm behaviour — pass it to a second agent whose task is to refute it, and present it only after it survives (report what the check found and changed). This applies even when the reasoning feels obvious. Prefer a shown derivation or a measured probe/readback over prose. The reviewer judges against these characteristics:
- **Correctness** — is the claim mathematically/logically true? Check derivatives, limits (evaluate at n=0 and the extremes), edge cases, and the sign/continuity of any transform (does a kink/discontinuity persist?).
- **Verifiability** — is it backed by an explicit derivation or a probe/readback? A rendered histogram or a measured constant beats a paragraph.
- **Axis separation** — does it conflate independent axes (amplitude vs curvature/smoothness vs DC level vs peak location)? Name which axis actually changes.
- **Assumptions & caveats** — hidden assumptions, failure modes, and honest limitations stated explicitly (including where a proposed knob does not do what its name suggests).
- **Goal fit** — does it solve the actual problem, not a plausible-looking tangent?
Trivial/mechanical answers (a rename, a lookup, a format fix) are exempt; the trigger is a proposal or a claim someone will act on.

**Tests are part of done, not a follow-up**
When you change code with a testable surface, add or update the matching test in the same commit. See [tests/README.md](../../tests/README.md) for layout, principles, and step-by-step howtos. Binding triggers:

| You changed… | Add/update… |
|---|---|
| a pure helper (terrainMath/waterMath/dynamics/interaction/…) | a vitest unit case (`tests/unit/`) |
| a GLSL per-fragment/vertex signal, or a debug view | a signal spec + `signalRegistry.js` row + fixture ground truth (`tests/signals/`) |
| biome placement / classification | a `classify.spec.js` zonation-ordering case |
| the lighting / shading transfer | a `shading.spec.js` case (tonal variety / sun response) |
| a new terrain uniform a tested signal reads | pin it in `probe.js`'s control set |
| a new **non-uniform** visual JS field on an existing module | its owner's `exportState`/`importState` (add the field) + a `scene_snapshot.spec.js` round-trip case. |
| a new **uniform** on terrain, water, clouds, godrays or the art pass | classify it, or the build is red: give it a param row (captured by key), or list it in that owner's `UNIFORM_CLASSES` (`*Params.js`) as `integrated` (accumulates over time: captured by name), `derived` (recomputed from rows by the restore), `frame` (rewritten every frame) or `constant` (never written after construction); a uniform written by a row's field is `row:<key>`. `tests/unit/uniformClasses.test.js` fails on an unclassified uniform and on a listed name that no longer exists. A new integrated one also needs a case in `tests/unit/snapshotFormat.test.js`. |
| a whole new stateful module (mesh transform owner, driver, geometry setting owner) | give it `exportState`/`importState`, add one entry to `sceneModules.js`'s `SCENE_MODULES` array, add it to `main.js`'s `snapshotDeps` — nothing else. `sceneSnapshot.js` derives capture/restore from that array, and `tests/unit/sceneSnapshot.test.js` proves every listed module is captured and restored. No test notices a module left off the array: it is silently omitted from every snapshot, so adding it to the array is part of the change. |
| a new debug-panel control (slider/toggle/radio/colour) | a param row in its owner's `*Params.js` (label, range and digits for a slider; `options` for a radio) and its id in `src/panel/panelLayout.js`, in the host it belongs to: the panel generates and binds the control from the row, never hand-write one in `index.html`. Plus a `{selector, text}` row in `src/panel/tooltips.js` explaining its effect on the landscape in plain language (no unexplained jargon, no uniform names) — never a `title=` attribute in `index.html` directly (see that file's header). `tests/visual/tooltips.spec.js` fails the build if the control has no tooltip or the row's selector matches nothing. |

Ground truth must be independent math, never a re-implementation of the signal's own shader formula (a mirror drifts in lockstep and tests nothing). Assert non-ossifying tiers — exact value / property / ordering / invariant — never a tuning threshold or a pixel snapshot (those go red on every legitimate retune and get deleted). If a change genuinely has no testable surface (pure constant tweak, comment), say so — don't invent an ossifying test.

## Where things are

This file holds rules, not a map. Read these instead of a module list here.

- **Module map, coupling, event payloads, GLSL layout:** [docs/architecture.md](../architecture.md)
- **A module's algorithm, constants and reasoning:** the header comment of its own file
- **Tests (layout, commands, how to add one):** [tests/README.md](../../tests/README.md) — `npm test` for unit, `npm run test:visual` for Playwright, run both before reporting done on any visual change
- **Debug panel:** `index.html` (markup), `src/panel/debugPanel.js` + `src/panel/tabs/` (wiring), `src/panel/tooltips.js` (plain-language help), the owners' param rows (`src/terrain/terrainParams.js`, `src/water/waterParams.js`, `src/clouds/cloudParams.js`, `src/artpass/artPassParams.js`, the drift's `src/drift/atmosphereParams.js` and `src/drift/formWalkerParams.js`, the form dials' `src/scene/formParams.js`; default, range, label per slider) listed for the panel by `src/panel/panelRows.js`
- **Future ideas:** [docs/process/IDEAS.md](IDEAS.md)
