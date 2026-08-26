// mirror.js — §8 mirror reflection.
//
// IMPLEMENTATION ASSUMPTIONS (the build spec explicitly says to flag ambiguity rather than
// silently guess — these are the places §8 left the exact composition underspecified without
// xrt source, and how this port resolves them; validated against the reference CSV in §16 of
// ASSUMPTIONS.md, which is what caught and fixed both A2 and A4 below):
//
//   A1. "Beamline coordinates" in §8.2/§8.6 means the per-stage transverse+propagation frame
//       that the (x,y,slope) phase-space representation already lives in (matching how §3/§7
//       only ever operate on (pos,slope) pairs, never full 3D world coordinates).
//   A2. Nominal orientation R_nom: built directly from its columns (see buildRnom below). At
//       azimuthal_angle=0, pitch=0 the mirror's lateral axis is Y_in, length axis is Z_in
//       (dominant — true grazing incidence, beam traveling mostly along the mirror's length with
//       only a small component along the normal), and normal is X_in. An earlier Rz*Ry-with-
//       offset formula had length/normal swapped (beam arriving near-normal instead of grazing);
//       this construction was confirmed against the reference run to leave a purely-horizontal
//       mirror's Y-divergence completely decoupled, and reproduces the reference tool's own
//       auto-corrected angles exactly (M101: pitch 1.500°; M102: azimuth 29.852°, pitch 0.407°).
//   A3. Rotation composition order for the rotation_sequence DOF list: R_extra = R_first *
//       R_second * R_third (intrinsic composition), applied on top of nominal: R_total = R_nom *
//       R_extra.
//   A4. Motion translations (x_val, y_val, z_val + pivot delta) are expressed directly in STAGE
//       (beamline-local, per A1) coordinates — NOT rotated into the mirror's tilted surface
//       frame. Re-reading "in the mirror's local frame, not world" as distinguishing per-element
//       beamline-local coordinates from a larger system's absolute/world coordinates (§2's own
//       usage of "local"), rather than as "rotated into the mirror's own pitch-tilted surface
//       orientation" — the latter reading (this port's original guess) makes x_motion/y_motion
//       physically inert for a flat mirror (translating a flat mirror within its own plane never
//       changes the reflected ray, only which point of the plane is hit), which cannot be what a
//       real x_motion/y_motion stage does. Confirmed against the reference run: motion in stage
//       coordinates is what produces the reference's large, asymmetric X-envelope growth after
//       M101 from combining x_motion's grazing-incidence lever arm with the beam's own angular
//       divergence — motion in the surface-tilted frame produces none of that growth.
//
// §8.3-§8.5 (flat mirror intersection/normal/reflection law) are transcribed exactly and do not
// depend on any of the above.
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const mirror = {};

  // Nominal surface-local axes expressed in stage (incoming-beam) coordinates, built directly
  // from azimuth/pitch rather than composed as Rz*Ry (see A2 above for why). azimuth is used
  // exactly as declared (this tool's own convention: 0 = horizontal-left, per §1) — no additional
  // offset. At azimuth=0, pitch=0: lateral(X)=Y_in, length(Y)=Z_in, normal(Z)=X_in.
  function buildRnom(azimuth, pitch) {
    const caz = Math.cos(azimuth), saz = Math.sin(azimuth);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const surfaceX = geo.v3(-saz, caz, 0);              // lateral, unaffected by pitch
    const surfaceY = geo.v3(sp * caz, sp * saz, cp);     // length (~propagation direction)
    const surfaceZ = geo.v3(cp * caz, cp * saz, -sp);    // normal
    return geo.matFromColumns(surfaceX, surfaceY, surfaceZ);
  }

  // §8.1 Build the local-frame-to-stage transform for a candidate motion sample.
  // motion = {yaw, pitch, roll, x, y, z} (Rx_val=yaw, Ry_val=pitch, Rz_val=roll per spec labels)
  mirror.buildTransform = function (mirrorDef, motion) {
    const nominalPitch = mirrorDef.nominal_pitch;
    const azimuth = mirrorDef.azimuthal_angle;
    const Rnom = buildRnom(azimuth, nominalPitch);

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
    const translationStage = translationLocal; // A4: stage-frame translation, not R_nom-rotated
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

  // Re-reference a reflected ray to the mirror's nominal center (local y=0) by propagating it
  // along its OWN new (post-reflection) direction until it crosses y_local=0, and report the
  // ray at that point instead of at its raw, per-ray intersection point. Necessary because
  // different sampled rays strike a real mirror at genuinely different points along its finite
  // length (different y_local); reporting each one's raw hit position mixes points that aren't
  // at a common reference plane, which inflates the apparent envelope spread. Confirmed against
  // a zero-motion reference run (ASSUMPTIONS.md §16): without this step a single-ray hand trace
  // showed ~2% spurious distortion even at zero motion; with it, the same ray reconstructs its
  // input position to 4+ significant figures, matching the reference tool's near-perfect
  // preservation for a flat mirror at zero motion.
  function reReferenceToCenter(point, dirOutLocal) {
    if (Math.abs(dirOutLocal.y) < 1e-15) return point; // direction runs parallel to the mirror's length axis; nothing to do
    const s = -point.y / dirOutLocal.y;
    return geo.v3(point.x + s * dirOutLocal.x, 0, point.z + s * dirOutLocal.z);
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
      // classify good/over using the TRUE hit point (the mirror's actual finite extent),
      // before re-referencing to the nominal center for reporting.
      const yGood = hit.point.y >= mirrorDef.length_min && hit.point.y <= mirrorDef.length_max;
      const reportPoint = type === 'Flat' ? reReferenceToCenter(hit.point, Dout_local) : hit.point;
      const Pstage = toStage(T, reportPoint);
      const Dstage = toStageDir(T, Dout_local);

      const outRay = { x: Pstage.x, y: Pstage.y, a: Dstage.x, b: Dstage.y, c: Dstage.z };
      if (yGood) good.push(outRay); else over.push(outRay);
    }
    return { good, over };
  };

  // Reorientation matrix for continuing propagation after this mirror: transforms a ray's
  // (position, direction), reported in the OLD (incoming) frame by reflectRays, into the NEW
  // frame whose Z-axis is the chief (zero-slope) ray's outgoing direction — i.e. the frame
  // subsequent free-travel shears need to be expressed in, matching how §2's bisector frame
  // reorients at a bend. Necessary because reflectRays reports every ray in the *incoming*
  // frame's basis; propagating that raw output forward with §3's shear (which assumes position/
  // slope are already relative to the *current* propagation axis) reproduces the old, pre-bend
  // axis instead of following the beam — confirmed against a zero-motion reference run
  // (ASSUMPTIONS.md §16): without this step, position downstream of a mirror was off by ~100mm+
  // (the deflection accumulated over distance, applied to the wrong reference axis); with it,
  // downstream stages matched the reference closely.
  //
  // M = Rtotal · Reflect · Rtotal^T is the (nominal, zero-motion) direction transform reflectRays
  // implicitly applies to every ray's direction; M^T undoes it, so a ray traveling exactly along
  // the chief/nominal direction reports slope (0,0) afterward — i.e. M^T*(chief ray's own output)
  // reconstructs (0,0,1) exactly, by construction (M is orthogonal). Using the mirror's own
  // R_total (nominal motion) keeps this self-consistent with whatever convention buildRnom uses,
  // rather than re-deriving it from §2's independently-parameterized rotation.
  mirror.outgoingReorientation = function (mirrorDef) {
    const T = mirror.buildTransform(mirrorDef, { x: 0, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 });
    const Reflect = [[1, 0, 0], [0, 1, 0], [0, 0, -1]];
    const M = geo.matMul(geo.matMul(T.Rtotal, Reflect), geo.matTranspose(T.Rtotal));
    return geo.matTranspose(M); // M^T
  };

  SR.mirror = mirror;
})(window.SR = window.SR || {});
