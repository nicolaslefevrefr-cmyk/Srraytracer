// beamline.js — §1 data model + §2 coordinate frames & transforms (exact per spec).
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const bl = {};

  // ---------- §1 Data model helpers ----------

  bl.defaultMisalignment = () => ({ X: [0, 0], Y: [0, 0], Z: [0, 0] });
  bl.defaultMirrorMisalignment = () => ({
    X: [0, 0], Y: [0, 0], Z: [0, 0], Pitch: [0, 0], Roll: [0, 0], Yaw: [0, 0],
  });

  // Resolve RelativeAperture entries into concrete Aperture objects inserted into the ordered
  // list, per §1. Operates on a raw JSON `components` array (Source first, then others in order).
  // RelativeAperture is specified as {type:'RelativeAperture', name, target: <name or index>,
  // distance}. `prev` = element immediately before target_element in the *current* ordered list
  // at resolution time (matches spec: order is load-bearing, so we resolve in a single left-to-right
  // pass, inserting as we go).
  bl.resolveBeamline = function (rawComponents, log) {
    const out = [];
    // First pass: copy everything, remembering where RelativeApertures want to be inserted.
    for (let i = 0; i < rawComponents.length; i++) {
      const comp = rawComponents[i];
      if (comp.type === 'RelativeAperture') {
        const targetIdx = out.findIndex((c) => c.name === comp.target);
        if (targetIdx === -1) {
          throw new Error(`RelativeAperture "${comp.name}": target "${comp.target}" not found among elements placed so far`);
        }
        if (targetIdx === 0) {
          throw new Error(`RelativeAperture "${comp.name}": target "${comp.target}" is the first element (the Source) — cannot place an aperture before it`);
        }
        const target = out[targetIdx];
        const prev = out[targetIdx - 1];
        const dir = geo.normalize(geo.sub(
          geo.v3(...target.position), geo.v3(...prev.position)));
        if (geo.length(dir) < 1e-12) {
          throw new Error(`RelativeAperture "${comp.name}": target and previous element share the same position; direction is undefined`);
        }
        const pos = geo.sub(geo.v3(...target.position), geo.scale(dir, comp.distance));
        const aperture = {
          type: 'Aperture',
          name: comp.name,
          position: [pos.x, pos.y, pos.z],
          size_x_min: comp.size_x_min, size_x_max: comp.size_x_max,
          size_y_min: comp.size_y_min, size_y_max: comp.size_y_max,
          misalignment_tolerances: comp.misalignment_tolerances || bl.defaultMisalignment(),
          _resolvedFromRelative: true,
        };
        out.splice(targetIdx, 0, aperture);
        if (log) log(`RelativeAperture "${comp.name}" resolved to position [${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}], inserted before "${target.name}"`);
      } else {
        out.push(Object.assign({}, comp));
      }
    }
    if (out.length === 0 || out[0].type !== 'Source') {
      throw new Error('Beamline must start with a Source element');
    }
    return out;
  };

  // ---------- §2.1 getLocalCoordinateSystem ----------
  // world.origin / world.orientation (3x3 col matrix X,Y,Z) describe the Source's world pose.
  bl.getLocalCoordinateSystem = function (elements, index, worldOrigin, worldOrientation) {
    if (index === 0) {
      const O = worldOrigin || geo.v3(0, 0, 0);
      const M = worldOrientation || geo.matIdentity();
      return {
        origin: O,
        X: geo.v3(M[0][0], M[1][0], M[2][0]),
        Y: geo.v3(M[0][1], M[1][1], M[2][1]),
        Z: geo.v3(M[0][2], M[1][2], M[2][2]),
      };
    }
    const prev = geo.v3(...elements[index - 1].position);
    const curr = geo.v3(...elements[index].position);
    const hasNext = index + 1 < elements.length;
    const next = hasNext ? geo.v3(...elements[index + 1].position) : null;

    const v1 = geo.sub(curr, prev);
    const v2 = hasNext ? geo.sub(next, curr) : null;

    let X, Y, Z;
    const collinear = v2 && geo.length(geo.cross(v1, v2)) < 1e-6;

    if (collinear) {
      Z = geo.normalize(v1);
      X = geo.normalize(geo.cross(geo.v3(0, 1, 0), Z));
      Y = geo.normalize(geo.cross(Z, X));
    } else if (v2) {
      // half-angle bisector convention
      const n1 = geo.normalize(v1), n2 = geo.normalize(v2);
      X = geo.normalize(geo.sub(n2, n1));
      const v1dotX = geo.dot(v1, X);
      Z = geo.normalize(geo.sub(v1, geo.scale(X, v1dotX)));
      Y = geo.normalize(geo.cross(Z, X));
    } else {
      // last element, no next
      Z = geo.normalize(v1);
      X = geo.normalize(geo.cross(geo.v3(0, 1, 0), Z));
      Y = geo.normalize(geo.cross(Z, X));
    }
    return { origin: curr, X, Y, Z };
  };

  // Straight-through frame at `index`, always using the collinear-branch formula, seeded from
  // elements[index-1] and elements[index] (used internally by §2.2 for R_prev, per spec).
  function straightThroughFrame(elements, index) {
    const curr = geo.v3(...elements[index].position);
    const prevPos = index > 0 ? geo.v3(...elements[index - 1].position) : null;
    let v1;
    if (prevPos) v1 = geo.sub(curr, prevPos);
    else v1 = geo.v3(0, 0, 1); // degenerate: index 0 with no predecessor, shouldn't be called this way
    const Z = geo.normalize(v1);
    const X = geo.normalize(geo.cross(geo.v3(0, 1, 0), Z));
    const Y = geo.normalize(geo.cross(Z, X));
    return { origin: curr, X, Y, Z };
  }

  // ---------- §2.2 getTransformationMatrix ----------
  bl.getTransformationMatrix = function (elements, index, worldOrigin, worldOrientation) {
    if (index === 0) {
      const O = worldOrigin || geo.v3(0, 0, 0);
      const M = worldOrientation || geo.matIdentity();
      const euler = geo.decomposeZYX(M);
      return { rotation: M, translation: O, azimuth: euler.az, pitch: euler.pitch, yaw: euler.yaw };
    }
    const Rprev3 = straightThroughFrame(elements, index - 1);
    const Rprev = geo.matFromColumns(Rprev3.X, Rprev3.Y, Rprev3.Z);
    const curr3 = bl.getLocalCoordinateSystem(elements, index, worldOrigin, worldOrientation);
    const Rcurr = geo.matFromColumns(curr3.X, curr3.Y, curr3.Z);

    const RprevT = geo.matTranspose(Rprev);
    const rotation = geo.matMul(RprevT, Rcurr);
    const originDiff = geo.sub(curr3.origin, Rprev3.origin);
    const translation = geo.matMulVec(RprevT, originDiff);
    const euler = geo.decomposeZYX(rotation);

    return { rotation, translation, azimuth: euler.az, pitch: euler.pitch, yaw: euler.yaw };
  };

  SR.bl = bl;
})(window.SR = window.SR || {});
