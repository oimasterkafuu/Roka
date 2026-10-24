import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(await readFile(path.join(root, 'static/intro/assets/manifest.json'), 'utf8'));
const score = path.join(root, 'static', manifest.files['score.mp3']);
const probe = JSON.parse(
  execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=sample_rate,channels',
      '-of',
      'json',
      score,
    ],
    { encoding: 'utf8' },
  ),
);
assert.equal(probe.streams[0].sample_rate, '48000');
assert.equal(probe.streams[0].channels, 2);

const pcm = execFileSync(
  'ffmpeg',
  ['-v', 'error', '-i', score, '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 's16le', '-'],
  {
    maxBuffer: 64 * 1024 * 1024,
  },
);
const bytesPerSecond = 48000 * 2 * 2;
const duration = pcm.length / bytesPerSecond;
assert.equal(duration, 120, 'decoded PCM, not the MP3 container padding, must be exactly 120 seconds');

const expected = await readFile(path.join(import.meta.dirname, 'fixtures/intro-score-expected-120.s16le'));
const actual = execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-i',
    score,
    '-map',
    '0:a:0',
    '-af',
    'aresample=100',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    '-',
  ],
  { maxBuffer: 1024 * 1024 },
);
assert.equal(actual.length, expected.length);
assert.equal(expected.length, 120 * 100 * 2);
const int16 = (buffer) => new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
const reference = int16(expected);
const candidate = int16(actual);
let sumReference = 0;
let sumCandidate = 0;
for (let i = 0; i < reference.length; i++) {
  sumReference += reference[i];
  sumCandidate += candidate[i];
}
const meanReference = sumReference / reference.length;
const meanCandidate = sumCandidate / candidate.length;
let covariance = 0;
let referenceEnergy = 0;
let candidateEnergy = 0;
let differenceEnergy = 0;
for (let i = 0; i < reference.length; i++) {
  const a = reference[i] - meanReference;
  const b = candidate[i] - meanCandidate;
  covariance += a * b;
  referenceEnergy += a * a;
  candidateEnergy += b * b;
  differenceEnergy += (reference[i] - candidate[i]) ** 2;
}
const correlation = covariance / Math.sqrt(referenceEnergy * candidateEnergy);
const normalizedRms =
  Math.sqrt(differenceEnergy / reference.length) / Math.sqrt(referenceEnergy / reference.length);
assert(correlation > 0.999, `expected-cut PCM correlation ${correlation}`);
assert(normalizedRms < 0.05, `expected-cut normalized PCM RMS ${normalizedRms}`);
console.log(
  `intro media: decoded PCM ${duration.toFixed(3)}s at 48000 Hz stereo; expected-cut correlation ${correlation.toFixed(9)}, normalized RMS ${normalizedRms.toFixed(9)} passed`,
);
