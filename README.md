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

1. Pick an example from the **Example** dropdown (or **Load JSON** your own beamline file — see
   `examples/*.json` for the schema, which matches §1 of the build spec).
2. Choose **coarse** or **fine** mode, adjust `linear_accuracy` / `angular_accuracy` if you want,
   and hit **Run raytrace**.
3. The left panel shows the beamline's top-down layout and a clickable table of every raytrace
   stage. The right panel shows envelope size vs. accumulated travel, and the phase-space polygon
   (position vs. slope) for whichever stage you've selected.
4. The **Debug panel** at the bottom (click to expand) has four tabs:
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

This environment has no access to xrt or the original Python source, so there's no ground-truth
CSV to diff against (per §15 of the build spec). `js/tests.js` checks the geometry primitives
against hand-derived expected values and confirms the pipeline runs end-to-end on all three
bundled examples — including the §14 fixture's M102/G101/M103, which have zero-width motion on
every DOF and specifically exercise the §7 degenerate-hull fallback path. If you do have access to
the Python tool, the fastest path to real validation is: run `examples/worked_fixture.json`
through it in `coarse` mode, export the envelope CSV, and diff the poly_x/poly_y bounds per stage
against what this app's stage table shows.
