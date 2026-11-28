import { decodeRpl } from './rpl';
import { GameEngine } from './game-engine';

self.onmessage = async ({ data }) => {
  try {
    const archive = await decodeRpl(new Uint8Array(data));
    const progress = (tick) => self.postMessage({ tick, total: archive.total_turns });
    progress(0);
    const replay = await GameEngine.buildReplayFromActions(archive, progress);
    const keys = ['grid_type', 'army_cnt', 'isolated'];
    const frames = [replay.initial, ...replay.keyframes.values()];
    for (const patch of replay.patches) frames.push(patch.forward, patch.backward);
    const words = frames.reduce(
      (total, frame) => total + keys.reduce((sum, key) => sum + frame[key].length, 0),
      0,
    );
    const packed = new Uint32Array(words);
    let offset = 0;
    for (const frame of frames)
      for (const key of keys) {
        const values = frame[key];
        packed.set(values, offset);
        frame[key] = packed.subarray(offset, offset + values.length);
        offset += values.length;
      }
    self.postMessage({ replay }, [packed.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
