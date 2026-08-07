// mirror.js — §8 mirror reflection.
//
// IMPLEMENTATION ASSUMPTIONS (the build spec explicitly says to flag ambiguity rather than
// silently guess — these are the three places §8 left the exact composition underspecified
// without xrt source, and how this port resolves them; see ASSUMPTIONS.md for the full writeup):
//
//   A1. "Beamline coordinates" in §8.2/§8.6 means the per-stage transverse+propagation frame
//       that the (x,y,slope) phase-space representation already lives in (matching how §3/§7
//       only ever operate on (pos,slope) pairs, never full 3D world coordinates). The mirror's
//       own §2 world placement is a separate concern (used for the 3D layout / distance tools),
//       not re-derived here.
//   A2. Rotation composition order: R_nom = Rz(azimuth) * Ry(nominalPitch); the rotation_sequence
//       DOF list composes as R_extra = R_first * R_second * R_third (intrinsic composition,
//       consistent with the ZYX convention established in §2.2); R_total = R_nom * R_extra.
//   A3. Motion translations (x_val,y_val,z_val + pivot delta) are expressed along the mirror's
//       NOMINAL local axes (rotated into stage coordinates via R_nom, not R_total) — i.e.
//       translation stages are assumed mounted on the nominal (undeflected) mirror frame.
//
// §8.3-§8.5 (flat mirror intersection/normal/reflection law) are transcribed exactly and do not
// depend on these assumptions.
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const mirror = {};

  // §8.1 Build the local-frame-to-stage transform for a candidate motion sample.
  // motion = {yaw, pitch, roll, x, y, z} (Rx_val=yaw, Ry_val=pitch, Rz_val=roll per spec labels)
  mirror.buildTransform = function (mirrorDef, motion) {
    const nominalPitch = mirrorDef.nominal_pitch;
    const azimuth = mirrorDef.azimuthal_angle - Math.PI / 2;
    const Rnom = geo.matMul(geo.Rz(azimuth), geo.Ry(nominalPitch));

    const pivot = geo.v3(mirrorDef.x_rotation_arm || 0, 0, mirrorDef.z_rotation_arm || 0);
    const RpitchMotion = geo.Ry(motion.pitch);
    const I = geo.matIdentity();
    const IminusR = [
      [I[0][0] - RpitchMotion[0][0], I[0][1] - RpitchMotion[0][1], I[0][2] - RpitchMotion[0][2]],
      [I[1][0] - RpitchMotion[1][0], I[1][1] - RpitchMotion[1][1], I[1][2] - RpitchMotion[1][2]],
      [I[2][0] - RpitchMotion[2][0], I[2][1] - RpitchMotion[2][1], I[2][2] - RpitchMotion[2][2]],
    ];
    const delta = geo.matMulVec(IminusR, pivot);
    const translationLocal = geo.v3(motion.x + delta.x, motion.y + delta.y, motion.z + delta.z);

    // Rotation sequence, e.g. 'Pitch->Roll->Yaw' -> compose in that literal order.
    const seq = (mirrorDef.rotation_sequence || 'Pitch->Roll->Yaw').split('->').map((s) => s.trim());
    const axisMat = { Yaw: geo.Rx(motion.yaw), Pitch: geo.Ry(motion.pitch), Roll: geo.Rz(motion.roll) };
    let Rextra = geo.matIdentity();
    for (const name of seq) {
      const M = axisMat[name];
      if (!M) throw new Error(`Unknown rotation_sequence axis "${name}"`);
      Rextra = geo.matMul(Rextra, M);
    }

    const Rtotal = geo.matMul(Rnom, Rextra);
    const translationStage = geo.matMulVec(Rnom, translationLocal); // A3
    return { Rtotal, translationStage, Rnom };
  };

  // §8.2 world/stage -> surface-local (inverse transform)
  function toLocal(T, P) {
    const Rt = geo.matTranspose(T.Rtotal);
    return geo.matMulVec(Rt, geo.sub(P, T.translationStage));
  }
  function toLocalDir(T, D) {
    const Rt = geo.matTranspose(T.Rtotal);
    return geo.matMulVec(Rt, D);
  }
  // §8.6 surface-local -> stage (forward transform)
  function toStage(T, P) {
    return geo.add(geo.matMulVec(T.Rtotal, P), T.translationStage);
  }
  function toStageDir(T, D) {
    return geo.matMulVec(T.Rtotal, D);
  }

  // §8.3/§8.4 Flat mirror: intersection with plane z_local=0, constant normal.
  function intersectFlat(P, D) {
    const t = -P.z / D.z;
    const x_local = P.x + t * D.x;
    const y_local = P.y + t * D.y;
    return { t, point: geo.v3(x_local, y_local, 0), normal: geo.v3(0, 0, 1) };
  }

  // §8.7 Paraboloid (cylindrical) — SKETCH ONLY, not validated against xrt. Root-finds via
  // Newton's method starting from the flat-plane closed-form guess, using the toy equation
  // z = x^2/(4f) given in the spec. `p`,`q` combine via the standard mirror equation 1/f =
  // 1/p + 1/q when both are provided; if only one is given, f = that value directly (treated
  // as focal length). This is explicitly flagged: xrt's real p/q/pitch-rotated parametrization
  // is NOT reproduced here (spec §8.7: "if you don't have xrt's source, say so explicitly").
  function focalLengthFromPQ(mirrorDef) {
    const p = mirrorDef.p, q = mirrorDef.q;
    if (p && q) return 1 / (1 / p + 1 / q);
    if (p) return p;
    if (q) return q;
    throw new Error('Paraboloid mirror requires p and/or q');
  }

  function intersectParaboloidSketch(P, D, mirrorDef, log) {
    const f = focalLengthFromPQ(mirrorDef);
    const zOf = (x) => (x * x) / (4 * f);
    const dzdx = (x) => x / (2 * f);
    // Newton's method on t: g(t) = P.z + t*D.z - zOf(P.x + t*D.x) = 0
    let t = -P.z / D.z; // flat-plane initial guess
    for (let iter = 0; iter < 50; iter++) {
      const x = P.x + t * D.x;
      const z = P.z + t * D.z;
      const g = z - zOf(x);
      const dgdt = D.z - dzdx(x) * D.x;
      if (Math.abs(dgdt) < 1e-14) break;
      const dt = g / dgdt;
      t -= dt;
      if (Math.abs(dt) < 1e-12) break;
    }
    const x_local = P.x + t * D.x;
    const y_local = P.y + t * D.y;
    const z_local = zOf(x_local);
    const grad = geo.normalize(geo.v3(-dzdx(x_local), 0, 1));
    if (log) log(`  [§8.7 sketch] paraboloid Newton solve: t=${t.toFixed(4)}, f=${f.toFixed(2)}mm — unvalidated, xrt source unavailable`);
    return { t, point: geo.v3(x_local, y_local, z_local), normal: grad };
  }

  // §8.5 Reflection law (universal).
  function reflect(D, n) {
    const dot = geo.dot(D, n);
    const Dout = geo.sub(D, geo.scale(n, 2 * dot));
    return geo.normalize(Dout);
  }

  // Full reflect-one-candidate pipeline. rays: [{x,y,z,a,b,c}]. Returns {good:[...], over:[...]}
  // each entry {x,y,a,b,c} in stage coordinates, ready for §7 hull reconstruction.
  mirror.reflectRays = function (rays, mirrorDef, motion, log) {
    const T = mirror.buildTransform(mirrorDef, motion);
    const good = [], over = [];
    const type = mirrorDef.mirrorType || 'Flat';

    if (type !== 'Flat' && type !== 'Paraboloid') {
      throw new Error(
        `Mirror type "${type}" (Toroid/Ellipsoid) is not implemented. §8.7 of the build spec ` +
        `explicitly says not to invent xrt's surface parametrization without its source — ` +
        `only "Flat" (exact) and "Paraboloid" (flagged sketch) are available. See ASSUMPTIONS.md.`
      );
    }

    for (const ray of rays) {
      const P = geo.v3(ray.x, ray.y, ray.z);
      const D = geo.v3(ray.a, ray.b, ray.c);
      const Plocal = toLocal(T, P);
      const Dlocal = toLocalDir(T, D);

      let hit;
      if (type === 'Flat') hit = intersectFlat(Plocal, Dlocal);
      else hit = intersectParaboloidSketch(Plocal, Dlocal, mirrorDef, log);

      const Dout_local = reflect(Dlocal, hit.normal);
      const Pstage = toStage(T, hit.point);
      const Dstage = toStageDir(T, Dout_local);

      const outRay = { x: Pstage.x, y: Pstage.y, a: Dstage.x, b: Dstage.y, c: Dstage.z };
      const yGood = hit.point.y >= mirrorDef.length_min && hit.point.y <= mirrorDef.length_max;
      if (yGood) good.push(outRay); else over.push(outRay);
    }
    return { good, over };
  };

  SR.mirror = mirror;
})(window.SR = window.SR || {});
