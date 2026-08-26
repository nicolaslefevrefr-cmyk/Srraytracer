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
from ±5.05mm to a wide, roughly-symmetric ±12.7/12.9mm; this port's fine-mode search — even
probed by hand across the full x_motion (±5mm) and pitch (±0.005rad) ranges, well past what the
optimizer itself finds — only reaches roughly ±5.2mm. Every physically-motivated mechanism this
port could derive by hand (translation-induced lever-arm shift combined with the beam's own
angular divergence at that point, which is very narrow — about ±0.0005 rad after AP101's clip;
pitch-induced shift of the intersection point along the mirror's length axis) comes out one to two
orders of magnitude too small to explain the reference's growth. This may be a further, deeper
misunderstanding of xrt's actual geometry that isn't recoverable without its source, or a
difference in what the reference tool's `mode='fine'` optimizer explores, or something else this
port hasn't identified. It's reported here rather than papered over. The `csv_validation` example
bundled with the app reproduces this exact beamline so the gap is directly inspectable — load it,
run it, and compare its stage table to the reference numbers in this section.


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
- **No Three.js 3D viewer / STL / CSV export (§13)**: replaced with three dependency-free 2D
  canvas views (top-down layout, envelope-vs-travel, per-stage phase space). §2's world-coordinate
  chain is still fully implemented (it's what draws the layout view and would feed a 3D viewer),
  just not rendered in 3D in this pass.
