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
      const direction = d > 1e-12 ? geo.scale(diff, 1 / d) : geo.v3(0, 0, 1);

      // §10.2b sub-segmentation into 250mm chunks for intermediate stages
      let numSegments = Math.floor(d / 250);
      let remaining = d - numSegments * 250;
      if (remaining < 10 && numSegments > 0) { numSegments -= 1; remaining += 250; }

      for (let seg = 0; seg < numSegments; seg++) {
        phaseSpace = { poly_x: geo.shearPoly(phaseSpace.poly_x, 250), poly_y: geo.shearPoly(phaseSpace.poly_y, 250) };
        accumulatedTravel += 250;
        const pos = geo.add(prevPos, geo.scale(direction, (seg + 1) * 250));
        stages.push({
          element: curr.name, elementType: curr.type, stage: 'Intermediate',
          position: [pos.x, pos.y, pos.z], travel_distance: 250, accumulated_travel: accumulatedTravel,
          phase_space_good: phaseSpace, phase_space_over: null,
        });
      }

      // §10.2c final shear for the remainder, 'Before' stage
      phaseSpace = { poly_x: geo.shearPoly(phaseSpace.poly_x, remaining), poly_y: geo.shearPoly(phaseSpace.poly_y, remaining) };
      accumulatedTravel += remaining;
      stages.push({
        element: curr.name, elementType: curr.type, stage: 'Before',
        position: curr.position.slice(), travel_distance: remaining, accumulated_travel: accumulatedTravel,
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
        const hasOver = (result.phase_space_over.poly_x.length > 0 || result.phase_space_over.poly_y.length > 0);
        stages.push({
          element: curr.name, elementType: 'Mirror', stage: 'After',
          position: curr.position.slice(), travel_distance: 0, accumulated_travel: accumulatedTravel,
          phase_space_good: phaseSpace, phase_space_over: hasOver ? result.phase_space_over : null,
          numRays: result.numRays,
        });
      } else {
        throw new Error(`Unknown element type "${curr.type}" for "${curr.name}"`);
      }
    }

    return { stages, warnings, elements };
  };

  SR.rt = rt;
})(window.SR = window.SR || {});
