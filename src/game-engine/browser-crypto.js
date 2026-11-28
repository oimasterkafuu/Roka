// The synchronous map generator uses only the first digest word, even on HTTP origins
// without SubtleCrypto. No keys or authentication use this SHA-256 implementation.
const constants = [];
const initial = [];
for (let prime = 2; constants.length < 64; prime++) {
  let divisor = 2;
  while (divisor * divisor <= prime && prime % divisor) divisor++;
  if (divisor * divisor <= prime) continue;
  constants.push((Math.cbrt(prime) * 0x100000000) >>> 0);
  if (initial.length < 8) initial.push((Math.sqrt(prime) * 0x100000000) >>> 0);
}
const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
function firstDigestWord(input) {
  const bytes = new TextEncoder().encode(input);
  const block = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  block.set(bytes);
  block[bytes.length] = 128;
  const view = new DataView(block.buffer);
  view.setUint32(block.length - 4, bytes.length * 8);
  const state = initial.slice();
  const words = new Uint32Array(64);
  for (let offset = 0; offset < block.length; offset += 64) {
    let [a, b, c, d, e, f, g, h] = state;
    for (let round = 0; round < 64; round++) {
      const left = words[round - 15],
        right = words[round - 2];
      words[round] =
        round < 16
          ? view.getUint32(offset + round * 4)
          : words[round - 16] +
            (rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3)) +
            words[round - 7] +
            (rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10));
      const t1 =
        h +
        (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) +
        constants[round] +
        words[round];
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      [a, b, c, d, e, f, g, h] = [(t1 + t2) | 0, a, b, c, (d + t1) | 0, e, f, g];
    }
    [a, b, c, d, e, f, g, h].forEach((word, index) => (state[index] = (state[index] + word) >>> 0));
  }
  return state[0];
}
export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw Error('Unsupported map digest');
  return {
    update(input) {
      return {
        digest() {
          const word = firstDigestWord(input),
            view = new DataView(new ArrayBuffer(4));
          view.setUint32(0, word);
          return { readUInt32LE: () => view.getUint32(0, true), readUInt16BE: () => view.getUint16(0) };
        },
      };
    },
  };
}
export function randomInt() {
  throw Error('Live broadcast in replay worker');
}
