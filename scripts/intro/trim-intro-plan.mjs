import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CUT_START = 84;
const CUT_END = 88;
const CUT_DURATION = CUT_END - CUT_START;

export function trimStandaloneCharge(source) {
  const plan = structuredClone(source);
  const chargeIndex = plan.shots.findIndex((shot) => shot.name === 'charge');
  const compareIndex = plan.shots.findIndex((shot) => shot.name === 'charge_compare');
  if (chargeIndex < 0 || compareIndex !== chargeIndex + 1)
    throw new Error('Expected one standalone charge immediately before charge_compare');
  const charge = plan.shots[chargeIndex];
  const compare = plan.shots[compareIndex];
  if (charge.start !== CUT_START || charge.end !== CUT_END || compare.start !== CUT_END)
    throw new Error('Expected the standalone charge at 84–88 seconds');

  const shotIndices = new Map();
  const shots = [];
  for (const [index, shot] of plan.shots.entries()) {
    if (index === chargeIndex) continue;
    const shifted = { ...shot };
    if (index > chargeIndex) {
      for (const key of ['start', 'end', 'nominalStart', 'nominalEnd'])
        if (typeof shifted[key] === 'number') shifted[key] -= CUT_DURATION;
    }
    shotIndices.set(index, shots.length);
    shots.push(shifted);
  }
  plan.shots = shots;
  plan.frames = plan.frames
    .filter((frame) => frame.t < CUT_START || frame.t >= CUT_END)
    .map((frame) => {
      const shot = shotIndices.get(frame.shot);
      if (shot === undefined) throw new Error(`Frame at ${frame.t} references the removed charge shot`);
      return { ...frame, t: frame.t >= CUT_END ? frame.t - CUT_DURATION : frame.t, shot };
    });
  plan.beats = plan.beats
    .filter((beat) => beat.time < CUT_START || beat.time >= CUT_END)
    .map((beat) => ({
      ...beat,
      time: beat.time >= CUT_END ? beat.time - CUT_DURATION : beat.time,
    }));
  plan.duration -= CUT_DURATION;
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] || 'static/intro/assets/plan.json';
  const output = process.argv[3] || input;
  const plan = trimStandaloneCharge(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, JSON.stringify(plan));
  console.log(
    `Trimmed standalone charge: ${plan.duration}s, ${plan.shots.length} shots, ${plan.frames.length} frames.`,
  );
}
