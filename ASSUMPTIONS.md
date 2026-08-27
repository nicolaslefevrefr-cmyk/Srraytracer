# Assumptions & flagged simplifications

The build spec (`SR_Raytracer_WebApp_Build_Instructions.md`) is explicit that most of it is exact,
and explicit about where it isn't ("if you don't have xrt's source... flag this explicitly rather
than guessing"). This document is that flag. Everything here is also summarized in the app's
Debug panel → "Assumptions & scope" tab.

## §8: three unresolved frame-composition choices

§8.1–§8.6 give the individual formulas (nominal orientation, pivot compensation, rotation
sequence, reflection law) exactly, but don't fully pin down how they compose into a single
transform without xrt's source in front of you. Three specific choices were needed:

**A1 — what "beamline coordinates" means in §8.2/§8.6.**
The spec says rays are transformed "into the mirror's local frame" (§8.2) and reflected rays are
transformed "back to beamline coordinates" (§8.6), but the raytrace pipeline (§10) never
constructs an explicit 3D world-coordinate ray representation anywhere else — §3's shear and §7's
hull reconstruction only ever operate on flat `(position, slope)` pairs. This port takes
"beamline coordinates" to mean exactly that per-stage 2D-transverse-plus-depth representation:
rays are expanded to 3D `{x, y, z, a, b, c}` only for the duration of the mirror-reflection step,
and immediately collapse back to `(x, slopeX=a/c)` / `(y, slopeY=b/c)` pairs afterward via §7 —
which is also why the pipeline never needs to separately construct an "outgoing beam frame": the
mirror's own local-to-stage transform, applied in the forward direction (§8.6), already produces
rays in a coordinate system consistent with continued 1D shearing for the next segment, because
reflection off a flat surface with normal `(0,0,1)` is literally a sign flip of the local z-axis —
it doesn't need to know where "downstream" is.

**A2 — rotation composition order.**
`R_nom = Rz(azimuth) · Ry(nominalPitch)`, and the `rotation_sequence` DOF list composes as
`R_extra = R_first · R_second · R_third` (e.g. for `'Pitch->Roll->Yaw'`,
`R_extra = Ry(pitch) · Rz(roll) · Rx(yaw)`), with `R_total = R_nom · R_extra`. This mirrors the
intrinsic composition rule §2.2 already establishes for `Rz·Ry·Rx` (azimuth·pitch·yaw), so it's
the same convention applied consistently rather than a new one invented for §8.

**A3 — what frame the motion translations are expressed in.**
§8.1 says `x_val, y_val, z_val` (plus the pivot-compensation delta) are "in the mirror's local
frame, not world," but doesn't say nominal-local or motion-perturbed-local. This port rotates
them into stage coordinates via `R_nom` only (not `R_total`) — i.e. translation stages are assumed
mounted along the mirror's nominal (undeflected) axes, unaffected by small simultaneous
pitch/roll/yaw motor motion. This is the more common physical convention for beamline optics
motion stages, but it's an assumption, not a transcription.

None of this affects §8.3–§8.5 (the flat-mirror intersection, normal, and reflection law), which
are transcribed exactly regardless of how the surrounding transform is composed.

## §16: validation against a real reference run (added after initial delivery)

The person later provided the actual Python reference script this port was built from, plus its
console debug log and its exported envelope CSV, for a 2-mirror beamline (M101 + M102 — the
script's G101/M103 are commented out). This is real ground truth, unlike everything above, and
running it through this port immediately found two genuine bugs in the A2/A4 guesses:

**What matched immediately, byte-for-bit-precision:**
- Source → AP101 (Before/After) → Before-M101 phase-space bounds matched the reference CSV
  exactly (to the last printed digit), confirming §3 (shear), §4 (source), §5 (aperture clip with
  Z-misalignment), §6/§6.1 (ray sampling), and §7 (hull reconstruction) are all correct.
- The §2/§10 auto-correction of declared vs. geometrically-derived mirror angles matched the
  reference debug log exactly: M101's declared 2° nominal_pitch corrected to 1.500°, and M102's
  declared azimuth 0°/pitch 2° corrected to 29.852°/0.407° — both bit-for-bit identical to the
  reference tool's own printed correction. This confirms §2's coordinate-frame math (the trickiest
  "exact" section) is fully correct.

**What this run found broken, and fixed:**
- **A2 (nominal orientation) was wrong.** The original `R_nom = Rz(azimuth - π/2) · Ry(pitch)`
  formula put the incoming beam mostly along the mirror's local Z axis (as if striking the mirror
  near-normal) instead of mostly along local Y (true grazing incidence — the beam travels mostly
  along the mirror's length, with only a small component along the normal). This showed up as
  Y-divergence incorrectly leaking into X after a purely-horizontal (azimuth=0) mirror. Replaced
  with `buildRnom(azimuth, pitch)` in `mirror.js`, which builds R_nom directly from its column
  vectors instead of a Rz·Ry product, and uses the declared azimuth with no extra offset. Confirmed
  by hand (see the derivation in `mirror.js`'s A2 comment) that this leaves Y-divergence completely
  decoupled for an azimuth=0 mirror, and it's what reproduces the reference tool's own
  auto-corrected angles exactly.
- **A4 (motion translation frame) was wrong.** The original guess rotated `x_motion`/`y_motion`/
  `z_motion` into the mirror's own tilted surface frame before applying them. Numerically, this
  makes x_motion/y_motion **physically inert** for a flat mirror — translating a flat mirror
  within its own plane never changes the reflected ray, only which point of the (possibly
  now-different) plane gets hit — which cannot be what a real translation stage does. Re-read
  "in the mirror's local frame, not world" as distinguishing per-element beamline-local
  coordinates from a larger system's absolute/world coordinates (the same sense "local" is used in
  §2), not as "rotated into the surface's own tilted orientation." Fixed to apply
  `x_motion`/`y_motion`/`z_motion` directly as a stage-frame (lab-frame) translation.

**What still doesn't match, and is left honestly unresolved:** after both fixes, "After M101" and
onward no longer match the reference CSV. The reference shows the X envelope after M101 growing
from ±5.05mm to a wide, roughly-symmetric ±12.7/12.9mm.

This was investigated exhaustively, not just guessed at once and abandoned:
- A dense 11×11 grid over the full declared range of both of M101's active DOFs (`x_motion`
  ±5mm, `pitch` ±0.005rad), reflecting 2000 rays (more than the reference's own 915) per grid
  point and taking the union, tops out around ±5.17mm — nowhere near ±12.7mm.
- A sensitivity sweep pushed pitch up to 20° (70× the declared bound) and X spread barely moved
  (±5.15 → ±5.17). Pushed `x_motion` up to 20mm (4× the declared bound) and *every* ray spills
  over the mirror's physical length instead (grazing-incidence geometry means a translation along
  the mirror's near-normal direction shifts the effective footprint by roughly
  `translation / sin(grazing angle)` ≈ 38× the translation — so at 20mm the ±250mm length window
  is blown through entirely). There is no intermediate value of either DOF, inside or outside the
  declared bounds, that reaches the reference's spread.
- The reference's own ray count (915) is consistent with this port's §6 formula at roughly the
  default accuracy settings (0.5mm / 250µrad) — back-solving from 915 gives a phase-space-area
  product implying ~249µrad angular accuracy, matching the default almost exactly — so the ray
  density/formula isn't the source of the mismatch either.

In other words: within every physically-motivated reading of the DOFs this port could construct
by hand, the reference's envelope growth isn't reachable from this beamline's stated motion
ranges and beam divergence (~±0.0005 rad after AP101's clip) via a flat-mirror reflection. That
either points to a further, deeper misunderstanding of xrt's actual geometry that isn't
recoverable without its source, a difference in what `mode='fine'` explores in the reference tool,
or some other mechanism this port hasn't identified — reported here rather than papered over.

**If you're able to get more information from the reference tool, the single most useful thing
would be:** run M101 in isolation with every motion DOF pinned to exactly 0 (no search at all) and
export just that one reflection's envelope. That isolates the pure geometric reflection from the
optimizer, and would immediately show whether the ±12.7mm spread exists even with zero motion
(pointing to a remaining geometry/frame bug in this port) or only appears once the search runs
(pointing to a difference in what's being explored or optimized). The `csv_validation` example
bundled with the app reproduces this exact beamline so either side of that comparison is directly
inspectable — load it, run it, and compare its stage table to the reference numbers in this
section.

## §17: the zero-motion reference run — two more real bugs found and fixed

The person then provided exactly that: a zero-motion run (both M101's and M102's motion bounds
pinned to 0) with its own reference CSV. This isolated the pure geometric reflection from the
optimizer entirely, and immediately found two more real bugs — both now fixed.

**Bug 1 — missing re-reference to the mirror's center.** A hand-traced single ray at zero motion
showed a ~2% position distortion even with no search involved (reference: near-perfect identity,
`Before M101`≈`After M101` to 5+ significant figures; this port: a real ~0.1–0.35mm deviation per
ray). Tracing the exact arithmetic (not an approximation) showed each ray reflects correctly, but
different rays in the same bundle strike the finite mirror surface at genuinely different points
along its length — and reporting each ray's raw hit position, without first re-referencing every
ray to a common plane (the mirror's own center, local y=0), mixes positions that were never
directly comparable. Fixed in `mirror.js`: `reReferenceToCenter()` propagates each reflected ray
along its own new direction until it crosses the mirror's local y=0, and *that* point is reported
instead of the raw intersection — using the true intersection only for the good/spillover length
check. This alone brought `After M101` to within 0.0001mm of the reference.

**Bug 2 — no reorientation into the outgoing beam's frame.** Even with bug 1 fixed, everything
downstream of M101 (`Before Entrance Slit` onward) was off by ~131mm in X — suspiciously close to
`2500mm × tan(3°)`, the lateral shift M101's 3° deflection accumulates over the distance to the
next element. The reflected phase space was being reported correctly in the *incoming* beam's
frame, then handed to §3's shear (which assumes position/slope are already relative to whatever
axis it's about to propagate along) — so the deflection was being counted twice: once as a real
physical shift, and again because downstream elements' declared positions are already placed along
the deflected path, but the phase space itself was still speaking the old frame's language.
Fixed: `mirror.outgoingReorientation(mirrorDef)` computes M = R_total · Reflect · R_total^T (the
direction transform reflection applies at nominal, zero-motion orientation) and returns M^T; by
construction M^T applied to the chief (zero-slope) ray's own output reconstructs exactly (0,0,1)
— i.e. it defines the new frame's Z-axis as the chief ray's actual outgoing direction. `raytrace.js`
now applies this to the mirror's output phase space (via `ps.reorient`, sampling the corner
cross-product — exact for a linear map — and re-hulling) before continuing propagation. This
brought `Before Entrance Slit` and `Before M102` to within 0.007mm of the reference (down from
~131mm), and fixed the `single_mirror` example's previously-zero final aperture stage as a side
effect.

**What's now confirmed correct, end to end:** for M101 (azimuth 0, a "planar"/non-oblique mirror),
every stage from Source through Before-M102 matches the reference closely: position bounds land
within about 0.007mm on `After M101` itself (down from a ~0.1mm, ~2% error before the
re-referencing fix, and from a ~131mm error before the reorientation fix), and that same ~0.007mm
gap simply carries forward unchanged through `Before Entrance Slit`/`Before M102` (shear is exact,
so it doesn't add error). That residual ~0.007mm is small enough to be a remaining
approximation/rounding-level difference rather than a structural one, but it's reported precisely
rather than rounded away to "matches."

**What still doesn't match:** `After M102` — M102 is a strongly oblique mirror (auto-corrected
azimuth 29.85° vs M101's 0°, meaning X and Y genuinely mix under its reflection, unlike M101's
case). The reorientation's own self-consistency check still holds exactly (M102's chief ray
reorients to exactly (0,0,1), confirmed numerically). But the resulting envelope only partially
matches: Y comes out close (±10.01/10.14 vs reference ±10.19/10.04), while X comes out roughly 2×
too wide (±11.5/12.1 vs reference ±5.71/5.76), and this gap does **not** shrink with more rays
(tested up to 50,000, ruling out a sampling-density artifact — it's structural). This is reported
precisely rather than glossed over: the fix that fully resolved the non-oblique case (M101) is only
partially sufficient for the oblique case (M102), and the remaining gap is specific to how X and Y
couple when both azimuth and pitch are simultaneously significant. Not resolved in this pass.


## §8.7: non-flat mirrors

- **Toroid, Ellipsoid**: **not implemented.** The spec is explicit that inventing xrt's real
  parametrization without its source would be guessing, not porting, so `mirror.js` throws a clear
  error naming the limitation rather than producing a plausible-looking but unvalidated surface.
- **Paraboloid**: implemented as the spec's own "toy equation" sketch (`z = x²/(4f)`, cylindrical,
  Newton-solved intersection), explicitly logged as unvalidated every time it's used. `f` is
  derived from `p`/`q` via the standard mirror equation `1/f = 1/p + 1/q` when both are given, or
  taken directly from whichever of `p`/`q` is present otherwise — this specific `p`/`q` → `f`
  mapping is also a guess in the same spirit as the rest of §8.7, not a transcription.

## §9: fine-mode convergence

- The differential-evolution optimizer is hand-rolled (standard rand/1/bin DE), matching
  `popsize=10` (→ population size `10×6=60`), `maxiter=25`, `mutation=(0.7,1.5)` dithering, and the
  two-consecutive-small-changes outer stopping rule exactly as specified.
- `polish=True` in scipy runs a local L-BFGS-B refinement on the DE result. This port approximates
  it with a small coordinate-wise local search (shrinking step size over 8 rounds). This will not
  match scipy's polish step numerically, only in spirit (a local refinement pass exists).
- Coarse mode (pure grid search, no DE) is implemented exactly as specified and is the mode worth
  trusting for anything approaching numerical validation.

## Engineering-only deviations (not spec ambiguity — pragmatic choices, always logged)

- **No Web Worker**: §9 runs synchronously on the main thread. A "Running…" button state plus a
  `requestAnimationFrame`/`setTimeout` deferral keeps the UI from looking frozen without feedback,
  but the tab genuinely blocks for the duration of a `fine`-mode run.
- **Browser-safety ray cap**: because of the above, an additional non-spec ray-count clamp (default
  3000, adjustable in the header as "max rays") is applied after §6's own clamp. It only ever
  reduces the ray count below what §6 would give, and every time it actually triggers, a `WARNING`
  line is written to the Evaluation log — it never silently changes behavior.
- **No Three.js 3D viewer / STL export (§13)**: replaced with interactive Plotly.js 2D views
  (top-down layout, envelope-vs-travel, per-stage phase space — see the render.js rewrite noted
  below). §2's world-coordinate chain is still fully implemented (it's what draws the layout view
  and would feed a 3D viewer), just not rendered in 3D in this pass.
- **Plotly.js for charts** (added after the initial canvas-based version): the person asked for
  real zoom/pan/hover interactivity, which plain `<canvas>` drawing can't give without
  reimplementing a chart library by hand. This is the one genuine external runtime dependency in
  the project (loaded from CDN in `index.html`) — everything else still works fully offline.

## §18: a real bug found (Save JSON not reflecting mode/accuracy changes), and a non-bug clarified

The person compared a `single_mirror` run — with real (nonzero) motion ranges this time, not the
zero-motion case §16/§17 used — against their Python reference, and noticed what looked like a
sign-flipped X envelope after the mirror, plus one-sided spillover in the reference vs two-sided
in this port.

**Real bug, fixed:** `state.beamline.config` was only ever written when a beamline was *loaded*;
changing the mode/accuracy dropdowns afterward updated what `Run raytrace` actually used (that
part was always correct — `runRaytrace()` reads the live DOM controls directly) but never made it
into what **Save JSON** exported. Loading an example with `config.mode: "coarse"`, switching the
dropdown to `fine`, running, then saving would silently save `"coarse"` — exactly what happened
here. Fixed by having `saveJSON()` read the same live controls `runRaytrace()` does
(`readCurrentConfig()`, now shared by both) rather than the stale value captured at load time.
`perf_max_rays` is deliberately excluded from the saved file — it's a browser-safety setting (see
the engineering-deviations note above), not a beamline property, so sharing a saved file doesn't
silently cap someone else's run too.

**Not a bug (best current understanding):** with this fixed, the *actual* run always did use
whatever mode was selected — so the sign-flip/spillover-sidedness question is separate from the
save bug. This mirror's motion ranges (`x_motion` ±5mm, `pitch` ±0.005rad) are symmetric around
zero, and the incoming beam (`Before M1`) is symmetric too, so the fully-explored envelope after
the mirror — and its spillover — **must** come out symmetric: every operation involved (shear,
the rotation in `buildRnom`, the reflection law) is linear, so reflecting with `x_motion=+5`
produces the exact mirror image of reflecting with `x_motion=-5` for the same incoming ray, and
unioning over the full symmetric range can't produce a net bias. Re-running this exact config
after the fix, repeatedly, in both `coarse` and `fine` mode, reproducibly gives a centered result
(center within ~0.04mm of zero, both directions) with spillover on both sides — consistent with
that requirement. The asymmetric, mirror-image-of-each-other results the person saw from both this
port and their Python reference look like an artifact of incomplete/biased search exploration in
whichever optimizer ran (`fine` mode's DE is stochastic; even a search that's supposed to be
symmetric can converge to a lopsided subset of the true envelope) rather than a sign error in the
reflection physics — which is separately validated exactly by the zero-motion case in §16/§17,
where there's no search/optimizer involved to introduce this kind of bias.

**Left open:** the specific magnitude the person reported from their run of this port
(~±6.3mm) could not be reproduced in this environment even with an identical (verified
byte-for-byte identical to the shipped build) config — every variation tried here (`coarse`,
`fine`, with/without the ray-count cap, five repeated runs) instead reproducibly gives ~±11.3mm.
Given `fine` mode's search always starts from (and can only add to) the same grid `coarse` mode
uses, and `coarse` mode alone already reaches ~±11.3mm here, a smaller result from a correctly
running current build seems structurally unlikely. If the discrepancy persists after a hard
refresh / re-downloading the zip, that would be worth another look with the exact steps that
produced it.

## §19: ALS Engineering Tools design system, versioning, linked Y-Z view, mode comparison

Applied the person's ALS design spec (fonts, color tokens with light/dark theme + toggle, header
layout, border-radius tokens, card hover/entrance styling, status badges) across the whole app —
see `css/styles.css`. Data-visualization colors (the blue/green/amber used for X/Y/spillover on
the charts) are deliberately kept separate from the `--accent`/`--accent2` UI tokens, since the
spec covers UI chrome, not chart semantics, and conflating them would make the charts harder to
read. The mirror-type maturity notes (§8.7) are now also shown as the spec's own status-badge
pattern (Flat=approved, Paraboloid=experimental, Toroid/Ellipsoid=deprecated) since that's exactly
the distinction the badge system is for.

Added `js/version.js` as a single source of truth for the app's version (shown as a small badge
in the header, click for the full changelog) — bumped on every meaningful change from here on.

Added a second, linked beamline-layout view (Y-Z, side view, alongside the existing X-Z top-down
view) — panning/zooming either one applies the same Z-range to the other via `plotly_relayout`.

Added a coarse-vs-fine comparison (ⓘ button next to the Mode selector) stating the actual grid
resolutions, ray-count formula, and DE parameters straight from `convergence.js`'s own constants
rather than generic prose.

Verified the §2/§10 geometric orientation-mismatch auto-correction against the person's reference
Python tool for the single-mirror case: this port computes azimuth=0.000°, pitch=1.431° for M1 —
an exact match to the reference's own printed warning. The warning does already surface in this
port's Warnings tab; confirmed via test that it's present in the returned warnings array for this
exact case (not just logged, but part of the same list the UI's Warnings tab renders from).

**Robustness fix found while testing the theme toggle:** `localStorage` access was unguarded and
throws in some environments for `file://`-opened pages (this app's own headless test harness hit
exactly this). Wrapped in `safeStorageGet`/`safeStorageSet` so a failure there degrades to
"theme choice isn't remembered between visits" instead of taking down the whole page — consistent
with the app's stated goal of working when opened directly from disk.

