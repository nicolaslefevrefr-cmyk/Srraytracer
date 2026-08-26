# SR Envelope Raytracer — browser port

A pure HTML/CSS/JS implementation of the synchrotron-radiation envelope raytracer described in
`SR_Raytracer_WebApp_Build_Instructions.md`. No build step, no server required, no external
runtime dependency other than a Google Fonts stylesheet (the app still runs fully offline if that
fails to load — it just falls back to system fonts).

## Run it

Open `index.html` directly in a browser. That's it. (Everything is loaded via plain `<script>`
tags in dependency order — no ES modules, no bundler — specifically so it also works when opened
straight from disk via `file://`, which fetch()-based module loading can't do reliably.)

## Using it

1. Either pick an example from the **Example** dropdown / **Load JSON** your own file, or click
   **New beamline** to start from just a Source and build up from there.
2. **Edit components** in the "Components" panel: each card is one element of the ordered list
   (order matters — every algorithm walks it in sequence). Click a card's name to rename it, click
   the ▸ chevron to expand its full form (position, sizes, divergences, motion ranges, misalignment
   tolerances, etc. — angles are shown in degrees for usability and converted to radians under the
   hood). Use **+ Add** to append a Mirror / Aperture / Relative aperture, ↑/↓ to reorder, ✕ to
   delete. A Relative aperture's "target element" dropdown lists every component defined earlier in
   the list, per §1's rule that the target must already exist. The Source can't be deleted or moved
   (a beamline always starts with exactly one).
3. Choose **coarse** or **fine** mode, adjust `linear_accuracy` / `angular_accuracy` if you want,
   and hit **Run raytrace**.
4. The left panel shows the beamline's top-down layout (updates live as you edit components, even
   before running) and a clickable table of every raytrace stage (Source, then Before/After for
   each element — no intermediate rows). The right panel shows envelope size vs. accumulated
   travel — **click anywhere on that plot to inspect the exact phase space at that Z**, computed
   on the fly by shearing analytically from the nearest preceding stage (exact, not interpolated
   guesswork) — and the phase-space polygon (position vs. slope) for whichever stage or clicked
   point you've selected.
5. The **Debug panel** at the bottom (click to expand) has four tabs:
   - **Evaluation log** — a line-by-line trace of what was computed at each step (shears, clips,
     ray counts, DE iterations, hull fallbacks, etc.)
   - **Warnings** — anything the engine flagged (auto-corrected mirror angles, spillover rays,
     degenerate hulls, ray-count clamps)
   - **Self-tests** — click **Run self-tests** in the header to execute the in-browser test suite
     (`js/tests.js`) against known-good geometry results and an end-to-end smoke test of all three
     bundled examples
   - **Assumptions & scope** — what's exact, what's a flagged simplification, and what's out of
     scope for this pass (mirrors the spec's own §0 confidence map)

## Project layout

```
index.html
css/styles.css
js/
  geometry.js      §2 math primitives, polygon ops (shear, area, hull, Sutherland–Hodgman clip)
  beamline.js       §1 data model / RelativeAperture resolution, §2 coordinate frames & transforms
  phasespace.js     §4 source radiate(), §5 aperture cut(), §7 hull reconstruction + union
  raysample.js      §6 ray-count formula, §6.1 ray sampling from phase space
  mirror.js         §8 mirror reflection (flat: exact; paraboloid: flagged sketch; toroid/
                     ellipsoid: not implemented, throws with an explicit explanation)
  convergence.js    §9 grid seeding + differential evolution ('fine' mode) / grid-only ('coarse')
  raytrace.js       §10 orchestration
  examples.js        built-in example beamlines (embedded, not fetched)
  render.js          canvas-based visualizations (layout / envelope plot / phase-space plot)
  tests.js            in-browser self-test suite
  ui.js               DOM wiring
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
- **§8's frame composition** — three specific choices (labeled A1/A2/A3 in `js/mirror.js`) the
  spec left unresolved without xrt source. Documented inline, not silently guessed.

Also out of scope for this pass (§13's 3D viewer / STL / CSV export, and §9's Web Worker) —
replaced with dependency-free 2D canvas views and a synchronous run with a "Running…" UI state
plus a browser-safety ray-count cap (adjustable in the header, clearly logged as a non-spec
deviation whenever it triggers).

## Validating against the real tool

An earlier version of this project had no ground truth to check against. That's since changed —
the person provided the real Python reference script, its console debug log, and its exported
envelope CSV for a 2-mirror beamline. Running it found and fixed two real bugs (see ASSUMPTIONS.md
§16 for the full writeup): the mirror's nominal-orientation formula had the local length/normal
axes swapped, and motion translations were being applied in the wrong frame. After both fixes,
**Source through Before-M101 now match the reference exactly**, and both mirrors' auto-corrected
azimuth/pitch match the reference debug log exactly — but the envelope growth across the mirror
reflections themselves still doesn't match, and that gap is reported honestly rather than hidden.
The `csv_validation` example bundled with the app reproduces this exact beamline; load it and
compare its stage table against the numbers in ASSUMPTIONS.md §16 to see the current state
yourself. If you have access to the real Python/xrt tool for other beamlines, the same
load-run-diff approach is the fastest path to catching more of this class of bug.
