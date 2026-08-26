// componentEditor.js — the §11 "componentPanel" this app was missing: an ordered, editable list
// of components with a per-type form, so a beamline can be built from scratch in the UI rather
// than only via example/JSON loading.
//
// Angles are shown to the user in DEGREES (more usable than radians) and converted to/from
// radians only at the read/write boundary with the underlying component object, which always
// stays in the spec's native units (mm / rad) so Save JSON round-trips correctly.
(function (SR) {
  'use strict';
  const R2D = 180 / Math.PI, D2R = Math.PI / 180;

  const ce = {};
  let onChangeCb = () => {};
  const expandedSet = new WeakSet();

  function defaultSource(name) {
    return {
      type: 'Source', name: name || 'Source', position: [0, 0, 0],
      size_x_min: -1, size_x_max: 1, size_y_min: -1, size_y_max: 1,
      div_a_min: -0.001, div_a_max: 0.001, div_b_min: -0.001, div_b_max: 0.001,
    };
  }
  function defaultMirror(name) {
    return {
      type: 'Mirror', name: name || 'M1', position: [0, 0, 10000],
      azimuthal_angle: 0, nominal_pitch: 2 * D2R, mirrorType: 'Flat',
      rotation_sequence: 'Pitch->Roll->Yaw', length_min: -250, length_max: 250,
      x_motion_min: 0, x_motion_max: 0, y_motion_min: 0, y_motion_max: 0, z_motion_min: 0, z_motion_max: 0,
      pitch_min: 0, pitch_max: 0, roll_min: 0, roll_max: 0, yaw_min: 0, yaw_max: 0,
      x_rotation_arm: 0, z_rotation_arm: 0,
      misalignment_tolerances: { X: [0, 0], Y: [0, 0], Z: [0, 0], Pitch: [0, 0], Roll: [0, 0], Yaw: [0, 0] },
    };
  }
  function defaultAperture(name) {
    return {
      type: 'Aperture', name: name || 'AP1', position: [0, 0, 15000],
      size_x_min: -5, size_x_max: 5, size_y_min: -5, size_y_max: 5,
      misalignment_tolerances: { X: [0, 0], Y: [0, 0], Z: [0, 0] },
    };
  }
  function defaultRelativeAperture(name, target) {
    return {
      type: 'RelativeAperture', name: name || 'RelAP1', target: target || '', distance: 100,
      size_x_min: -5, size_x_max: 5, size_y_min: -5, size_y_max: 5,
    };
  }

  ce.newBeamline = function () {
    return {
      name: 'New beamline', description: '', config: { linear_accuracy: 0.5, angular_accuracy: 0.00025, mode: 'coarse' },
      world_origin: [0, 0, 0],
      components: [defaultSource('Source')],
    };
  };

  // ---------- small DOM helpers ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function field(labelText, inputEl) {
    const wrap = el('label', 'ce-field');
    wrap.appendChild(el('span', null, labelText));
    wrap.appendChild(inputEl);
    return wrap;
  }
  function numInput(value, onSet, step) {
    const i = document.createElement('input');
    i.type = 'number'; i.step = step || 'any'; i.value = value;
    i.addEventListener('input', () => { const v = parseFloat(i.value); if (!isNaN(v)) { onSet(v); onChangeCb(); } });
    return i;
  }
  function textInput(value, onSet) {
    const i = document.createElement('input');
    i.type = 'text'; i.value = value;
    i.addEventListener('input', () => { onSet(i.value); onChangeCb(); });
    return i;
  }
  function selectInput(value, options, onSet) {
    const s = document.createElement('select');
    options.forEach((opt) => {
      const o = document.createElement('option');
      const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
      o.value = val; o.textContent = label;
      if (val === value) o.selected = true;
      s.appendChild(o);
    });
    s.addEventListener('change', () => { onSet(s.value); onChangeCb(); });
    return s;
  }
  function checkInput(value, onSet) {
    const i = document.createElement('input');
    i.type = 'checkbox'; i.checked = !!value;
    i.addEventListener('change', () => { onSet(i.checked); onChangeCb(); });
    return i;
  }
  function minMaxRow(labelText, pair, onSet, step, scale) {
    scale = scale || 1;
    const wrap = el('div', 'ce-minmax');
    wrap.appendChild(el('span', 'ce-minmax-label', labelText));
    const inputs = el('div', 'ce-minmax-inputs');
    const mn = numInput(pair[0] * scale, (v) => onSet(0, v / scale), step);
    const mx = numInput(pair[1] * scale, (v) => onSet(1, v / scale), step);
    inputs.appendChild(el('span', null, 'min')); inputs.appendChild(mn);
    inputs.appendChild(el('span', null, 'max')); inputs.appendChild(mx);
    wrap.appendChild(inputs);
    return wrap;
  }
  function positionFields(comp) {
    const row = el('div', 'ce-row');
    ['x', 'y', 'z'].forEach((ax, i) => {
      row.appendChild(field(`pos ${ax} (mm)`, numInput(comp.position[i], (v) => { comp.position[i] = v; }, 'any')));
    });
    return row;
  }
  function misalignRow(labelText, tol, key, scale) {
    scale = scale || 1;
    if (!tol[key]) tol[key] = [0, 0];
    return minMaxRow(labelText, tol[key], (i, v) => { tol[key][i] = v; }, 'any', scale);
  }

  // ---------- per-type forms ----------
  function buildSourceForm(comp) {
    const body = el('div', 'ce-body');
    body.appendChild(positionFields(comp));
    const row1 = el('div', 'ce-row');
    row1.appendChild(minMaxRow('size X (mm)', [comp.size_x_min, comp.size_x_max], (i, v) => { if (i === 0) comp.size_x_min = v; else comp.size_x_max = v; }));
    row1.appendChild(minMaxRow('size Y (mm)', [comp.size_y_min, comp.size_y_max], (i, v) => { if (i === 0) comp.size_y_min = v; else comp.size_y_max = v; }));
    body.appendChild(row1);
    const row2 = el('div', 'ce-row');
    row2.appendChild(minMaxRow('div A (mrad)', [comp.div_a_min, comp.div_a_max], (i, v) => { if (i === 0) comp.div_a_min = v; else comp.div_a_max = v; }, 'any', 1000));
    row2.appendChild(minMaxRow('div B (mrad)', [comp.div_b_min, comp.div_b_max], (i, v) => { if (i === 0) comp.div_b_min = v; else comp.div_b_max = v; }, 'any', 1000));
    body.appendChild(row2);
    return body;
  }

  function buildApertureForm(comp) {
    const body = el('div', 'ce-body');
    body.appendChild(positionFields(comp));
    const row1 = el('div', 'ce-row');
    row1.appendChild(minMaxRow('size X (mm)', [comp.size_x_min, comp.size_x_max], (i, v) => { if (i === 0) comp.size_x_min = v; else comp.size_x_max = v; }));
    row1.appendChild(minMaxRow('size Y (mm)', [comp.size_y_min, comp.size_y_max], (i, v) => { if (i === 0) comp.size_y_min = v; else comp.size_y_max = v; }));
    body.appendChild(row1);
    if (!comp.misalignment_tolerances) comp.misalignment_tolerances = { X: [0, 0], Y: [0, 0], Z: [0, 0] };
    const tol = comp.misalignment_tolerances;
    body.appendChild(el('div', 'ce-subhead', 'misalignment tolerances'));
    const row2 = el('div', 'ce-row');
    row2.appendChild(misalignRow('X (mm)', tol, 'X'));
    row2.appendChild(misalignRow('Y (mm)', tol, 'Y'));
    row2.appendChild(misalignRow('Z (mm)', tol, 'Z'));
    body.appendChild(row2);
    return body;
  }

  function buildRelativeApertureForm(comp, precedingNames) {
    const body = el('div', 'ce-body');
    const row0 = el('div', 'ce-row');
    row0.appendChild(field('target element', selectInput(comp.target, precedingNames.length ? precedingNames : [['', '(no earlier element)']], (v) => { comp.target = v; })));
    row0.appendChild(field('distance before target (mm)', numInput(comp.distance, (v) => { comp.distance = v; })));
    body.appendChild(row0);
    const row1 = el('div', 'ce-row');
    row1.appendChild(minMaxRow('size X (mm)', [comp.size_x_min, comp.size_x_max], (i, v) => { if (i === 0) comp.size_x_min = v; else comp.size_x_max = v; }));
    row1.appendChild(minMaxRow('size Y (mm)', [comp.size_y_min, comp.size_y_max], (i, v) => { if (i === 0) comp.size_y_min = v; else comp.size_y_max = v; }));
    body.appendChild(row1);
    body.appendChild(el('div', 'ce-note', 'Position is computed at run time from the target and distance (§1 RelativeAperture) — not editable directly.'));
    return body;
  }

  const ROTATION_SEQUENCES = [
    'Pitch->Roll->Yaw', 'Pitch->Yaw->Roll', 'Roll->Pitch->Yaw',
    'Roll->Yaw->Pitch', 'Yaw->Pitch->Roll', 'Yaw->Roll->Pitch',
  ];

  function buildMirrorForm(comp) {
    const body = el('div', 'ce-body');
    body.appendChild(positionFields(comp));

    const row1 = el('div', 'ce-row');
    row1.appendChild(field('azimuthal angle (deg)', numInput(comp.azimuthal_angle * R2D, (v) => { comp.azimuthal_angle = v * D2R; })));
    row1.appendChild(field('nominal pitch (deg)', numInput(comp.nominal_pitch * R2D, (v) => { comp.nominal_pitch = v * D2R; })));
    row1.appendChild(field('mirror type', selectInput(comp.mirrorType || 'Flat', [
      ['Flat', 'Flat (exact)'], ['Paraboloid', 'Paraboloid (flagged sketch)'],
      ['Toroid', 'Toroid (not implemented)'], ['Ellipsoid', 'Ellipsoid (not implemented)'],
    ], (v) => { comp.mirrorType = v; scheduleRerender(); })));
    body.appendChild(row1);

    if (comp.mirrorType === 'Paraboloid' || comp.mirrorType === 'Ellipsoid') {
      const rowPQ = el('div', 'ce-row');
      rowPQ.appendChild(field('p (mm)', numInput(comp.p || 0, (v) => { comp.p = v; })));
      rowPQ.appendChild(field('q (mm)', numInput(comp.q || 0, (v) => { comp.q = v; })));
      rowPQ.appendChild(field('cylindrical', checkInput(comp.isCylindrical, (v) => { comp.isCylindrical = v; })));
      body.appendChild(rowPQ);
      if (comp.mirrorType === 'Ellipsoid') body.appendChild(el('div', 'ce-note warn', '§8.7: Ellipsoid is not implemented — running this mirror will raise an explicit error (see ASSUMPTIONS.md), not a guessed result.'));
      else body.appendChild(el('div', 'ce-note warn', '§8.7: Paraboloid runs the spec\'s own unvalidated toy equation, not xrt\'s real parametrization.'));
    }
    if (comp.mirrorType === 'Toroid') {
      const rowRr = el('div', 'ce-row');
      rowRr.appendChild(field('R (mm)', numInput(comp.R || 0, (v) => { comp.R = v; })));
      rowRr.appendChild(field('r (mm)', numInput(comp.r || 0, (v) => { comp.r = v; })));
      body.appendChild(rowRr);
      body.appendChild(el('div', 'ce-note warn', '§8.7: Toroid is not implemented — running this mirror will raise an explicit error (see ASSUMPTIONS.md), not a guessed result.'));
    }

    body.appendChild(el('div', 'ce-subhead', 'active length (local Y axis, mm)'));
    const rowLen = el('div', 'ce-row');
    rowLen.appendChild(field('length min', numInput(comp.length_min, (v) => { comp.length_min = v; })));
    rowLen.appendChild(field('length max', numInput(comp.length_max, (v) => { comp.length_max = v; })));
    body.appendChild(rowLen);

    body.appendChild(el('div', 'ce-subhead', 'motion ranges'));
    const rowM1 = el('div', 'ce-row');
    rowM1.appendChild(minMaxRow('x motion (mm)', [comp.x_motion_min, comp.x_motion_max], (i, v) => { if (i === 0) comp.x_motion_min = v; else comp.x_motion_max = v; }));
    rowM1.appendChild(minMaxRow('y motion (mm)', [comp.y_motion_min, comp.y_motion_max], (i, v) => { if (i === 0) comp.y_motion_min = v; else comp.y_motion_max = v; }));
    rowM1.appendChild(minMaxRow('z motion (mm)', [comp.z_motion_min, comp.z_motion_max], (i, v) => { if (i === 0) comp.z_motion_min = v; else comp.z_motion_max = v; }));
    body.appendChild(rowM1);
    const rowM2 = el('div', 'ce-row');
    rowM2.appendChild(minMaxRow('pitch (mdeg)', [comp.pitch_min, comp.pitch_max], (i, v) => { if (i === 0) comp.pitch_min = v; else comp.pitch_max = v; }, 'any', 1000 * R2D));
    rowM2.appendChild(minMaxRow('roll (mdeg)', [comp.roll_min, comp.roll_max], (i, v) => { if (i === 0) comp.roll_min = v; else comp.roll_max = v; }, 'any', 1000 * R2D));
    rowM2.appendChild(minMaxRow('yaw (mdeg)', [comp.yaw_min, comp.yaw_max], (i, v) => { if (i === 0) comp.yaw_min = v; else comp.yaw_max = v; }, 'any', 1000 * R2D));
    body.appendChild(rowM2);

    const row3 = el('div', 'ce-row');
    row3.appendChild(field('rotation sequence', selectInput(comp.rotation_sequence, ROTATION_SEQUENCES, (v) => { comp.rotation_sequence = v; })));
    row3.appendChild(field('x rotation arm (mm)', numInput(comp.x_rotation_arm || 0, (v) => { comp.x_rotation_arm = v; })));
    row3.appendChild(field('z rotation arm (mm)', numInput(comp.z_rotation_arm || 0, (v) => { comp.z_rotation_arm = v; })));
    body.appendChild(row3);

    if (!comp.misalignment_tolerances) comp.misalignment_tolerances = SR.bl.defaultMirrorMisalignment();
    const tol = comp.misalignment_tolerances;
    body.appendChild(el('div', 'ce-subhead', 'misalignment tolerances'));
    const row4 = el('div', 'ce-row');
    row4.appendChild(misalignRow('X (mm)', tol, 'X'));
    row4.appendChild(misalignRow('Y (mm)', tol, 'Y'));
    row4.appendChild(misalignRow('Z (mm)', tol, 'Z'));
    body.appendChild(row4);
    const row5 = el('div', 'ce-row');
    row5.appendChild(misalignRow('Pitch (mdeg)', tol, 'Pitch', 1000 * R2D));
    row5.appendChild(misalignRow('Roll (mdeg)', tol, 'Roll', 1000 * R2D));
    row5.appendChild(misalignRow('Yaw (mdeg)', tol, 'Yaw', 1000 * R2D));
    body.appendChild(row5);
    return body;
  }

  // ---------- card / list rendering ----------
  let containerRef = null, beamlineRef = null, rerenderScheduled = false;
  function scheduleRerender() { if (!rerenderScheduled) { rerenderScheduled = true; setTimeout(() => { rerenderScheduled = false; ce.render(containerRef, beamlineRef, onChangeCb); }, 0); } }

  function typeBadgeClass(type) {
    if (type === 'Mirror') return 'mirror';
    if (type === 'Source') return 'source';
    return 'aperture';
  }

  function renderCard(comp, idx, components, container) {
    const card = el('div', 'ce-card');
    const head = el('div', 'ce-card-head');

    const chev = el('span', 'ce-chev', expandedSet.has(comp) ? '▾' : '▸');
    chev.addEventListener('click', () => { if (expandedSet.has(comp)) expandedSet.delete(comp); else expandedSet.add(comp); scheduleRerender(); });
    head.appendChild(chev);

    head.appendChild(el('span', `ce-badge ${typeBadgeClass(comp.type)}`, comp.type === 'RelativeAperture' ? 'RelAperture' : comp.type));

    const nameInput = textInput(comp.name, (v) => { comp.name = v; });
    nameInput.className = 'ce-name';
    // Live-update the model on every keystroke (§ so position/labels stay in sync elsewhere),
    // but only rebuild the card list on blur/Enter — other cards' dropdowns that reference this
    // component's name (e.g. a RelativeAperture's "target" select) need a full re-render to pick
    // up a rename, but doing that on every keystroke would steal focus mid-typing.
    nameInput.addEventListener('change', () => scheduleRerender());
    head.appendChild(nameInput);

    const spacer = el('span', 'ce-spacer'); head.appendChild(spacer);

    if (idx > 0) {
      const up = el('button', 'ce-icon-btn', '↑');
      up.title = 'Move up';
      up.disabled = components[idx - 1].type === 'Source';
      up.addEventListener('click', () => {
        if (idx === 0) return;
        [components[idx - 1], components[idx]] = [components[idx], components[idx - 1]];
        scheduleRerender(); onChangeCb();
      });
      head.appendChild(up);
    }
    if (idx < components.length - 1 && comp.type !== 'Source') {
      const down = el('button', 'ce-icon-btn', '↓');
      down.title = 'Move down';
      down.addEventListener('click', () => {
        [components[idx + 1], components[idx]] = [components[idx], components[idx + 1]];
        scheduleRerender(); onChangeCb();
      });
      head.appendChild(down);
    }
    if (comp.type !== 'Source') {
      const del = el('button', 'ce-icon-btn ce-danger', '✕');
      del.title = 'Delete';
      del.addEventListener('click', () => {
        if (!confirm(`Delete "${comp.name}"?`)) return;
        components.splice(idx, 1);
        scheduleRerender(); onChangeCb();
      });
      head.appendChild(del);
    }
    card.appendChild(head);

    if (expandedSet.has(comp)) {
      let body;
      if (comp.type === 'Source') body = buildSourceForm(comp);
      else if (comp.type === 'Aperture') body = buildApertureForm(comp);
      else if (comp.type === 'RelativeAperture') body = buildRelativeApertureForm(comp, components.slice(0, idx).map((c) => c.name));
      else if (comp.type === 'Mirror') body = buildMirrorForm(comp);
      else body = el('div', 'ce-note', `Unknown type "${comp.type}"`);
      card.appendChild(body);
    }
    container.appendChild(card);
  }

  ce.render = function (container, beamline, onChange) {
    containerRef = container; beamlineRef = beamline; onChangeCb = onChange || (() => {});
    container.innerHTML = '';
    if (!beamline || !beamline.components) return;
    beamline.components.forEach((comp, idx) => renderCard(comp, idx, beamline.components, container));
  };

  ce.addComponent = function (beamline, type) {
    const names = beamline.components.map((c) => c.name);
    const uniq = (base) => { let n = base, i = 1; while (names.includes(n)) n = base + (i++); return n; };
    let comp;
    if (type === 'Mirror') comp = defaultMirror(uniq('M'));
    else if (type === 'Aperture') comp = defaultAperture(uniq('AP'));
    else if (type === 'RelativeAperture') comp = defaultRelativeAperture(uniq('RelAP'), beamline.components[beamline.components.length - 1] && beamline.components[beamline.components.length - 1].name);
    else return;
    beamline.components.push(comp);
    expandedSet.add(comp);
  };

  ce.resetExpanded = function () { /* WeakSet has no clear(); new beamlines get fresh component objects anyway */ };

  SR.componentEditor = ce;
})(window.SR = window.SR || {});
