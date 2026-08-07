// convergence.js — §9 converge_reflect().
//
// NOTE: §9.3 specifies scipy.optimize.differential_evolution with tol=0, atol=-1 (disabling its
// internal early stopping) so that the OUTER loop's two-consecutive-iterations rule (§9.3 step 5)
// is what governs stopping. This port hand-rolls a standard rand/1/bin DE (§12 of the build spec
// explicitly sanctions hand-rolling since §9 is fully specified). `polish=True` in scipy runs a
// local L-BFGS-B refinement on the best member at the end of each DE call; this port approximates
// that with a small coordinate-wise local search (documented simplification — flagged, not silent).
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const ps = SR.ps;
  const rs = SR.rs;
  const mirror = SR.mirror;
  const conv = {};

  const DOF = ['x', 'y', 'z', 'pitch', 'roll', 'yaw'];
  const motionKey = { x: 'x_motion', y: 'y_motion', z: 'z_motion', pitch: 'pitch', roll: 'roll', yaw: 'yaw' };

  function motionRange(mirrorDef, dof) {
    const key = motionKey[dof];
    const mn = mirrorDef[key + '_min'];
    const mx = mirrorDef[key + '_max'];
    return [mn == null ? 0 : mn, mx == null ? 0 : mx];
  }

  // §9.1 grid seed bounds: motion range extended by misalignment tolerance.
  // Translational (X,Y,Z) misalignment is rotated by azimuth-only (not pitch) per spec §9.1.
  function gridBounds(mirrorDef) {
    const mis = mirrorDef.misalignment_tolerances || SR.bl.defaultMirrorMisalignment();
    const azimuth = mirrorDef.azimuthal_angle - Math.PI / 2;
    const Rz = geo.Rz(azimuth);

    // rotate the 8 corners of the misalignment box to get a safe enclosing range per axis
    const corners = [];
    for (const X of mis.X) for (const Y of mis.Y) for (const Z of mis.Z) corners.push(geo.v3(X, Y, Z));
    let rmn = geo.v3(Infinity, Infinity, Infinity), rmx = geo.v3(-Infinity, -Infinity, -Infinity);
    for (const c of corners) {
      const r = geo.matMulVec(Rz, c);
      rmn = geo.v3(Math.min(rmn.x, r.x), Math.min(rmn.y, r.y), Math.min(rmn.z, r.z));
      rmx = geo.v3(Math.max(rmx.x, r.x), Math.max(rmx.y, r.y), Math.max(rmx.z, r.z));
    }

    const b = {};
    const [xmn, xmx] = motionRange(mirrorDef, 'x'); b.x = [xmn + rmn.x, xmx + rmx.x];
    const [ymn, ymx] = motionRange(mirrorDef, 'y'); b.y = [ymn + rmn.y, ymx + rmx.y];
    const [zmn, zmx] = motionRange(mirrorDef, 'z'); b.z = [zmn + rmn.z, zmx + rmx.z];
    const [pmn, pmx] = motionRange(mirrorDef, 'pitch'); b.pitch = [pmn + Math.min(...mis.Pitch), pmx + Math.max(...mis.Pitch)];
    const [rmn2, rmx2] = motionRange(mirrorDef, 'roll'); b.roll = [rmn2 + Math.min(...mis.Roll), rmx2 + Math.max(...mis.Roll)];
    const [ymn2, ymx2] = motionRange(mirrorDef, 'yaw'); b.yaw = [ymn2 + Math.min(...mis.Yaw), ymx2 + Math.max(...mis.Yaw)];
    return b;
  }

  function linspace(a, b, n) {
    if (n <= 1) return [(a + b) / 2];
    const out = [];
    for (let i = 0; i < n; i++) out.push(a + (i * (b - a)) / (n - 1));
    return out;
  }

  function buildGrid(bounds, resolution) {
    const axes = DOF.map((dof) => {
      const [mn, mx] = bounds[dof];
      const width = mx - mn;
      const n = width < 1e-12 ? 1 : resolution[dof];
      return linspace(mn, mx, n);
    });
    const points = [];
    (function recurse(i, acc) {
      if (i === DOF.length) { points.push(Object.assign({}, acc)); return; }
      for (const v of axes[i]) { acc[DOF[i]] = v; recurse(i + 1, acc); }
    })(0, {});
    return points;
  }

  function reflectAtMotion(rays, mirrorDef, motionPt, log) {
    return mirror.reflectRays(rays, mirrorDef, motionPt, log);
  }

  function combinedArea(union) {
    return geo.polygonArea(union.poly_x) + geo.polygonArea(union.poly_y);
  }

  // §9.1/§9.2 grid seeding + initial union coverage. Used standalone for 'coarse' mode too
  // (with resolution flattened to 3 on every axis per §9.4, and reduced ray count already
  // applied upstream by §6's formula).
  function seedGrid(rays, mirrorDef, resolution, log) {
    const bounds = gridBounds(mirrorDef);
    const gridPts = buildGrid(bounds, resolution);
    let unionGood = { poly_x: [], poly_y: [] };
    let unionOver = { poly_x: [], poly_y: [] };
    for (const pt of gridPts) {
      const { good, over } = reflectAtMotion(rays, mirrorDef, pt, log);
      const hullGood = ps.hullFromRays(good, log);
      const hullOver = ps.hullFromRays(over, log);
      unionGood = { poly_x: ps.unionHull(unionGood.poly_x, hullGood.poly_x, log), poly_y: ps.unionHull(unionGood.poly_y, hullGood.poly_y, log) };
      unionOver = { poly_x: ps.unionHull(unionOver.poly_x, hullOver.poly_x, log), poly_y: ps.unionHull(unionOver.poly_y, hullOver.poly_y, log) };
    }
    return { unionGood, unionOver, bounds, gridPointCount: gridPts.length };
  }

  // Hand-rolled DE (rand/1/bin), bounds-only (motion_min/max, NOT misalignment per §9.3).
  function differentialEvolution(objective, bounds6, opts) {
    const { popsize = 10, maxiter = 25, mutationRange = [0.7, 1.5], recombination = 0.7, seedCache } = opts;
    const D = 6;
    const NP = Math.max(popsize * D, 6);
    let pop = [];
    for (let i = 0; i < NP; i++) {
      const ind = bounds6.map(([lo, hi]) => lo + Math.random() * (hi - lo));
      pop.push(ind);
    }
    let fitness = pop.map((ind) => objective(ind));

    let best = pop[0], bestF = fitness[0];
    for (let i = 1; i < NP; i++) if (fitness[i] < bestF) { bestF = fitness[i]; best = pop[i]; }

    for (let gen = 0; gen < maxiter; gen++) {
      const F = mutationRange[0] + Math.random() * (mutationRange[1] - mutationRange[0]);
      for (let i = 0; i < NP; i++) {
        let a, b, c;
        do { a = Math.floor(Math.random() * NP); } while (a === i);
        do { b = Math.floor(Math.random() * NP); } while (b === i || b === a);
        do { c = Math.floor(Math.random() * NP); } while (c === i || c === a || c === b);
        const trial = pop[i].slice();
        const jrand = Math.floor(Math.random() * D);
        for (let j = 0; j < D; j++) {
          if (Math.random() < recombination || j === jrand) {
            let v = pop[a][j] + F * (pop[b][j] - pop[c][j]);
            const [lo, hi] = bounds6[j];
            if (v < lo) v = lo; if (v > hi) v = hi;
            trial[j] = v;
          }
        }
        const tf = objective(trial);
        if (tf <= fitness[i]) { pop[i] = trial; fitness[i] = tf; if (tf < bestF) { bestF = tf; best = trial; } }
      }
    }
    // "polish=True" approximation: small coordinate-wise local search around the best member.
    let step = 0.05;
    for (let round = 0; round < 8; round++) {
      let improved = false;
      for (let j = 0; j < D; j++) {
        const [lo, hi] = bounds6[j];
        const span = (hi - lo) * step || 1e-6;
        for (const dir of [-1, 1]) {
          const cand = best.slice();
          cand[j] = Math.max(lo, Math.min(hi, cand[j] + dir * span));
          const cf = objective(cand);
          if (cf < bestF) { bestF = cf; best = cand; improved = true; }
        }
      }
      if (!improved) step *= 0.5;
    }
    return { x: best, f: bestF };
  }

  // §9 top-level entry point. Returns {phase_space_good, phase_space_over, warnings, debug}.
  conv.convergeReflect = function (incomingPhaseSpace, mirrorDef, opts) {
    const { mode, linearAccuracy, angularAccuracy, log, perfCap } = opts;
    const debug = { mode, steps: [] };
    const warnings = [];

    const { numRays } = rs.computeNumRays(incomingPhaseSpace.poly_x, incomingPhaseSpace.poly_y, linearAccuracy, angularAccuracy, mode, log, perfCap);

    if (mode === 'coarse') {
      const resolution = { x: 3, y: 3, z: 3, pitch: 3, roll: 3, yaw: 3 };
      const rays = rs.sampleRaysFromPhaseSpace(numRays, incomingPhaseSpace, mirrorDef.length_min, log);
      const { unionGood, unionOver, gridPointCount } = seedGrid(rays, mirrorDef, resolution, log);
      if (log) log(`coarse mode: grid of ${gridPointCount} motion samples, ${rays.length} rays each`);
      if (unionOver.poly_x.length > 0 || unionOver.poly_y.length > 0) warnings.push(`spillover ("over") rays detected on mirror "${mirrorDef.name}"`);
      return { phase_space_good: unionGood, phase_space_over: unionOver, warnings, numRays, debug };
    }

    // fine mode
    const resolution = { x: 11, y: 3, z: 3, pitch: 11, roll: 3, yaw: 3 };
    const rays0 = rs.sampleRaysFromPhaseSpace(numRays, incomingPhaseSpace, mirrorDef.length_min, log);
    const { unionGood: seedGood, unionOver: seedOver, gridPointCount } = seedGrid(rays0, mirrorDef, resolution, log);
    if (log) log(`fine mode: initial grid of ${gridPointCount} motion samples, ${rays0.length} rays each`);

    let unionGood = seedGood, unionOver = seedOver;
    let totalArea = combinedArea(unionGood);
    const tol = linearAccuracy * angularAccuracy;
    let consecutiveSmall = 0;
    const maxIter = 25;

    // motion-only bounds (NOT misalignment) for the DE inner loop, per §9.3.
    const bounds6 = DOF.map((dof) => motionRange(mirrorDef, dof));

    for (let iter = 0; iter < maxIter; iter++) {
      const rays = rs.sampleRaysFromPhaseSpace(numRays, incomingPhaseSpace, mirrorDef.length_min, null);
      const cache = new Map();
      const objective = (vec) => {
        const key = vec.map((v) => v.toFixed(8)).join(',');
        if (cache.has(key)) return cache.get(key);
        const motionPt = { x: vec[0], y: vec[1], z: vec[2], pitch: vec[3], roll: vec[4], yaw: vec[5] };
        const { good } = reflectAtMotion(rays, mirrorDef, motionPt, null);
        const hullGood = ps.hullFromRays(good, null);
        const candidateUnion = { poly_x: ps.unionHull(unionGood.poly_x, hullGood.poly_x, null), poly_y: ps.unionHull(unionGood.poly_y, hullGood.poly_y, null) };
        const increase = combinedArea(candidateUnion) - combinedArea(unionGood);
        const val = -increase; // minimize negative increase = maximize increase
        cache.set(key, val);
        return val;
      };

      const result = differentialEvolution(objective, bounds6, { popsize: 10, maxiter: 25, mutationRange: [0.7, 1.5] });
      const bestMotion = { x: result.x[0], y: result.x[1], z: result.x[2], pitch: result.x[3], roll: result.x[4], yaw: result.x[5] };
      const { good, over } = reflectAtMotion(rays, mirrorDef, bestMotion, log);
      const hullGood = ps.hullFromRays(good, log);
      const hullOver = ps.hullFromRays(over, log);
      unionGood = { poly_x: ps.unionHull(unionGood.poly_x, hullGood.poly_x, log), poly_y: ps.unionHull(unionGood.poly_y, hullGood.poly_y, log) };
      unionOver = { poly_x: ps.unionHull(unionOver.poly_x, hullOver.poly_x, log), poly_y: ps.unionHull(unionOver.poly_y, hullOver.poly_y, log) };

      const newTotalArea = combinedArea(unionGood);
      const absChange = Math.abs(newTotalArea - totalArea);
      totalArea = newTotalArea;
      debug.steps.push({ iter, absChange, totalArea });
      if (log) log(`fine iter ${iter}: DE best motion=${JSON.stringify(bestMotion)}, |Δarea|=${absChange.toExponential(3)}`);

      if (absChange < tol) {
        consecutiveSmall++;
        if (consecutiveSmall >= 2) { if (log) log(`fine mode converged after ${iter + 1} iterations (2 consecutive small changes)`); break; }
      } else {
        consecutiveSmall = 0;
      }
    }

    if (unionOver.poly_x.length > 0 || unionOver.poly_y.length > 0) warnings.push(`spillover ("over") rays detected on mirror "${mirrorDef.name}"`);
    return { phase_space_good: unionGood, phase_space_over: unionOver, warnings, numRays, debug };
  };

  SR.conv = conv;
})(window.SR = window.SR || {});
