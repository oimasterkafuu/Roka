// Gesture continuity across the leader → ascend cut (28–32s → 32–44s) and seek
// reproducibility, exercised against the real Motion solver with a synthetic rig.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import * as T from 'three';
const gestureSource = await fs.readFile(new URL('../../static/intro/gesture.js', import.meta.url), 'utf8');
const { leaderGestureWeight, ascendPullback } = await import(
  `data:text/javascript;base64,${Buffer.from(gestureSource).toString('base64')}`
);
const motionSource = await fs.readFile(new URL('../../static/intro/motion.js', import.meta.url), 'utf8');
const Motion = new Function(
  'T',
  motionSource.replace(/^import .*;\n/gm, '').replace('export class Motion', 'class Motion') +
    '\nreturn Motion;',
)(T);

globalThis.document = {
  createElement() {
    return createCanvas(64, 64);
  },
};

function makeActor() {
  const model = new T.Object3D();
  const bone = (name, parent, x, y, z) => {
    const b = new T.Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    return b;
  };
  const hips = bone('Hips', model, 0, 1, 0);
  bone('Spine02', hips, 0, 0.3, 0);
  bone('Head', hips, 0, 0.5, 0);
  for (const side of ['Left', 'Right']) {
    const s = side === 'Left' ? -1 : 1,
      up = bone(side + 'UpLeg', hips, s * 0.1, -0.05, 0),
      leg = bone(side + 'Leg', up, 0, -0.45, 0),
      foot = bone(side + 'Foot', leg, 0, -0.45, 0);
    bone(side + 'ToeBase', foot, 0, 0, 0.12);
  }
  const arm = bone('RightArm', hips, 0.25, 0.35, 0);
  bone('RightForeArm', arm, 0.24, 0, 0);
  const pivot = new T.Group(),
    parent = new T.Group(),
    fxParent = new T.Object3D();
  pivot.add(model);
  parent.add(pivot, fxParent);
  parent.visible = true;
  const walk = new T.AnimationClip('walk', 1, [
    new T.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  const run = walk.clone();
  run.name = 'run';
  return {
    model,
    pivot,
    parent,
    fxParent,
    gl: { animations: [walk, run] },
    mixer: new T.AnimationMixer(model),
    x: 0,
    z: 0,
    yaw: 0,
    phase: 0,
    speed: 1,
    variation: 1,
  };
}

const clip = {
  duration: 1,
  rows: [{ LeftFoot: [0, 0, 0], RightFoot: [0, 0, 0] }],
  feet: {
    Left: { soleOffset: 0, neutralQ: [0, 0, 0, 1], toeQ: [0, 0, 0, 1] },
    Right: { soleOffset: 0, neutralQ: [0, 0, 0, 1], toeQ: [0, 0, 0, 1] },
  },
};
const runClip = { ...clip, name: 'run' };
clip.name = 'walk';
const profile = { clips: [clip, runClip] };
const ground = () => 0;

function armQuaternion(motion) {
  return motion.bones.RightArm.getWorldQuaternion(new T.Quaternion()).toArray();
}
function angleBetween(a, b) {
  return 2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, v, i) => sum + v * b[i], 0))));
}

{
  const motion = new Motion(makeActor(), profile, ground);
  // Weight envelope: forms during leader, holds through the cut, relaxes into ascend.
  assert.equal(leaderGestureWeight('leader', 0), 0, 'gesture starts from neutral');
  assert.equal(leaderGestureWeight('leader', 0.8), 1, 'gesture fully formed by 0.8s');
  assert.equal(leaderGestureWeight('leader', 4), 1, 'gesture holds until the cut');
  assert.equal(leaderGestureWeight('ascend', 0), 1, 'ascend continues the same weight at 32s');
  assert.equal(leaderGestureWeight('ascend', 1.25), 0, 'gesture relaxes within ~1.25s');
  assert.equal(leaderGestureWeight('march', 2), 0, 'other shots never raise the arm');
  for (let k = 0; k < 40; k++) assert.equal(leaderGestureWeight('leader', k / 10) >= 0, true);

  // Frame-to-frame pose deltas stay small across the 32s boundary (no snap).
  const samples = [];
  for (let k = 0; k <= 40; k++) samples.push(['leader', k / 10]);
  for (let k = 0; k <= 26; k++) samples.push(['ascend', k / 10]);
  let previous = null,
    worst = 0;
  for (const [name, local] of samples) {
    motion.update(local, 'idle', leaderGestureWeight(name, local));
    const q = armQuaternion(motion);
    if (previous) worst = Math.max(worst, angleBetween(previous, q));
    previous = q;
  }
  assert.ok(worst < 0.3, `largest per-100ms arm step ${worst.toFixed(3)} rad stays continuous`);

  // A full-weight frame differs clearly from neutral (the gesture is still visible).
  motion.update(2, 'idle', 0);
  const neutral = armQuaternion(motion);
  motion.update(2, 'idle', 1);
  const raised = armQuaternion(motion);
  assert.ok(angleBetween(neutral, raised) > 0.5, 'full weight raises the arm well above neutral');

  // Seek reproducibility: arbitrary seek order reproduces the identical pose.
  const targets = [
    ['leader', 2.4],
    ['ascend', 0.5],
    ['leader', 2.4],
    ['ascend', 1.0],
    ['leader', 2.4],
  ];
  let reference = null;
  for (const [name, local] of targets) {
    motion.update(local, 'idle', leaderGestureWeight(name, local));
    const q = armQuaternion(motion);
    if (name === 'leader' && local === 2.4) {
      if (reference) assert.deepEqual(q, reference, 're-seeking reproduces the exact arm pose');
      else reference = q;
    }
  }
  const fresh = new Motion(makeActor(), profile, ground);
  fresh.update(2.4, 'idle', leaderGestureWeight('leader', 2.4));
  assert.deepEqual(armQuaternion(fresh), reference, 'a fresh instance matches the seeked pose');
}

{
  // Walk/run/idle mode switches around the boundary tolerate any weight and the
  // gesture never corrupts locomotion state.
  const motion = new Motion(makeActor(), profile, ground);
  for (const [mode, t, w] of [
    ['walk', 1, 0],
    ['walk', 1.1, 1],
    ['idle', 0, leaderGestureWeight('leader', 0.3)],
    ['run', 2, leaderGestureWeight('ascend', 0.4)],
    ['idle', 1.2, leaderGestureWeight('ascend', 1.0)],
  ]) {
    motion.update(t, mode, w);
    assert.ok(motion.contacts.length === 2, mode + ' keeps both foot contacts');
    for (const c of motion.contacts) assert.ok(Number.isFinite(c.soleY), 'sole height stays finite');
  }
}

{
  // Ascend pull-back keeps the squad readable as a group: the ortho height holds
  // near the leader framing first, then climbs monotonically to the full map.
  assert.equal(ascendPullback(0), 0, 'pull-back holds the tight squad framing at the cut');
  assert.ok(ascendPullback(0.08) === 0, 'framing stays put for the first beat');
  assert.equal(ascendPullback(0.8), 1, 'full map reach is unchanged by u=0.8');
  let prev = -1;
  for (let k = 0; k <= 80; k++) {
    const v = ascendPullback(k / 100);
    assert.ok(v >= prev, 'pull-back easing is monotonic');
    prev = v;
  }
  // A ~2m soldier must stay at least ~48px tall on the 1080p frame through the
  // early pull-back (u≤0.3), i.e. ortho height stays under ~45m there.
  for (let k = 0; k <= 30; k++) {
    const u = k / 100,
      height = 9 * Math.pow(360 / 9, ascendPullback(u));
    assert.ok(height <= 45, `squad stays readable at u=${u} (height ${height.toFixed(1)}m)`);
  }
  assert.ok(9 * Math.pow(360 / 9, ascendPullback(0.8)) >= 359, 'final full-map height preserved');
}

console.log('intro gesture: leader→ascend continuity, seek reproducibility and squad framing passed');
