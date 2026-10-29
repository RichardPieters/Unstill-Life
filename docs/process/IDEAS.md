# Ideas — possible future features

Not commitments. Each entry has enough rationale to revive it later.

## Landscape

**Buildings that turn into ruins.** Sparse man-made structures that decay over time: intact → cracked → collapsed → overgrown. The clearest Vanitas symbol: human works outlasted by, then reclaimed by, the land. Open questions: geometry source (instanced meshes, SDF, or displaced terrain detail), placement (hand-set landmarks or procedural), how decay couples to the dynamics (per event or continuous), whether ruins persist when the landscape re-seeds. Cost risk: real geometry is heavier than the current pure-shader scene.

**Snowy forest.** A high-forest colour role (a snow-forest colour with glow/shade pair) for the belt above the snowline read well and is worth reviving on its own. Frosted crown tops failed: a cap keyed on distance from the crown centre is always a concentric dot (white polka dots on near-black), and keying it on the surface normal frosts flat ground (at a crown's apex the normal equals the terrain normal). A cap needs an asymmetric key (fall line or sun direction) or a different figure/ground relationship. The "snow gap" idea was never fairly judged.

**Adret gold (sun-facing heath).** In `classify()`, inside the tree belt and before the forest default, carve sun-facing, convex shoulders into a gold colour (the heath material was removed, so this needs a new palette entry): aspect toward the sun AND small-scale convexity (shoulder, not gully). It flooded sunny slopes with gold; a revival retunes the aspect threshold upward. Needs its uniforms, sliders and tooltip rows re-added (they were removed), and the heath colour/glow.

**Frost hollow.** Cold-air basins (high hollowness, low height, flat) painted as meadow. Decide first which rule owns flat basins, since the flat-pocket pasture branch already covers most of them; must run before the forest default.

## Weather and sky

**Weather beyond overcast and haze.** Water deep/shallow colours are not weather-driven. The sky has gradient only, no structure. Cloud shadows could follow the drawn silhouette exactly (add the weather-map bias and detail tail to the light bake). The grey-light terms use one curve for direct sun and diffuse light; separating them is the physically better model.

**Fog as a restlessness veil.** As unrest rises the fog thickens and swallows the distance; in calm the far ridges return. A direct Vanitas device and a cheap depth cue, e.g. a density mix between a minimum and maximum driven by momentum. Today the haze is the weather's, and only the pace of its walk follows momentum.