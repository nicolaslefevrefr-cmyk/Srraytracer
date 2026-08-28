// ui.js — wires the DOM to the engine. No framework; small enough to stay readable as one file.
(function (SR) {
  'use strict';

  const state = {
    beamline: null,
    result: null,      // {stages, warnings, elements}
    selection: { mode: 'stage', stageIndex: 0 }, // or {mode:'travel', travel: mm}
    logLines: [],
    applyMotions: false,
    locationDefaults: SR.bl.defaultLocationMisalignments(),
    showIntermediate: false,
  };

  const $ = (id) => document.getElementById(id);

  function drawBothLayoutPlanes(elements) {
    SR.render.drawLayout('layoutPlotXZ', elements, 0, 'R');
    SR.render.drawLayout('layoutPlotYZ', elements, 1, 'S');
    SR.render.linkZAxis('layoutPlotXZ', 'layoutPlotYZ');
  }

  // ---------- Theme (per ALS design spec §7) ----------
  // localStorage can throw on file:// origins in some browsers (confirmed happening in this
  // app's own test harness) — the app is explicitly designed to also work opened straight from
  // disk, so persistence degrades gracefully to "remember for this session only" rather than
  // taking the whole page down.
  function safeStorageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeStorageSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    $('themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  function initTheme() {
    const theme = safeStorageGet('als-theme') || 'light';
    applyTheme(theme);
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    safeStorageSet('als-theme', next);
    applyTheme(next);
  }

  // ---------- Version badge + history modal ----------
  function initVersionBadge() {
    $('versionBadge').textContent = `v${SR.VERSION.current}`;
    $('versionBadge').title = `v${SR.VERSION.current} (${SR.VERSION.date}) — click for changelog`;
  }
  function renderVersionHistory() {
    const host = $('versionHistoryBody');
    host.innerHTML = SR.VERSION.history.map((h) => `
      <div class="version-history-entry">
        <div class="vh-head"><span class="vh-v">v${h.v}</span><span class="vh-date">${h.date}</span></div>
        <div class="vh-notes">${h.notes}</div>
      </div>`).join('');
  }

  // ---------- Coarse vs fine mode comparison ----------
  function modeComparisonHTML() {
    return `
      <h4>coarse vs fine — what actually changes</h4>
      <table>
        <tr><th></th><th>coarse</th><th>fine</th></tr>
        <tr><td>Search</td><td>grid only</td><td>grid, then refined with differential evolution</td></tr>
        <tr><td>Grid resolution per mirror DOF</td><td>3 × 3 × 3 × 3 × 3 × 3 = 729 combinations</td><td>x/pitch: 11 pts; y/z/roll/yaw: 3 pts → 11×3×3×11×3×3 = 9,801 combinations</td></tr>
        <tr><td>DE refinement</td><td>—</td><td>population 60, up to 25 generations, up to 25 outer iterations (stops after 2 consecutive small changes)</td></tr>
        <tr><td>Ray count formula</td><td>§6 formula ÷ 5, capped at 100,000</td><td>§6 formula as-is, capped at 500,000</td></tr>
        <tr><td>Typical runtime</td><td>fast — good for quick iteration</td><td>much slower, especially with several mirrors that have real motion ranges</td></tr>
        <tr><td>Result</td><td>a lower bound on the true envelope</td><td>closer to the true fully-explored envelope, but not guaranteed exact (DE is stochastic)</td></tr>
      </table>
      <div class="note">Both modes use the exact same §8 reflection physics — this only changes how thoroughly the
      mirror motion/misalignment space gets searched. For a mirror with all motion ranges pinned to zero (no
      real DOF to search), coarse and fine give the same answer.</div>
    `;
  }

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
    state.applyMotions = !!bl.apply_motions_misalignments;
    $('applyMotionsCheckbox').checked = state.applyMotions;
    state.locationDefaults = bl.location_misalignment_defaults
      ? JSON.parse(JSON.stringify(bl.location_misalignment_defaults))
      : SR.bl.defaultLocationMisalignments();
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
      drawBothLayoutPlanes(elements);
    } catch (e) {
      log('ERROR resolving beamline: ' + e.message);
    }
  }

  function renderComponentEditor() {
    SR.componentEditor.render($('componentList'), state.beamline, () => {
      refreshLayoutPreview();
    }, { applyMotions: state.applyMotions, locationDefaults: state.locationDefaults });
  }

  function readCurrentConfig() {
    return {
      mode: $('modeSelect').value,
      linear_accuracy: parseFloat($('linearAccuracy').value),
      angular_accuracy: parseFloat($('angularAccuracy').value),
      perf_max_rays: parseInt($('perfCap').value, 10) || undefined,
    };
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
      const config = readCurrentConfig();
      log(`Running raytrace: mode=${config.mode}, linear_accuracy=${config.linear_accuracy}mm, angular_accuracy=${config.angular_accuracy}rad, perf cap=${config.perf_max_rays}, apply motions & misalignments=${state.applyMotions}`);
      const t0 = performance.now();
      try {
        const effectiveComponents = SR.bl.buildEffectiveComponents(state.beamline.components, state.locationDefaults, state.applyMotions);
        const beamlineForRun = Object.assign({}, state.beamline, { components: effectiveComponents });
        const result = SR.rt.run(beamlineForRun, config, log);
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
  function boundsStr(poly) {
    if (!poly || poly.length === 0) return ['—', '—'];
    const [mn, mx] = SR.geo.posBounds(poly);
    return [mn.toFixed(3), mx.toFixed(3)];
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
    drawBothLayoutPlanes(elements);

    const displayStages = state.showIntermediate ? SR.rt.expandWithIntermediates(stages, 250) : stages;

    $('stageCount').textContent = `(${stages.length}${state.showIntermediate ? `, ${displayStages.length} incl. intermediate` : ''})`;
    const tbody = $('stageTable').querySelector('tbody');
    tbody.innerHTML = '';
    displayStages.forEach((s) => {
      const isIntermediate = s.stage === 'Intermediate';
      const tr = document.createElement('tr');
      if (isIntermediate) tr.classList.add('intermediate');
      if (state.selection.mode === 'stage' && !isIntermediate && s === stages[state.selection.stageIndex]) tr.classList.add('selected');
      const tagClass = s.elementType === 'Mirror' ? 'mirror' : s.elementType === 'Aperture' ? 'aperture' : 'source';
      const [xmn, xmx] = boundsStr(s.phase_space_good.poly_x);
      const [ymn, ymx] = boundsStr(s.phase_space_good.poly_y);
      const idxLabel = isIntermediate ? '·' : stages.indexOf(s);
      tr.innerHTML = `<td>${idxLabel}</td><td>${s.element}</td>` +
        `<td><span class="tag ${tagClass}">${s.stage}</span></td>` +
        `<td>${s.accumulated_travel.toFixed(1)}</td>` +
        `<td>${xmn}</td><td>${xmx}</td><td>${ymn}</td><td>${ymx}</td>` +
        `<td>${areaStr(s.phase_space_good.poly_x)}</td>` +
        `<td>${areaStr(s.phase_space_good.poly_y)}</td>`;
      tr.addEventListener('click', () => {
        state.selection = isIntermediate ? { mode: 'travel', travel: s.accumulated_travel } : { mode: 'stage', stageIndex: stages.indexOf(s) };
        renderResult();
      });
      tbody.appendChild(tr);
    });

    const current = resolveSelection();
    SR.render.drawEnvelopePlots('envelopeXPlot', 'envelopeYPlot', displayStages, { selectedTravel: current.travel }, (travel) => {
      state.selection = { mode: 'travel', travel };
      renderResult();
    });

    $('selectedStageLabel').textContent = `— ${current.label}`;
    SR.render.drawPhaseSpace('phaseXPlot', current.phase_space.poly_x, 'rgba(63,122,224,0.18)', '#3f7ae0', current.phase_space_over ? current.phase_space_over.poly_x : null, 'R');
    SR.render.drawPhaseSpace('phaseYPlot', current.phase_space.poly_y, 'rgba(63,174,92,0.18)', '#3fae5c', current.phase_space_over ? current.phase_space_over.poly_y : null, 'S');
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

<h4>New in this pass: location-based misalignments &amp; motion toggle</h4>
Every Mirror/Aperture/Relative-aperture now has a <code>location</code> (PTL / Front End /
Experimental floor). Misalignment tolerances default from that location's global defaults
(editable via the "General misalignments…" button) and stay live-linked to them — until the
person edits that component's own misalignment fields directly, at which point that one
component freezes at its own values and stops tracking the global defaults (a "↺ reset to
location default" button un-freezes it). The header's "apply motions &amp; misalignments"
checkbox (default off) hides motion-range/misalignment sections entirely and zeroes them for the
actual computation when unchecked, without touching what's stored — re-checking it brings
everything straight back, including any per-component overrides.

<h4>Not implemented (out of scope for this pass)</h4>
3D Three.js viewer / STL export (§13) — replaced with interactive Plotly.js 2D views (layout,
envelope-vs-travel, per-stage phase space) with native zoom/pan/hover. This does introduce an
external runtime dependency (Plotly, loaded from CDN) where earlier versions of this app had
none — the trade-off requested for genuinely interactive charts. If Plotly fails to load (no
internet access), charts will show an error rather than silently rendering blank.
Web Worker for §9 (runs synchronously; large ray counts in fine mode may be slow — reduce
linear_accuracy/angular_accuracy or use coarse mode for quick iteration).

<h4>Validation</h4>
This has since been validated against real reference data (Python script + console debug log +
exported CSV) for a 2-mirror beamline — see ASSUMPTIONS.md §16-§17 for the full account, and the
bundled <code>csv_validation</code> example to reproduce it directly. Headline results: §2-§7
(everything up through aperture clipping and ray sampling) match the reference exactly; a
non-oblique mirror's reflection (M101, azimuth 0°) matches to within ~0.007mm after two real bugs
found and fixed this way (a missing re-reference to the mirror's own center, and a missing
reorientation into the outgoing beam's frame); an oblique mirror's reflection (M102, azimuth
29.85°) still only partially matches (Y is close, X is roughly 2× too wide) and that gap is
reported precisely rather than hidden. "Run self-tests" also checks geometry primitives against
hand-derived values and pins both of the fixes above with regression tests.
`;
  }

  // ---------- Load / Save JSON ----------
  function saveJSON() {
    if (!state.beamline) { alert('Nothing loaded yet.'); return; }
    // Sync `config` from the live UI controls, not the possibly-stale value captured at load
    // time — this is exactly what runRaytrace() actually uses, so what gets saved always
    // matches what running "now" would compute (this was a real bug: mode/accuracy changes made
    // after loading a beamline never used to make it into the saved file). perf_max_rays is a
    // browser-safety-only setting (see raysample.js) and intentionally NOT saved, so a beamline
    // shared with someone else doesn't silently cap their run too.
    const liveConfig = readCurrentConfig();
    delete liveConfig.perf_max_rays;
    const toSave = Object.assign({}, state.beamline, {
      config: liveConfig,
      apply_motions_misalignments: state.applyMotions,
      location_misalignment_defaults: state.locationDefaults,
    });
    const blob = new Blob([JSON.stringify(toSave, null, 2)], { type: 'application/json' });
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

  // ---------- General misalignments modal ----------
  function renderMisalignModal() {
    const host = $('misalignLocationForms');
    host.innerHTML = '';
    SR.bl.LOCATIONS.forEach((loc) => {
      const d = state.locationDefaults[loc];
      const box = document.createElement('div');
      box.className = 'ml-location';
      box.innerHTML = `<div class="ml-location-title">${SR.bl.LOCATION_LABELS[loc]}</div>`;
      const row1 = document.createElement('div'); row1.className = 'ml-row';
      ['X', 'Y', 'Z'].forEach((ax) => {
        const wrap = document.createElement('label'); wrap.className = 'ce-minmax';
        wrap.innerHTML = `<span class="ce-minmax-label">${ax} (mm)</span>`;
        const inputs = document.createElement('div'); inputs.className = 'ce-minmax-inputs';
        const mn = document.createElement('input'); mn.type = 'number'; mn.step = 'any'; mn.value = d[ax][0];
        const mx = document.createElement('input'); mx.type = 'number'; mx.step = 'any'; mx.value = d[ax][1];
        mn.addEventListener('input', () => { d[ax][0] = parseFloat(mn.value) || 0; });
        mx.addEventListener('input', () => { d[ax][1] = parseFloat(mx.value) || 0; });
        inputs.appendChild(document.createTextNode('min')); inputs.appendChild(mn);
        inputs.appendChild(document.createTextNode('max')); inputs.appendChild(mx);
        wrap.appendChild(inputs);
        row1.appendChild(wrap);
      });
      box.appendChild(row1);
      const row2 = document.createElement('div'); row2.className = 'ml-row';
      ['Pitch', 'Roll', 'Yaw'].forEach((ax) => {
        const wrap = document.createElement('label'); wrap.className = 'ce-field';
        wrap.innerHTML = `<span>${ax} (±mrad)</span>`;
        const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.value = d[ax] * 1000;
        inp.addEventListener('input', () => { d[ax] = (parseFloat(inp.value) || 0) / 1000; });
        wrap.appendChild(inp);
        row2.appendChild(wrap);
      });
      box.appendChild(row2);
      host.appendChild(box);
    });
  }

  function openMisalignModal() { renderMisalignModal(); $('misalignModalBackdrop').style.display = 'flex'; }
  function closeMisalignModal() {
    $('misalignModalBackdrop').style.display = 'none';
    renderComponentEditor(); // pick up any default changes on un-overridden components
    if (state.result) renderResult();
  }

  // ---------- Init ----------
  function init() {
    initTheme();
    initVersionBadge();
    wireDebugTabs();
    fillAbout();
    wireFileLoad();

    $('themeToggle').addEventListener('click', toggleTheme);

    $('versionBadge').addEventListener('click', () => {
      renderVersionHistory();
      $('versionModalBackdrop').style.display = 'flex';
    });
    $('versionModalClose').addEventListener('click', () => { $('versionModalBackdrop').style.display = 'none'; });
    $('versionModalBackdrop').addEventListener('click', (ev) => { if (ev.target.id === 'versionModalBackdrop') $('versionModalBackdrop').style.display = 'none'; });

    const modeInfoPopover = $('modeInfoPopover');
    $('modeInfoBtn').addEventListener('click', (ev) => {
      ev.preventDefault();
      if (modeInfoPopover.style.display === 'block') { modeInfoPopover.style.display = 'none'; return; }
      modeInfoPopover.innerHTML = modeComparisonHTML();
      const rect = $('modeInfoBtn').getBoundingClientRect();
      modeInfoPopover.style.top = `${rect.bottom + 8}px`;
      modeInfoPopover.style.left = `${Math.max(8, rect.left - 200)}px`;
      modeInfoPopover.style.display = 'block';
    });
    document.addEventListener('click', (ev) => {
      if (modeInfoPopover.style.display === 'block' && !modeInfoPopover.contains(ev.target) && ev.target.id !== 'modeInfoBtn') {
        modeInfoPopover.style.display = 'none';
      }
    });

    $('exampleSelect').addEventListener('change', (ev) => {
      const key = ev.target.value;
      if (!key) return;
      loadBeamline(JSON.parse(JSON.stringify(SR.examples[key])), key);
    });
    $('btnRun').addEventListener('click', runRaytrace);
    $('btnSave').addEventListener('click', saveJSON);
    $('btnTests').addEventListener('click', runSelfTests);

    $('applyMotionsCheckbox').addEventListener('change', (ev) => {
      state.applyMotions = ev.target.checked;
      renderComponentEditor();
    });
    $('btnGeneralMisalignments').addEventListener('click', openMisalignModal);
    $('misalignModalClose').addEventListener('click', closeMisalignModal);
    $('btnMisalignSave').addEventListener('click', closeMisalignModal);
    $('misalignModalBackdrop').addEventListener('click', (ev) => { if (ev.target.id === 'misalignModalBackdrop') closeMisalignModal(); });
    $('btnMisalignReset').addEventListener('click', () => {
      state.locationDefaults = SR.bl.defaultLocationMisalignments();
      renderMisalignModal();
    });

    $('showIntermediateCheckbox').addEventListener('change', (ev) => {
      state.showIntermediate = ev.target.checked;
      if (state.result) renderResult();
    });

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
