// ui.js — wires the DOM to the engine. No framework; small enough to stay readable as one file.
(function (SR) {
  'use strict';

  const state = {
    beamline: null,
    result: null,      // {stages, warnings, elements}
    selection: { mode: 'stage', stageIndex: 0 }, // or {mode:'travel', travel: mm}
    logLines: [],
  };

  const $ = (id) => document.getElementById(id);

  function log(msg) {
    state.logLines.push(msg);
    const el = $('debugLog');
    const div = document.createElement('div');
    div.textContent = msg;
    if (/^WARNING/.test(msg)) div.className = 'warn';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function clearLog() {
    state.logLines = [];
    $('debugLog').innerHTML = '';
  }

  function setDebugSummary(text) { $('debugSummary').textContent = text; }

  function openDebugPanel() {
    $('debugPanel').classList.add('open');
  }

  // ---------- Beamline load ----------
  function loadBeamline(bl, sourceLabel) {
    state.beamline = bl;
    if (bl.config) {
      $('modeSelect').value = bl.config.mode || 'coarse';
      $('linearAccuracy').value = bl.config.linear_accuracy != null ? bl.config.linear_accuracy : 0.5;
      $('angularAccuracy').value = bl.config.angular_accuracy != null ? bl.config.angular_accuracy : 0.00025;
    }
    clearLog();
    log(`Loaded beamline "${bl.name || sourceLabel || '(unnamed)'}" with ${bl.components.length} raw component(s).`);
    SR.componentEditor.resetExpanded();
    renderComponentEditor();
    refreshLayoutPreview();
    $('stageCount').textContent = '';
    $('stageTable').querySelector('tbody').innerHTML = '';
    state.result = null;
    openDebugPanel();
  }

  function refreshLayoutPreview() {
    try {
      const elements = SR.bl.resolveBeamline(state.beamline.components, log);
      SR.render.drawLayout($('layoutCanvas'), elements);
    } catch (e) {
      log('ERROR resolving beamline: ' + e.message);
    }
  }

  function renderComponentEditor() {
    SR.componentEditor.render($('componentList'), state.beamline, () => {
      refreshLayoutPreview();
    });
  }

  // ---------- Run ----------
  // Runs synchronously (no Web Worker — see the About tab), which blocks the main thread for the
  // duration of the raytrace. We flip the button into a "Running…" state and defer the actual
  // work by one animation frame so the browser gets a chance to paint that state first, rather
  // than the tab appearing to hang with no feedback.
  function runRaytrace() {
    if (!state.beamline) { alert('Load a beamline first (pick an example or Load JSON).'); return; }
    clearLog();
    openDebugPanel();
    const btn = $('btnRun');
    btn.disabled = true;
    btn.textContent = 'Running…';
    setDebugSummary('running…');
    requestAnimationFrame(() => setTimeout(() => {
      const config = {
        mode: $('modeSelect').value,
        linear_accuracy: parseFloat($('linearAccuracy').value),
        angular_accuracy: parseFloat($('angularAccuracy').value),
        perf_max_rays: parseInt($('perfCap').value, 10) || undefined,
      };
      log(`Running raytrace: mode=${config.mode}, linear_accuracy=${config.linear_accuracy}mm, angular_accuracy=${config.angular_accuracy}rad, perf cap=${config.perf_max_rays}`);
      const t0 = performance.now();
      try {
        const result = SR.rt.run(state.beamline, config, log);
        const dt = (performance.now() - t0).toFixed(0);
        log(`Done in ${dt}ms. ${result.stages.length} stages, ${result.warnings.length} warning(s).`);
        state.result = result;
        state.selection = { mode: 'stage', stageIndex: result.stages.length - 1 };
        renderResult();
        setDebugSummary(`${result.stages.length} stages · ${result.warnings.length} warning(s) · ${dt}ms`);
      } catch (e) {
        log('ERROR: ' + e.message);
        setDebugSummary('run failed — see log');
        console.error(e);
      }
      renderWarnings();
      btn.disabled = false;
      btn.textContent = 'Run raytrace';
    }, 10));
  }

  function renderWarnings() {
    const el = $('debugWarnings');
    el.innerHTML = '';
    const warnings = state.result ? state.result.warnings : [];
    if (warnings.length === 0) {
      el.textContent = '(none)';
      return;
    }
    warnings.forEach((w) => {
      const d = document.createElement('div');
      d.className = 'warn';
      d.textContent = '⚠ ' + w;
      el.appendChild(d);
    });
  }

  function areaStr(poly) {
    return poly && poly.length ? SR.geo.polygonArea(poly).toExponential(2) : '0';
  }

  // Resolve the current selection into the phase space + a label to display. Table-row
  // selections show the exact stage; envelope-plot clicks show an analytically-sheared snapshot
  // at the clicked travel (exact — shear is linear — see SR.rt.phaseSpaceAtTravel).
  function resolveSelection() {
    const { stages } = state.result;
    if (state.selection.mode === 'stage') {
      const s = stages[state.selection.stageIndex];
      return {
        phase_space: s.phase_space_good, phase_space_over: s.phase_space_over,
        travel: s.accumulated_travel,
        label: `#${state.selection.stageIndex}: ${s.element} / ${s.stage} (travel ${s.accumulated_travel.toFixed(1)} mm)`,
      };
    }
    const r = SR.rt.phaseSpaceAtTravel(stages, state.selection.travel);
    const exact = Math.abs(r.deltaTravel) < 1e-6;
    return {
      phase_space: r.phase_space, phase_space_over: null,
      travel: state.selection.travel,
      label: exact
        ? `${r.sourceStage.element} / ${r.sourceStage.stage} (travel ${r.sourceStage.accumulated_travel.toFixed(1)} mm)`
        : `interpolated at travel ${state.selection.travel.toFixed(1)} mm (${r.deltaTravel.toFixed(1)} mm past ${r.sourceStage.element}/${r.sourceStage.stage}, free propagation — exact via §3 shear)`,
    };
  }

  function renderResult() {
    const { stages, elements } = state.result;
    SR.render.drawLayout($('layoutCanvas'), elements);

    $('stageCount').textContent = `(${stages.length})`;
    const tbody = $('stageTable').querySelector('tbody');
    tbody.innerHTML = '';
    stages.forEach((s, i) => {
      const tr = document.createElement('tr');
      if (state.selection.mode === 'stage' && i === state.selection.stageIndex) tr.classList.add('selected');
      const tagClass = s.elementType === 'Mirror' ? 'mirror' : s.elementType === 'Aperture' ? 'aperture' : 'source';
      tr.innerHTML = `<td>${i}</td><td>${s.element}</td>` +
        `<td><span class="tag ${tagClass}">${s.stage}</span></td>` +
        `<td>${s.accumulated_travel.toFixed(1)}</td>` +
        `<td>${areaStr(s.phase_space_good.poly_x)}</td>` +
        `<td>${areaStr(s.phase_space_good.poly_y)}</td>`;
      tr.addEventListener('click', () => { state.selection = { mode: 'stage', stageIndex: i }; renderResult(); });
      tbody.appendChild(tr);
    });

    const current = resolveSelection();
    SR.render.drawEnvelopePlot($('envelopeCanvas'), stages, { selectedTravel: current.travel });

    $('selectedStageLabel').textContent = `— ${current.label}`;
    SR.render.drawPhaseSpace($('phaseXCanvas'), current.phase_space.poly_x, 'rgba(63,122,224,0.18)', '#3f7ae0');
    SR.render.drawPhaseSpace($('phaseYCanvas'), current.phase_space.poly_y, 'rgba(63,174,92,0.18)', '#3fae5c');
    if (current.phase_space_over) {
      overlaySpillover($('phaseXCanvas'), current.phase_space_over.poly_x);
      overlaySpillover($('phaseYCanvas'), current.phase_space_over.poly_y);
    }
  }

  function overlaySpillover(canvas, poly) {
    if (!poly || poly.length < 2) return;
    // Re-draw on top using the same coordinate mapping logic as drawPhaseSpace would need;
    // simplest robust approach: just note it exists via a small badge, to avoid duplicating
    // render.js's internal scaling math here.
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e07a3f';
    ctx.font = 'bold 10px "IBM Plex Mono", monospace';
    ctx.fillText('⚠ spillover rays present (see Warnings tab)', 8, 14);
  }

  // Envelope-plot click -> travel (mm), corrected for CSS scaling of the canvas.
  function wireEnvelopeClick() {
    $('envelopeCanvas').addEventListener('click', (ev) => {
      if (!state.result) return;
      const canvas = $('envelopeCanvas');
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const pixelX = (ev.clientX - rect.left) * scaleX;
      const travel = SR.render.travelFromPixel(canvas, state.result.stages, pixelX);
      if (travel == null) return;
      state.selection = { mode: 'travel', travel };
      renderResult();
    });
  }

  // ---------- Debug tabs ----------
  function wireDebugTabs() {
    document.querySelectorAll('.debug-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.debug-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        ['log', 'warnings', 'tests', 'about'].forEach((t) => {
          $('debug' + t[0].toUpperCase() + t.slice(1)).style.display = (t === btn.dataset.tab) ? 'block' : 'none';
        });
      });
    });
    $('debugToggle').addEventListener('click', () => $('debugPanel').classList.toggle('open'));
  }

  // ---------- Tests ----------
  function runSelfTests() {
    openDebugPanel();
    document.querySelector('.debug-tab[data-tab="tests"]').click();
    const results = SR.tests.runTests();
    const el = $('debugTests');
    el.innerHTML = '';
    const pass = results.filter((r) => r.ok).length;
    const summary = document.createElement('div');
    summary.innerHTML = `<strong>${pass}/${results.length} passed</strong>`;
    el.appendChild(summary);
    results.forEach((r) => {
      const d = document.createElement('div');
      d.className = r.ok ? 'pass' : 'fail';
      d.textContent = (r.ok ? '✓ ' : '✗ ') + r.msg;
      el.appendChild(d);
    });
  }

  // ---------- About / assumptions tab ----------
  function fillAbout() {
    $('debugAbout').innerHTML = `
<h4>Confidence map (from the build spec's §0)</h4>
Exact, transcribed: §2 frames/transforms, §3 shear, §4 source phase space, §5 aperture clip,
§6 ray-count formula &amp; §6.1 sampling, §7 hull reconstruction + fallback, §8.1–§8.6 flat-mirror
reflection, §10 orchestration.

Flagged, not exact:
<br>• <code>§8.7 non-flat mirrors</code> — Toroid/Ellipsoid are <strong>not implemented</strong> (the spec explicitly
says not to invent xrt's parametrization without its source). "Paraboloid" runs a Newton-solved
toy equation (z = x²/(4f)) as a labeled, unvalidated sketch.
<br>• <code>§9 fine-mode convergence</code> — hand-rolled differential evolution (rand/1/bin) approximating
scipy's <code>differential_evolution</code>; "polish=True" is approximated with a local coordinate search,
not true L-BFGS-B. Coarse mode (pure grid, no DE) is exact.
<br>• <code>§8 frame composition</code> — three specific compositions the spec left unresolved without xrt
source (labeled A1/A2/A3 in <code>js/mirror.js</code>): which frame "beamline coordinates" refers to,
the rotation composition order, and which frame translation motions are expressed in. Documented
inline rather than silently guessed — see comments at the top of <code>js/mirror.js</code>.

<h4>Not implemented (out of scope for this pass)</h4>
3D Three.js viewer / STL export / CSV export (§13) — replaced with 2D canvas views (layout,
envelope-vs-travel, per-stage phase space) so the app has zero external runtime dependencies.
Web Worker for §9 (runs synchronously; large ray counts in fine mode may be slow — reduce
linear_accuracy/angular_accuracy or use coarse mode for quick iteration).

<h4>Validation</h4>
No ground-truth CSV from the real Python/xrt tool was available in this environment, so
"Run self-tests" checks geometry primitives against hand-derived expected values and confirms
the full pipeline runs end-to-end (including the degenerate-hull path exercised by the §14
fixture's M102/G101/M103) — it does not confirm numerical agreement with the original tool.
`;
  }

  // ---------- Load / Save JSON ----------
  function saveJSON() {
    if (!state.beamline) { alert('Nothing loaded yet.'); return; }
    const blob = new Blob([JSON.stringify(state.beamline, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.beamline.name || 'beamline').replace(/\s+/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function wireFileLoad() {
    $('btnLoad').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result);
          loadBeamline(json, file.name);
        } catch (e) {
          alert('Could not parse JSON: ' + e.message);
        }
      };
      reader.readAsText(file);
      ev.target.value = '';
    });
  }

  // ---------- Init ----------
  function init() {
    wireDebugTabs();
    fillAbout();
    wireFileLoad();

    $('exampleSelect').addEventListener('change', (ev) => {
      const key = ev.target.value;
      if (!key) return;
      loadBeamline(JSON.parse(JSON.stringify(SR.examples[key])), key);
    });
    $('btnRun').addEventListener('click', runRaytrace);
    $('btnSave').addEventListener('click', saveJSON);
    $('btnTests').addEventListener('click', runSelfTests);
    wireEnvelopeClick();

    $('btnNew').addEventListener('click', () => {
      if (state.beamline && !confirm('Start a new beamline? Unsaved changes will be lost (use Save JSON first if you want to keep them).')) return;
      $('exampleSelect').value = '';
      loadBeamline(SR.componentEditor.newBeamline(), 'new');
      SR.componentEditor.resetExpanded();
      // expand the Source by default so it's obviously editable
      const list = $('componentList');
      const firstChev = list.querySelector('.ce-chev');
      if (firstChev) firstChev.click();
    });

    $('btnAddComponent').addEventListener('click', () => {
      if (!state.beamline) { alert('Load or create a beamline first.'); return; }
      SR.componentEditor.addComponent(state.beamline, $('addTypeSelect').value);
      renderComponentEditor();
      refreshLayoutPreview();
    });

    // default: load the single-mirror example so the app isn't blank on first paint
    $('exampleSelect').value = 'single_mirror';
    loadBeamline(JSON.parse(JSON.stringify(SR.examples.single_mirror)), 'single_mirror');
  }

  document.addEventListener('DOMContentLoaded', init);
})(window.SR = window.SR || {});
