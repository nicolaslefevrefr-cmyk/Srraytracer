# SR Envelope Raytracer — browser port

A pure HTML/CSS/JS implementation of the synchrotron-radiation envelope raytracer described in
`SR_Raytracer_WebApp_Build_Instructions.md`, styled to the ALS Engineering Tools design spec
(Syne/DM Sans fonts, light/dark theme). No build step, no server required. Charts are rendered
with [Plotly.js](https://plotly.com/javascript/) loaded from CDN — this is the one real runtime
dependency and it needs internet access; everything else (the physics engine, the component
editor, load/save, theming) works fully offline.

Current version: see the badge in the app's header (click it for the full changelog) or
`js/version.js`.

## Run it

Open `index.html` directly in a browser (with internet access, for the Plotly CDN load). Aside
from that, everything is loaded via plain `<script>` tags in dependency order — no ES modules, no
bundler — specifically so it also works when opened straight from disk via `file://`, which
fetch()-based module loading can't do reliably.

## Using it

1. Either pick an example from the **Example** dropdown / **Load JSON** your own file, or click
   **New beamline** to start from just a Source and build up from there.
2. **Edit components** in the "Components" panel: each card is one element of the ordered list
   (order matters — every algorithm walks it in sequence). Click a card's name to rename it, click
   the ▸ chevron to expand its full form (position, sizes, divergences, location, misalignment
   tolerances, etc. — angles are shown in degrees for usability and converted to radians under the
   hood). Use **+ Add** to append a Mirror / Aperture / Relative aperture, ↑/↓ to reorder, ✕ to
   delete. A Relative aperture's "target element" dropdown lists every component defined earlier in
   the list, per §1's rule that the target must already exist. The Source can't be deleted or moved
   (a beamline always starts with exactly one).
3. Every Mirror/Aperture/Relative-aperture has a **location** (PTL / Front End / Experimental
   floor). Its misalignment tolerances default from that location's global values — edit those
   defaults via **General misalignments…** in the header — and stay linked to them live, *unless*
   you edit that specific component's own misalignment fields, which freezes it at its own values
   (a ↺ button un-freezes it back to tracking the location default). The header's **apply motions
   & misalignments** checkbox (off by default) controls whether motion ranges and misalignment
   tolerances are shown at all and whether they're used in the run — unchecking it doesn't erase
   anything you've set, it's just excluded from that run.
4. Click the ⓘ next to **Mode** for a concrete coarse-vs-fine comparison (grid resolution, DE
   parameters, ray-count formula) pulled straight from the engine's own constants. Then choose
   **coarse** or **fine**, adjust `linear_accuracy` / `angular_accuracy` if you want, and hit
   **Run raytrace**.
5. The left panel shows the beamline's interactive layout in both **X-Z** (top-down) and **Y-Z**
   (side view) — the two share the same Z-axis and stay in sync when you zoom or pan either one
   (scroll to zoom, drag to pan, hover for exact coordinates — updates live as you edit
   components, even before running) — and a clickable table of every raytrace stage (Source, then
   Before/After for each element by default; check **show intermediate points** next to the table
   header to also see every 250mm along the way, computed on the fly with no re-run needed),
   including each stage's min/max X and Y bounds directly in the table for comparing against
   reference data. The right panel shows envelope size vs. accumulated travel as two interactive
   Plotly charts (drag to zoom, scroll to zoom, double-click to reset, hover for exact values)
   with component names called out via arrows — **click anywhere on either plot to inspect the
   exact phase space at that Z**, computed on the
   fly by shearing analytically from the nearest preceding stage (exact, not interpolated
   guesswork; this also respects the current zoom level). Any mirror that produced spillover rays
   shows an amber band extending 2500mm downstream (via the same exact shear) so its impact is
   visible at a glance. Below that, the phase-space polygon (position vs. slope, with grid and
   units) for whichever stage or clicked point you've selected.
6. The **Debug panel** at the bottom (click to expand) has four tabs, each with a fixed height so
   switching tabs doesn't shift the rest of the page:
   - **Evaluation log** — a line-by-line trace of what was computed at each step (shears, clips,
     ray counts, DE iterations, hull fallbacks, etc.)
   - **Warnings** — anything the engine flagged (auto-corrected mirror angles, spillover rays,
     degenerate hulls, ray-count clamps)
   - **Self-tests** — click **Run self-tests** in the header to execute the in-browser test suite
     (`js/tests.js`) against known-good geometry results, regression-pins for the two mirror-math
     bugs found via reference-data validation (§16-§17), and an end-to-end smoke test of all four
     bundled examples
   - **Assumptions & scope** — what's exact, what's a flagged simplification, and what's out of
     scope for this pass (mirrors the spec's own §0 confidence map)

## Project layout

```
index.html
css/styles.css
js/
  version.js         current version + changelog (shown via the header badge)
  geometry.js      §2 math primitives, polygon ops (shear, area, hull, Sutherland–Hodgman clip)
  beamline.js       §1 data model / RelativeAperture resolution, §2 coordinate frames & transforms
  phasespace.js     §4 source radiate(), §5 aperture cut(), §7 hull reconstruction + union
  raysample.js      §6 ray-count formula, §6.1 ray sampling from phase space
  mirror.js         §8 mirror reflection (flat: exact; paraboloid: flagged sketch; toroid/
                     ellipsoid: not implemented, throws with an explicit explanation)
  convergence.js    §9 grid seeding + differential evolution ('fine' mode) / grid-only ('coarse')
  raytrace.js       §10 orchestration + on-demand intermediate-point expansion for display
  examples.js        built-in example beamlines (embedded, not fetched)
  componentEditor.js  editable component list: add/edit/reorder/delete, location + misalignment
                       override logic
  render.js          Plotly.js-based interactive visualizations (layout / envelope plot with
                       zoom-pan-annotations-spillover / phase-space plot)
  tests.js            in-browser self-test suite
  ui.js               DOM wiring, modal for general misalignment defaults
examples/*.json        the same example beamlines as standalone files, for reference / re-import
ASSUMPTIONS.md          full writeup of every place the spec was ambiguous and how it was resolved
```

## What's exact vs. flagged (short version — see ASSUMPTIONS.md for the full story)

Exact, transcribed from the spec: §2 (frames/transforms), §3 (shear), §4 (source phase space), §5
(aperture clip incl. Z-misalignment), §6/§6.1 (ray-count formula + sampling), §7 (hull
reconstruction + degenerate fallback), §8.1–§8.6 (flat-mirror reflection), §10 (orchestration).

Flagged (the build spec itself says these needed xrt source or further validation that wasn't
available):
- **§8.7 non-flat mirrors** — Toroid and Ellipsoid are **not implemented** (an explicit runtime
  error explains why, rather than guessing at xrt's parametrization). Paraboloid runs a small
  Newton-solved toy equation as a labeled, unvalidated sketch.
- **§9 fine-mode convergence** — hand-rolled differential evolution approximating scipy's
  `differential_evolution`; the "polish" step is approximated with a local coordinate search.
  Coarse mode (pure grid search) is exact.
- **§8's frame composition** — four specific choices (labeled A1-A4 in `js/mirror.js`) the spec
  left unresolved without xrt source. Documented inline, not silently guessed — two of them (A2,
  A4) were found to be wrong and fixed once real reference data became available; see below.

Also out of scope for this pass (§13's 3D viewer / STL export, and §9's Web Worker) — replaced
with interactive Plotly.js 2D views (one real external dependency, loaded from CDN — see "Run it"
above) and a synchronous run with a "Running…" UI state plus a browser-safety ray-count cap
(adjustable in the header, clearly logged as a non-spec deviation whenever it triggers).

## Validating against the real tool

An earlier version of this project had no ground truth to check against. That's since changed —
the person provided the real Python reference script, its console debug log, and its exported
envelope CSV, for both a general run and a zero-motion isolation run of the same 2-mirror
beamline. Running these found and fixed **three** real bugs in the mirror-reflection code (full
account in ASSUMPTIONS.md §16-§17):
1. The nominal-orientation formula had the mirror's local length/normal axes swapped.
2. Motion translations were being applied in the wrong (tilted-surface) frame instead of the
   beamline-local frame, making them physically inert.
3. Reflected rays weren't being re-referenced to the mirror's own center before reporting their
   position, and the downstream phase space wasn't being reoriented into the outgoing beam's own
   frame before continuing propagation — both needed for a bend to be tracked correctly at all.

**Current state:** §2 through §7 (everything up to and including aperture clipping and ray
sampling) match the reference exactly. A non-oblique mirror's reflection (M101, azimuth 0°)
matches to within ~0.007mm. An oblique mirror's reflection (M102, azimuth 29.85°) still only
partially matches — Y is close, X comes out roughly 2× too wide — and that remaining gap is
reported precisely rather than smoothed over; it did **not** shrink when tested with up to 50,000
rays, ruling out a sampling-density explanation. The `csv_validation` example bundled with the app
reproduces this exact beamline; load it (with **apply motions & misalignments** left unchecked, to
match the zero-motion reference run) and compare its stage table against ASSUMPTIONS.md §17 to see
the current state yourself.

