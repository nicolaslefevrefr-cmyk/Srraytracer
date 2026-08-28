// render.js — Plotly.js-based visualizations (replaces the earlier plain-canvas renderer).
// Loaded from CDN in index.html. All plots get native drag-to-zoom, scroll-to-zoom, pan, and
// hover tooltips for free; annotations are used for component-name callouts on the envelope plot.
//
// Axis naming: the app's internal data model and JSON schema keep the spec's own X/Y/Z field
// names (size_x_min, poly_x, etc. — unchanged, since that's the ported spec's contract) but every
// user-facing label in these charts uses R (horizontal transverse), S (vertical transverse), T
// (beam-propagation / accumulated travel) instead, per the person's request.
(function (SR) {
  'use strict';
  const geo = SR.geo;
  const render = {};

  const FONT = { family: '"DM Sans", sans-serif', size: 11, color: '#22303c' };
  const PLOTLY_CONFIG = {
    responsive: true, displaylogo: false, scrollZoom: true,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  };
  // Fixed high-contrast hover styling (dark bg, light text) regardless of the page's own
  // light/dark theme, so it's always legible — this fixes a real bug where an earlier version
  // set the hover label's text color equal to its background color, making tooltips unreadable.
  // Spike lines are enabled so the cursor's exact R/S/T position is traceable against both axes,
  // not just readable from the tooltip.
  const BASE_LAYOUT = () => ({
    font: FONT, margin: { l: 52, r: 16, t: 10, b: 40 },
    plot_bgcolor: '#fdfefe', paper_bgcolor: 'rgba(0,0,0,0)',
    hovermode: 'closest',
    hoverlabel: { font: { family: FONT.family, size: 11, color: '#f4f6f9' }, bgcolor: '#1c2430', bordercolor: '#e8a020' },
    xaxis: {
      gridcolor: '#e7ecf0', zerolinecolor: '#d7dee4', showline: true, linecolor: '#d7dee4',
      showspikes: true, spikemode: 'across', spikedash: 'dot', spikecolor: '#94a3ad', spikethickness: 1,
    },
    yaxis: {
      gridcolor: '#e7ecf0', zerolinecolor: '#d7dee4', showline: true, linecolor: '#d7dee4',
      showspikes: true, spikemode: 'across', spikedash: 'dot', spikecolor: '#94a3ad', spikethickness: 1,
    },
  });

  function ensurePlotly() {
    if (!window.Plotly) throw new Error('Plotly.js failed to load (needs internet access — see README). Charts cannot render.');
  }

  // ---------- Beamline layout (R-T top-down / S-T side view) ----------
  // `axisIndex`: 0 for R-T (top-down, world X), 1 for S-T (side view, world Y).
  render.drawLayout = function (divId, elements, axisIndex, axisLabel) {
    ensurePlotly();
    const el = document.getElementById(divId);
    if (!elements || elements.length === 0) { window.Plotly.purge(el); return; }

    const ts = elements.map((e) => e.position[2]);
    const vs = elements.map((e) => e.position[axisIndex]);
    const colors = elements.map((e) => (e.type === 'Source' ? '#e07a3f' : e.type === 'Mirror' ? '#3f7ae0' : '#3fae5c'));
    const sizes = elements.map((e) => (e.type === 'Source' ? 11 : 9));
    const names = elements.map((e) => e.name);
    const label = axisLabel || (axisIndex === 0 ? 'R' : 'S');

    const trace = {
      type: 'scatter', mode: 'lines+markers+text',
      x: ts, y: vs, text: names, textposition: 'top center',
      textfont: { family: FONT.family, size: 10, color: '#5a6b78' },
      marker: { color: colors, size: sizes, line: { color: '#fff', width: 1 } },
      line: { color: '#a9bcca', width: 1.6 },
      hovertemplate: `%{text}<br>T=%{x:.2f} mm<br>${label}=%{y:.2f} mm<extra></extra>`,
    };

    const layout = Object.assign(BASE_LAYOUT(), {
      xaxis: Object.assign({}, BASE_LAYOUT().xaxis, { title: { text: 'T (mm)', font: FONT } }),
      yaxis: Object.assign({}, BASE_LAYOUT().yaxis, { title: { text: `${label} (mm)`, font: FONT } }),
      showlegend: false,
    });

    window.Plotly.react(el, [trace], layout, PLOTLY_CONFIG);
  };

  // Keeps two plots' T (x-)axis ranges in sync (the R-T and S-T layout views): panning or
  // zooming either one applies the same x-range to the other. Guards against feedback loops with
  // a simple re-entrancy flag. Safe to call every render — only attaches its listeners once per
  // element.
  render.linkZAxis = function (divIdA, divIdB) {
    ensurePlotly();
    const a = document.getElementById(divIdA), b = document.getElementById(divIdB);
    if (!a || !b || a.__zLinked) return;
    a.__zLinked = true; b.__zLinked = true;
    let syncing = false;
    function relay(from, to) {
      from.on('plotly_relayout', (ev) => {
        if (syncing) return;
        const range = [];
        if (ev['xaxis.range[0]'] !== undefined) range[0] = ev['xaxis.range[0]'];
        if (ev['xaxis.range[1]'] !== undefined) range[1] = ev['xaxis.range[1]'];
        if (range.length === 2) {
          syncing = true;
          window.Plotly.relayout(to, { 'xaxis.range': range }).then(() => { syncing = false; });
        } else if (ev['xaxis.autorange']) {
          syncing = true;
          window.Plotly.relayout(to, { 'xaxis.autorange': true }).then(() => { syncing = false; });
        }
      });
    }
    relay(a, b); relay(b, a);
  };

  // ---------- Envelope vs accumulated travel (two independent interactive plots: R, S) ----------
  // Shears a phase space's position bounds forward by `dt` (exact — shear is linear).
  function shearedBounds(poly, dt) {
    if (!poly || poly.length === 0) return null;
    const sheared = geo.shearPoly(poly, dt);
    return geo.posBounds(sheared);
  }

  function rExtract(phaseSpace) {
    const poly = phaseSpace && phaseSpace.poly_x;
    return poly && poly.length ? geo.posBounds(poly) : null;
  }
  function sExtract(phaseSpace) {
    const poly = phaseSpace && phaseSpace.poly_y;
    return poly && poly.length ? geo.posBounds(poly) : null;
  }

  function buildElementAnnotations(stages) {
    const seen = new Set();
    const annotations = [];
    stages.forEach((s) => {
      if (seen.has(s.element)) return;
      seen.add(s.element);
      annotations.push({
        x: s.accumulated_travel, y: 1.0, xref: 'x', yref: 'paper',
        text: s.element, showarrow: true, arrowhead: 2, arrowsize: 0.9, arrowwidth: 1,
        arrowcolor: '#94a3ad', ax: 0, ay: -20,
        font: { family: FONT.family, size: 9.5, color: '#5a6b78' },
        yanchor: 'bottom',
      });
    });
    return annotations;
  }

  // extractFn(phaseSpace) -> [min,max] | null. `whichAxis` selects poly_x/poly_y for spillover.
  // `axisLetter` ('R' or 'S') is baked into hover text so the cursor's value is unambiguous.
  function buildEnvelopeFigure(stages, extractFn, whichAxis, axisLetter, color, opts) {
    const travels = stages.map((s) => s.accumulated_travel);
    const maxVals = [], minVals = [];
    stages.forEach((s) => {
      const b = extractFn(s.phase_space_good);
      maxVals.push(b ? b[1] : null);
      minVals.push(b ? b[0] : null);
    });

    const traces = [];

    // Spillover: extend each mirror's "over" bounds forward by SPILLOVER_DISTANCE via exact
    // shear, drawn as a fading amber band so its downstream impact is visible at a glance.
    const SPILLOVER_DISTANCE = 2500;
    const SPILLOVER_STEPS = 6;
    stages.forEach((s) => {
      if (!s.phase_space_over) return;
      const poly = whichAxis === 'x' ? s.phase_space_over.poly_x : s.phase_space_over.poly_y;
      if (!poly || poly.length === 0) return;
      const xsUpper = [], ysUpper = [], xsLower = [], ysLower = [];
      for (let i = 0; i <= SPILLOVER_STEPS; i++) {
        const dt = (SPILLOVER_DISTANCE * i) / SPILLOVER_STEPS;
        const b = shearedBounds(poly, dt);
        if (!b) continue;
        xsUpper.push(s.accumulated_travel + dt); ysUpper.push(b[1]);
        xsLower.push(s.accumulated_travel + dt); ysLower.push(b[0]);
      }
      traces.push({
        type: 'scatter', mode: 'lines', x: xsUpper.concat(xsLower.slice().reverse()),
        y: ysUpper.concat(ysLower.slice().reverse()),
        fill: 'toself', fillcolor: 'rgba(224,178,63,0.18)', line: { color: 'rgba(224,178,63,0.55)', width: 1.2, dash: 'dot' },
        name: `${s.element} spillover (+${SPILLOVER_DISTANCE}mm)`, hoverinfo: 'skip', showlegend: false,
      });
    });

    // Shaded envelope band (good rays)
    traces.push({
      type: 'scatter', mode: 'lines', x: travels, y: maxVals,
      line: { color, width: 2 }, name: 'max', showlegend: false,
      hovertemplate: `T=%{x:.1f} mm<br>${axisLetter}(max)=%{y:.4f} mm<extra></extra>`,
    });
    traces.push({
      type: 'scatter', mode: 'lines', x: travels, y: minVals,
      line: { color, width: 1.4 }, fill: 'tonexty', fillcolor: hexToRgba(color, 0.10),
      name: 'min', showlegend: false,
      hovertemplate: `T=%{x:.1f} mm<br>${axisLetter}(min)=%{y:.4f} mm<extra></extra>`,
    });

    // Markers at each real stage, colored to distinguish mirrors from everything else.
    const markerColors = stages.map((s) => (s.elementType === 'Mirror' && s.stage === 'After' ? '#3f7ae0' : '#22303c'));
    ['max', 'min'].forEach((which) => {
      traces.push({
        type: 'scatter', mode: 'markers', x: travels, y: which === 'max' ? maxVals : minVals,
        marker: { color: markerColors, size: 5 }, showlegend: false,
        customdata: stages.map((s) => `${s.element} / ${s.stage}`),
        hovertemplate: `%{customdata}<br>T=%{x:.1f} mm<br>${axisLetter}=%{y:.4f} mm<extra></extra>`,
      });
    });

    const layout = Object.assign(BASE_LAYOUT(), {
      margin: { l: 52, r: 16, t: 46, b: 40 },
      xaxis: Object.assign({}, BASE_LAYOUT().xaxis, { title: { text: 'T — accumulated travel (mm)', font: FONT } }),
      yaxis: Object.assign({}, BASE_LAYOUT().yaxis, { title: { text: (opts && opts.axisLabel) || `${axisLetter} (mm)`, font: FONT } }),
      annotations: buildElementAnnotations(stages),
      shapes: (opts && opts.selectedTravel != null) ? [{
        type: 'line', xref: 'x', yref: 'paper', x0: opts.selectedTravel, x1: opts.selectedTravel, y0: 0, y1: 1,
        line: { color: '#e07a3f', width: 1.5, dash: 'dash' },
      }] : [],
      showlegend: false,
    });

    return { traces, layout };
  }

  function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  render.drawEnvelopePlots = function (rDivId, sDivId, stages, opts, onClick) {
    ensurePlotly();
    if (!stages || stages.length === 0) return;
    const rEl = document.getElementById(rDivId), sEl = document.getElementById(sDivId);

    const figR = buildEnvelopeFigure(stages, rExtract, 'x', 'R', '#3f7ae0', Object.assign({ axisLabel: 'R (mm)' }, opts));
    const figS = buildEnvelopeFigure(stages, sExtract, 'y', 'S', '#3fae5c', Object.assign({ axisLabel: 'S (mm)' }, opts));

    window.Plotly.react(rEl, figR.traces, figR.layout, PLOTLY_CONFIG);
    window.Plotly.react(sEl, figS.traces, figS.layout, PLOTLY_CONFIG);

    if (onClick) { wireTravelClick(rEl, onClick); wireTravelClick(sEl, onClick); }
  };

  // Reads the click position directly against Plotly's current x-axis range (rather than relying
  // on plotly_click, which only fires for clicks near an actual data point) so any point on the
  // plot — including empty space between mirrors — maps to a travel value, and correctly follows
  // the axis range after zooming/panning since the range is re-read on every click.
  function wireTravelClick(el, onClick) {
    if (el.__travelClickWired) return;
    el.__travelClickWired = true;
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.modebar')) return;
      const dragLayer = el.querySelector('.nsewdrag');
      if (!dragLayer) return;
      const rect = dragLayer.getBoundingClientRect();
      if (rect.width === 0) return;
      const xFrac = (ev.clientX - rect.left) / rect.width;
      if (xFrac < 0 || xFrac > 1) return;
      const xaxis = el._fullLayout && el._fullLayout.xaxis;
      if (!xaxis || !xaxis.range) return;
      onClick(xaxis.range[0] + xFrac * (xaxis.range[1] - xaxis.range[0]));
    });
  }

  // ---------- Single phase-space polygon (position mm vs slope mrad), with grid + axis units ----------
  // `axisLetter` ('R' or 'S') labels the position axis in the hover text. `overPoly` (optional):
  // the spillover polygon for the same stage, drawn as a second, amber trace.
  render.drawPhaseSpace = function (divId, poly, colorFill, colorStroke, overPoly, axisLetter) {
    ensurePlotly();
    const el = document.getElementById(divId);
    const letter = axisLetter || 'R';
    if ((!poly || poly.length === 0) && (!overPoly || overPoly.length === 0)) {
      window.Plotly.react(el, [], Object.assign(BASE_LAYOUT(), {
        annotations: [{ text: '(empty)', xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, font: { family: FONT.family, size: 12, color: '#94a3ad' } }],
        xaxis: Object.assign({}, BASE_LAYOUT().xaxis, { title: { text: `${letter} (mm)`, font: FONT } }),
        yaxis: Object.assign({}, BASE_LAYOUT().yaxis, { title: { text: `slope (mrad)`, font: FONT } }),
      }), PLOTLY_CONFIG);
      return;
    }
    const traces = [];
    function polyTrace(p, fill, stroke, name) {
      const xs = p.map((v) => v.p).concat([p[0].p]);
      const ys = p.map((v) => v.s * 1000).concat([p[0].s * 1000]);
      return {
        type: 'scatter', mode: 'lines+markers', x: xs, y: ys, name,
        fill: p.length > 2 ? 'toself' : 'none', fillcolor: fill,
        line: { color: stroke, width: 1.6 }, marker: { color: stroke, size: 4 },
        hovertemplate: `${name}<br>${letter}=%{x:.4f} mm<br>slope=%{y:.4f} mrad<extra></extra>`,
      };
    }
    if (poly && poly.length) traces.push(polyTrace(poly, colorFill || 'rgba(63,122,224,0.18)', colorStroke || '#3f7ae0', 'good'));
    if (overPoly && overPoly.length) traces.push(polyTrace(overPoly, 'rgba(224,178,63,0.20)', '#e0b23f', 'spillover'));

    const layout = Object.assign(BASE_LAYOUT(), {
      xaxis: Object.assign({}, BASE_LAYOUT().xaxis, { title: { text: `${letter} (mm)`, font: FONT } }),
      yaxis: Object.assign({}, BASE_LAYOUT().yaxis, { title: { text: 'slope (mrad)', font: FONT } }),
      showlegend: !!(overPoly && overPoly.length),
      legend: { font: { family: FONT.family, size: 9.5 }, orientation: 'h', y: 1.08 },
    });
    window.Plotly.react(el, traces, layout, PLOTLY_CONFIG);
  };

  SR.render = render;
})(window.SR = window.SR || {});
