// render.js — plain <canvas> 2D visualizations. No charting library dependency (documented
// simplification vs. the build spec's §12 recommendation of Three.js/Chart.js — kept dependency
// -free so the app runs with zero network access once loaded).
(function (SR) {
  'use strict';
  const render = {};

  function clear(ctx, canvas) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function niceAxis(min, max, pad = 0.08) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    return [min - span * pad, max + span * pad];
  }

  // Top-down (X vs Z) layout of the beamline.
  render.drawLayout = function (canvas, elements) {
    const ctx = canvas.getContext('2d');
    clear(ctx, canvas);
    const W = canvas.width, H = canvas.height;
    if (!elements || elements.length === 0) return;

    const zs = elements.map((e) => e.position[2]);
    const xs = elements.map((e) => e.position[0]);
    const [zMin, zMax] = niceAxis(Math.min(...zs), Math.max(...zs), 0.1);
    const [xMin, xMax] = niceAxis(Math.min(...xs, -50), Math.max(...xs, 50), 0.3);

    const margin = 40;
    const sx = (W - 2 * margin) / (zMax - zMin);
    const sy = (H - 2 * margin) / (xMax - xMin);
    const toPx = (z, x) => [margin + (z - zMin) * sx, H - margin - (x - xMin) * sy];

    ctx.strokeStyle = '#c9d3dc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const [ox, oy] = toPx(zMin, 0);
    ctx.moveTo(margin, oy); ctx.lineTo(W - margin, oy);
    ctx.stroke();

    ctx.strokeStyle = '#6a8caf';
    ctx.lineWidth = 2;
    ctx.beginPath();
    elements.forEach((e, i) => {
      const [px, py] = toPx(e.position[2], e.position[0]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();

    elements.forEach((e) => {
      const [px, py] = toPx(e.position[2], e.position[0]);
      ctx.beginPath();
      const color = e.type === 'Source' ? '#e07a3f' : e.type === 'Mirror' ? '#3f7ae0' : '#3fae5c';
      ctx.fillStyle = color;
      ctx.arc(px, py, e.type === 'Source' ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#22303c';
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.fillText(e.name, px + 6, py - 6);
    });

    ctx.fillStyle = '#5a6b78';
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillText('Z (mm) →', W - margin - 55, H - margin + 22);
    ctx.save();
    ctx.translate(14, margin + 10);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('X (mm)', 0, 0);
    ctx.restore();
  };

  // Shared travel-axis mapping so click handling (travelFromPixel) always agrees exactly with
  // what drawEnvelopePlot rendered — both derive tMin/tMax/margin the same way from the same
  // stage list.
  const ENVELOPE_MARGIN = 46;
  function travelAxis(stages) {
    const travels = stages.map((s) => s.accumulated_travel);
    return niceAxis(Math.min(...travels), Math.max(...travels), 0.03);
  }

  // Inverse of the pixel<->travel mapping used inside drawEnvelopePlot, so a click on the canvas
  // can be turned back into a travel (mm) value. `pixelX` is in the canvas's own coordinate space
  // (i.e. already corrected for CSS scaling — see ui.js's click handler).
  render.travelFromPixel = function (canvas, stages, pixelX) {
    if (!stages || stages.length === 0) return null;
    const [tMin, tMax] = travelAxis(stages);
    const W = canvas.width;
    const sx = (W - 2 * ENVELOPE_MARGIN) / Math.max(tMax - tMin, 1e-9);
    const t = tMin + (pixelX - ENVELOPE_MARGIN) / sx;
    return Math.max(stages[0].accumulated_travel, Math.min(stages[stages.length - 1].accumulated_travel, t));
  };

  // Envelope half-size vs accumulated travel, X and Y stacked (two panels in one canvas).
  // `selectedTravel` (optional, mm) draws a vertical marker line at that Z on both panels.
  render.drawEnvelopePlot = function (canvas, stages, opts) {
    const ctx = canvas.getContext('2d');
    clear(ctx, canvas);
    const W = canvas.width, H = canvas.height;
    const filtered = stages;
    if (filtered.length === 0) return;
    const selectedTravel = opts && opts.selectedTravel;

    const panelH = H / 2 - 20;
    const margin = ENVELOPE_MARGIN;

    function panel(yOffset, label, extractFn, color) {
      const travels = filtered.map((s) => s.accumulated_travel);
      const vals = filtered.map((s) => extractFn(s.phase_space_good));
      const overVals = filtered.filter((s) => s.phase_space_over).map((s) => extractFn(s.phase_space_over));
      const [tMin, tMax] = niceAxis(Math.min(...travels), Math.max(...travels), 0.03);
      const allVals = vals.flat().concat(overVals.flat());
      const [vMin, vMax] = niceAxis(Math.min(0, ...allVals), Math.max(0, ...allVals), 0.15);

      const sx = (W - 2 * margin) / Math.max(tMax - tMin, 1e-9);
      const sy = panelH / Math.max(vMax - vMin, 1e-9);
      const toPx = (t, v) => [margin + (t - tMin) * sx, yOffset + panelH - (v - vMin) * sy];

      ctx.strokeStyle = '#d7dee4';
      ctx.strokeRect(margin, yOffset, W - 2 * margin, panelH);

      // zero line
      const [zx0, zy0] = toPx(tMin, 0);
      ctx.strokeStyle = '#e3e8ec';
      ctx.beginPath(); ctx.moveTo(margin, zy0); ctx.lineTo(W - margin, zy0); ctx.stroke();

      // Spillover ("over") rays: sparse (only at mirrors that produced them), so drawn as
      // individual amber whiskers rather than a connected line — there's nothing meaningful to
      // interpolate between two mirrors' spillover values.
      filtered.forEach((s) => {
        if (!s.phase_space_over) return;
        const [omn, omx] = extractFn(s.phase_space_over);
        const [px, pyMx] = toPx(s.accumulated_travel, omx);
        const pyMn = toPx(s.accumulated_travel, omn)[1];
        ctx.strokeStyle = '#e0b23f';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(px, pyMx); ctx.lineTo(px, pyMn); ctx.stroke();
        ctx.fillStyle = '#e0b23f';
        ctx.beginPath(); ctx.arc(px, pyMx, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px, pyMn, 2.6, 0, Math.PI * 2); ctx.fill();
      });

      ['max', 'min'].forEach((which, idx) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = idx === 0 ? 2 : 1.4;
        ctx.beginPath();
        filtered.forEach((s, i) => {
          const v = extractFn(s.phase_space_good)[which === 'max' ? 1 : 0];
          const [px, py] = toPx(s.accumulated_travel, v);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });

      filtered.forEach((s) => {
        const [mn, mx] = extractFn(s.phase_space_good);
        const [px, pyMx] = toPx(s.accumulated_travel, mx);
        const pyMn = toPx(s.accumulated_travel, mn)[1];
        const isMirror = s.elementType === 'Mirror' && s.stage === 'After';
        ctx.fillStyle = isMirror ? '#3f7ae0' : '#22303c';
        ctx.beginPath(); ctx.arc(px, pyMx, 2.2, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px, pyMn, 2.2, 0, Math.PI * 2); ctx.fill();
      });

      if (selectedTravel != null && selectedTravel >= tMin && selectedTravel <= tMax) {
        const [mx, my0] = toPx(selectedTravel, vMin);
        const my1 = toPx(selectedTravel, vMax)[1];
        ctx.strokeStyle = '#e07a3f';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(mx, my0); ctx.lineTo(mx, my1); ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = '#22303c';
      ctx.font = 'bold 12px "IBM Plex Mono", monospace';
      ctx.fillText(label, margin, yOffset - 6);
    }

    panel(0, 'Envelope X (mm) vs accumulated travel (mm)', (phaseSpace) => {
      const poly = phaseSpace && phaseSpace.poly_x;
      return poly && poly.length ? SR.geo.posBounds(poly) : [0, 0];
    }, '#3f7ae0');
    panel(H / 2 + 20, 'Envelope Y (mm) vs accumulated travel (mm)', (phaseSpace) => {
      const poly = phaseSpace && phaseSpace.poly_y;
      return poly && poly.length ? SR.geo.posBounds(poly) : [0, 0];
    }, '#3fae5c');
  };

  // Single phase-space polygon (position mm vs slope mrad).
  render.drawPhaseSpace = function (canvas, poly, colorFill, colorStroke) {
    const ctx = canvas.getContext('2d');
    clear(ctx, canvas);
    const W = canvas.width, H = canvas.height;
    if (!poly || poly.length === 0) {
      ctx.fillStyle = '#94a3ad';
      ctx.font = '12px "IBM Plex Mono", monospace';
      ctx.fillText('(empty)', W / 2 - 20, H / 2);
      return;
    }
    const margin = 36;
    const ps = poly.map((v) => ({ p: v.p, s: v.s * 1000 })); // rad -> mrad
    const [pMin, pMax] = niceAxis(Math.min(...ps.map((v) => v.p)), Math.max(...ps.map((v) => v.p)));
    const [sMin, sMax] = niceAxis(Math.min(...ps.map((v) => v.s)), Math.max(...ps.map((v) => v.s)));
    const sx = (W - 2 * margin) / Math.max(pMax - pMin, 1e-9);
    const sy = (H - 2 * margin) / Math.max(sMax - sMin, 1e-9);
    const toPx = (v) => [margin + (v.p - pMin) * sx, H - margin - (v.s - sMin) * sy];

    ctx.strokeStyle = '#d7dee4';
    ctx.strokeRect(margin, margin, W - 2 * margin, H - 2 * margin);

    ctx.beginPath();
    ps.forEach((v, i) => {
      const [px, py] = toPx(v);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    if (ps.length > 2) ctx.closePath();
    ctx.fillStyle = colorFill || 'rgba(63,122,224,0.18)';
    ctx.strokeStyle = colorStroke || '#3f7ae0';
    ctx.lineWidth = 1.6;
    if (ps.length > 2) ctx.fill();
    ctx.stroke();
    ps.forEach((v) => {
      const [px, py] = toPx(v);
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = colorStroke || '#3f7ae0'; ctx.fill();
    });

    ctx.fillStyle = '#5a6b78';
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillText('position (mm)', W - margin - 70, H - margin + 20);
    ctx.save();
    ctx.translate(12, margin + 4);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('slope (mrad)', 0, 0);
    ctx.restore();
  };

  SR.render = render;
})(window.SR = window.SR || {});
