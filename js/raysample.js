// raysample.js — §6 ray-count formula + §6.1 sample_rays_from_phase_space (exact per spec).
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const rs = {};

  // §6 numRays formula.
  // `perfCap` (optional) is NOT part of the build spec — it's a pragmatic browser-safety clamp
  // documented in the UI's "About" tab: this port runs §9's DE loop synchronously on the main
  // thread (no Web Worker, see §11's roadmap note), so an unclamped `fine`-mode ray count at the
  // spec's own default accuracy (0.5mm / 250µrad) can take many minutes per mirror. When perfCap
  // is supplied and smaller than the formula's result, numRays is clamped further and a warning
  // is logged so the deviation from the exact formula is never silent.
  rs.computeNumRays = function (poly_x, poly_y, linearAccuracy, angularAccuracy, mode, log, perfCap) {
    const areaX = geo.polygonArea(poly_x);
    const areaY = geo.polygonArea(poly_y);
    const raysPerMmRad = 1 / (linearAccuracy * angularAccuracy);
    const numRaysX = areaX * raysPerMmRad;
    const numRaysY = areaY * raysPerMmRad;
    const numRaysFromAccuracy = Math.ceil(numRaysX * numRaysY);

    const verticesX = geo.numberOfVertices(poly_x);
    const verticesY = geo.numberOfVertices(poly_y);
    const numRaysFromVertices = Math.ceil(10 * verticesX * verticesY);

    let numRays = 5 * Math.max(numRaysFromAccuracy, numRaysFromVertices);
    let clamped = false;

    if (mode === 'fine') {
      if (numRays > 500000) { numRays = 500000; clamped = true; }
    } else {
      if (numRays > 100000) { numRays = 100000; clamped = true; }
      numRays = Math.floor(numRays / 5);
    }
    if (clamped && log) log(`ray count clamped to ${numRays} for mode="${mode}" (formula gave more) — this clamp IS in the spec (§6)`);

    if (perfCap && numRays > perfCap) {
      if (log) log(`WARNING: browser-safety cap applied — numRays reduced from ${numRays} to ${perfCap}. This is NOT part of §6; it exists because this port runs synchronously with no Web Worker. Raise "Max rays" in the UI (or run headless) to use the exact formula.`);
      numRays = perfCap;
    }
    return { numRays, areaX, areaY, numRaysFromAccuracy, numRaysFromVertices };
  };

  // §6.1 sample_rays_from_phase_space(numRays, phaseSpace, length_min)
  // Returns array of {x,y,z,a,b,c}.
  rs.sampleRaysFromPhaseSpace = function (numRays, phaseSpace, length_min, log) {
    const d = 2 * length_min;
    const backX = geo.shearPoly(phaseSpace.poly_x, d);
    const backY = geo.shearPoly(phaseSpace.poly_y, d);

    const nx = backX.length, ny = backY.length;
    if (numRays < nx * ny) {
      throw new Error(`sample_rays_from_phase_space: numRays (${numRays}) must be >= nx*ny (${nx}*${ny}=${nx * ny})`);
    }

    const pairs = [];
    // 1) full cross product of vertices (guarantees corners are represented)
    for (const vx of backX) {
      for (const vy of backY) {
        pairs.push([vx, vy]);
      }
    }

    // 2) fill remaining via rejection sampling inside each polygon's bounding box
    const remaining = numRays - nx * ny;
    if (remaining > 0) {
      const [pxMin, pxMax] = geo.posBounds(backX);
      const [sxMin, sxMax] = geo.slopeBounds(backX);
      const [pyMin, pyMax] = geo.posBounds(backY);
      const [syMin, syMax] = geo.slopeBounds(backY);
      const xSamples = rejectionSample(remaining, backX, pxMin, pxMax, sxMin, sxMax);
      const ySamples = rejectionSample(remaining, backY, pyMin, pyMax, syMin, syMax);
      for (let i = 0; i < remaining; i++) pairs.push([xSamples[i], ySamples[i]]);
    }

    const rays = pairs.map(([vx, vy]) => {
      const slopeX = vx.s, slopeY = vy.s;
      const denom = Math.sqrt(1 + slopeX * slopeX + slopeY * slopeY);
      return {
        x: vx.p, y: vy.p, z: d,
        a: slopeX / denom, b: slopeY / denom, c: 1 / denom,
      };
    });
    if (log) log(`sampled ${rays.length} rays (${nx}x${ny}=${nx * ny} corner pairs + ${Math.max(0, remaining)} interior)`);
    return rays;
  };

  function pointInConvexPolyForSampling(pt, poly) {
    if (poly.length < 3) {
      // degenerate polygon: accept points that lie essentially on the segment/point
      if (poly.length === 0) return false;
      if (poly.length === 1) return Math.abs(pt.p - poly[0].p) < 1e-9 && Math.abs(pt.s - poly[0].s) < 1e-9;
      // segment: accept anything within its bounding box (best-effort for a measure-zero region)
      const [pmn, pmx] = [Math.min(poly[0].p, poly[1].p), Math.max(poly[0].p, poly[1].p)];
      const [smn, smx] = [Math.min(poly[0].s, poly[1].s), Math.max(poly[0].s, poly[1].s)];
      return pt.p >= pmn - 1e-9 && pt.p <= pmx + 1e-9 && pt.s >= smn - 1e-9 && pt.s <= smx + 1e-9;
    }
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const cr = (b.p - a.p) * (pt.s - a.s) - (b.s - a.s) * (pt.p - a.p);
      if (Math.abs(cr) < 1e-12) continue;
      const sgn = cr > 0 ? 1 : -1;
      if (sign === 0) sign = sgn;
      else if (sgn !== sign) return false;
    }
    return true;
  }

  function rejectionSample(n, poly, pMin, pMax, sMin, sMax) {
    const out = [];
    const pSpan = Math.max(pMax - pMin, 1e-12);
    const sSpan = Math.max(sMax - sMin, 1e-12);
    let guard = 0;
    const guardLimit = n * 5000 + 10000;
    while (out.length < n && guard < guardLimit) {
      guard++;
      const cand = { p: pMin + Math.random() * pSpan, s: sMin + Math.random() * sSpan };
      if (pointInConvexPolyForSampling(cand, poly)) out.push(cand);
    }
    // If rejection sampling can't fill (near-zero-area polygon), pad with the bounding-box center.
    while (out.length < n) out.push({ p: (pMin + pMax) / 2, s: (sMin + sMax) / 2 });
    return out;
  }

  SR.rs = rs;
})(window.SR = window.SR || {});
