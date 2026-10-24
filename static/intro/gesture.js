// Continuous gesture weight for the front-center leader across the leader → ascend cut.
// A pure function of shot-local time, so playback and progress-bar seeks reproduce
// the exact same pose instead of snapping at the 32s shot boundary.
const smooth = (x) => {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
};
// Gesture forms over the first 0.8s of the leader shot, holds through the cut,
// then relaxes to neutral during the first 1.25s of the ascend pull-back.
export function leaderGestureWeight(name, local) {
  if (name === 'leader') return smooth(local / 0.8);
  if (name === 'ascend') return 1 - smooth(local / 1.25);
  return 0;
}
// Ascend pull-back easing: hold the tight squad framing for the first beat so the
// blue group reads as one unit, then complete the full 9m→360m climb by u=0.8.
export function ascendPullback(u) {
  return smooth((u - 0.08) / 0.72);
}
