// version.js — single source of truth for the app's version, shown in the header (short form)
// and in the Debug panel's "About" tab (full changelog). Bump `current` (and add a history
// entry) whenever a meaningful change ships, so anyone comparing behavior against an older
// screenshot/report can immediately tell whether they're on the same build.
(function (SR) {
  'use strict';

  SR.VERSION = {
    current: '1.2.0',
    date: '2026-08-28',
    history: [
      {
        v: '1.2.0', date: '2026-08-28',
        notes: 'ALS Engineering Tools design system applied (Syne/DM Sans fonts, light/dark theme '
          + 'with toggle, header spec, card styling). Version badge added (this). Beamline layout '
          + 'now shows both X-Z and Y-Z views, pan/zoom-linked. Coarse-vs-fine mode comparison panel '
          + 'added next to the mode selector. Verified the geometric orientation-mismatch warning '
          + '(§2/§10 auto-correction) fires correctly and matches the reference tool exactly '
          + '(0.000°/1.431° on the single-mirror case).',
      },
      {
        v: '1.1.0', date: '2026-08-27',
        notes: 'Fixed Save JSON not syncing mode/accuracy changes made after loading a beamline. '
          + 'Investigated a reported X-envelope "sign flip" on the single-mirror example: found no '
          + 'physics bug (confirmed via a symmetry argument + regression test) — traced to '
          + 'incomplete/biased search exploration in whichever optimizer ran.',
      },
      {
        v: '1.0.0', date: '2026-08-27',
        notes: 'Location-based misalignment defaults (PTL / Front End / Experimental floor) with '
          + 'per-component override that survives changes to the global defaults. Global "apply '
          + 'motions & misalignments" toggle. Switched charts to Plotly.js for real zoom/pan/hover. '
          + 'Spillover extended 2500mm downstream in the envelope plot. On-demand intermediate-point '
          + 'display (no re-run needed). Component editor scrolling/layout fix.',
      },
      {
        v: '0.3.0', date: '2026-08-27',
        notes: 'Validated against real reference data (Python script + debug log + CSV) for a '
          + '2-mirror beamline. Found and fixed two real mirror-reflection bugs: the nominal-'
          + 'orientation formula had local length/normal axes swapped, and a missing re-reference '
          + "to the mirror's own center plus missing reorientation into the outgoing beam's frame "
          + 'were corrupting everything downstream of a bend. Removed intermediate raytrace stages '
          + '(replaced with on-the-fly shear); click-to-inspect on the envelope plot.',
      },
      {
        v: '0.2.0', date: '2026-08-26',
        notes: 'Added the component editor (add/edit/reorder/delete Source/Mirror/Aperture/'
          + 'RelativeAperture from scratch). Added the §14 worked fixture and a bundled CSV-'
          + 'validation example matching the reference Python script exactly.',
      },
      {
        v: '0.1.0', date: '2026-08-26',
        notes: 'Initial browser port: §2-§10 raytrace engine, canvas visualizations, load/save '
          + 'JSON, in-browser self-test suite.',
      },
    ],
  };
})(window.SR = window.SR || {});
