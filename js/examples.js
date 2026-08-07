// examples.js — built-in example beamlines. Embedded directly (not fetched) so the app works
// when opened straight from disk via file:// as well as from a server.
(function (SR) {
  'use strict';
  const deg = (d) => (d * Math.PI) / 180;

  const worked_fixture = {
    name: '§14 Worked Validation Fixture',
    description: 'The canonical regression fixture from the build spec (§14): Source -> M101 -> AP101 (relative) -> Entrance Slit -> M102 -> G101 -> M103 -> Aperture2. M102/G101/M103 have zero-width motion on every DOF, which exercises the §7 degenerate-hull fallback.',
    config: { linear_accuracy: 0.5, angular_accuracy: 0.00025, mode: 'coarse' },
    world_origin: [0, 0, 0],
    components: [
      {
        type: 'Source', name: 'Source', position: [0, 0, 0],
        size_x_min: -1, size_x_max: 1, size_y_min: -1, size_y_max: 1,
        div_a_min: -0.002, div_a_max: 0.002, div_b_min: -0.002, div_b_max: 0.002,
      },
      {
        type: 'Mirror', name: 'M101', position: [0.0, 0.0, 11957.055],
        azimuthal_angle: 0, nominal_pitch: deg(2), mirrorType: 'Flat',
        rotation_sequence: 'Pitch->Roll->Yaw',
        length_min: -250, length_max: 250,
        x_motion_min: -5, x_motion_max: 5, y_motion_min: 0, y_motion_max: 0, z_motion_min: 0, z_motion_max: 0,
        pitch_min: -0.005, pitch_max: 0.005, roll_min: 0, roll_max: 0, yaw_min: 0, yaw_max: 0,
        x_rotation_arm: 0, z_rotation_arm: 0,
        misalignment_tolerances: { X: [0, 0], Y: [0, 0], Z: [0, 0], Pitch: [0, 0], Roll: [0, 0], Yaw: [0, 0] },
      },
      {
        type: 'RelativeAperture', name: 'AP101', target: 'M101', distance: 100,
        size_x_min: -5, size_x_max: 5, size_y_min: -5, size_y_max: 5,
      },
      {
        type: 'Aperture', name: 'Entrance Slit', position: [130.84, 0.0, 14453.628],
        size_x_min: -10, size_x_max: 10, size_y_min: -10, size_y_max: 10,
      },
      {
        type: 'Mirror', name: 'M102', position: [407.402, 0.0, 19730.756],
        azimuthal_angle: 0, nominal_pitch: deg(2), mirrorType: 'Flat',
        rotation_sequence: 'Pitch->Roll->Yaw', length_min: -250, length_max: 250,
        x_motion_min: 0, x_motion_max: 0, y_motion_min: 0, y_motion_max: 0, z_motion_min: 0, z_motion_max: 0,
        pitch_min: 0, pitch_max: 0, roll_min: 0, roll_max: 0, yaw_min: 0, yaw_max: 0,
        x_rotation_arm: 0, z_rotation_arm: 0,
      },
      {
        type: 'Mirror', name: 'G101', position: [418.688, 15.0, 19946.09],
        azimuthal_angle: 0, nominal_pitch: deg(2), mirrorType: 'Flat',
        rotation_sequence: 'Pitch->Roll->Yaw', length_min: -250, length_max: 250,
        x_motion_min: 0, x_motion_max: 0, y_motion_min: 0, y_motion_max: 0, z_motion_min: 0, z_motion_max: 0,
        pitch_min: 0, pitch_max: 0, roll_min: 0, roll_max: 0, yaw_min: 0, yaw_max: 0,
        x_rotation_arm: 0, z_rotation_arm: 0,
      },
      {
        type: 'Mirror', name: 'M103', position: [492.418, 15.0, 21352.959],
        azimuthal_angle: 0, nominal_pitch: deg(2), mirrorType: 'Flat',
        rotation_sequence: 'Pitch->Roll->Yaw', length_min: -250, length_max: 250,
        x_motion_min: 0, x_motion_max: 0, y_motion_min: 0, y_motion_max: 0, z_motion_min: 0, z_motion_max: 0,
        pitch_min: 0, pitch_max: 0, roll_min: 0, roll_max: 0, yaw_min: 0, yaw_max: 0,
        x_rotation_arm: 0, z_rotation_arm: 0,
      },
      {
        type: 'Aperture', name: 'Aperture2', position: [544.619, 15.0, 21849.614],
        size_x_min: -10, size_x_max: 10, size_y_min: -10, size_y_max: 10,
      },
    ],
  };

  const simple_passthrough = {
    name: 'Simple: Source -> Aperture (no mirrors)',
    description: 'Smallest possible non-trivial beamline. Good first smoke test for §3/§4/§5.',
    config: { linear_accuracy: 0.5, angular_accuracy: 0.00025, mode: 'coarse' },
    world_origin: [0, 0, 0],
    components: [
      {
        type: 'Source', name: 'Source', position: [0, 0, 0],
        size_x_min: -0.5, size_x_max: 0.5, size_y_min: -0.5, size_y_max: 0.5,
        div_a_min: -0.001, div_a_max: 0.001, div_b_min: -0.001, div_b_max: 0.001,
      },
      {
        type: 'Aperture', name: 'A1', position: [0, 0, 20000],
        size_x_min: -8, size_x_max: 8, size_y_min: -8, size_y_max: 8,
        misalignment_tolerances: { X: [-0.5, 0.5], Y: [0, 0], Z: [-50, 50] },
      },
    ],
  };

  const single_mirror = {
    name: 'Single flat mirror (coarse mode)',
    description: 'Source -> flat mirror at 2° grazing incidence -> exit aperture. Exercises §6-§8 end to end without the multi-mirror degeneracies of the full fixture.',
    config: { linear_accuracy: 0.5, angular_accuracy: 0.00025, mode: 'coarse' },
    world_origin: [0, 0, 0],
    components: [
      {
        type: 'Source', name: 'Source', position: [0, 0, 0],
        size_x_min: -1, size_x_max: 1, size_y_min: -1, size_y_max: 1,
        div_a_min: -0.002, div_a_max: 0.002, div_b_min: -0.002, div_b_max: 0.002,
      },
      {
        type: 'Mirror', name: 'M1', position: [0, 0, 12000],
        azimuthal_angle: 0, nominal_pitch: deg(2), mirrorType: 'Flat',
        rotation_sequence: 'Pitch->Roll->Yaw', length_min: -250, length_max: 250,
        x_motion_min: -5, x_motion_max: 5, y_motion_min: 0, y_motion_max: 0, z_motion_min: 0, z_motion_max: 0,
        pitch_min: -0.005, pitch_max: 0.005, roll_min: 0, roll_max: 0, yaw_min: 0, yaw_max: 0,
        x_rotation_arm: 0, z_rotation_arm: 0,
      },
      {
        type: 'Aperture', name: 'Exit', position: [500, 0, 22000],
        size_x_min: -10, size_x_max: 10, size_y_min: -10, size_y_max: 10,
      },
    ],
  };

  SR.examples = { worked_fixture, simple_passthrough, single_mirror };
})(window.SR = window.SR || {});
