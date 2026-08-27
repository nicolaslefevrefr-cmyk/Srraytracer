// raytrace.js — §10 raytrace() orchestration (exact per spec, except where §9/§8.7 already flag
// their own simplifications).
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const bl = SR.bl;
  const ps = SR.ps;
  const conv = SR.conv;
  const rt = {};

  rt.run = function (rawBeamline, config, log) {
    const logFn = log || (() => {});
    const warnings = [];
    const elements = bl.resolveBeamline(rawBeamline.components, logFn);

    const worldOrigin = rawBeamline.world_origin ? geo.v3(...rawBeamline.world_origin) : geo.v3(0, 0, 0);
    const worldOrientation = rawBeamline.world_orientation || geo.matIdentity();

    const source = elements[0];
    let phaseSpace = SR.ps.radiate(source);
    logFn(`Source "${source.name}": poly_x area=${geo.polygonArea(phaseSpace.poly_x).toExponential(3)} mm·rad, poly_y area=${geo.polygonArea(phaseSpace.poly_y).toExponential(3)} mm·rad`);

    const stages = [{
      element: source.name, elementType: 'Source', stage: 'Source',
      position: source.position.slice(), travel_distance: 0, accumulated_travel: 0,
      phase_space_good: phaseSpace, phase_space_over: null,
    }];

    let accumulatedTravel = 0;

    for (let i = 1; i < elements.length; i++) {
      const prev = elements[i - 1];
      const curr = elements[i];
      const prevPos = geo.v3(...prev.position);
      const currPos = geo.v3(...curr.position);
      const diff = geo.sub(currPos, prevPos);
      const d = geo.length(diff);

      // Single shear over the full gap distance. (An earlier version of this port sub-segmented
      // gaps into 250mm "Intermediate" stages for visualization; that's been removed — it wasn't
      // part of the spec, the reference CSV in §16 of ASSUMPTIONS.md only ever has Source/Before/
      // After rows, and it was mathematically redundant anyway since shear is linear: N chained
      // shears of the sub-distances equal one shear of the total distance. The envelope plot now
      // reconstructs intermediate points on demand via SR.render's click-to-inspect, computed by
      // shearing analytically from the nearest preceding stage rather than being pre-computed.)
      phaseSpace = { poly_x: geo.shearPoly(phaseSpace.poly_x, d), poly_y: geo.shearPoly(phaseSpace.poly_y, d) };
      accumulatedTravel += d;
      stages.push({
        element: curr.name, elementType: curr.type, stage: 'Before',
        position: curr.position.slice(), travel_distance: d, accumulated_travel: accumulatedTravel,
        phase_space_good: phaseSpace, phase_space_over: null,
      });

      if (curr.type === 'Aperture') {
        logFn(`Aperture "${curr.name}": clipping phase space (§5)`);
        phaseSpace = ps.cut(phaseSpace, curr, logFn);
        stages.push({
          element: curr.name, elementType: 'Aperture', stage: 'After',
          position: curr.position.slice(), travel_distance: 0, accumulated_travel: accumulatedTravel,
          phase_space_good: phaseSpace, phase_space_over: null,
        });
      } else if (curr.type === 'Mirror') {
        // §10.2e: recompute transform matrix and reconcile declared vs derived azimuth/pitch/yaw
        const T = bl.getTransformationMatrix(elements, i, worldOrigin, worldOrientation);
        let mirrorDef = curr;
        const dAz = Math.abs(T.azimuth - curr.azimuthal_angle);
        const dPitch = Math.abs(T.pitch - curr.nominal_pitch);
        if (dAz > 1e-6 || dPitch > 1e-6) {
          const w = `Mirror "${curr.name}": declared azimuthal_angle/nominal_pitch differ from the geometrically-derived values (Δaz=${dAz.toExponential(2)}, Δpitch=${dPitch.toExponential(2)}) — auto-corrected to the derived values.`;
          warnings.push(w); logFn('WARNING: ' + w);
          mirrorDef = Object.assign({}, curr, { azimuthal_angle: T.azimuth, nominal_pitch: T.pitch });
        }
        if (Math.abs(T.yaw) > 1e-6) {
          const w = `Mirror "${curr.name}": geometrically-derived yaw is non-negligible (${T.yaw.toExponential(2)} rad) — model assumes mirrors introduce no out-of-plane yaw from positioning; NOT auto-corrected.`;
          warnings.push(w); logFn('WARNING: ' + w);
        }

        logFn(`Mirror "${mirrorDef.name}": reflecting (§8/§9), mode=${config.mode}`);
        const result = conv.convergeReflect(phaseSpace, mirrorDef, {
          mode: config.mode, linearAccuracy: config.linear_accuracy, angularAccuracy: config.angular_accuracy,
          log: logFn, perfCap: config.perf_max_rays,
        });
        result.warnings.forEach((w) => { warnings.push(w); logFn('WARNING: ' + w); });

        phaseSpace = result.phase_space_good;
        let phaseSpaceOver = result.phase_space_over;
        if (mirrorDef.mirrorType === 'Flat' || !mirrorDef.mirrorType) {
          const R = SR.mirror.outgoingReorientation(mirrorDef);
          logFn(`Mirror "${mirrorDef.name}": reorienting downstream phase space into the outgoing-beam frame`);
          phaseSpace = ps.reorient(phaseSpace, R, logFn);
          if (phaseSpaceOver.poly_x.length > 0 || phaseSpaceOver.poly_y.length > 0) {
            phaseSpaceOver = ps.reorient(phaseSpaceOver, R, logFn);
          }
        }
        const hasOver = (phaseSpaceOver.poly_x.length > 0 || phaseSpaceOver.poly_y.length > 0);
        stages.push({
          element: curr.name, elementType: 'Mirror', stage: 'After',
          position: curr.position.slice(), travel_distance: 0, accumulated_travel: accumulatedTravel,
          phase_space_good: phaseSpace, phase_space_over: hasOver ? phaseSpaceOver : null,
          numRays: result.numRays,
        });
      } else {
        throw new Error(`Unknown element type "${curr.type}" for "${curr.name}"`);
      }
    }

    return { stages, warnings, elements };
  };

  // Given the full `stages` array from a run and an arbitrary travel value, return the phase
  // space at that point by shearing analytically from the nearest preceding stage — exact
  // (shear is linear), and lets the UI show a phase-space snapshot at any Z the person clicks on
  // the envelope plot without having to have pre-computed a stage there. Returns
  // {phase_space, sourceStage, deltaTravel} where sourceStage is the stage sheared from and
  // deltaTravel is how far past it the requested point is (0 if travel matches a stage exactly).
  rt.phaseSpaceAtTravel = function (stages, travel) {
    let left = stages[0];
    for (const s of stages) {
      if (s.accumulated_travel <= travel + 1e-9) left = s;
      else break;
    }
    const dt = travel - left.accumulated_travel;
    if (Math.abs(dt) < 1e-6) {
      return { phase_space: left.phase_space_good, sourceStage: left, deltaTravel: 0 };
    }
    const phase_space = {
      poly_x: geo.shearPoly(left.phase_space_good.poly_x, dt),
      poly_y: geo.shearPoly(left.phase_space_good.poly_y, dt),
    };
    return { phase_space, sourceStage: left, deltaTravel: dt };
  };

  // Expand a stage list with extra "Intermediate" points computed on demand, purely for display
  // (table + envelope plot) — never re-runs the raytrace. Every gap between two consecutive real
  // stages is pure free travel (a single §3 shear, per how §10 is implemented above), so each
  // intermediate point is exact, not interpolated/approximated: it's the same
  // phaseSpaceAtTravel() shear used for click-to-inspect, just sampled at regular steps instead
  // of one arbitrary point.
  rt.expandWithIntermediates = function (stages, stepMm) {
    const step = stepMm || 250;
    const out = [];
    for (let i = 0; i < stages.length; i++) {
      out.push(stages[i]);
      if (i + 1 >= stages.length) continue;
      const t0 = stages[i].accumulated_travel, t1 = stages[i + 1].accumulated_travel;
      const gap = t1 - t0;
      if (gap <= step) continue; // includes the common case of Before/After sharing the same travel (gap=0)
      const n = Math.floor(gap / step);
      for (let k = 1; k <= n; k++) {
        const t = t0 + k * step;
        if (t >= t1 - 1e-6) break;
        const r = rt.phaseSpaceAtTravel(stages, t);
        out.push({
          element: stages[i].element, elementType: stages[i].elementType, stage: 'Intermediate',
          position: null, travel_distance: step, accumulated_travel: t,
          phase_space_good: r.phase_space, phase_space_over: null,
        });
      }
    }
    return out;
  };

  SR.rt = rt;
})(window.SR = window.SR || {});
