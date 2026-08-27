// tests.js — lightweight self-test suite, runnable from the UI ("Run self-tests" button).
// Not a replacement for validating against the real Python tool's output (§15) — that requires
// ground-truth CSVs this environment doesn't have access to — but it pins down the geometry
// primitives and exercises the full pipeline (including the degenerate-hull path) so regressions
// are caught immediately.
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const results = [];

  function approx(a, b, tol, msg) {
    const ok = Math.abs(a - b) <= tol;
    results.push({ ok, msg: `${msg} (got ${a}, expected ${b}, tol ${tol})` });
    return ok;
  }
  function assert(cond, msg) {
    results.push({ ok: !!cond, msg });
  }

  function runTests() {
    results.length = 0;

    // --- §3 shear ---
    (function () {
      const poly = [{ p: 0, s: 0.001 }, { p: 1, s: -0.001 }];
      const sheared = geo.shearPoly(poly, 100);
      approx(sheared[0].p, 0.1, 1e-9, 'shear: pos advances by d*slope (pt0)');
      approx(sheared[1].p, 0.9, 1e-9, 'shear: pos advances by d*slope (pt1)');
      approx(sheared[0].s, 0.001, 1e-12, 'shear: slope unchanged (pt0)');
    })();

    // --- §4 source phase space + area ---
    (function () {
      const src = { size_x_min: -1, size_x_max: 1, size_y_min: -2, size_y_max: 2, div_a_min: -0.5, div_a_max: 0.5, div_b_min: -0.25, div_b_max: 0.25 };
      const phaseSpace = SR.ps.radiate(src);
      approx(geo.polygonArea(phaseSpace.poly_x), 2 * 1, 1e-9, 'radiate: poly_x area = width*divergence');
      approx(geo.polygonArea(phaseSpace.poly_y), 4 * 0.5, 1e-9, 'radiate: poly_y area = width*divergence');
    })();

    // --- convex hull sanity ---
    (function () {
      const pts = [{ p: 0, s: 0 }, { p: 2, s: 0 }, { p: 2, s: 2 }, { p: 0, s: 2 }, { p: 1, s: 1 }]; // square + interior pt
      const h = geo.hullOrFallback(pts);
      assert(!h.degenerate, 'hull: square+interior point is non-degenerate');
      assert(h.poly.length === 4, 'hull: interior point excluded, 4 vertices remain');
      approx(geo.polygonArea(h.poly), 4, 1e-9, 'hull: reconstructed square has area 4');
    })();

    // --- §7 degenerate fallback ---
    (function () {
      const collinear = [{ p: 0, s: 0 }, { p: 1, s: 1 }, { p: 2, s: 2 }, { p: 0.5, s: 0.5 }];
      const h = geo.hullOrFallback(collinear);
      assert(h.degenerate, 'hull: perfectly collinear points fall back to degenerate path');
      assert(h.poly.length === 2, 'hull: degenerate collinear fallback keeps the two extreme points');

      const onePoint = [{ p: 5, s: 5 }, { p: 5, s: 5 }];
      const h2 = geo.hullOrFallback(onePoint);
      assert(h2.degenerate && h2.poly.length === 1, 'hull: duplicate single point collapses to 1-point degenerate polygon');
    })();

    // --- §5 clip: clipping a square against a smaller square gives the smaller square ---
    (function () {
      const big = geo.rect(-10, 10, -10, 10);
      const small = geo.rect(-3, 4, -2, 5);
      const clipped = geo.clipConvex(big, small);
      const h = geo.hullOrFallback(clipped);
      approx(geo.polygonArea(h.poly), 7 * 7, 1e-6, 'clip: square ∩ smaller square = smaller square area');
    })();

    // --- clip: degenerate (segment/point) subjects, which §5 can hand to the clipper whenever
    // an upstream stage's phase space already collapsed via §7's fallback ---
    (function () {
      const rect = geo.rect(-2, 2, -1, 1);
      const seg = geo.clipConvex([{ p: -5, s: 0 }, { p: 5, s: 0 }], rect);
      assert(seg.length === 2, 'clip: open segment through a rect clips to 2 points');
      approx(Math.min(...seg.map((v) => v.p)), -2, 1e-9, 'clip: segment clipped at left edge');
      approx(Math.max(...seg.map((v) => v.p)), 2, 1e-9, 'clip: segment clipped at right edge');

      const segOutside = geo.clipConvex([{ p: 10, s: 10 }, { p: 20, s: 20 }], rect);
      assert(segOutside.length === 0, 'clip: segment entirely outside clips to empty');

      const ptIn = geo.clipConvex([{ p: 0, s: 0 }], rect);
      assert(ptIn.length === 1, 'clip: single point inside is kept');
      const ptOut = geo.clipConvex([{ p: 100, s: 100 }], rect);
      assert(ptOut.length === 0, 'clip: single point outside is dropped');
    })();

    // --- §5 clip: fully disjoint rectangles give empty result ---
    (function () {
      const a = geo.rect(-1, 1, -1, 1);
      const b = geo.rect(5, 6, 5, 6);
      const clipped = geo.clipConvex(a, b);
      assert(clipped.length === 0, 'clip: disjoint rectangles clip to empty');
    })();

    // --- Euler decomposition round-trip ---
    (function () {
      const az = 0.3, pitch = -0.2, yaw = 0.1;
      const R = geo.matMul(geo.matMul(geo.Rz(az), geo.Ry(pitch)), geo.Rx(yaw));
      const d = geo.decomposeZYX(R);
      approx(d.az, az, 1e-9, 'decomposeZYX: azimuth round-trips');
      approx(d.pitch, pitch, 1e-9, 'decomposeZYX: pitch round-trips');
      approx(d.yaw, yaw, 1e-9, 'decomposeZYX: yaw round-trips');
    })();

    // --- §8.5 reflection law: normal incidence on flat mirror flips z only ---
    (function () {
      const D = geo.v3(0.01, 0.02, 0.9997);
      const n = geo.v3(0, 0, 1);
      const dot = geo.dot(D, n);
      const Dout = geo.sub(D, geo.scale(n, 2 * dot));
      approx(Dout.x, D.x, 1e-12, 'reflect: x-component unchanged for a z-normal');
      approx(Dout.y, D.y, 1e-12, 'reflect: y-component unchanged for a z-normal');
      approx(Dout.z, -D.z, 1e-12, 'reflect: z-component flips sign');
    })();

    // --- §6 ray count formula, hand-checked small example ---
    (function () {
      const poly_x = geo.rect(-1, 1, -0.001, 0.001); // area = 2*0.002=0.004
      const poly_y = geo.rect(-1, 1, -0.001, 0.001);
      const { numRays } = SR.rs.computeNumRays(poly_x, poly_y, 0.5, 0.00025, 'coarse', null);
      assert(numRays > 0, '§6: coarse-mode ray count formula produces a positive count');
    })();

    // --- §1 RelativeAperture resolution ---
    (function () {
      const raw = [
        { type: 'Source', name: 'S', position: [0, 0, 0] },
        { type: 'Aperture', name: 'Target', position: [0, 0, 1000], size_x_min: -1, size_x_max: 1, size_y_min: -1, size_y_max: 1 },
        { type: 'RelativeAperture', name: 'Rel', target: 'Target', distance: 100, size_x_min: -1, size_x_max: 1, size_y_min: -1, size_y_max: 1 },
      ];
      const resolved = SR.bl.resolveBeamline(raw);
      const relIdx = resolved.findIndex((c) => c.name === 'Rel');
      const targetIdx = resolved.findIndex((c) => c.name === 'Target');
      assert(relIdx === targetIdx - 1, 'RelativeAperture: inserted immediately before its target');
      approx(resolved[relIdx].position[2], 900, 1e-6, 'RelativeAperture: position = target - distance*direction (z)');
    })();

    // --- §8 reflection: purely-horizontal (azimuth=0) mirror must leave Y-divergence decoupled.
    // This pins the A2 fix found via real-reference validation (ASSUMPTIONS.md §16) — an earlier
    // R_nom formula leaked Y-divergence into X here.
    (function () {
      const mirrorDef = { name: 'M', azimuthal_angle: 0, nominal_pitch: 1.5 * Math.PI / 180, length_min: -250, length_max: 250, rotation_sequence: 'Pitch->Roll->Yaw', x_rotation_arm: 0, z_rotation_arm: 0 };
      const denom = Math.sqrt(1 + 0.001 * 0.001);
      const rays = [{ x: 0, y: 0, z: -500, a: 0, b: 0.001 / denom, c: 1 / denom }];
      const { good } = SR.mirror.reflectRays(rays, mirrorDef, { x: 0, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 }, null);
      approx(good[0].b, 0.001 / denom, 1e-9, '§8 A2: horizontal mirror leaves Y-divergence (b) unchanged');
    })();

    // --- §8 reflection: motion translation must be physically active (A4 fix) — a pure in-plane
    // (surface-local) translation is inert for a flat mirror, which is why A4 moved translations
    // into the stage frame; this pins that a nonzero z_motion actually changes the output.
    (function () {
      const mirrorDef = { name: 'M', azimuthal_angle: 0, nominal_pitch: 1.5 * Math.PI / 180, length_min: -250, length_max: 250, rotation_sequence: 'Pitch->Roll->Yaw', x_rotation_arm: 0, z_rotation_arm: 0 };
      const rays = [{ x: 0, y: 0, z: -500, a: 0.001, b: 0, c: 1 }];
      const base = SR.mirror.reflectRays(rays, mirrorDef, { x: 0, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 }, null).good[0];
      const moved = SR.mirror.reflectRays(rays, mirrorDef, { x: 5, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 }, null).good[0];
      assert(Math.abs(base.x - moved.x) > 1e-6, '§8 A4: x_motion measurably changes output position (not inert)');
    })();

    // --- §8 reflection: re-referencing to mirror center + outgoing-frame reorientation (§17
    // fixes) — pins near-perfect position preservation for a zero-motion, non-oblique (az=0)
    // mirror, matching the zero-motion reference run in ASSUMPTIONS.md §17.
    (function () {
      const mirrorDef = { name: 'M', azimuthal_angle: 0, nominal_pitch: 1.5 * Math.PI / 180, length_min: -250, length_max: 250, rotation_sequence: 'Pitch->Roll->Yaw', x_rotation_arm: 0, z_rotation_arm: 0 };
      // Reconstruct "Before M101" exactly as raytrace.js would (source -> shear -> AP101 clip -> shear).
      const source = { size_x_min: -1, size_x_max: 1, size_y_min: -1, size_y_max: 1, div_a_min: -0.002, div_a_max: 0.002, div_b_min: -0.002, div_b_max: 0.002 };
      let phaseSpace = SR.ps.radiate(source);
      phaseSpace = { poly_x: geo.shearPoly(phaseSpace.poly_x, 11857.055), poly_y: geo.shearPoly(phaseSpace.poly_y, 11857.055) };
      const ap101 = { name: 'AP101', size_x_min: -5, size_x_max: 5, size_y_min: -5, size_y_max: 5, misalignment_tolerances: SR.bl.defaultMisalignment() };
      phaseSpace = SR.ps.cut(phaseSpace, ap101, null);
      phaseSpace = { poly_x: geo.shearPoly(phaseSpace.poly_x, 100), poly_y: geo.shearPoly(phaseSpace.poly_y, 100) };

      const rays = SR.rs.sampleRaysFromPhaseSpace(2000, phaseSpace, mirrorDef.length_min, null);
      const { good } = SR.mirror.reflectRays(rays, mirrorDef, { x: 0, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 }, null);
      const hull = SR.ps.hullFromRays(good, null);
      const R = SR.mirror.outgoingReorientation(mirrorDef);
      const reoriented = SR.ps.reorient(hull, R, null);
      const [xmn, xmx] = geo.posBounds(reoriented.poly_x);
      approx(xmx, 5.050736729249766, 0.01, '§17: zero-motion az=0 mirror preserves X envelope to <0.01mm (reference: 5.0507)');
      approx(xmn, -5.050468847028225, 0.01, '§17: zero-motion az=0 mirror preserves X envelope to <0.01mm (reference: -5.0505)');
    })();

    // --- End-to-end smoke tests (must not throw) ---
    ['simple_passthrough', 'single_mirror', 'worked_fixture', 'csv_validation'].forEach((key) => {
      try {
        const ex = SR.examples[key];
        const out = SR.rt.run(ex, ex.config, null);
        assert(out.stages.length > 0, `e2e: "${key}" produced ${out.stages.length} stages without throwing`);
      } catch (e) {
        assert(false, `e2e: "${key}" threw: ${e.message}`);
      }
    });

    // --- e2e with the UI's actual default perf cap (3000): this is the exact scenario that
    // regressed once — worked_fixture's degenerate M102/G101/M103 hulls can accumulate enough
    // vertices that nx*ny exceeds a perf cap this low, which used to throw a hard error instead
    // of raising numRays to the true minimum (see raysample.js). ---
    (function () {
      try {
        const ex = SR.examples.worked_fixture;
        const config = Object.assign({}, ex.config, { perf_max_rays: 3000 });
        const out = SR.rt.run(ex, config, null);
        assert(out.stages.length > 0, 'e2e: worked_fixture with UI default perf_max_rays=3000 does not throw');
      } catch (e) {
        assert(false, `e2e: worked_fixture with perf_max_rays=3000 threw: ${e.message}`);
      }
    })();

    return results;
  }

  SR.tests = { runTests };
})(window.SR = window.SR || {});
