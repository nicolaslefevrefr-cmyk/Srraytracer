// geometry.js — pure math primitives. No DOM, no globals besides `SR.geo`.
// Framework-free by design (per build-instructions §11) so it can be validated in isolation.
(function (SR) {
  'use strict';

  const geo = {};

  // ---------- Vec3 ----------
  geo.v3 = (x, y, z) => ({ x, y, z });
  geo.add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  geo.sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  geo.scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
  geo.dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  geo.cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  geo.length = (a) => Math.sqrt(geo.dot(a, a));
  geo.normalize = (a) => {
    const l = geo.length(a);
    if (l < 1e-15) return { x: 0, y: 0, z: 0 };
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  };

  // ---------- Mat3 (rows = [[m00,m01,m02],[m10,m11,m12],[m20,m21,m22]]) ----------
  geo.matIdentity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  geo.matFromColumns = (X, Y, Z) => [
    [X.x, Y.x, Z.x],
    [X.y, Y.y, Z.y],
    [X.z, Y.z, Z.z],
  ];

  geo.matMul = (A, B) => {
    const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
        R[i][j] = s;
      }
    return R;
  };

  geo.matMulVec = (A, v) => ({
    x: A[0][0] * v.x + A[0][1] * v.y + A[0][2] * v.z,
    y: A[1][0] * v.x + A[1][1] * v.y + A[1][2] * v.z,
    z: A[2][0] * v.x + A[2][1] * v.y + A[2][2] * v.z,
  });

  geo.matTranspose = (A) => [
    [A[0][0], A[1][0], A[2][0]],
    [A[0][1], A[1][1], A[2][1]],
    [A[0][2], A[1][2], A[2][2]],
  ];

  // Standard rotation matrices about the LOCAL principal axes.
  geo.Rx = (t) => [
    [1, 0, 0],
    [0, Math.cos(t), -Math.sin(t)],
    [0, Math.sin(t), Math.cos(t)],
  ];
  geo.Ry = (t) => [
    [Math.cos(t), 0, Math.sin(t)],
    [0, 1, 0],
    [-Math.sin(t), 0, Math.cos(t)],
  ];
  geo.Rz = (t) => [
    [Math.cos(t), -Math.sin(t), 0],
    [Math.sin(t), Math.cos(t), 0],
    [0, 0, 1],
  ];

  // Intrinsic ZYX decomposition of R = Rz(az) * Ry(pitch) * Rx(yaw).
  // Returns {az, pitch, yaw} in radians. Handles the gimbal-lock case (|R[2][0]|~1) gracefully.
  geo.decomposeZYX = (R) => {
    const r20 = Math.max(-1, Math.min(1, -R[2][0]));
    const pitch = Math.asin(r20);
    let az, yaw;
    if (Math.abs(Math.abs(r20) - 1) < 1e-9) {
      // Gimbal lock: az and yaw are not independently observable; convention: yaw = 0.
      yaw = 0;
      az = Math.atan2(-R[0][1], R[1][1]);
    } else {
      az = Math.atan2(R[1][0], R[0][0]);
      yaw = Math.atan2(R[2][1], R[2][2]);
    }
    return { az, pitch, yaw };
  };

  // ---------- Polygon ops on {p, s} vertex lists (p = position mm, s = slope rad) ----------
  // A "polygon" is an array of {p, s}. Degenerate polygons (0, 1, or 2 vertices) are supported
  // by every function below since §7's fallback path explicitly produces these.

  // §3 Free travel / shear: pos' = pos + d*slope, slope unchanged.
  geo.shearPoly = (poly, d) => poly.map((v) => ({ p: v.p + d * v.s, s: v.s }));

  // Shoelace formula; robust to <3 vertices (returns 0).
  geo.polygonArea = (poly) => {
    if (!poly || poly.length < 3) return 0;
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i];
      const n = poly[(i + 1) % poly.length];
      a += c.p * n.s - n.p * c.s;
    }
    return Math.abs(a) / 2;
  };

  geo.slopeBounds = (poly) => {
    if (!poly || poly.length === 0) return [0, 0];
    let mn = Infinity, mx = -Infinity;
    for (const v of poly) { if (v.s < mn) mn = v.s; if (v.s > mx) mx = v.s; }
    return [mn, mx];
  };

  geo.posBounds = (poly) => {
    if (!poly || poly.length === 0) return [0, 0];
    let mn = Infinity, mx = -Infinity;
    for (const v of poly) { if (v.p < mn) mn = v.p; if (v.p > mx) mx = v.p; }
    return [mn, mx];
  };

  const keyOf = (v) => v.p.toFixed(9) + '|' + v.s.toFixed(9);
  geo.dedupeVerts = (verts) => {
    const seen = new Set();
    const out = [];
    for (const v of verts) {
      const k = keyOf(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    return out;
  };

  // Monotone-chain convex hull on {p,s} points (p = x-axis, s = y-axis for hull purposes).
  // Throws on internal inconsistency; callers should use hullOrFallback() instead of this directly.
  function monotoneChainHull(points) {
    const pts = points.slice().sort((a, b) => (a.p - b.p) || (a.s - b.s));
    const n = pts.length;
    if (n < 3) throw new Error('monotoneChainHull: fewer than 3 points');
    const cross = (o, a, b) => (a.p - o.p) * (b.s - o.s) - (a.s - o.s) * (b.p - o.p);
    const lower = [];
    for (const pt of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    }
    const upper = [];
    for (let i = n - 1; i >= 0; i--) {
      const pt = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
      upper.push(pt);
    }
    lower.pop(); upper.pop();
    const hull = lower.concat(upper);
    if (hull.length < 3) throw new Error('monotoneChainHull: degenerate (collinear) point set');
    return hull;
  }

  // §7's two-tier fallback: <3 unique points -> raw "hull" (point or segment);
  // else try real hull, falling back to the raw extreme points on any failure.
  geo.hullOrFallback = (rawPoints, log) => {
    const pts = geo.dedupeVerts(rawPoints);
    if (pts.length === 0) return { poly: [], degenerate: true, reason: 'empty' };
    if (pts.length < 3) {
      return { poly: pts, degenerate: true, reason: `${pts.length} unique point(s)` };
    }
    try {
      const hull = monotoneChainHull(pts);
      return { poly: hull, degenerate: false };
    } catch (e) {
      if (log) log(`convex hull fallback triggered: ${e.message}`);
      // Fallback: convexHull "of the raw point set" degenerate case -> extreme points along p.
      let mn = pts[0], mx = pts[0];
      for (const v of pts) { if (v.p < mn.p) mn = v; if (v.p > mx.p) mx = v; }
      const seg = geo.dedupeVerts([mn, mx]);
      return { poly: seg, degenerate: true, reason: e.message };
    }
  };

  // point-in-convex-polygon (poly given as ordered vertices, either winding)
  function pointInConvexPolygon(pt, poly) {
    if (poly.length < 3) return false;
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const cr = (b.p - a.p) * (pt.s - a.s) - (b.s - a.s) * (pt.p - a.p);
      if (Math.abs(cr) < 1e-12) continue;
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  // Sutherland–Hodgman clip of `subject` (any length >= 0) against convex `clip` (length >= 3).
  // Generalizes correctly for degenerate subjects (points/segments) since each half-plane pass
  // is just linear interpolation along consecutive (possibly wrapped) vertex pairs.
  geo.clipConvex = (subject, clip) => {
    if (!subject || subject.length === 0) return [];
    if (!clip || clip.length < 3) return [];
    if (subject.length === 1) {
      return pointInConvexPolygon(subject[0], clip) ? subject.slice() : [];
    }
    let output = subject.slice();
    const isOpen = subject.length === 2; // treat as a segment, not a closed 2-gon
    for (let i = 0; i < clip.length && output.length > 0; i++) {
      const A = clip[i], B = clip[(i + 1) % clip.length];
      // inside test: cross(B-A, X-A) >= 0 consistently oriented; determine polygon winding once.
      const edge = { p: B.p - A.p, s: B.s - A.s };
      const inside = (X) => edge.p * (X.s - A.s) - edge.s * (X.p - A.p);
      // Determine winding sign using clip centroid so 'inside' means "same side as interior".
      let cx = 0, cs = 0;
      for (const v of clip) { cx += v.p; cs += v.s; }
      cx /= clip.length; cs /= clip.length;
      const centroidSide = inside({ p: cx, s: cs });
      const sgn = centroidSide >= 0 ? 1 : -1;
      const isInside = (X) => sgn * inside(X) >= -1e-9;

      // Standard per-vertex half-plane clip. For a closed polygon (isOpen=false) we walk the
      // vertex list with wraparound (curr's "previous" for index 0 is the last vertex). For an
      // open path (isOpen=true, a bare 2-point segment) there's no wraparound: the first vertex
      // is only ever a "current", never implicitly re-visited as an edge's end, so it has to be
      // emitted explicitly up front if it's inside.
      const input = output;
      output = [];
      const nPts = input.length;
      if (isOpen && nPts > 0 && isInside(input[0])) output.push(input[0]);
      const startK = isOpen ? 1 : 0;
      for (let k = startK; k < nPts; k++) {
        const curr = input[k];
        const prev = input[(k - 1 + nPts) % nPts];
        const currIn = isInside(curr), prevIn = isInside(prev);
        if (currIn) {
          if (!prevIn) output.push(intersectEdge(prev, curr, A, edge));
          output.push(curr);
        } else if (prevIn) {
          output.push(intersectEdge(prev, curr, A, edge));
        }
      }
    }
    return geo.dedupeVerts(output);
  };

  function intersectEdge(S, E, A, edgeDir) {
    // Line S-E vs line through A with direction edgeDir. Solve S + t*(E-S) = A + u*edgeDir.
    const d1p = E.p - S.p, d1s = E.s - S.s;
    const d2p = edgeDir.p, d2s = edgeDir.s;
    const denom = d1p * d2s - d1s * d2p;
    if (Math.abs(denom) < 1e-15) return E; // parallel, shouldn't normally hit
    const t = ((A.p - S.p) * d2s - (A.s - S.s) * d2p) / denom;
    return { p: S.p + t * d1p, s: S.s + t * d1s };
  }

  // Axis-aligned rectangle in (p,s) space from corners, ordered CCW-ish (order doesn't matter
  // for clipConvex since winding is resolved via centroid test).
  geo.rect = (pMin, pMax, sMin, sMax) => [
    { p: pMin, s: sMin }, { p: pMin, s: sMax }, { p: pMax, s: sMax }, { p: pMax, s: sMin },
  ];

  geo.numberOfVertices = (poly) => (poly ? poly.length : 0);

  SR.geo = geo;
})(window.SR = window.SR || {});
