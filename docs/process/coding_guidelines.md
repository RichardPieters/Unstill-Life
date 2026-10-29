# Coding Guidelines

Standards for all code in this repository. Grounded in widely-recognised
literature and adapted to this project (a Three.js / WebGL generative-art
piece with a CPU state machine driving GPU shaders).

**Sources referenced**
- *Clean Code* — Robert C. Martin (naming, functions, comments, tests)
- *Clean Architecture* — Robert C. Martin (SOLID, dependency rule, boundaries)
- *Refactoring* — Martin Fowler (code smells, small safe steps)
- *The Pragmatic Programmer* — Hunt & Thomas (DRY, orthogonality, tracer bullets)

Rules are ordered by how often they bite in this codebase. Each states the
principle, its source, and how it applies here. When a guideline and a
shader/GPU reality conflict, the reality wins — but say so in a comment.

---

## 1. Naming (*Clean Code* ch.2)

- **Intention-revealing, domain names.** `computeHeightMax`, `shapeOvercast`,
  `foamWidthForMomentum` — not `calc`, `tmp`, `doStuff`. A reader should infer purpose
  without the body.
- **Uniforms mirror their meaning, prefixed `u`**: `uSeaLevel`, `uShadeLo`.
  Varyings prefixed `v`. Keep the JS key, the uniform name, and the slider label
  semantically aligned (they meet in one param row, §7).
- **No disinformation.** Don't call something `normal` if it's a gradient; don't
  keep a name after its meaning changed: a value whose role changes gets a new
  name for the new role (`UNDERWATER_MARGIN` in `terrain.frag`).
- **Searchable > terse.** Named constants over magic numbers: `MOMENTUM_TARGET_MAX`,
  `H_NORM`, `ADAPTIVE_CAM_Z`. A literal that appears in two files (JS `H_NORM`
  vs GLSL `H_NORM`) must be named in both and cross-referenced in a comment.

## 2. Functions (*Clean Code* ch.3)

- **Small, one job.** If a function needs a "and" to describe it, split it.
- **One level of abstraction per function.** The terrain tick orchestrates;
  the arithmetic lives in `terrainMath.js`. Don't mix policy (what to do) with
  mechanism (uniform plumbing) in the same block.
- **Few arguments.** Prefer an options/params object over 4+ positional args.
  Pure helpers may take explicit scalars for testability (`computeHeightMax`),
  but keep the count low and the order obvious.
- **Command-query separation.** A function either does something or answers
  something. `water.getSeaLevel()` reads; `water.params.set(key, v)` writes.
  Don't hide a mutation inside a getter.
- **No side effects in "pure" helpers.** `terrainMath.js` touches no THREE, no
  DOM, no wall-clock — that's why it is unit-testable. Keep it that way.

## 3. Comments (*Clean Code* ch.4)

- **Explain WHY, not WHAT.** The code says what. Comments carry the rationale
  the code can't: why a constant is `0.5`, which failure a clamp prevents, what
  the value does to the picture. Describe what the code does now, not how it got
  there. These rationale comments are **load-bearing knowledge** in
  this repo — do not delete them when refactoring; move them with their code.
- **No commented-out code.** Delete dead code; git keeps it.
- **Keep comments true.** A stale comment is worse than none. When you change
  behaviour, update the comment in the same edit.

## 4. Formatting & consistency

- **One idiom per job.** There is one way to bind a debug control (`bindParam`
  over a param row), one way to inject a shader include (`inject`). Don't
  add a second style beside an existing one — migrate or match.
- Match the surrounding file's comment density, alignment, and naming. New code
  should be indistinguishable in style from the code around it.

## 5. Error handling & boundaries

- **Fail loud in dev, degrade gracefully in the piece.** A GLSL compile error
  logs and keeps the last good program (HMR); the audio context failure is
  caught so the overlay still dismisses. User-facing paths never hard-crash the
  render loop.
- **Guard external/optional resources**: `if (!this._renderer) return`,
  half-float RT fallback when `OES_texture_float_linear` is absent.

## 6. Architecture (*Clean Architecture* — SOLID + the Dependency Rule)

- **Single Responsibility.** One reason to change per module. `main.js` is a
  composition root (wiring only); `debugPanel.js` owns UI; `terrainGeometry.js`
  owns geometry; `terrainMath.js` owns tick math. If a file changes for two
  unrelated reasons, split it.
- **Dependency direction points inward.** The sim core (`dynamics.js`) knows
  nothing about its consumers; modules subscribe to it. UI depends on modules,
  never the reverse. Never make the state machine import a renderer.
- **Composition root.** All construction and wiring happens in one place
  (`main.js`). Modules receive their dependencies (`new Terrain(dynamics, sceneUniforms)`,
  `initDebugPanel({...})`) — don't reach for globals. `window.__d` is a
  dev/test handle, not a dependency channel.
- **Open/Closed via data, not edits.** New sliders are new rows in
  an owner's param rows (`terrainParams.js`, `waterParams.js`, `cloudParams.js`),
  not new hand-wired listeners. Extend the table; don't
  branch the code.
- **Interface Segregation / narrow contracts.** Modules talk through small
  explicit methods (`getSeaLevel`, `setSeaLevel`) and the tick payload — not by
  reaching into each other's internals.
- **Stable, intention-revealing module interfaces.** The public surface of a
  class is its methods; keep `_private` fields private.

## 7. DRY & Single Source of Truth (*Pragmatic Programmer*; *Clean Code*)

- **Every fact lives in exactly one place.**
  - A slider-backed uniform's *default value* lives in its param row (the
    owner's `*Params.js`); the owner's uniform block takes it from there with
    `uniformsFor`, and sliders read it back on load, never duplicate it as an
    HTML `value=` attribute. A uniform with no row keeps its default in the
    uniform block.
  - Slider ⇄ uniform *bindings* live once in the row; the owner's accessor
    (`paramAccess`) and debugPanel.js (via `panel/panelRows.js`) both
    derive from it.
  - Shader include-injection lives once in `shaderCompose.js`.
- **Constant-dependency rule.** When a value is derived from others (e.g.
  `uHeightMax` = amp0 + amp1 + erosion margin), compute it — never hardcode a
  copy that can drift. Recompute on the tick if inputs are live.
- A param row and its consumers change together: the panel generates each
  control from its row (`panel/paramPanel.js`), so a row with a control needs
  its id placed in `panel/panelLayout.js` and a tooltip row in
  `panel/tooltips.js`; `panelLayout.test.js` and `tooltips.spec.js` fail
  otherwise.

## 8. Project-specific invariants (violate these and the render silently breaks)

- **Shared uniforms by reference.** The heightmap/derive materials share the
  terrain material's fBM/drift *uniform objects*. A tick mutates one
  object and it reaches every pass. **Never copy a uniform's value into a
  separate object** where sharing is expected — the terrain freezes while water
  keeps moving, which no naive test catches. Guarded by
  `tests/visual/terrain_reactive.spec.js`.
- **Fixed render-pass order** in the loop: data-map → depth pre-pass →
  reflection pre-pass → main. Preserve it; document any change.
- **Shader function signatures are a contract.** Before changing a `.glsl`
  function signature, grep every call site — GLSL compile errors are silent
  until runtime and break the whole render.
- **Never `drawImage` the WebGL canvas** in tests — it's blank without
  `preserveDrawingBuffer`. Decode `page.screenshot()` instead.

## 9. Testing

Layout, principles and how to add each kind of test: `tests/README.md`. Which
change needs which test: `docs/process/agent_rules.md`, "Tests are part of done".

## 10. Refactoring discipline (*Refactoring* — Fowler)

- **Small, safe, reversible steps**, each committed separately (one logical
  change per commit). Verify (build/test) between steps.
- **Boy Scout Rule**: leave code cleaner than you found it — but scope-confirm
  before deleting anything you didn't write or that's deliberately parked.
- **Name the smell you're fixing** (god object, duplicated declaration,
  dead code, feature envy) in the commit message.
- **Adversarial verification** on any change touching ≥3 files: every
  hand-written readout's `getElementById` has a matching id in `index.html`;
  every declared uniform is a row or listed in its owner's `UNIFORM_CLASSES`;
  no tick listener reads a removed readout.

## 11. Commits & workflow

Commit with explicit pathspecs (`git commit -m "…" -- <paths>`), so unrelated
edits in the working tree stay out of the commit. Small, atomic,
Conventional-Commits style (`refactor(terrain): …`). The rest of the workflow
(checkpoints, build check) is in `docs/process/agent_rules.md`.
