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
