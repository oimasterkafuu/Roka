import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const controlsSource = readFileSync(new URL('../static/main/replay-controls.js', import.meta.url), 'utf8');
const updates = [];
const clickHandlers = new Map();
const styles = {};
const timers = new Map();
let nextTimer = 0;
const controls = vm.createContext({
  console,
  replay_data: {
    initial: { turn: 0 },
    patches: [
      { forward: { turn: 1 }, backward: { turn: 0 } },
      { forward: { turn: 2 }, backward: { turn: 1 } },
    ],
  },
  cur_turn: 0,
  is_autoplaying: false,
  autoplay_speed: 1,
  update(data, options) {
    updates.push({ data, options, frame: controls.cur_turn });
  },
  setTimeout(callback, delay) {
    timers.set(++nextTimer, { callback, delay });
    return nextTimer;
  },
  clearTimeout(timer) {
    timers.delete(timer);
  },
  $(selector) {
    const targets = [selector];
    return {
      children: () => ({ eq: (index) => controls.$(`bottom-${index}`) }),
      add(target) {
        targets.push(target);
        return this;
      },
      on(type, handler) {
        assert.equal(type, 'click');
        for (const target of targets) clickHandlers.set(target, handler);
      },
      attr() {},
      css(property, value) {
        styles[`${selector}:${property}`] = value;
      },
    };
  },
});
vm.runInContext(controlsSource, controls, { filename: 'static/main/replay-controls.js' });

assert.equal(controls.nextTurn(), true);
assert.equal(controls.nextTurn(), true);
assert.equal(controls.cur_turn, 2);
assert.equal(controls.backTurn({ type: 'click' }), true, 'jQuery event must not enable silent mode');
assert.equal(controls.cur_turn, 1);
assert.deepEqual(updates.at(-1), { data: { turn: 1 }, options: undefined, frame: 1 });
assert.equal(controls.backTurn(true), true, 'jump-to-frame intermediate steps remain silent');
assert.equal(controls.cur_turn, 0);
assert.equal(updates.at(-1).options.silent, true);
assert.equal(controls.backTurn(), false, 'cannot step before the initial frame');
assert.equal(updates.length, 4);

controls.bindReplayPlaybackControls();
const click = (target) => clickHandlers.get(target)({ type: 'click' });
const rateDisplay = () => styles['#tabs-replay-autoplay:display'];
const tick = () => {
  assert.equal(timers.size, 1);
  const [id, { callback, delay }] = timers.entries().next().value;
  assert.equal(delay, 500 / controls.autoplay_speed);
  timers.delete(id);
  callback();
};
for (let cycle = 0; cycle < 3; cycle++) {
  click('bottom-1');
  assert.equal(rateDisplay(), 'inline-block');
  click('bottom-2');
  assert.equal(controls.cur_turn, 0, 'next click must not bypass the autoplay guard');
  click('#replay-autoplay-btn');
  assert.equal(rateDisplay(), 'none', 'manual pause hides the speed tabs');
  assert.equal(timers.size, 0, 'manual pause cancels the pending tick');
}
for (let step = 0; step < 2; step++) click('bottom-2');
assert.equal(controls.cur_turn, 2);
for (let step = 0; step < 2; step++) click('bottom-0');
assert.equal(controls.cur_turn, 0);
assert.deepEqual(
  updates.slice(-4).map(({ frame, options }) => [frame, options]),
  [
    [1, undefined],
    [2, undefined],
    [1, undefined],
    [0, undefined],
  ],
);
click('#replay-autoplay-btn');
tick();
tick();
tick();
assert.equal(controls.is_autoplaying, false);
assert.equal(rateDisplay(), 'inline-block', 'reaching the end still leaves speed tabs visible');
assert.equal(timers.size, 0);

const mainSource = readFileSync(new URL('../static/main.js', import.meta.url), 'utf8');
const loadingSource = mainSource.slice(
  mainSource.indexOf('function formatReplaySize'),
  mainSource.indexOf('function base64ToArrayBuffer'),
);
const nodes = {
  '#replay-loading-fill': {
    classes: new Set(['indeterminate']),
    styles: {},
    removeClass(name) {
      this.classes.delete(name);
      return this;
    },
    addClass(name) {
      this.classes.add(name);
      return this;
    },
    css(name, value) {
      this.styles[name] = value;
      return this;
    },
  },
  '#replay-loading-text': {
    text: '',
    textContent(value) {
      this.text = value;
      return this;
    },
  },
};
const loading = vm.createContext({
  console,
  Uint8Array,
  fetch: async () => {
    throw new Error('fetch stub not configured');
  },
  $(selector) {
    const node = nodes[selector];
    assert(node, `unexpected selector ${selector}`);
    if (selector === '#replay-loading-text') return { text: (value) => node.textContent(value) };
    return node;
  },
});
vm.runInContext(loadingSource, loading, { filename: 'static/main.js replay loading' });

loading.updateReplayLoading(25, 100);
assert.equal(nodes['#replay-loading-fill'].classes.has('indeterminate'), false);
assert.equal(nodes['#replay-loading-fill'].styles.width, '25%');
loading.updateReplayLoading(1, 0);
assert.equal(nodes['#replay-loading-fill'].classes.has('indeterminate'), true);
assert.equal(nodes['#replay-loading-fill'].styles.width, '');

async function runStream(chunks, total) {
  let index = 0;
  loading.fetch = async () => ({
    ok: true,
    headers: { get: (name) => (name === 'X-Replay-Size' && total > 0 ? String(total) : null) },
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length ? { done: false, value: Uint8Array.from(chunks[index++]) } : { done: true },
      }),
    },
  });
  const result = await loading.fetchReplayWithProgress('/api/getreplay/test');
  assert.equal(result.buffer.byteLength, chunks.flat().length);
  assert.deepEqual(Array.from(new Uint8Array(result.buffer)), chunks.flat());
  assert.equal(nodes['#replay-loading-fill'].classes.has('indeterminate'), false);
  assert.equal(nodes['#replay-loading-fill'].styles.width, '100%');
  assert.match(nodes['#replay-loading-text'].text, /100%/);
}

await runStream(
  [
    [1, 2],
    [3, 4, 5],
  ],
  5,
);
await runStream([[6, 7, 8, 9]], 0);
await runStream([[10, 11, 12, 13]], 10_000);

console.log('replay controls and loading progress regression tests passed');
