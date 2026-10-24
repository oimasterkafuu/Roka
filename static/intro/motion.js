import * as T from 'three';
const V = () => new T.Vector3(),
  Q = () => new T.Quaternion();
const fract = (x) => x - Math.floor(x),
  clamp = T.MathUtils.clamp;
function rotateWorld(b, delta) {
  const p = b.parent.getWorldQuaternion(Q()),
    w = b.getWorldQuaternion(Q());
  b.quaternion.copy(p.invert().multiply(delta.multiply(w)));
  b.updateMatrixWorld(true);
}
function solve(hip, knee, foot, target) {
  const h = hip.getWorldPosition(V()),
    k = knee.getWorldPosition(V()),
    a = foot.getWorldPosition(V());
  const l1 = h.distanceTo(k),
    l2 = k.distanceTo(a);
  let dir = target.clone().sub(h),
    distance = clamp(dir.length(), Math.abs(l1 - l2) + 0.001, (l1 + l2) * 0.999);
  dir.normalize();
  let bend = k.clone().sub(h).addScaledVector(dir, -k.clone().sub(h).dot(dir));
  if (bend.length() < 0.001) bend.set(0, 0, 1).addScaledVector(dir, -dir.z);
  bend.normalize();
  const along = (l1 * l1 + distance * distance - l2 * l2) / (2 * distance);
  const nk = h
    .clone()
    .addScaledVector(dir, along)
    .addScaledVector(bend, Math.sqrt(Math.max(0, l1 * l1 - along * along)));
  rotateWorld(hip, Q().setFromUnitVectors(k.clone().sub(h).normalize(), nk.clone().sub(h).normalize()));
  const nowK = knee.getWorldPosition(V()),
    nowA = foot.getWorldPosition(V());
  rotateWorld(knee, Q().setFromUnitVectors(nowA.sub(nowK).normalize(), target.clone().sub(nowK).normalize()));
}
function setWorldQ(b, q) {
  b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(q));
  b.updateMatrixWorld(true);
}
function sample(rows, side, phase) {
  const k = fract(phase) * rows.length,
    i = Math.floor(k),
    a = rows[i],
    b = rows[(i + 1) % rows.length];
  return new T.Vector3().fromArray(a[side + 'Foot']).lerp(new T.Vector3().fromArray(b[side + 'Foot']), k - i);
}
export class Motion {
  constructor(actor, profile, ground) {
    this.a = actor;
    this.ground = ground;
    this.profiles = Object.fromEntries(profile.clips.map((c) => [c.name, c]));
    this.bones = {};
    actor.model.traverse((o) => {
      if (o.isBone) this.bones[o.name] = o;
    });
    this.actions = {};
    for (const c of actor.gl.animations) this.actions[c.name] = actor.mixer.clipAction(c);
    this.actions.walk.reset().play();
    actor.mixer.setTime(0.36 * this.profiles.walk.duration);
    this.idlePose = Object.values(this.bones).map((b) => ({
      b,
      p: b.position.clone(),
      q: b.quaternion.clone(),
      s: b.scale.clone(),
    }));
    actor.mixer.stopAllAction();
    this.mode = '';
    this.contacts = [];
    this.shadows = [];
    for (const side of ['Left', 'Right']) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d'),
        g = x.createRadialGradient(32, 32, 2, 32, 32, 31);
      g.addColorStop(0, 'rgba(8,6,4,.75)');
      g.addColorStop(1, 'rgba(8,6,4,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
      const m = new T.Mesh(
        new T.PlaneGeometry(0.26, 0.45),
        new T.MeshBasicMaterial({
          map: new T.CanvasTexture(c),
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 3;
      actor.fxParent.add(m);
      this.shadows.push(m);
    }
  }
  // `gesture` is a 0..1 raised-arm weight; each frame rebuilds the pose from the
  // idle base, so partial weights stay continuous across shot boundaries and seeks.
  update(t, mode = 'walk', gesture = 0) {
    const a = this.a,
      idle = mode === 'idle',
      clipName = mode === 'run' ? 'run' : 'walk',
      p = this.profiles[clipName],
      speed = clipName === 'run' ? 4.3 : 1.5,
      timeScale = a.speed,
      phase = a.phase * p.duration;
    if (this.mode !== mode) {
      a.mixer.stopAllAction();
      if (!idle) this.actions[clipName].reset().play();
      this.mode = mode;
    }
    const sampleTime = idle ? 0.36 * p.duration : t * timeScale + phase;
    if (idle) {
      for (const p of this.idlePose) {
        p.b.position.copy(p.p);
        p.b.quaternion.copy(p.q);
        p.b.scale.copy(p.s);
      }
    } else a.mixer.setTime(sampleTime);
    a.pivot.rotation.y = a.yaw;
    a.pivot.position.set(a.x, this.ground(a.x, a.z), a.z);
    const dir = new T.Vector3(0, 0, 1).applyAxisAngle(new T.Vector3(0, 1, 0), a.yaw),
      distance = idle ? 0 : t * speed * timeScale * a.variation;
    a.pivot.position.addScaledVector(dir, distance);
    a.pivot.position.y = this.ground(a.pivot.position.x, a.pivot.position.z);
    if (idle) {
      const spine = this.bones.Spine02;
      spine.rotation.z += 0.006 * Math.sin(t * 1.7 + a.phase);
      this.bones.Head.rotation.y += 0.035 * Math.sin(t * 0.65 + a.phase);
    }
    a.model.updateMatrixWorld(true);
    const hips = this.bones.Hips,
      hipWorld = hips.getWorldPosition(V());
    hipWorld.y -= idle ? 0.04 : 0.025;
    hips.position.copy(hips.parent.worldToLocal(hipWorld));
    a.model.updateMatrixWorld(true);
    this.contacts = [];
    for (let si = 0; si < 2; si++) {
      const side = si ? 'Right' : 'Left',
        foot = this.bones[side + 'Foot'],
        knee = this.bones[side + 'Leg'],
        hip = this.bones[side + 'UpLeg'],
        toe = this.bones[side + 'ToeBase'];
      const start = clipName === 'run' ? (si ? 0.73 : 0.23) : si ? 0.74 : 0.24,
        end = clipName === 'run' ? (si ? 0.98 : 0.48) : si ? 1.18 : 0.68;
      const cycle = Math.floor(sampleTime / p.duration - start),
        within = sampleTime / p.duration - cycle - start,
        planted = idle || within < end - start;
      let target = foot.getWorldPosition(V()),
        q = foot.getWorldQuaternion(Q()),
        contactAge = 100;
      if (planted) {
        const landTime = (cycle * p.duration + start * p.duration - phase) / timeScale;
        const pos = sample(p.rows, side, idle ? 0.36 : start)
          .multiplyScalar(a.variation)
          .applyAxisAngle(new T.Vector3(0, 1, 0), a.yaw);
        target = new T.Vector3(a.x, 0, a.z)
          .addScaledVector(dir, idle ? 0 : landTime * speed * timeScale * a.variation)
          .add(pos);
        target.y = this.ground(target.x, target.z) + p.feet[side].soleOffset * a.variation + 0.008;
        q = Q()
          .setFromAxisAngle(new T.Vector3(0, 1, 0), a.yaw)
          .multiply(Q().fromArray(p.feet[side].neutralQ));
        toe.quaternion.fromArray(p.feet[side].toeQ);
        contactAge = idle ? 100 : t - landTime;
      } else {
        const minimum = this.ground(target.x, target.z) + p.feet[side].soleOffset * a.variation + 0.012;
        target.y = Math.max(target.y, minimum);
      }
      solve(hip, knee, foot, target);
      setWorldQ(foot, q);
      a.model.updateMatrixWorld(true);
      const actual = foot.getWorldPosition(V()),
        ground = this.ground(actual.x, actual.z),
        soleY = actual.y - p.feet[side].soleOffset * a.variation;
      const sh = this.shadows[si];
      sh.visible = a.pivot.parent.visible;
      sh.position.set(actual.x, ground + 0.009, actual.z);
      sh.rotation.z = -a.yaw;
      sh.material.opacity = planted ? 0.58 : clamp(1 - (soleY - ground) / 0.17, 0, 1) * 0.24;
      this.contacts.push({
        side,
        planted,
        age: contactAge,
        target: target.toArray(),
        actual: actual.toArray(),
        soleY,
        ground,
        error: actual.distanceTo(target),
      });
    }
    if (idle && gesture > 0) {
      const arm = this.bones.RightArm,
        elbow = this.bones.RightForeArm;
      const p0 = arm.getWorldPosition(V()),
        p1 = elbow.getWorldPosition(V());
      const direction = new T.Vector3(0.55, 0.12, -0.78).normalize();
      const raise = Q().setFromUnitVectors(p1.sub(p0).normalize(), direction);
      // Blend from the fresh idle base pose so weight changes stay continuous and
      // every frame (including seeks) recomputes the same pose from scratch.
      rotateWorld(arm, Q().slerp(raise, Math.min(1, gesture)));
      elbow.rotation.z += 0.15 * Math.min(1, gesture);
    }
    a.model.updateMatrixWorld(true);
  }
}
