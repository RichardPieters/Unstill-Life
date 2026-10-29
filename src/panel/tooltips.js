/**
 * tooltips.js — single source of truth for every debug-panel control's
 * hover tooltip (native `title` attribute), explaining what the control does
 * to the LANDSCAPE in plain language — not the uniform name or the formula.
 *
 * Written for someone who has never read this codebase: define jargon inline
 * (fBM, ridge, lacunarity, aniso, aspect, flatness, moisture, hollowness) the
 * first time each appears in a section, rather than assuming it's known.
 *
 * WHY A SEPARATE MODULE, NOT `title=` ATTRIBUTES IN index.html: index.html
 * changes with every new control, and driving tooltips from selectors here
 * means adding one never touches it, so tooltip edits cannot collide with
 * markup edits.
 *
 * `selector` is a CSS selector (not always an id — the debug-view and
 * field-solo radios share a `name` with no `id`, so they're matched by
 * `input[name=...][value=...]`). applyTooltips() in debugPanel.js runs this
 * list once at startup and sets `.title` on every match; it warns to the
 * console for any selector that matches nothing, so a renamed/removed control
 * shows up immediately instead of silently going tooltip-less.
 *
 * FUTURE AGENTS: adding a new debug-panel control? Add its entry here in the
 * same pass (agent_rules.md "tests are part of done" table has a row for this).
 * tests/visual/tooltips.spec.js asserts every slider/checkbox/radio/color
 * input inside #debug has a non-empty title — a missing entry fails CI, not
 * just a lint warning.
 */
import { SPECIES, SPECIES_FORM } from '../terrain/treeSpecies.js'

const STATIC_TOOLTIPS = [

  // ── Art pass (artPass.js) — generated controls, ids from artPassParams.js ──
  { selector: "#tog-artpass", text: 'Repaints the finished frame as a neo-impressionist picture: the image is rebuilt out of thousands of small brush marks, each one a single colour taken from a painter\'s palette rather than from the pixel underneath. Switching it on plays the entrance animation below; switching it off removes the paint immediately. On by default; it replaces the whole image, so turn it off while tuning the landscape itself.' },
  { selector: "#art-cell", text: 'How big each brush mark is, in pixels of the reference screen (a retina laptop window); on a bigger or smaller screen the marks scale with the picture, so the same number of marks always cover it. Small values give a fine, dense stipple that reads almost like the original image from a distance; large values give bold separate dabs you can count. Everything else about the paint scales with this, so it is the first dial to set.' },
  { selector: "#art-dot-scale", text: 'How far each mark spreads relative to the space it is given. Too low and bare canvas shows through in patches between the marks; too high and they crowd into each other and the separation is lost. There is a minimum below which holes are guaranteed, and it rises as placement jitter rises.' },
  { selector: "#art-jitter", text: 'How far each mark is allowed to wander from its slot on the grid. At 0 the marks sit on a perfectly regular lattice, which reads as machine-made; turn it up and they scatter like a hand placed them. Raising this needs a matching rise in dot fill or gaps open up.' },
  { selector: "#art-aspect", text: 'How stretched each mark is along its own direction. 1 is a round dab; higher makes an elongated stroke, as if dragged with the brush. Combined with the direction field this is what makes marks follow the shape of a hillside instead of speckling it.' },
  { selector: "#art-ground-mix", text: 'How much of the bare surface underneath shows through the paint. At 0 the marks cover completely; turn it up and the ground colour breathes through the gaps, which lightens and unifies the whole picture.' },
  { selector: "#art-size-depth", text: 'Makes distant marks smaller than near ones, so the paint itself carries depth the way handwriting gets finer as it runs out of room. Extra marks are automatically added where they shrink, so the distance gets finer grain rather than bare gaps.' },
  { selector: "#art-aerial", text: 'Thins the variety of colours used in the distance. Near passages keep their full spread of pigments while far ones settle toward a single colour, which is how distance reads in a real landscape — not just paler, but less varied.' },
  { selector: "#art-edge-align", text: 'How strongly marks turn to run ALONG a silhouette they touch — the line of a ridge against the sky, or a cliff against the plain behind it. At 0 they ignore it; turn it up and a dotted treeline reads as a treeline instead of dissolving into the sky.' },
  { selector: "#art-edge-reach", text: 'How far from a silhouette that turning still happens, measured in mark widths. Low keeps it to marks actually touching the edge; high lets a whole band of paint swing into line with it.' },
  { selector: "#art-flatten", text: 'Blurs the picture each mark takes its colour from, without blurring the picture itself. Low reads the colour exactly where the mark sits, so fine detail survives as speckle; high makes each mark carry a broad shape instead, which is what turns a photograph into three or four flat areas of paint.' },
  { selector: "#art-layer2", text: 'A second sitting: the same grid of marks again, shifted half a step across with fresh randomness, painted over the first. At 0 none of it is there, at 1 all of it. Marks come in one at a time as you raise it, and the layer underneath is pushed thinner as it fills in.' },
  { selector: "#art-shape-n", text: 'The outline of one mark, from a round dab to a pressed rectangular tile. Low is a soft blob made by a pointed brush; high is the flat-edged patch a loaded flat brush leaves when pressed down and lifted.' },
  { selector: "#art-taper", text: 'Pinches one end of each mark narrower than the other, which is what a brush leaves as it lifts off the canvas. At 0 the marks are symmetrical; turn it up and they become commas rather than dabs.' },
  { selector: "#art-warp-amp", text: 'Bends the space each mark is drawn in, so its edge lobes and pinches instead of being a clean curve. This is what stops a field of marks reading as geometry — a perfect ellipse looks printed, a slightly pushed-around one looks painted.' },
  { selector: "#art-warp-scale", text: 'How large the bends from the shape warp are, relative to the mark. Small values ripple the edge finely; large ones push the whole mark into a lopsided shape.' },
  { selector: "#art-ragged", text: 'Bites irregular notches out of the rim of each mark. A clean edge reads as a printed dot; a lumpy one reads as foliage and paint. It only ever bites inward, so marks can never grow into their neighbours.' },
  { selector: "#art-ragged-freq", text: 'How many lobes the ragged rim has around one mark. Low gives a couple of broad bulges; high gives a finer, more chewed edge.' },
  { selector: "#art-thick-base", text: 'How thickly the paint sits for a typical mark. This is physical height, not colour — it is what the studio lamp below catches, so raising it makes the whole surface more obviously made of paint.' },
  { selector: "#art-thick-var", text: 'How much the thickness varies from one mark to the next. At 0 every mark is the same slab; turn it up and some sit thin and scumbled while others stand proud, which is most of what makes a surface look worked rather than printed.' },
  { selector: "#art-rim", text: 'Extra paint piled up at the edge of each mark, where the side of the brush dragged. This is what makes a stroke catch the light around its outline rather than only across its middle.' },
  { selector: "#art-dip", text: 'Scoops the centre of each mark lower than its rim, as a heavily loaded brush leaves. Used with the edge rim it turns a flat patch into something with a lip around it.' },
  { selector: "#art-groove", text: 'The furrows individual bristles leave along a stroke. Under raking light these are most of what reads as \'brush\' rather than \'blob\'.' },
  { selector: "#art-groove-freq", text: 'How many bristle furrows run across the width of one mark. Low is a coarse house brush; high is a fine sable.' },
  { selector: "#art-k-sky", text: 'How far the sky\'s marks are allowed to stray from the colour they are replacing. The sky needs its own value: it is pale, so it resolves to mostly white plus the occasional saturated accent, and a setting that suits the land leaves the sky looking either flat or speckled.' },
  { selector: "#art-k-water", text: 'The same for water. Water usually takes more spread than land — reflections genuinely do carry a wider range of colour than a hillside does.' },
  { selector: "#art-k-land-near", text: 'How far terrain marks close to the camera are allowed to stray from the colour they are replacing. Land is usually kept the tightest of the three, because it already carries variation from its own materials and lighting. Terrain eases from this value to the far one as it recedes.' },
  { selector: "#art-k-land-far", text: 'The same for terrain at the far end of the view, where the scene\'s own haze starts. Lower than the near value, the distant land settles toward fewer, flatter colours while the foreground stays varied.' },
  { selector: "#art-dark-quiet", text: 'Keeps the colour scatter out of the shadows. Turn it up and the darks settle into quiet, near-uniform areas while the lights and mid-tones stay divided into separate colours — which is how the paintings this is modelled on actually behave.' },
  { selector: "#art-tint", text: 'How far individual marks drift toward white within their own colour family. A small amount gives the sparkle of a passage worked over several sittings; too much and the picture goes chalky.' },
  { selector: "#art-load", text: 'How far individual marks drift toward raw undiluted pigment within their own family. This is the opposite move to tint — where tint lightens, this saturates, and a mix of both is what a painter gets from dipping into the same pile of paint repeatedly.' },
  { selector: "#art-weave", text: 'How much the canvas texture shows through the paint. The cloth is a surface, not just a tint: thin paint lets the weave show and catch light, thick paint fills it in and hides it.' },
  { selector: "#art-weave-scale", text: 'How coarse the canvas weave is, in screen pixels per thread. Low is a fine portrait linen; high is a rough sailcloth.' },
  { selector: "#art-weave-depth", text: 'How much the canvas weave physically bumps the surface, as opposed to just tinting it. This is what makes thinly-painted passages catch light differently from loaded ones.' },
  { selector: "#art-height-scale", text: 'Overall strength of the paint relief — how much the thickness of the paint shows as light and shade. Set at a reference mark size; change the mark size and this is scaled to match, so the paint does not silently flatten or over-emboss as a side effect.' },
  { selector: "#art-normal-radius", text: 'How far apart the surface is measured when working out which way it slopes. Small reads every bristle furrow, so the light catches fine texture; large ignores those and reads only where whole marks stack on top of each other.' },
  { selector: "#art-light-az", text: 'Which direction the studio lamp shines from, as an angle around the canvas. This is the light on the PAINTING, not the sun in the landscape — turning it moves the highlights on the ridges of paint without touching the depicted scene.' },
  { selector: "#art-light-el", text: 'How high the studio lamp sits. Low is raking light that skims the surface and exaggerates every ridge of paint; high is flat overhead light that shows almost no texture.' },
  { selector: "#art-ambient", text: 'How much light reaches the paint regardless of which way it faces. High flattens the relief toward even illumination; low lets the lamp do all the work and deepens the contrast between ridge and trough.' },
  { selector: "#art-diffuse", text: 'How strongly the paint\'s own ridges and troughs lighten and darken. It is balanced around flat paint, so raising it deepens the texture without also brightening the whole picture.' },
  { selector: "#art-specular", text: 'How much the paint sheens where it faces the lamp directly — the wet-looking glint on a ridge of thick oil.' },
  { selector: "#art-spec-power", text: 'How tight that sheen is. Low spreads a broad satin gleam across the surface; high concentrates it into small sharp glints on the very tops of the paint.' },
  { selector: "#art-crevice", text: 'Darkens the genuine troughs where almost no paint reached, the way dirt and shadow collect in the low points of a real painted surface. It only affects the near-bare places, not the shaded side of every ridge.' },
  { selector: "#art-high-key", text: 'Squeezes the whole picture into a narrower range of tone, so nothing reaches pure white or pure black. The paintings this is modelled on work this way — they get their apparent punch from opposing colours rather than from contrast between light and dark.' },
  { selector: "#art-beta", text: 'How many different pigments are mixed to hit each colour. Low picks the closest pair and uses just those, giving clean simple marks; high spreads the same colour across as many pigments as it can, giving a livelier, more broken surface. Both are exact — the average still lands on the right colour either way.' },
  { selector: "#art-cull", text: 'Drops pigments that would only occupy a tiny fraction of an area. The rarest pigments are also the ones furthest from the target colour, so keeping ones worth half a percent is what produces the occasional wildly wrong mark.' },
  { selector: "#art-ground-blur", text: 'How softly the surface underneath the paint is blurred. This is the tone the picture is built on: a blurred version of the scene gives broad areas of colour for the marks to sit on, so gaps read as considered ground rather than as holes.' },
  { selector: "#art-edge-tau", text: 'How big a jump in distance counts as an edge worth aligning marks to. Low treats every small step in the landscape as an edge, which puts alignment almost everywhere; high keeps it to genuine silhouettes — a cliff against far plains, a ridge against the sky. It is measured relative to how far away things are, so it means the same thing near and far.' },
  { selector: "#art-edge-fit", text: 'How long a stretch of an edge is used to work out which way it runs. Small follows every wiggle of a ridge line; large reads the same ridge as a straighter line and gives calmer, more deliberate alignment.' },
  { selector: "#art-keep-edges", text: 'How firmly the blurred ground is stopped from bleeding across a silhouette. At 0 it is an ordinary blur, which smears far terrain into the ridge standing in front of it and leaves a halo around every skyline. Only affects the blurred ground mode.' },
  { selector: "#art-seg-fog", text: 'In the flat-colour ground mode, how far distant terrain melts into the sky colour. Far ridges in this landscape are so deep in haze that they read as sky, so painting them full terrain green would put solid mountains where the picture has none.' },
  { selector: "#art-prepass-scale", text: 'Resolution the edge-detection and ground-blur stages are computed at, as a fraction of the screen. Lower is much cheaper — the cost goes as the square — and almost never visible, because both are read through a wide soft filter anyway. Raise it only if edges look coarse.' },
  { selector: "input[name=art-ground][value='0']", text: 'Paint straight onto the rendered scene. Whatever the marks do not cover shows the original image, so thin passages read as a photograph with dots on it rather than as paint.' },
  { selector: "input[name=art-ground][value='1']", text: 'Paint onto a blurred version of the scene, held back at silhouettes so a far plain does not bleed a halo around the cliff in front of it. Gaps between marks then read as broad areas of considered colour.' },
  { selector: "input[name=art-ground][value='2']", text: 'Paint onto a single flat toned colour, like a primed canvas. The most abstract option: nothing of the original image survives except through the marks themselves.' },
  { selector: "input[name=art-ground][value='3']", text: 'Paint onto three flat colours — one for sky, one for land, one for water — softened into each other at the boundaries. Unlike the blurred mode this deliberately blurs ACROSS silhouettes, because softening those three joins is the whole point.' },
  { selector: "#art-col-ground", text: 'The flat toned colour used by the solid ground mode — the colour of the primed canvas showing between the marks, on a clear day. It has no separate grey-weather colour: instead it is simply dimmed by the same light level as the landscape, so the canvas sits in the same light as the ground it stands for. The painted SKY is left out of that dimming, exactly as the real sky is.' },
  { selector: "#art-col-sky", text: 'The flat colour standing in for the sky in the segment-solids ground mode.' },
  { selector: "#art-col-land", text: 'The flat colour standing in for terrain in the segment-solids ground mode. Distant terrain is melted toward the sky colour by the haze setting.' },
  { selector: "#art-col-water", text: 'The flat colour standing in for water in the segment-solids ground mode.' },
  { selector: "input[name=art-view][value='0']", text: 'The finished painting, lit by the studio lamp.' },
  { selector: "input[name=art-view][value='1']", text: 'The painting with the direction field switched off, so every mark lies horizontally. Useful for judging how much of the look comes from the marks following the landscape\'s shape.' },
  { selector: "input[name=art-view][value='2']", text: 'Shows which way marks are being turned, as colour. Flat areas of one colour mean marks all pointing the same way; the swirls follow contours and silhouettes.' },
  { selector: "input[name=art-view][value='3']", text: 'Distance from the camera, black near to white far. This is what drives mark size, the thinning of colour with distance, and edge detection.' },
  { selector: "input[name=art-view][value='4']", text: 'The three areas the pass works in: blue sky, cyan water, green land. If this comes up solid blue the scene data failed to render, which otherwise just looks like edge alignment quietly doing nothing.' },
  { selector: "input[name=art-view][value='5']", text: 'Distance to the nearest silhouette. White on the edge itself, red where marks are being turned to follow it, fading to dark beyond its reach.' },
  { selector: '#art-reveal-prime-duration', text: 'How long the canvas takes to arrive before any mark appears: the weave fades in and the whole scene lightens toward the toned canvas, then holds there while painting begins. Set to 0 to skip this step and go straight to the marks.' },
  { selector: '#art-reveal-prime-lighten', text: "How far the whole scene lightens toward the ground colour by the end of priming, as a ceiling — 0 leaves it untouched, 1 replaces it outright with the toned canvas. It reaches this amount smoothly over the priming duration above and then stays there for the rest of painting, the way a real canvas stays toned once primed." },
  { selector: '#art-reveal-duration', text: 'How long the marks take to appear, once the canvas priming step above has finished. Everything else in this section is timed relative to this one number, so changing it stretches or compresses the whole sequence rather than any one part of it.' },
  { selector: '#art-reveal-bias', text: 'How strongly the dark parts of the picture and the marks sitting on a silhouette are pulled ahead of the one growing patch. At 0 the growth alone decides the order; turn it up and it tends to start from a shadow or a drawn edge rather than wherever the single seed happens to land, closer to how a painter lays a canvas in.' },
  { selector: '#art-reveal-growth-reach', text: 'How far the growth travels before it fades out. Low keeps it close to its single starting point for most of the reveal, so distant corners of the picture arrive very late; high lets it reach the far edges of the frame promptly. Changing this takes effect the NEXT time painting is switched on, not on a reveal already in progress.' },
  { selector: '#art-reveal-colour-weight', text: "How strongly the growth prefers to stay within one colour rather than spreading evenly in every direction. At 0 it grows as a plain circle with no regard for what it's painting over; turn it up and it spreads freely through a patch of similar colour and only pushes into a different one once nothing similar and closer is left, so a single growing patch is made of one colour rather than a colour-blind blob. Changing this takes effect on the NEXT reveal, not one already playing." },
  { selector: '#art-reveal-growth-jitter', text: 'How much the growth is broken up by plain, independent scatter instead of following the single growing patch. At 0 the paint arrives as one clean, continuous region widening outward; turn it up and individual marks increasingly jump in on their own regardless of where the growth has actually reached, back toward an even sprinkle.' },
  { selector: '#art-reveal-even-pace', text: 'How steadily the marks arrive. At 0 they come as the growth reaches them: a whole flat patch of sky or field fills in at once, then little happens while the growth crosses a border. At 1 the same marks arrive in the same order but at a constant number per second, which is also what the soundscape follows.' },
  { selector: '#art-reveal-ground-beat', text: 'How much of the total reveal time is spent transitioning the canvas underneath, at whichever end "underpaint before marks" below puts that transition — the very start if it is checked, the very end if it is not.' },
  { selector: '#art-exit-duration', text: 'How long the painting takes to come apart once the landscape starts moving again, in seconds. The strokes are a still picture by this point, so what you are timing is how long they are allowed to linger over a scene that no longer matches them.' },
  { selector: '#art-exit-random', text: 'How the painting comes apart. Checked, each stroke simply vanishes at its own random moment during the exit, so the picture thins out evenly all over and the landscape underneath has no say in it. Unchecked (the default), a stroke instead stays for as long as the scene beneath it still resembles what it was painted from, so the picture breaks up first wherever the landscape is moving most and lingers over the calm parts. The four sliders below only do anything while this is unchecked.' },
  { selector: '#art-exit-threshold', text: 'How far the landscape under a stroke has to move away from what that stroke was painted from before the stroke goes. Low means the faintest shift takes it, so the picture starts breaking up the moment anything stirs; high holds the painting together until the scene underneath is barely recognisable.' },
  { selector: '#art-exit-ground-beat', text: 'How much of the exit is spent settling the surface between the strokes back into the moving scene before any stroke starts to fade. Low is a quick, almost immediate settle; high lets the bare canvas visibly catch up with the live world first, with the paint on top staying put until it has.' },
  { selector: '#art-exit-jitter', text: 'How much strokes disagree with one another about when to go. At 0 every stroke over the same shifting patch leaves on the same frame, which reads as a sheet being pulled away; turn it up and they go raggedly, a few at a time.' },
  { selector: '#art-exit-softness', text: 'How abruptly a single stroke goes once its moment comes. Low is a clean disappearance; high wipes it away more gradually, so it thins out instead of simply ceasing to be there.' },
  { selector: '#art-exit-sweep', text: 'How far into the exit the landscape\'s own movement still decides which strokes go. Past this point, whatever paint is still standing switches to disappearing at its own random moment instead — same as the "paint just disappears at random" option — so the picture always ends completely empty without every remaining stroke leaving together on one shared beat. Only matters while "paint just disappears at random" is unchecked; a random exit already finishes every stroke on its own from the start.' },
  { selector: '#art-exit-resume-ease', text: 'How gradually the waves and clouds start moving again once the painting stops holding the scene. At 0 they jump straight to full speed; turn it up and they creep back into motion instead, as though waking rather than being switched on.' },
  { selector: '#art-reveal-edges-first', text: 'Opens the reveal by drawing the picture before painting it: for a short beat only the marks lying directly on a silhouette or a hard edge appear, so the shapes are blocked out in quick strokes, and nothing else may start until that is done. Unchecked, there is no drawing stage and every mark simply waits its turn as the colour spreads.' },
  { selector: '#art-reveal-edge-beat', text: 'How much of the reveal is spent on that opening blocking-in stage. Low is a brief flurry of edge strokes before the colour starts filling in; high lets the drawing stand on its own for a long while, so the picture reads as a line sketch before any mass arrives. Only does anything while the blocking-in checkbox above is on.' },
  { selector: '#art-reveal-edge-depth', text: 'How far into the distance the opening drawing stage reaches. At the maximum every silhouette is drawn first; lower it and edges beyond that distance are left out of the drawing stage and simply fill in with the rest of the colour, so only the near shapes are sketched. Only does anything while the blocking-in checkbox above is on.' },
  { selector: '#art-reveal-darks-first', text: 'Opens the reveal with its own separate blocking-in stage for the darkest marks only, independent of the edges one above — a painter often blocks in the shadow masses before ever touching a silhouette. Unchecked (the default), there is no such stage and the darks arrive at the pace the darks & edges first slider already gives them.' },
  { selector: '#art-reveal-dark-beat', text: 'How much of the reveal is spent on the darks-only blocking-in stage. Only does anything while the checkbox above is on.' },
  { selector: '#art-reveal-underpaint', text: 'Chooses when the surface under the paint changes to its configured look. Checked, it settles in first, before any mark appears — the traditional order of toning a canvas and then dividing it. Unchecked (the default), the surface stays as the plain photograph while marks arrive on top of it, and only takes on its configured look in a short beat at the very end, once painting is essentially finished.' },
  // ── Palette colours (dynamically created — matched by dbg-color position) ──
  // Applied directly in debugPanel.js's titlePaletteControls(), not from this list
  // (the swatches are generated from rows, and their label is only 'forest').

  // ── Interaction ─────────────────────────────────────────────────────────────
  { selector: '#ctrl-momentum-inertia', text: 'How long the landscape takes to respond after the Attention slider moves, in seconds. At 0 it changes pace the instant you move the slider. Turn it up and the landscape drifts into its new pace slowly instead, so a viewer arriving or leaving eases the scene along rather than switching it. This only changes how quickly it gets there — the pace it ends up at is set by Attention alone.' },
  { selector: '#ctrl-settle-interval', text: 'How many seconds of full Attention it takes for the landscape to turn into a still painting, at the fastest pace (Attention all the way up). Lower attention always takes longer than this — it only sets the fastest pace.' },
  { selector: '#ctrl-unfreeze-attention', text: 'Attention has to stay ABOVE this line for the landscape to drift toward settling into a still painting at all — below or at it, the landscape simply holds where it is and does not drift any further. Once fully settled, Attention has to drop BELOW this same line before it starts moving again. So the two directions pull opposite ways: set this low and only a little attention is needed to start it settling, but a very empty, calm room is then needed to wake it back up; set it high and the opposite — it takes real sustained attention to settle, but almost any drop in attention wakes it.' },
  { selector: '#ctrl-anim-speed', text: 'How fast the water’s waves and the clouds drift, at full restlessness. As the landscape settles toward stillness this fades down in step with it, reaching a complete stop the same moment the frame gets fully painted over. Once the painting stops holding the scene, the speed builds back up toward this value, easing in over the art pass’s "landscape resume ease" time instead of jumping straight to full speed.' },
  { selector: '#ctrl-wave-weather-gain', text: 'How much a grey sky hurries the water. At 0 the weather leaves the waves alone and they move at the speed set just above; at 1 they run twice as fast once the sky is fully overcast, with everything in between following how grey it has actually turned. It only ever adds to the pace already set — under a clear sky it changes nothing at all.' },
  { selector: '#ctrl-cloud-weather-gain', text: 'The same for the clouds: how much faster they drift across the sky as it greys over. Kept separate from the waves so you can have a sky tearing past above a sea that is barely stirring, or the other way round. At 0 the clouds ignore the weather entirely.' },

  { selector: '#tog-scene-drift', text: 'When on, the scene changes itself with nobody touching it — both the land and the weather. The landscape slowly reshapes (how much of it is sea, how mountainous it is, how far down the snow reaches, and how the clouds gather), and the weather wanders through sunny and grey spells. Turn it off to hold everything still and set the dials below by hand. If it shows a dash rather than a tick, one of the two has been stopped on its own and the other is still going; clicking it puts both back in step.' },
  { selector: '#ctrl-walk-spread', text: 'How far the drifting form is allowed to roam on its own. Low keeps the landscape recognisably the same place, wandering only a little around where it is. High lets a quiet stretch carry it somewhere quite different — from mountainous coast to open sea.' },
  { selector: '#ctrl-walk-rate', text: 'How fast the drifting form travels toward its next shape, relative to how fast the terrain is already evolving. At 0 the shape stops drifting. Higher makes the coastline, the mountains and the snowline visibly change as you watch. Because it is relative, a calm scene still drifts slowly however high this is set.' },

  // ── Sky / weather (atmosphere.js) ────────────────────────────────────────
  { selector: '#ctrl-atmo-spread', text: 'How far the weather is allowed to roam on its own — and, along with it, how far the cloud scatter and cloud density dials roam, since they drift on this same pace rather than the landform\'s. Low keeps conditions around where they are now, so a sunny afternoon stays broadly sunny. High lets one quiet stretch carry it from open sun to a full grey lid and back.' },
  { selector: '#ctrl-sky-reach', text: 'How much of the visible sky, from directly overhead down toward the mountains, the gradient colour change is spread across. The camera looks slightly downward, so most of what would be the lower sky is hidden behind the land anyway — pulling this down concentrates the whole colour change into the strip of sky that is actually on screen, instead of spreading it across space nothing ever shows.' },
  { selector: '#ctrl-atmo-rate', text: 'How fast the weather changes, relative to how fast the landscape is already evolving — the cloud scatter and cloud density dials change at this same pace too. At 0 it stops changing by itself and holds wherever it is. Deliberately slower than the drifting landform by default: weather that turns faster than the land underneath it reads as a light show rather than as weather.' },
  { selector: '#ctrl-atmo-overcast', text: 'How much sun the sky is letting through right now. At 0 the sun is open: strong shadows, warm glow on the peaks, a blue sky. At 1 the sky is a solid grey lid: shadows lift and go grey, the warm glow on snow and rock disappears, the whole scene flattens, and the land gets less light while the sky above it stays bright. Drifts on its own unless the drifting weather switch above is off.' },
  { selector: '#ctrl-atmo-haze', text: 'How much moisture sits in the air between you and the far ridges right now. At 0 the distance is crisp and the far hills keep their own colour. At 1 the distance dissolves: far ground loses its colour and melts into the sky well before the horizon. Independent of overcast, so a clear blue day can still swallow its distance, and a grey one can still have sharp far ridges.' },
  { selector: '#ctrl-atmo-onset', text: 'How much overcast there has to be before the LIGHT starts changing at all. Below this the sky gathers cloud but the landscape is still lit as though it were a clear day, which is what happens in the world: a few clouds do not flatten the light. This exists because cloud amount and the amount of sky actually covered are not the same curve — a fifth of the way up the overcast dial the sky is barely one part in eighty cloud, and without this the scene would already be a fifth of the way to flat grey light under an almost empty blue sky.' },
  { selector: '#ctrl-atmo-full', text: 'The point at which the grey-day light is fully arrived, so that pushing overcast any further only adds more cloud. Lower it and the flat light shows up earlier and then holds; raise it to 1 and the light keeps deepening right to the top of the dial. Together with the setting above this is the shape of the whole transition — where it starts, where it finishes, and a straight ramp in between.' },

  // The clear-weather end. Each of these is the same quantity as the "at full
  // …" row of the same name, read at overcast 0 / haze 0 instead of 1, so the
  // text says what the setting IS and leaves the weather's own direction to the
  // heavy rows.
  { selector: '#ctrl-atmo-clear-shadow', text: 'How dark shadows go on a clear day. This is the starting point the overcast version below travels away from. Low is the tuned look: deep, almost black shadows under open sun.' },
  { selector: '#ctrl-atmo-clear-light', text: 'How much light falls on the land on a clear day. 1 is full sun and is what the rest of the palette is tuned against, so there is rarely a reason to move it — lower it only if you want the piece to sit in a dimmer key overall.' },
  { selector: '#ctrl-atmo-clear-glow', text: 'How much warm alpenglow catches the snow and high rock on a clear day. This is the direct low sun touching the peaks, and it is one of the first things a cloud lid takes away.' },
  { selector: '#ctrl-atmo-clear-hue', text: 'How much blue-violet the shadows carry on a clear day. With the sun off them, shadows are lit by the blue sky alone, which is where the cool cast in a sunlit landscape comes from.' },
  { selector: '#ctrl-atmo-clear-sky', text: 'The sky and distance-fog colour on a clear day. The same swatch as the Colour tab\'s sky, kept here so both ends of the weather sit side by side. Because the far distance melts into it, it sets the tone of the whole background.' },
  { selector: '#ctrl-atmo-clear-zenith', text: 'The colour directly overhead on a clear day, the top end of the sky gradient. As the weather turns grey or hazy this travels to the SAME colour the horizon does, so an overcast or hazy sky loses its gradient the way a real one does, rather than staying a deep blue on top no matter how grey the horizon gets.' },
  { selector: '#ctrl-atmo-clear-artsky', text: 'The sky colour of the painted still frame on a clear day. Separate from the sky above because the painting is authored in its own slightly greyer key rather than copying the landscape\'s sky; the weather moves both toward the same overcast colour, each from its own starting point.' },
  { selector: '#ctrl-atmo-clear-cloud', text: 'How much cloud covers the sky on a clear day. Remember the scale runs BACKWARDS — it is the threshold a cloud has to beat to exist, so LOWER means MORE cloud. High here, the default, gives a clear day an empty sky.' },
  { selector: '#ctrl-atmo-clear-cloudgrey', text: 'How far the clouds take on the colour of the sky behind them on a clear day. Normally 0: clear-weather cloud should be lit by the sun and read as separate bright shapes, not merged into the sky.' },
  { selector: '#ctrl-atmo-clear-spec', text: 'How much sharp sunlight sparkle sits on the water on a clear day. This is the sun\'s own reflection breaking up on the ripples.' },
  { selector: '#ctrl-atmo-clear-reflect', text: 'How mirror-like the water is on a clear day — how much of the sky and the far shore it throws back, as opposed to showing its own colour.' },
  { selector: '#ctrl-atmo-clear-curve', text: 'How close to you the haze reaches on a clear day. Counter-intuitive direction: LOWER means MORE haze, because this is the steepness of the fade rather than its amount.' },
  { selector: '#ctrl-atmo-clear-aerial', text: 'How much colour the distance loses on a clear day, as opposed to how much it fades. Even in clear air far ground goes a little grey before it goes pale, and that is what separates distance from a flat wash.' },
  { selector: '#ctrl-atmo-clear-near', text: 'How far from the camera the haze begins on a clear day, in world units. Far out by default, so near and middle ground stay crisp and only the far ridges soften.' },
  { selector: '#ctrl-atmo-clear-max', text: 'How completely the farthest ground dissolves into the sky on a clear day. Below 1 the most distant ridge keeps a trace of itself instead of vanishing entirely.' },

  { selector: '#ctrl-atmo-heavy-shadow', text: 'How dark shadows are allowed to go once the sky is fully overcast. Raising it lifts shaded ground toward the colour it has in sunlight, which is what flat cloud light really does — it removes the contrast between lit and shaded ground without making anything darker. At the low end a grey day still has deep shadows, which reads as dramatic rather than overcast.' },
  { selector: '#ctrl-atmo-heavy-glow', text: 'How much of the warm alpenglow on snow and high rock survives a fully overcast sky. Kept low by default: that glow is direct low sunlight catching the peaks, and behind a solid cloud lid there is none of it left to catch. Raise it if you want the peaks to keep some warmth even in grey weather.' },
  { selector: '#ctrl-atmo-heavy-hue', text: 'How much blue is left in the shadows at full overcast. Physically this should drop to 0 under a solid grey lid — there is no blue sky left to tint them — but a wholly neutral shadow reads as a rendering fault rather than weather, so this is deliberately kept up as an artistic choice standing in for the still-slightly-blue overcast dome.' },
  { selector: '#ctrl-atmo-heavy-cloud', text: 'How much cloud covers the sky at full overcast. Careful: this scale runs BACKWARDS — it is the threshold a cloud has to beat to exist, so LOWER means MORE cloud. The clear-weather value is the clear cloud-cover setting above; setting this below it is what turns the empty sky of a clear day into a solid lid, and is what makes an overcast sky actually look overcast instead of merely being lit as though it were.' },
  { selector: '#ctrl-atmo-heavy-cloudgrey', text: 'How far the clouds take on the colour of the sky behind them at full overcast. Clouds are normally coloured by the height of the sun alone, which leaves a grey day full of bright sunlit-looking clouds. Turning this up merges them into one continuous overcast lid; turning it down keeps them as separate bright shapes.' },
  { selector: '#ctrl-atmo-heavy-spec', text: 'How much sharp sunlight sparkle is left on the water at full overcast. Normally almost none — the sparkle is the sun\'s own reflection, and behind a solid cloud lid there is no disc left to reflect. This is the most immediately readable weather cue the water has.' },
  { selector: '#ctrl-atmo-heavy-reflect', text: 'How mirror-like the water is at full overcast. Higher than on a clear day by default: with the sun\'s sparkle gone, a soft reflection of the grey sky is most of what makes water read as water under cloud.' },
  { selector: '#ctrl-atmo-heavy-near', text: 'How close to the camera the haze begins at full humidity, in world units. This is what stops thick haze running out part-way across the scene: the fade always finishes at a fixed far distance, so if it also starts far away there is no room left for it to build and everything beyond a certain point ends up equally hazy, with a visible edge where it stopped. Bringing the start closer gives the haze the whole depth of the view to happen across.' },
  { selector: '#ctrl-atmo-heavy-max', text: 'How completely the farthest ground dissolves into the sky at full humidity. Below 1 the most distant ridges keep a trace of themselves and never quite merge with the sky, which leaves a faint permanent seam along the horizon. At 1 they disappear into it entirely.' },
  { selector: '#ctrl-atmo-heavy-sky', text: 'The sky and distance-fog colour at full overcast. The clear-weather sky colour stays whatever the Colour tab\'s sky swatch says; this is only the other end, and the scene moves between the two as the weather turns. Because the far distance melts into this colour, it sets the tone of the whole background, not just the strip above the horizon.' },
  { selector: '#ctrl-atmo-heavy-curve', text: 'How close to you the haze reaches at full humidity. Low brings it right up to the near hills, so even middle distance goes soft and the scene reads as deep. High keeps the air clear until almost the horizon. Counter-intuitive direction: LOWER means MORE haze, because this is the steepness of the fade rather than its amount.' },
  { selector: '#ctrl-atmo-heavy-aerial', text: 'How much colour the distance loses at full humidity, as opposed to how much it fades. At 0 far ground keeps its own greens and golds while simply getting paler. At 1 it goes grey first and only then fades into the sky — which is how real distance behaves, and what stops far hills looking like near hills seen through tracing paper.' },
  { selector: '#ctrl-atmo-heavy-light', text: 'How much light is falling on the land at full overcast. This is the plain brightness of the ground and water, and it is a different thing from the shadow floor above: the shadow floor closes the gap between sunlit and shaded ground, while this lowers both together. A grey day is genuinely darker underfoot — well under half the light of open sun — while the cloud lid itself stays bright, so the land goes dark against a glaring sky rather than the whole picture dimming evenly. Take it too low and it reads as dusk instead of as weather.' },
  { selector: '#ctrl-atmo-heavy-hazesky', text: 'The colour the distance dissolves into at full humidity, mixed in on top of whatever the cloud has already done to the sky. Milky and near-white on purpose: a clear sky is blue because air molecules scatter short wavelengths far more strongly, but haze is dust and droplets, which scatter all colours about equally — which is exactly why a hazy horizon goes white rather than deep blue. Without this a heavy haze under a clear sky would drown the far ridges in saturated blue, the one thing real haze never looks like.' },

  // ── Scene / water ──────────────────────────────────────────────────────────
  { selector: '#tog-flycam', text: 'Debug-only free camera (WASD/Space/Shift/Ctrl, drag to look). Does not change the landscape — the finished piece always uses the fixed authored viewpoint.' },
  { selector: '#ctrl-sea-low', text: 'Sea level in calm periods (world units). Higher floods more of the coastline; lower exposes more seabed.' },
  { selector: '#ctrl-sea-high', text: 'Sea level once the landscape has fully settled (world units). The water rises toward this level as the scene calms toward becoming a still painting, then settles back to "sea · calm" once it wakes up again.' },
  { selector: '#ctrl-ripple', text: 'Height of the small wind-ripple waves on the water surface.' },
  { selector: '#ctrl-wave-noise', text: 'Blends the water\'s wave pattern between a clean repeating swell (0) and an irregular, noise-driven chop (1).' },
  { selector: '#ctrl-water-depth', text: 'How far down the water must be before it reaches its fully "deep" colour, as a share of how deep the water gets in this landscape. Lower and the sea turns dark close to the shore; higher and it stays pale for longer.' },
  { selector: '#ctrl-water-bands', text: 'Splits the smooth deep→shallow colour gradient into this many flat colour steps, for a posterized/painterly look. 0 or 1 = smooth gradient.' },
  { selector: '#ctrl-water-reflect', text: 'Overall strength of the sky/terrain reflection on the water surface.' },
  { selector: '#ctrl-reflect-terrain', text: 'How much of the reflection shows the actual mirrored terrain vs. a flat sky colour. 0 = flat sky reflection only, 1 = full mirrored landscape.' },
  { selector: '#ctrl-reflect-distort', text: 'How much the ripples distort the reflection, so it wobbles with the waves instead of sitting as a perfect mirror.' },
  { selector: '#ctrl-reflect-tiers', text: 'Posterizes the reflection\'s visibility falloff (by viewing angle) into this many flat steps. Under 2 = smooth.' },
  { selector: '#ctrl-reflect-res', text: 'Resolution the mirrored reflection is rendered at, as a fraction of the screen. Lower values make the mirrored image softer/blurrier, and cheaper to render.' },
  { selector: '#ctrl-distort-steps', text: 'Quantizes the reflection\'s ripple-wobble into this many discrete facets instead of a smooth wobble. Under 1 = smooth.' },
  { selector: '#ctrl-water-spec', text: 'Brightness of the sharp sunlight glints ("sparkle") on the water surface.' },
  { selector: '#ctrl-water-sparkle', text: 'How selective the sunlight glints are — lower makes more of the water surface sparkle, higher restricts it to the brightest wave crests.' },
  { selector: '#ctrl-foam-width', text: 'How far from the shoreline the white foam band extends into the water, as a share of how deep the water gets in this landscape. It stays in proportion as the land and sea level change.' },
  { selector: '#ctrl-foam-tiers', text: 'Posterizes the foam band into this many flat steps instead of a smooth fade. Under 2 = smooth.' },
  { selector: '#ctrl-foam-amt', text: 'How strongly the foam colour blends in where it appears.' },
  { selector: '#ctrl-foam-noise', text: 'How ragged/clumped the foam edge looks. 0 = a clean depth-based band, 1 = broken up by noise into patches.' },

  // ── Clouds ───────────────────────────────────────────────────────────────
  { selector: '#tog-clouds', text: 'Turns the drifting sky clouds on or off.' },
  // ── Cloud implementation picker + the baked-volume controls ──────────────
  { selector: '#ctrl-cvol-distance', text: 'How far from you the clouds are drawn. A longer distance shows clouds right out to the horizon, but spreads the same amount of stored detail over more sky, so the clouds get softer and blobbier. A shorter distance gives crisper clouds that fade out closer to you.' },
  { selector: '#ctrl-cvol-level', text: 'How high above the ground the cloud layer sits.' },
  { selector: '#ctrl-cvol-height', text: 'Thickness of the cloud layer — taller gives clouds more visible depth and shading.' },
  { selector: '#ctrl-cvol-speed', text: 'How fast the clouds drift across the sky. Drifting is free until the clouds have moved a whole grid cell, at which point the stored cloud shape is recomputed.' },
  { selector: '#ctrl-cvol-freq', text: 'Size of the cloud masses. Lower makes fewer, larger, slower-looking cloud banks; higher makes smaller, busier clouds — but only up to the point the stored grid can hold, after which the clouds stop getting finer and start to shimmer instead.' },
  { selector: '#ctrl-cvol-density', text: 'Overall thickness/opacity of the cloud shapes.' },
  { selector: '#ctrl-cvol-coverage', text: 'How much of the sky the clouds fill. Higher = fewer, more isolated clouds; lower = a fuller, more overcast sky.' },
  { selector: '#ctrl-cvol-coverage-ease', text: 'How many seconds the cloud amount takes to follow a change, such as dragging the overcast slider. Longer makes the clouds fill or clear gradually instead of jumping; 0 follows instantly.' },
  { selector: '#ctrl-cvol-absorb', text: 'How much sunlight the clouds soak up as it passes through. Higher makes cloud undersides darker and more contrasty.' },
  { selector: '#ctrl-cvol-aniso', text: 'Whether clouds glow brightest looking toward the sun (positive) or away from it (negative). 0 = evenly lit from all directions.' },
  { selector: '#ctrl-cvol-steps', text: 'Maximum number of samples taken through a cloud along each line of sight. More gives smoother, more detailed clouds; each sample is only a memory lookup, so this is cheap to raise.' },
  { selector: '#ctrl-cvol-step-size', text: 'Distance between each sample taken through a cloud. There is little to gain from going below the grid cell size shown above, since the stored cloud shape holds no detail finer than that.' },
  { selector: '#ctrl-cvol-step-growth', text: 'Lets samples spread further apart the further away they are. Near the camera they stay close together so fine wispy detail shows; far away they spread out, which costs nothing visible because that detail is smaller than a pixel out there anyway. At 0 every sample is the same distance apart, so a fine setting runs out of samples before reaching the far clouds and the distant sky empties out.' },
  { selector: '#ctrl-cvol-detail', text: 'Adds back the fine wispy detail the stored cloud grid is too coarse to hold, worked out on the fly as you look. 0 gives the plain stored shape — soft and blobby. Higher puts back more of that missing detail, though pushed too far it starts to look lumpy rather than wispy. It only does anything if the step size above is smaller than the grid cell — otherwise the samples are too far apart to see the detail, and the readout at the top will show 0 marched octaves.' },
  { selector: '#ctrl-cvol-light-steps', text: 'How far sunlight is traced into a cloud to work out its own shadow on itself, counted in samples. This is computed ahead of time rather than while drawing, so it can afford to reach deep into the cloud for solid-looking shading.' },
  { selector: '#ctrl-cvol-light-step-size', text: 'Distance between each of those sun-facing shadow samples. Together with the sample count this sets how deep into a cloud its self-shadowing reaches.' },
  { selector: '#perf-measure', text: 'Finds out what each part of the picture costs: switches the clouds, the forest, the terrain and water passes off and back on a few times each and measures how much faster the frames get without them. Takes 15 to 30 seconds, and the picture flickers while it runs. Click again to stop early.' },
  { selector: '#ctrl-pixel-ratio', text: 'How sharply the picture is drawn: pixels drawn per screen point. A Retina laptop screen shows 2, the default. Drawing at 2 costs four times the work of 1, so lowering it draws fewer pixels and lets the browser stretch them to fill the window: faster, but softer at the edges. On an ordinary monitor or projector anything above 1 makes no difference.' },
  { selector: '#ctrl-cvol-roll-rate', text: 'When the cloud size drifts a little (the scatter dial moving on its own), the clouds are rebuilt a few slices at a time instead of all at once. This sets how many slices per frame: low keeps the frame rate smooth, high makes the clouds follow the dial more closely.' },
  { selector: '#ctrl-cvol-ground-ease', text: 'How smoothly the shadow the clouds cast on the ground (and the light shafts) follows a change in the sky. Higher blends each frame with the one before it, so the shadow glides instead of stepping, at the price of trailing the clouds a little. 0 follows every frame exactly.' },
  { selector: '#ctrl-cvol-light-rate', text: 'How much of the cloud shadowing is refreshed each frame. Low spreads the work out so the frame rate stays smooth, but shading takes a moment to catch up after clouds drift or the sun moves. High catches up immediately at the cost of an occasional stutter.' },

  { selector: '#ctrl-cvol-weather-strength', text: 'How much some patches of sky get extra-full of cloud while others thin out, on top of the plain coverage slider. 0 is an even sky everywhere; higher makes clumps of dense cloud with clearer gaps between them.' },
  { selector: '#ctrl-cvol-weather-scale', text: 'How large those cloudy/clear patches are, in world units. Smaller makes many small patches; larger makes a few broad ones.' },
  { selector: '#ctrl-cvol-weather-speed', text: 'How fast the pattern of cloudy and clear patches drifts over time, independent of how fast the clouds themselves blow past. 0 freezes the pattern in place; higher reshuffles which parts of the sky are fuller or thinner more quickly.' },

  { selector: '#ctrl-cvol-curl-freq', text: 'How large the swirls in the cloud shape are. Smaller makes many tight little swirls; larger makes a few broad, sweeping ones.' },
  { selector: '#ctrl-cvol-curl-strength', text: 'How much the cloud shape gets bent into swirls instead of drifting past in a straight line. 0 is off. Pushed too high the swirl starts folding back on itself and looks more like static than wind.' },

  { selector: '#ctrl-cdial-scatter', text: 'One dial for how broken-up the sky is: low gathers the cloud into a few broad masses, high breaks it into many small scattered ones. It drives the cloud-scale slider below, so that one moves on its own when this does. The weather never changes it: the same setting gives the same cloud size under any sky.' },
  { selector: '#ctrl-cdial-density', text: 'One dial for how solid the cloud reads: low gives thin, translucent cloud with faint light shafts, high gives thick cloud with strong shafts punching through. It drives the absorption slider below and the brightness of the light shafts together, because a denser deck makes the beams that get through look harder, not softer.' },
  { selector: '#ctrl-cvol-worley-freq', text: 'How large the cellular gaps carved into the cloud shape are. Smaller makes many small gaps; larger makes a few broad ones.' },
  { selector: '#ctrl-cvol-worley-amount', text: 'How much the smooth, rounded cloud shape gets bitten into by cellular gaps, giving a more billowy, less uniformly blobby look. 0 is off (the plain smooth shape).' },
  { selector: '#ctrl-cvol-worley-erosion', text: 'How strongly those gaps reshape the cloud, once worley amount above is turned up. Higher digs the gaps deeper AND piles the cloud up thicker in between them, so the shape gets lumpier without getting smaller overall; lower leaves it closer to its original rounded form.' },
  { selector: '#ctrl-cvol-worley-octaves', text: 'How many layers of gap-carving detail are combined, once worley amount above is turned up. More adds finer nested gaps on top of the broad ones, at a small extra cost when the cloud shape is (re)computed.' },

  { selector: '#ctrl-cvol-planet-curve', text: 'How much the cloud layer sinks toward the horizon at a distance, mimicking a curved planet, so it does not just stop with a flat edge and empty sky beneath it. Smaller makes the sinking more pronounced (a smaller, more visibly curved world); larger flattens it out. 0 turns the effect off entirely.' },

  { selector: '#ctrl-cloud-color-steps', text: 'How many flat tonal bands a cloud\'s shading is split into, for a flat painted look. Higher = more bands. 0 = off.' },
  { selector: '#ctrl-cloud-alpha-tiers', text: 'How many flat opacity steps a cloud\'s edge fades through, instead of a smooth fade. 0 or 1 = smooth edge.' },
  { selector: '#tog-cloud-sint', text: 'A more physically exact way of adding up sunlight scattered through a cloud along each sample step. Mostly matters at a coarse step size — with fine steps the difference is negligible.' },
  { selector: '#tog-cloud-powder', text: 'Darkens the sun-facing edges of clouds slightly, like the dusty look of a thin layer of powdered sugar catching light. Only visible looking toward the sun.' },
  { selector: '#ctrl-cloud-powder-strength', text: 'Only used when powder edge darkening above is checked: how strong the darkening is. Higher = darker sun-facing edges.' },

  // ── Terrain shape · Form ────────────────────────────────────────────────────
  { selector: '#ctrl-form-ocean', text: 'One-slider shortcut that pushes several settings at once toward "more ocean" (lower land, more of the map underwater) or "less ocean".' },
  { selector: '#ctrl-form-mountains', text: 'One-slider shortcut that pushes several settings at once toward taller, more rugged mountains, or gentler terrain.' },

  // ── Terrain shape · Landform ────────────────────────────────────────────────
  // fBM = "fractal Brownian motion": several layers of noise at different
  // scales added together — the basic technique this landscape's height comes
  // from. Explained once here; later sections assume it.
  { selector: '#tog-basefbm', text: 'Turns the base terrain noise (fBM — several layered noise scales summed together, the landscape\'s underlying shape) on or off. Off = a flat plane, no hills at all.' },
  { selector: '#ctrl-octaves', text: 'Number of noise layers summed into the base terrain shape. More octaves add finer bumps and detail on top of the big landforms; fewer gives a smoother, simpler shape.' },
  { selector: '#ctrl-segments', text: 'How many triangles make up the terrain mesh (per side). Higher looks smoother and shows finer detail, at a performance cost.' },
  { selector: '#ctrl-ridge-amt', text: 'How much of the terrain reads as sharp mountain ridges rather than rounded, rolling hills.' },
  { selector: '#ctrl-ridge-round', text: 'Rounds off the very tip of each ridge crease. 0 = knife-sharp crests (can look "wormy" once carved by erosion); higher softens the crest.' },

  // ── Terrain shape · Bedrock & mantle ────────────────────────────────────────
  { selector: '#ctrl-bedrock-octaves', text: 'Noise detail (see "octaves" above) used ONLY for the exposed rocky bedrock layer — independent from the softer mantle layer\'s own detail.' },
  { selector: '#ctrl-mantle-relief', text: 'How much vertical relief (bumpiness) the soil/mantle layer has, as a fraction of the bedrock layer\'s. Lower makes valleys and lower ground look smoother and more filled-in.' },
  { selector: '#ctrl-mantle-bias', text: 'Raises or lowers the soil layer relative to the rock layer — think "how much soil has accumulated". Higher buries more of the terrain in soil, leaving less bare rock exposed.' },

  // ── Terrain shape · Where rock detail appears ───────────────────────────────
  { selector: '#ctrl-gate-amt', text: 'How completely the rock detail is suppressed on low ground when the height gate (above) is on. 1 = fully suppressed low down; lower leaves a bit of detail everywhere.' },
  { selector: '#ctrl-gate-lo', text: 'The (normalized) elevation below which rock detail starts fading out.' },
  { selector: '#ctrl-gate-hi', text: 'The (normalized) elevation above which rock detail is at full strength.' },

  // ── Terrain shape · What rock detail looks like ─────────────────────────────
  { selector: '#ctrl-rock-ridge', text: 'How creased/jagged the exposed rock surface looks, independent of the main ridge-amount setting above.' },
  { selector: '#ctrl-rock-persist', text: 'How much each finer layer of rock detail contributes relative to the coarser layer beneath it — higher keeps fine detail more visible, lower smooths it away faster.' },
  { selector: '#ctrl-rock-aniso', text: 'Stretches the rock\'s surface detail into elongated joint-like bands rather than uniform lumps — higher reads as more blade-like fracture lines.' },
  { selector: '#ctrl-rock-joint', text: 'Rotates the direction the rock\'s joint/fracture bands run.' },

  // ── Terrain shape · Inspect ──────────────────────────────────────────────────
  { selector: 'input[name="field-solo"][value="0"]', text: 'Shows the normal, fully composed terrain (bedrock + mantle combined, as in the finished piece).' },
  { selector: 'input[name="field-solo"][value="1"]', text: 'Debug view: shows ONLY the rocky bedrock layer everywhere, as if the soil/mantle layer did not exist — useful for judging that layer on its own.' },
  { selector: 'input[name="field-solo"][value="2"]', text: 'Debug view: shows ONLY the soil/mantle layer everywhere, as if the rocky bedrock layer did not exist — useful for judging that layer on its own.' },

  // ── Erosion ─────────────────────────────────────────────────────────────────
  { selector: '#tog-erosion', text: 'Turns the erosion simulation on or off. Off = the raw noise-generated terrain with no carved gullies or sharpened ridges.' },
  { selector: '#ctrl-ero-scale', text: 'Size of the simulated water-erosion gullies — a larger value makes bigger, wider and deeper gullies; a smaller value a finer, tighter gully network.' },
  { selector: '#ctrl-ero-strength', text: 'How deeply the erosion simulation carves into the terrain overall.' },
  { selector: '#ctrl-ero-gully', text: 'How much weight the erosion simulation gives to carving narrow gullies specifically, versus its other (ridge-sharpening) effects.' },
  { selector: '#ctrl-ero-time', text: 'How fast the gully pattern slowly drifts/migrates over time, so the carved network isn\'t perfectly static.' },
  { selector: '#ctrl-ero-detail', text: 'Strength of fine wrinkle-detail added inside the carved gullies — higher adds visible fine texture to gully walls, lower leaves them smoother.' },
  { selector: '#ctrl-ero-octaves', text: 'Number of noise layers (see "octaves" under Landform) used inside the erosion simulation itself — more adds finer gully sub-detail.' },
  { selector: '#ctrl-ero-ridge-round', text: 'Rounds off sharp ridge creases specifically within the erosion simulation\'s own carving, separate from the main "ridge roundness" slider.' },
  { selector: '#ctrl-ero-crease-round', text: 'Rounds off sharp gully/crease bottoms within the erosion simulation, softening how deep, narrow channels come to a point.' },
  { selector: '#ctrl-ero-input-round', text: 'Softens how much the erosion simulation reacts to sharp peaks in the terrain it\'s carving — higher avoids needle-like spikes at summits.' },
  { selector: '#ctrl-ero-peak', text: 'How aggressively the erosion simulation sharpens mountain peaks and valley floors toward a point. 1 = original strong sharpening (can produce tall needle spikes); 0 = no peak-sharpening at all, flatter summits.' },

  // ── Camera clearance ────────────────────────────────────────────────────────
  { selector: '#ctrl-cam-pit-radius', text: 'How far out from the fixed camera position the "keep the camera clear" terrain compression extends. Larger = a gentler, wider dip around the camera; smaller = a tighter one.' },
  { selector: '#ctrl-cam-pit-floor', text: 'The maximum terrain height allowed directly at the camera\'s own position — guarantees the camera can never end up buried inside a mountain. Its maximum is capped in code so it can never be set higher than the camera itself.' },
  { selector: '#ctrl-cam-pit-ease', text: 'How gently the camera-clearing dip fades out with distance. Lower values (near 1) spread the dip gently over a wide area; higher values shrink it toward a sharp, narrow dip right at the camera.' },

  // ── Biome zonation ──────────────────────────────────────────────────────────
  // "flatness" = how flat vs. steep the ground is at a point. "aspect" = which
  // way a slope faces (sunlit vs. shaded side). "moisture"/"hollowness" = how
  // concave/valley-like a point is, used as a stand-in for dampness.
  { selector: '#ctrl-tree-base', text: 'Elevation (normalized 0–1) above which forest starts giving way to open/alpine ground. Lower brings the treeline down the mountain; higher pushes it up.' },
  { selector: '#ctrl-tree-aspect', text: 'How much the sunward vs. shaded side of a slope shifts the treeline up or down (sun-facing slopes can support trees a bit higher).' },
  { selector: '#ctrl-tree-wind', text: 'How much wind-exposed convex ridges push the treeline down, thinning trees on exposed spurs.' },
  { selector: '#ctrl-snow-base', text: 'Elevation (normalized 0–1) above which snow starts appearing. Lower puts more of the mountains under snow.' },
  { selector: '#ctrl-scree-band', text: 'Width of the bare rocky "scree" band that sits just below the snowline, between snow and vegetation.' },
  { selector: '#ctrl-cliff-flat', text: 'Flatness threshold below which ground counts as "too steep for soil" and reads as bare rock/cliff instead of a vegetated slope.' },
  { selector: '#ctrl-pasture-flat', text: 'Flatness threshold above which forested ground instead reads as open meadow/pasture.' },
  { selector: '#ctrl-riparian', text: 'How much extra dampness (hollowness) a gully floor needs before it reads as a lush green streamside band instead of ordinary forest/rock.' },
  { selector: '#ctrl-hollow-radius', text: 'Radius (world units) used to measure large-scale concavity — how "valley-like" a broad area is, which feeds the moisture/hollowness look of the terrain.' },
  { selector: '#ctrl-crease-radius', text: 'Radius (world units) used to measure small-scale concavity — how "gully-like" a narrow feature is, which feeds fine-scale dampness/hollowness detail.' },
  { selector: '#ctrl-height-lo', text: 'Normalized elevation where the low end of the height-based colour palette begins (deep/valley colours).' },
  { selector: '#ctrl-height-hi', text: 'Normalized elevation where the high end of the height-based colour palette is reached (peak colours).' },

  // ── Forest ──────────────────────────────────────────────────────────────────
  { selector: '#tog-forest', text: 'Turns the forest tree forest (individual crowns + clearings between them) on or off. Off = biome colour only, no tree shapes.' },
  { selector: '#ctrl-forest-cell', text: 'Spacing (world units) between candidate tree positions — larger spreads trees further apart, smaller packs them denser.' },
  { selector: '#ctrl-forest-jitter', text: 'How far each tree\'s position is randomly nudged off its regular grid slot, so the forest doesn\'t look mechanically gridded.' },
  { selector: '#ctrl-forest-depth', text: 'How much darker/lighter a crown\'s shading steps swing from the base forest colour — higher gives crowns more visible tonal depth.' },
  { selector: '#ctrl-forest-fillpad', text: 'How far the solid-forest-fill effect (above) is allowed to bleed past a biome boundary (e.g. into a clearing) before stopping.' },
  { selector: '#ctrl-forest-band', text: 'How gradually the baseline tree-appearance chance (see "on rock/on snow/on meadow/on shore" below) ramps up or down at a biome boundary, instead of switching abruptly.' },
  { selector: '#ctrl-forest-grow', text: 'Width of the probability window over which trees "grow in" — a narrow window makes the treeline a sharper on/off edge; a wide one makes it a gradual thinning.' },
  { selector: '#ctrl-forest-on-rock', text: 'Baseline chance of a stray tree appearing on bare rock ground, outside the normal forest belt.' },
  { selector: '#ctrl-forest-on-snow', text: 'Baseline chance of a stray tree appearing on snow-covered ground, outside the normal forest belt.' },
  { selector: '#ctrl-forest-on-mdw', text: 'Baseline chance of a stray tree appearing on open meadow, outside the normal forest belt.' },
  { selector: '#ctrl-forest-on-shore', text: 'Baseline chance of a stray tree appearing right at the shoreline, outside the normal forest belt.' },
  { selector: '#ctrl-forest-on-rip', text: 'How heavily streamside gully floors are stocked with trees. Unlike the other four, this one can go ABOVE 1: past that the gully is fully wooded while the hillside around it stays at the forest baseline, which is what makes gallery forest read as a thicker line along the valley bottom.' },
  { selector: '#ctrl-forest-spillfade', text: 'How far stray trees (the "on rock/snow/meadow" sliders above) can spread past the forest\'s boundary before fading out completely.' },
  { selector: '#ctrl-forest-ribthin', text: 'Thins stray trees out on wind-exposed convex ridges, so spilled trees favour sheltered draws instead of scattering evenly.' },
  { selector: '#ctrl-forest-slopethin', text: 'Thins stray trees out on steep ground, so spilled trees favour flatter terrain.' },

  // ── Forest form ─────────────────────────────────────────────────────────────
  { selector: '#ctrl-forest-wobflat', text: 'How much the ragged outline effect is limited to flat ground — on steep ground it\'s reduced by this amount.' },
  { selector: '#ctrl-forest-slope', text: 'How strongly the lean/elongation shaping is gated by steepness — 1 restricts it fully to slopes, 0 applies it everywhere.' },
  { selector: '#ctrl-forest-hgtflat', text: 'How much crown height is tied to how flat the ground is — higher makes trees on flat ground taller relative to trees on slopes.' },
  { selector: '#ctrl-forest-lod-hi', text: 'Distance at which distant crowns are fully simplified away. Individual crown shapes fade out over the last third of the way to this distance and stop being drawn beyond it.' },

  // ── Shore ───────────────────────────────────────────────────────────────────
  { selector: '#ctrl-shore-width', text: 'Width of the sandy shoreline band where land meets water.' },
  { selector: '#ctrl-shore-noise', text: 'How irregular/wavy the sandy shoreline\'s edge looks, instead of tracking the water level in a perfectly even band.' },
  { selector: '#ctrl-beach-flat', text: 'Flatness threshold a shoreline point needs to qualify as sandy beach rather than a rocky/cliff shore.' },
  { selector: '#ctrl-beach-moist', text: 'Moisture threshold a shoreline point needs to qualify as sandy beach.' },

  // ── Colour & light ──────────────────────────────────────────────────────────
  { selector: '#tog-diffuse', text: 'Turns sunlight-direction shading on or off. Off = every surface is lit flatly regardless of which way it faces the sun.' },
  { selector: '#tog-fog', text: 'Turns distance fog on or off — the effect that fades distant terrain toward the sky colour, giving a sense of depth.' },
  { selector: '#ctrl-sun-elev', text: 'How high the sun sits in the sky, controlling the overall lighting angle across the whole scene.' },
  { selector: '#ctrl-sun-azimuth', text: 'Which compass direction the sun shines from, rotating the shadows and lit sides of the terrain and clouds around without changing how high the sun sits.' },
  { selector: '#ctrl-shade-lo', text: 'The dark end of the sunlight-response range — surfaces facing this far from the sun (or further) render at full shadow tone.' },
  { selector: '#ctrl-shade-hi', text: 'The bright end of the sunlight-response range — surfaces facing this close to the sun (or closer) render at full lit tone.' },
  { selector: '#ctrl-aerial-desat', text: 'How much colour is drained from distant terrain as the aerial-perspective fog takes over.' },
  { selector: '#ctrl-fog-curve', text: 'Shapes how the haze builds up with distance. 1 is a plain even fade. Above 1, things stay clear for longer and then fade quickly near the far edge; below 1, the haze sets in early and eases off gradually after. Applies to both land and water so the horizon still matches.' },
  { selector: '#ctrl-fog-max', text: 'How completely the haze can take over at the far edge. 1 lets it fully melt into the sky, same as before; lower keeps a trace of colour visible even at the horizon instead of a hard wall of fog. Applies to both land and water so the horizon still matches.' },
  { selector: '#ctrl-shadow-value', text: 'Brightness of the shadow tone used on surfaces facing away from the sun.' },
  { selector: '#ctrl-shadow-desat', text: 'How much colour is drained out of shadowed ground before it is tinted. At 0 a shadow keeps its own material colour; at 1 it goes neutral grey first and takes only the shadow tint below. Works together with that one: this decides how much of the material survives, that one decides what colour replaces it.' },
  { selector: '#ctrl-shadow-hue-amt', text: 'How strongly shadows are tinted toward the shadow colour picked on this tab — the blue of the open sky, which is what actually lights a shadow on a clear day. At 0 shadows keep their own colour, just darker; turn it up and they go blue. This changes colour only and never brightness, so it is independent of shadow val above. Note that in very dark shadows no colour is visible at all — if turning this up appears to do nothing, raise shadow val first.' },
  { selector: '#ctrl-glow', text: 'Strength of the warm "alpenglow" highlight colour on sun-facing surfaces (mainly high, exposed ground like snow and rock).' },
  { selector: '#ctrl-cloudshadow-amt', text: 'How strongly the clouds cast shadows onto the landscape below them. At 0 the ground is lit as though the sky were empty, however much cloud is overhead. Turning it up drifts patches of shade across the hills in step with the clouds you can actually see, which is the single thing that makes an overcast sky feel like it is above a real place rather than painted behind one.' },
  { selector: '#ctrl-cloudshadow-abs', text: 'How dark a cloud shadow gets for a given thickness of cloud. Low means only the densest cores darken the ground at all; high means even thin cloud casts a clear patch. This is separate from the clouds\' own opacity slider on purpose — otherwise deepening the shadows would also thicken every cloud in the sky. Tied directly to the cloud-density dial above: at full density this sits at 1, at zero density it sits at 0, so dragging it by hand only matters while that dial is not itself moving.' },
  { selector: '#ctrl-cloudshadow-floor', text: 'How dark the ground is allowed to go under the very thickest cloud. Raising it keeps shadowed ground readable and coloured; taking it to 0 lets a heavy cloud black the land out completely, which usually reads as a hole in the picture rather than as shade.' },
  { selector: '#ctrl-cloudshadow-tiers', text: 'How many flat steps a cloud shadow is quantised into, so it reads as printed shapes rather than a soft airbrushed gradient. At 1 the shadow fades smoothly, which is the one thing in this landscape that would not look posterized. Higher counts give a finer staircase; 3 or 4 keeps the shadow edges as decisive as the terrain\'s own tonal bands.' },
  { selector: '#tog-godrays', text: 'Visible beams of sunlight slanting through the air where gaps in the cloud let the sun through. The sun here sits well off to the side of the view, so the shafts rake across the picture rather than fanning out from a visible disc — and they are strongest when the sky is half covered, since a beam is the contrast between lit air and shadowed air and needs both to exist.' },
  { selector: '#ctrl-ray-intensity', text: 'How bright the light shafts are. This is the one to reach for first; everything else below shapes them.' },
  { selector: '#ctrl-ray-density', text: 'How much haze is in the air for the sunlight to catch on. Nothing in perfectly clear air makes a beam visible — you are seeing light scattered off dust and moisture, so with no medium there is nothing to see. Raising it thickens every shaft at once.' },
  { selector: '#ctrl-ray-absorption', text: 'How deeply a cloud has to block the sun before the air beneath it goes dark. Low means only the thickest cloud cores carve a shaft; high means even thin cloud cuts a clean edge. Separate from the ground-shadow control above so beams and ground shade can be tuned apart.' },
  { selector: '#ctrl-ray-tiers', text: 'How many flat steps the beams are quantised into, so they read as printed bands of light rather than a soft glow. At 1 they fade smoothly, which is the one thing here that would look out of place against the rest of the picture.' },
  { selector: '#ctrl-ray-hardness', text: 'How sharply the edge of a beam is cut. The cloud shadow this is carved from is a smooth, low-frequency field, and tracing something that soft gives soft blobs rather than shafts. Turning this up cuts it toward a clean lit/unlit boundary, which is what lets the beams read as straight-edged wedges of light instead of a glow. At 0 you get the raw soft field.' },
  { selector: '#ctrl-ray-threshold', text: 'How much cloud has to be overhead before the air below counts as shadowed. Lower it and only the thickest cloud casts a shaft; raise it and the faintest wisp does. Note that the control below pulls this onto the nearest step of the ground shade, so it moves in jumps rather than smoothly while that is turned up.' },
  { selector: '#ctrl-ray-cutsnap', text: 'How closely a beam\'s edge is made to line up with the cloud shadow on the ground. The shade on the land is painted in a few flat steps, and at full strength the air is made to go dark at exactly the step where the ground does — so a shaft and the pool of light it falls into are one thing rather than two that nearly agree. Turn it down to tune the beams apart from the ground shade on purpose.' },
  { selector: '#ctrl-ray-gateonset', text: 'How grey the day has to be before any light shafts appear at all. Shafts are a heavy-weather sight: you need a deck thick enough that the land under it has gone dark, and a break in it for the light to come through, so they belong at the very top of the cloud range. Below this setting there are none, and from here up to the greyest sky they come up to full strength. Nothing is drawn while there are none, so the setting also decides how often the effect costs anything.' },
  { selector: '#ctrl-ray-nearfade', text: 'How much of the air immediately in front of the camera is left out of the shafts. That near air fills most of the picture, so light picked up there arrives as a flat veil over everything rather than as a beam with a shape. Pushing this out keeps the shafts where they read as shafts, out across the landscape. The cut is gradual, so nothing draws a visible line across the image.' },
  { selector: '#ctrl-ray-deckfade', text: 'How far up into the cloud a shaft dissolves before it disappears. At 0 every beam stops dead at the cloud base, on one flat plane, which reads as the light switching on at a fixed height rather than streaming out of a cloud. Raising it lets the shafts fade into the cloud that is casting them.' },
  { selector: '#ctrl-ray-drop', text: 'How quickly a shaft dims on its way down from the cloud. In every photograph of real sun shafts the beam is brightest where it leaves the cloud and dissipates as it falls toward the ground. At 0 the shaft is equally bright along its whole length, which makes it read as a flat overlay on the picture instead of light coming out of a cloud.' },
  { selector: '#ctrl-ray-aniso', text: 'How much the shafts favour the side of the frame the sun is on. At 0 they are equally bright everywhere; turning it up brightens the sunward edge of the picture and darkens the far side, which is what real air does and what gives the effect its glare. Note it does not change how strong the beams are against their own shadows — only how that brightness is spread across the frame.' },
  { selector: '#ctrl-ray-soften', text: 'How much the beams are blurred before being cut into steps. A little smoothing first is what lets the steps land as clean bands instead of speckle; too much and the shafts lose their edges altogether.' },
  { selector: '#ctrl-ray-maxdist', text: 'How far from the camera the shafts are traced. Beyond the distance where haze has already whited everything out there is nothing left for them to add, so tracing further costs frames and shows nothing.' },
  { selector: '#ctrl-ray-steps', text: 'How many samples each beam is built from. Fewer is faster but lays down banding across the picture; more is smoother and slower. The sampling is jittered, so moderate counts look better here than the number suggests.' },
  { selector: '#ctrl-ray-color', text: 'The colour of the light in the shafts. Pale warm cream by default, so the beams read as sunlight rather than as a coloured effect added on top.' },
  { selector: '#ctrl-light-level', text: 'Overall brightness of the land and water — how much light is falling on the scene. Separate from the shadow controls: those change how far apart lit and shaded ground sit, this moves both together. The sky is deliberately left out of it, so lowering this darkens the landscape against an unchanged sky rather than dimming the whole picture, which is how an overcast day actually looks. Driven by the weather when that is switched on.' },
  { selector: '#ctrl-light-steps', text: 'Number of flat lighting steps used for the cel-shaded (posterized) look, instead of a smooth lighting gradient.' },
  { selector: '#ctrl-band-noise', text: 'How much noise wobbles the edges between lighting/colour bands, so they read as hand-painted rather than perfectly crisp.' },
  { selector: '#ctrl-band-scale', text: 'Spatial scale of the band-edge wobble noise above — smaller value gives a coarser, larger-scale wobble.' },

  // ── Debug view (changes what is DISPLAYED, not the landscape itself) ───────
  { selector: 'input[name="debug-view"][value="0"]', text: 'Normal rendering — the finished material colours, as seen in the piece.' },
  { selector: 'input[name="debug-view"][value="1"]', text: 'Debug view: visualizes raw terrain height as brightness (dark = low, bright = high).' },
  { selector: 'input[name="debug-view"][value="2"]', text: 'Debug view: visualizes how flat vs. steep the ground is (red = steep, white = flat).' },
  { selector: 'input[name="debug-view"][value="3"]', text: 'Debug view: visualizes which way a slope faces relative to the sun (blue = shaded side, red = sun-facing side).' },
  { selector: 'input[name="debug-view"][value="4"]', text: 'Debug view: visualizes small-scale concavity — narrow gully-like dips (blue = convex rib, red = concave gully).' },
  { selector: 'input[name="debug-view"][value="5"]', text: 'Debug view: visualizes large-scale concavity — broad valley-like areas (blue = convex mass, red = concave valley).' },
  { selector: 'input[name="debug-view"][value="6"]', text: 'Debug view: visualizes the derived "moisture" signal used for damp-ground biome placement (tan = dry, blue = wet).' },
  { selector: 'input[name="debug-view"][value="7"]', text: 'Debug view: visualizes the erosion simulation\'s ridge/crease map (blue = crease, white = ridge).' },
  { selector: 'input[name="debug-view"][value="8"]', text: 'Debug view: visualizes how much the erosion simulation raised or carved each point (red = carved away, green = built up into a ridge).' },
  { selector: 'input[name="debug-view"][value="9"]', text: 'Debug view: visualizes the combined hollowness signal used for biome placement (blue = ridge, red = valley).' },
  { selector: 'input[name="debug-view"][value="10"]', text: 'Debug view: shows each biome (forest, meadow, snow, rock, etc.) as a flat, distinct colour key instead of its real shaded colour.' },
  { selector: 'input[name="debug-view"][value="11"]', text: 'Debug view: visualizes the surface normal (the direction each point faces) as an RGB colour — the raw input the lighting is computed from.' },
  { selector: 'input[name="debug-view"][value="12"]', text: 'Debug view: visualizes N·L — the angle between the ground\'s surface direction and the sunlight direction — before any colour is applied (blue = facing away from sun, white = grazing angle, red = directly sunlit).' },
  { selector: 'input[name="debug-view"][value="13"]', text: 'Debug view: visualizes tree forest coverage as brightness (dark = bare ground, bright = full crown).' },
  { selector: 'input[name="debug-view"][value="14"]', text: 'Debug view: shows which of the two terrain layers (bedrock vs. mantle/soil) is exposed at each point (green = mantle, tan = bedrock).' },

  // ── fBM debug ───────────────────────────────────────────────────────────────
  { selector: '#tog-time-axis', text: 'Turns off-clock terrain evolution on or off. Off = the terrain becomes a rigid pattern that only slides (drifts) without otherwise changing shape.' },
  { selector: '#tog-drift', text: 'Turns the terrain\'s slow spatial drift (its noise pattern sliding across the map over time) on or off.' },
  { selector: '#fbm-basespeed-0', text: 'Overall drift speed multiplier for noise layer 0 (see "fBM instance 0" below) — how fast its pattern slides across the map.' },
  { selector: '#fbm-basespeed-1', text: 'Overall drift speed multiplier for noise layer 1 (see "fBM instance 1" below) — how fast its pattern slides across the map.' },

  // ── fBM instance 0 / 1 (the two noise layers summed to make the base terrain) ─
  { selector: '#f0-freq', text: 'Spatial frequency of noise layer 0 — lower value means larger, broader landforms from this layer; higher means smaller, tighter ones.' },
  { selector: '#f0-amp', text: 'Height contribution (world units) of noise layer 0 — how tall the landforms from this layer can get.' },
  { selector: '#f0-timespeed', text: 'How fast noise layer 0 evolves over time (independent of its spatial drift), gradually reshaping the terrain it contributes.' },
  { selector: '#f0-persistence', text: 'Persistence (how much each finer noise octave contributes relative to the coarser one beneath it) for layer 0 — lower gives smoother, rounder hills; higher gives sharper, more rugged terrain.' },
  { selector: '#f0-lacunarity', text: 'Lacunarity (how much smaller each finer noise octave\'s scale is than the one beneath it) for layer 0 — lower gives a gentler size progression between detail levels; higher gives a more aggressive jump.' },
  { selector: '#f1-freq', text: 'Spatial frequency of noise layer 1 — lower value means larger, broader landforms from this layer; higher means smaller, tighter ones.' },
  { selector: '#f1-amp', text: 'Height contribution (world units) of noise layer 1 — how tall the landforms from this layer can get.' },
  { selector: '#f1-timespeed', text: 'How fast noise layer 1 evolves over time (independent of its spatial drift), gradually reshaping the terrain it contributes.' },
  { selector: '#f1-persistence', text: 'Persistence (how much each finer noise octave contributes vs. the coarser one beneath it) for layer 1 — lower gives smoother, rounder hills; higher gives sharper, more rugged terrain.' },
  { selector: '#f1-lacunarity', text: 'Lacunarity (how much smaller each finer noise octave\'s scale is than the one beneath it) for layer 1 — lower gives a gentler size progression between detail levels; higher gives a more aggressive jump.' },

  // ── Sound tab ────────────────────────────────────────────────────────────────
  { selector: '#tog-sound', text: 'Turns the soundscape on. Starts the audio engine the first time you check it.' },
  { selector: '#ctrl-master-gain', text: 'Overall volume of everything — wind, water, birds, and the painting sounds together.' },

  { selector: 'input[name="snd-solo"][value=""]', text: 'Play the whole soundscape as the piece actually sounds, with every layer mixed together.' },
  { selector: 'input[name="snd-solo"][value="wind"]', text: 'Mute everything except the wind, so you can hear its gusting and tone on their own.' },
  { selector: 'input[name="snd-solo"][value="trees"]', text: 'Mute everything except the trees, so you can hear the leaves alone — the rustle, how fast it flutters, and how long it keeps going after a gust has passed. Nothing else is playing, so if this is silent the forest genuinely is.' },
  { selector: 'input[name="snd-solo"][value="surf"]', text: 'Mute everything except the water, so you can hear the swell breathing and the waves breaking on their own.' },
  { selector: 'input[name="snd-solo"][value="birds"]', text: 'Mute everything except the birds, so you can judge the calls without wind and water over them.' },
  { selector: 'input[name="snd-solo"][value="paint"]', text: 'Mute everything except the painting sounds — the brushed sweep, the grain of the marks, and the cracks as it breaks apart.' },

  { selector: '#snd-test-tone', text: 'Play a plain beep wired straight to the speakers, skipping the whole soundscape. If you can hear this but not the landscape, the fault is in the soundscape itself; if you cannot hear even this, the browser or the computer is blocking or misrouting the sound and nothing in this panel will help.' },

  { selector: '#snd-play-bird', text: 'Play one bird call close by, right now, so you can hear its detail. Most calls in the piece are far away and much softer than this.' },
  { selector: '#snd-play-birdfar', text: 'Play one distant bird call, at the range most of them actually sit at during the piece.' },
  { selector: '#snd-play-break', text: 'Play one breaking wave immediately, instead of waiting for the swell to rise high enough to break on its own.' },
  { selector: '#snd-play-gust', text: 'Send one gust through the trees, with no wind in front of it. It drives the real forest layer rather than playing a separate demo sound, so what you hear is exactly what the scene produces — it swells, then dies away over the whisper time set below.' },
  { selector: '#snd-play-sweep', text: 'Play the brushed sweep heard once as the canvas is toned, at the very start of the painting appearing.' },
  { selector: '#snd-play-stroke', text: 'Play one brush stroke — the grainy patter heard as marks land on the canvas while the painting is being made.' },
  { selector: '#snd-play-crack', text: 'Play one crack of the paint, the dry snapping sound heard as the painting breaks apart and dissolves.' },

  { selector: '#ctrl-wind-level', text: 'Loudness of the wind on its own. The wind is the layer that never fully goes away, so this also sets the quietest the piece ever gets.' },
  { selector: '#ctrl-tree-level', text: 'Loudness of the trees as a whole. The leaves are their own voice now rather than part of the wind, so this sets how much of the mix the forest takes, independently of how hard the wind itself is blowing.' },
  { selector: '#ctrl-leaf-level', text: 'How strongly the leaves answer each gust. This is the rustle of leaves and needles — it only appears when there is forest on screen, it swells as each gust arrives and keeps whispering for a second or two after the gust has passed, and it flutters faster the harder the wind blows. At 0 the trees fall silent and only the bare air is left.' },
  { selector: '#ctrl-leaf-flutter', text: 'How quickly the leaves flip back and forth when the wind is at its hardest. Low settings give big, slow, broad leaves; high settings give small dry ones that chatter. This is the single cue that separates a tree from a fan — without the flutter the layer is just hiss.' },
  { selector: '#ctrl-leaf-tail', text: 'How long the trees go on whispering after a gust has passed. At the low end they stop the instant the air does, which sounds mechanical; longer settings let the forest keep moving on its own for a while, the way a real tree does once it has been set going.' },
  { selector: '#ctrl-leaf-tone', text: 'The character of the foliage. Toward the left it is dry and thin, all top and no weight — grass, heath, bare twigs. Toward the right it is a full forest with body underneath the hiss. The middle leaves it wherever the amount of forest on screen puts it.' },
  { selector: '#ctrl-surf-level', text: 'Loudness of the water on its own — both the slow breathing swell and the waves that break out of it.' },
  { selector: '#ctrl-surf-break-level', text: 'How loud a breaking wave is compared to the steady water sound underneath it — turn up to make crashes punch out more, turn down for a smoother wash.' },
  { selector: '#ctrl-bird-level', text: 'Loudness of the bird calls on its own, without changing how often they happen.' },
  { selector: '#ctrl-bird-rate', text: 'How often birds call, as a multiple of normal. The landscape still decides the actual rate — lots of forest means lots of birds, and open sea or bare rock means none however high this is set.' },
  { selector: '#ctrl-reverb-level', text: 'How much space the sounds appear to be in. Low is dry and immediate; high puts the landscape in a wide valley and is what makes distant birds sit behind near ones.' },

  { selector: '#ctrl-distance-depth', text: 'How far the landscape seems to retreat when the picture is painted over it. At 0 the world stays exactly where it is; at 1 it pulls right back, as if you had stepped inside and were hearing it through glass.' },
  { selector: '#ctrl-distance-cutoff', text: 'How muffled the landscape gets once it has fully retreated behind the painting. Lower is more muffled and further away; higher keeps it clear and close even at full distance.' },
  { selector: '#tog-room-mode', text: 'Instead of the landscape merely retreating behind the painting, it drains away almost completely, leaving only the quiet of the room the picture hangs in. The starker reading of the same moment.' },
  { selector: '#tog-paint-sound', text: 'Whether the act of painting is audible at all — the brushed sweep as the canvas tones, the grain of the marks landing, and the cracking as it dissolves. Turn it off to leave only the landscape retreating and returning.' },
  { selector: '#ctrl-paint-level', text: 'Loudness of the painting sounds. These are deliberately dry and close, so they sit in front of the landscape rather than in the same space as it.' },

  // ── Bottom control bar ──────────────────────────────────────────────────────
  { selector: '#attention', text: 'Simulates viewer engagement. Each position settles the landscape at its own steady energy level and holds it there: turning it up calms the terrain toward smoother, slower change but speeds up the countdown to it settling into a still painting, while turning it down keeps the terrain more restless day-to-day and delays that settling. The move is gradual — see "attention inertia" in the Interaction section for how long it takes to arrive.' },
  { selector: '#fullscreen', text: 'Shows the painting alone, filling the whole screen. Double-clicking the painting does the same; Esc leaves. The control bar hides until the mouse moves to the bottom edge, and the mouse pointer hides when it stops moving.' },

  // ── Mic tab ────────────────────────────────────────────────────────────────
  { selector: '#int-src-mic', text: 'Lets the room\'s own sound drive the landscape instead of the Attention slider above — a quiet, still room settles it toward stillness, a noisy or busy one keeps it restless. Asks for microphone permission the first time you turn it on.' },
  { selector: '#mic-calibrate', text: 'Listens to the room for about a second and remembers its current sound level as "quiet". Do this once when the room is empty or settled, so the landscape can tell a genuinely quiet room from a noisy one wherever it\'s installed. The installation\'s own sound is accounted for, so it is fine to calibrate while it is playing.' },
  { selector: '#ctrl-mic-floor', text: 'The room\'s own sound level that counts as "quiet", in decibels, not counting the installation\'s own sound. Calibrate Empty Room sets this for you — only move it by hand if you want to override that reading.' },
  { selector: '#ctrl-mic-span', text: 'How many decibels louder than "quiet" counts as fully restless. A smaller span makes the landscape react to quieter sounds; a larger one needs a louder room before it reacts at all.' },
  { selector: '#ctrl-mic-tau', text: 'How many seconds the mic-derived attention takes to catch up with a sudden change in the room, smoothing out short bursts like a single cough or a door closing.' },
  { selector: '#ctrl-mic-curve', text: 'Reshapes how room noise maps onto attention. Higher values keep the landscape calm across most everyday noise levels and only let it react once the room gets properly loud; lower values make it more sensitive throughout.' },
  { selector: '#ctrl-mic-fluxgain', text: 'How strongly a change in the room\'s sound (talking, movement) pushes the landscape toward restlessness. Turn it up if speaking or moving around barely affects the landscape; turn it down if it reacts to the slightest sound.' },
  { selector: '#ctrl-mic-leakgain', text: 'How loudly the installation\'s own sound reaches the microphone, relative to how loud it is playing. The landscape uses this to ignore its own noise. If it still stirs itself up in an empty room, turn this up; if it stops noticing people talking or clapping, turn it down.' },
  { selector: '#ctrl-mic-leakdelay', text: 'How long the installation\'s own sound takes to travel from the speakers to the microphone, in milliseconds. It lines its own noise up with what the microphone hears. Only matters for sudden changes in volume: if it twitches whenever its own sound jumps, nudge this up or down until it stops.' },

]

// ── Generated controls without a plain id ───────────────────────────────────
// A colour swatch is an input inside its label, and the label's own text is
// only 'forest', 'water deep': both carry the tooltip, so hovering the text works.
const PALETTE_HELP = {
  'col-forest':   'Base colour for forested ground.',
  'col-meadow':   'Base colour for open grassy meadow.',
  'col-snow':     'Base colour for snow-covered ground above the snowline.',
  'col-rock':     'Base colour for bare exposed rock.',
  'col-sand':     'Base colour for the sandy shoreline/beach band.',
  'col-riparian': 'Base colour for the lush green streamside band along damp gully floors.',
  'col-shadow':   'Hue tint applied to surfaces in shadow.',
  'col-glow':     'Hue tint for the warm alpenglow highlight on sun-facing high ground.',
  'col-water-deep': 'Colour of deep water.',
  'col-water-shallow': 'Colour of shallow water near the shore.',
  'col-glint':    'Colour of the sharp sunlight sparkle on the water surface.',
  'col-sky':      'Sky/horizon colour — also tints the distance fog.',
}

const PALETTE_TOOLTIPS = Object.entries(PALETTE_HELP).flatMap(([id, text]) => [
  { selector: `[id="${id}"]`, text },
  { selector: `label:has(> [id="${id}"])`, text },
])

// One heading, one crown-colour swatch and the form sliders per species (tabs/species.js).
const SPECIES_TOOLTIPS = SPECIES.flatMap((sp, i) => {
  const host = `[data-param-group="forest.sp-${sp.key}"]`
  const crown = `Sunlit crown colour for ${sp.label}. The whole tree takes this — it is not a tint over the ground underneath.`
  return [
    { selector: `h4:has(+ ${host})`, text: sp.tip },
    { selector: `${host} .dbg-color`, text: crown },
    { selector: `${host} .dbg-color input`, text: crown },
    ...SPECIES_FORM.map(prop => ({ selector: `#ctrl-sp${i}-${prop.key}`, text: prop.tip })),
  ]
})

export const TOOLTIPS = [...STATIC_TOOLTIPS, ...PALETTE_TOOLTIPS, ...SPECIES_TOOLTIPS]
