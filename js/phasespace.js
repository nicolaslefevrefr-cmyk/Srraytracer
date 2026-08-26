// phasespace.js — §4 source radiate() and §5 aperture cut() (exact per spec).
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const ps = {};

  // §4 radiate(): build the two starting rectangles from Source params.
  ps.radiate = function (source) {
    const poly_x = geo.rect(source.size_x_min, source.size_x_max, source.div_a_min, source.div_a_max);
    const poly_y = geo.rect(source.size_y_min, source.size_y_max, source.div_b_min, source.div_b_max);
    return { poly_x, poly_y };
  };

  // §5 cut(): aperture clipping with Z-misalignment handling.
  ps.cut = function (phaseSpace, aperture, log) {
    const mis = aperture.misalignment_tolerances || SR.bl.defaultMisalignment();
    const dzCandidates = [Math.min(...mis.Z), Math.max(...mis.Z)];
    // dedupe identical extremes (all-zero misalignment case) but keep the loop structure per spec.
    const cutResultsX = [];
    const cutResultsY = [];

    for (const dz of dzCandidates) {
      const shiftedX = geo.shearPoly(phaseSpace.poly_x, dz);
      const shiftedY = geo.shearPoly(phaseSpace.poly_y, dz);

      const [sMinX, sMaxX] = geo.slopeBounds(shiftedX);
      const rectX = geo.rect(
        aperture.size_x_min + Math.min(...mis.X), aperture.size_x_max + Math.max(...mis.X),
        sMinX, sMaxX
      );
      const newPolyX = geo.clipConvex(shiftedX, rectX);

      const [sMinY, sMaxY] = geo.slopeBounds(shiftedY);
      const rectY = geo.rect(
        aperture.size_y_min + Math.min(...mis.Y), aperture.size_y_max + Math.max(...mis.Y),
        sMinY, sMaxY
      );
      const newPolyY = geo.clipConvex(shiftedY, rectY);

      const backX = geo.shearPoly(newPolyX, -dz);
      const backY = geo.shearPoly(newPolyY, -dz);
      cutResultsX.push(...backX);
      cutResultsY.push(...backY);
    }

    const hullX = geo.hullOrFallback(cutResultsX, log);
    const hullY = geo.hullOrFallback(cutResultsY, log);
    if (log) {
      if (hullX.degenerate) log(`Aperture "${aperture.name}": poly_x is degenerate after clipping (${hullX.reason})`);
      if (hullY.degenerate) log(`Aperture "${aperture.name}": poly_y is degenerate after clipping (${hullY.reason})`);
    }
    return { poly_x: hullX.poly, poly_y: hullY.poly };
  };

  // §7 Convex hull reconstruction from a reflected ray set ({x,y,a,b,c}[]).
  ps.hullFromRays = function (rays, log) {
    if (rays.length === 0) return { poly_x: [], poly_y: [] };
    const pointsX = rays.map((r) => ({ p: r.x, s: r.a / r.c }));
    const pointsY = rays.map((r) => ({ p: r.y, s: r.b / r.c }));
    const hullX = geo.hullOrFallback(pointsX, log);
    const hullY = geo.hullOrFallback(pointsY, log);
    return { poly_x: hullX.poly, poly_y: hullY.poly, degenerateX: hullX.degenerate, degenerateY: hullY.degenerate };
  };

  // Convex union-then-rehull, used by §9's running coverage accumulation:
  // "unary_union(...).convex_hull" on each new addition, simplified (since our polygons are
  // always convex already) to: hull(hull1.vertices UNION hull2.vertices).
  ps.unionHull = function (polyA, polyB, log) {
    const combined = (polyA || []).concat(polyB || []);
    const h = geo.hullOrFallback(combined, log);
    return h.poly;
  };

  // Reorient a phase space into a new frame via a 3x3 rotation matrix R (v_new = R * v_old),
  // by sampling the full corner cross-product (exact for a linear map — extremes of a linear
  // functional over a convex polygon occur at its vertices) and re-hulling. Position vectors are
  // treated as (x, y, 0) — the phase space only ever tracks a transverse plane, never a depth —
  // and direction vectors come from the usual slope -> direction-cosine conversion.
  ps.reorient = function (phaseSpace, R, log) {
    const rays = [];
    for (const vx of phaseSpace.poly_x) {
      for (const vy of phaseSpace.poly_y) {
        const denom = Math.sqrt(1 + vx.s * vx.s + vy.s * vy.s);
        const Pold = geo.v3(vx.p, vy.p, 0);
        const Dold = geo.v3(vx.s / denom, vy.s / denom, 1 / denom);
        const Pnew = geo.matMulVec(R, Pold);
        const Dnew = geo.matMulVec(R, Dold);
        rays.push({ x: Pnew.x, y: Pnew.y, a: Dnew.x, b: Dnew.y, c: Dnew.z });
      }
    }
    return ps.hullFromRays(rays, log);
  };

  SR.ps = ps;
})(window.SR = window.SR || {});
