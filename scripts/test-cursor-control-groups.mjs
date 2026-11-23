import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { format, resolveConfig } from 'prettier';
import pug from 'pug';

const storageKey = 'roka.controlGroups';
const grid = [
  [101, 201, 200, 204, 0],
  [1, 1, 2, 151, 201],
  [101, 201, 1, 51, 200],
];
const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const sources = [
  'static/main/core-globals.js',
  'static/main/room-controls.js',
  'static/main/render-update.js',
  'static/main.js',
].map((file) => new vm.Script(read(file), { filename: file }));

function createClient({ platform = 'Linux x86_64', storage = new Map(), multiLine = false } = {}) {
  const sent = [];
  const handlers = new Map();
  const ready = [];
  const elements = new Map();
  const makeElement = () => ({ style: {}, events: {}, innerHTML: '', className: '' });
  const document = {
    getElementById() {
      return null;
    },
  };
  const socket = {
    on: (name, handler) => handlers.set(name, handler),
    emit: (name, payload) => sent.push([name, payload]),
  };
  elements.set('#tabs-multi-line-mode', { ...makeElement(), children: [makeElement()] });
  elements.set('#status-alert', {
    children: [{ children: Array.from({ length: 7 }, makeElement) }],
    style: {},
  });
  let cells = [];
  function $(selector) {
    if (typeof selector === 'string' && !elements.has(selector)) elements.set(selector, makeElement());
    const list = selector === '#map td' ? cells : [elements.get(selector) || selector];
    const [element] = list;
    return Object.assign(list, {
      ready: (callback) => ready.push(callback),
      blur() {},
      on(name, handler) {
        element.events[name] = handler;
      },
      bind() {},
      children: () => element.children || [],
      addClass(name) {
        if (!element.className.split(' ').includes(name))
          element.className = `${element.className} ${name}`.trim();
      },
      removeClass(name) {
        element.className = element.className
          .split(' ')
          .filter((item) => item !== name)
          .join(' ');
      },
      css(name, value) {
        if (value === undefined) return element.style[name];
        element.style[name] = value;
      },
      html(value) {
        if (value === undefined) return element.innerHTML;
        element.innerHTML = value;
        if (selector === '#map') cells = Array.from(value.matchAll(/<td id="t\d+_\d+">/g), makeElement);
      },
      width: () => 240,
      height: () => 180,
      val(value) {
        if (value === undefined) return element.value;
        element.value = value;
      },
      attr() {},
    });
  }
  const replay = [];
  const context = vm.createContext({
    $,
    _: { debounce: (callback) => callback },
    document,
    console: { log() {} },
    window: { addEventListener() {} },
    location: { pathname: '/games/test' },
    navigator: { platform },
    io: { connect: () => socket },
    localStorage: {
      scale: '3',
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    hideSurrenderAlert() {},
    usernameEnsureColors() {},
    backTurn: () => replay.push('back'),
    nextTurn: () => replay.push('next'),
    switchAutoplay: () => replay.push('autoplay'),
  });
  for (const source of sources) source.runInContext(context);
  ready[2]();
  context.client_id = 'player';
  context.setMultiLineModeByCode(false);

  function start(options = {}) {
    handlers.get('init_map')({
      n: grid.length,
      m: grid[0].length,
      player_ids: ['player', 'enemy'],
      general: [0, 0],
      ...((options.multiLine ?? multiLine) ? { multi_line: true } : {}),
    });
    context.grid_type = grid.map((row) => row.slice());
    context.army_cnt = grid.map((row) => row.map((type) => (type < 200 ? 60 : 0)));
    context.army_cnt[1][1] = 1;
    context.isolated[2][2] = 1;
    context.fog[0][1] = 1;
    context.fog[0][2] = 1;
    context.general_order = ['0_0', '2_0'];
    context.render();
  }

  return {
    context,
    sent,
    storage,
    replay,
    start,
    update: (turn) =>
      handlers.get('update')({
        turn,
        is_diff: true,
        grid_type: [],
        army_cnt: [],
        leaderboard: [],
        kills: {},
      }),
    element: (selector) => elements.get(selector),
    key(key, options = {}) {
      let prevented = false;
      elements.get('body').events.keydown({
        key,
        preventDefault: () => {
          prevented = true;
        },
        ...options,
      });
      return prevented;
    },
    cell: (row, col) => context.cell_elems[row][col],
    click(row, col, shiftKey = false) {
      context.cell_elems[row][col].events.click({ shiftKey });
    },
    selection: () => structuredClone(context.getSelectedCells()),
    camera: () => ({ ...elements.get('#map').style }),
    panOffscreen() {
      Object.assign(elements.get('#map').style, { left: '-1000px', top: '-1000px' });
    },
    queue: () => structuredClone(context.route),
  };
}

test('live burst border is single-line only and does not affect the turn counter', () => {
  const client = createClient();
  for (const [multiLine, clientId] of [
    [false, 'player'],
    [true, 'player'],
    [true, 'spectator'],
  ]) {
    client.context.client_id = clientId;
    client.context.setMultiLineModeByCode(!multiLine);
    client.start({ multiLine });
    for (const [turn, label, alpha] of [
      [25, '回合 12.'],
      [26, '回合 13', '0.700'],
      [50, '回合 25', '0.028'],
      [51, '回合 25.'],
    ]) {
      client.update(turn);
      const map = client.element('#map');
      assert.equal(
        map.className.split(' ').includes('burst'),
        !multiLine && Boolean(alpha),
        `${clientId}, multi-line=${multiLine}, Tick ${turn}`,
      );
      if (!multiLine && alpha) assert.equal(map.style['--burst-alpha'], alpha);
      assert.equal(client.element('#turn-counter').innerHTML, label);
    }
  }
});

test('arrow keys cross any terrain, while WASD respects mountains and preserves split modes', () => {
  const client = createClient();
  client.start();
  client.panOffscreen();
  assert.equal(client.key('ArrowRight'), true);
  assert.deepEqual(client.selection(), [[0, 1]]);
  assert.equal(client.context.isCellVisible(0, 1), true);
  client.key('ArrowRight', { shiftKey: true });
  assert.deepEqual(client.selection(), [[0, 2]]);
  client.key('ArrowRight');
  assert.deepEqual(client.selection(), [[0, 3]]);
  client.key('ArrowUp');
  assert.deepEqual(client.selection(), [[0, 3]]);
  assert.deepEqual(client.queue(), []);
  assert.deepEqual(client.sent, []);

  client.click(0, 0);
  client.key('d');
  assert.deepEqual(client.selection(), [[0, 0]]);
  assert.deepEqual(client.sent, []);
  client.key('ArrowRight');
  client.key('d');
  assert.deepEqual(client.selection(), [[0, 2]]);
  assert.deepEqual(client.queue(), []);
  assert.deepEqual(client.sent, []);
  client.click(0, 0);
  client.key('z');
  client.key('s', { shiftKey: true });
  assert.equal(client.context.selt, 2);
  client.key('s');
  assert.equal(client.context.selt, 1);
  assert.deepEqual(
    client.queue().map(({ mode }) => mode),
    [0, 1],
  );
  client.click(0, 0);
  client.key('ArrowRight');
  client.key('d');
  assert.equal(client.sent.length, 2, 'a queued move must not allow an attack from a mountain');
});

test('slots 0, 9, 10 and 19 persist, overwrite and recall without issuing commands', () => {
  const client = createClient();
  client.start();
  for (const [number, digit, altKey] of [
    [0, '0', false],
    [9, '9', false],
    [10, '0', true],
    [19, '9', true],
  ]) {
    for (const row of [0, 2]) {
      client.click(row, 0);
      assert.equal(client.key(digit, { ctrlKey: true, altKey }), true);
      assert.deepEqual(JSON.parse(client.storage.get(storageKey))[number], [[row, 0]]);
    }
    client.click(0, 0);
    client.panOffscreen();
    assert.equal(client.key(digit, { altKey }), true);
    assert.deepEqual(client.selection(), [[2, 0]]);
    assert.equal(client.context.isCellVisible(2, 0), true);
  }
  assert.equal(client.key('3'), true);
  assert.deepEqual(client.selection(), [[2, 0]]);
  assert.deepEqual(client.sent, []);
  const reloaded = createClient({ storage: client.storage });
  reloaded.start();
  reloaded.key('9', { altKey: true });
  assert.deepEqual(reloaded.selection(), [[2, 0]]);

  const mac = createClient({ platform: 'MacIntel', multiLine: true });
  mac.start();
  assert.equal(mac.key('1', { ctrlKey: true }), false);
  assert.equal(mac.key('1', { metaKey: true }), true);
  mac.click(2, 0);
  assert.equal(mac.key('º', { metaKey: true, altKey: true, originalEvent: { code: 'Digit0' } }), true);
  assert.deepEqual(JSON.parse(mac.storage.get(storageKey)), { 1: [[0, 0]], 10: [[2, 0]] });
  mac.key('1');
  assert.deepEqual(mac.selection(), [[0, 0]]);
  assert.equal(mac.key('º', { altKey: true, code: 'Digit0' }), true);
  assert.deepEqual(mac.selection(), [[2, 0]]);
  assert.equal(mac.key('a', { metaKey: true }), true);
  assert.equal(mac.selection().length, 6);
  assert.deepEqual(mac.sent, []);
});

test('stored groups reject malformed coordinates and ignore cells outside the current map', () => {
  const storage = new Map([
    [
      storageKey,
      JSON.stringify({
        0: [[10, 0], [0, 3], ['1', 1], [-1, 0], [0, 3], null, [1, 1, 1], [2, 0.5]],
        1: [2, 0],
        2: [[8, 8]],
        3: '<img>',
        20: [[0, 0]],
      }),
    ],
  ]);
  const client = createClient({ storage, multiLine: true });
  client.start();
  client.key('0');
  assert.deepEqual(client.selection(), [[0, 3]]);
  assert.match(client.cell(0, 3).innerHTML, /class="control-group-label" title="0">0<\/span>/);
  assert.doesNotMatch(client.cell(0, 0).innerHTML, /control-group-label/);
  for (const digit of ['1', '2', '3']) client.key(digit);
  assert.deepEqual(client.selection(), [[0, 3]]);

  const broken = createClient({ storage: new Map([[storageKey, '{']]) });
  broken.start();
  broken.key('0');
  assert.deepEqual(broken.selection(), [[0, 0]]);
  broken.context.localStorage.setItem = () => {
    throw new Error('storage unavailable');
  };
  broken.key('9', { ctrlKey: true });
  broken.click(2, 0);
  broken.key('9');
  assert.deepEqual(broken.selection(), [[0, 0]]);
});

test('multi-line selection supports shift keys, all controllable cells and all crowns', () => {
  const client = createClient({ multiLine: true });
  client.start();
  client.key('ArrowRight', { shiftKey: true });
  client.key('ArrowRight', { shiftKey: true });
  client.click(1, 2, true);
  client.click(1, 2, true);
  assert.deepEqual(client.selection(), [
    [0, 2],
    [0, 1],
    [0, 0],
    [1, 2],
  ]);
  assert.match(client.cell(0, 1).className, /mountain.*selected-secondary/);
  assert.match(client.cell(0, 2).className, /fog selected$/);
  client.click(2, 0);
  assert.deepEqual(client.selection(), [[2, 0]]);
  assert.equal(client.key('a', { ctrlKey: true }), true);
  assert.deepEqual(client.selection(), [
    [2, 0],
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 3],
    [2, 3],
  ]);
  client.panOffscreen();
  assert.equal(client.key(' '), true);
  assert.deepEqual(client.selection(), [
    [0, 0],
    [2, 0],
  ]);
  assert.equal(client.context.isCellVisible(0, 0), true);
  assert.equal(client.context.isCellVisible(2, 0), true);
  assert.deepEqual(client.queue(), []);
  assert.deepEqual(client.sent, []);
  client.start({ multiLine: false });
  client.click(2, 3);
  client.panOffscreen();
  client.key(' ');
  assert.deepEqual(client.selection(), [[2, 0]]);
  assert.equal(client.context.isCellVisible(2, 0), true);
  const visibleCamera = client.camera();
  client.key(' ');
  assert.deepEqual(client.camera(), visibleCamera);
  client.context.setMultiLineModeByCode(true);
  client.key(' ');
  assert.deepEqual(
    client.selection(),
    [
      [0, 0],
      [2, 0],
    ],
    'mode falls back to the room tab on rebind',
  );
});

test('synchronous WASD queues valid origins once and advances or stops each cursor independently', () => {
  const client = createClient({ multiLine: true });
  client.start();
  client.click(0, 0);
  client.click(2, 0, true);
  client.key('z');
  assert.match(client.cell(0, 0).className, /selected50 selected-group-primary/);
  assert.match(client.cell(0, 0).innerHTML, /^60/);
  client.key('s', { shiftKey: true });
  assert.equal(client.context.selt, 2);
  assert.deepEqual(client.selection(), [
    [1, 0],
    [2, 0],
  ]);
  client.click(0, 0);
  client.click(1, 0, true);
  client.key('s');
  assert.deepEqual(
    client.sent.map(([name, { x, y, dx, dy, mode }]) => [name, x, y, dx, dy, mode]),
    [
      ['attack', 0, 0, 1, 0, 0],
      ['attack', 0, 0, 1, 0, 1],
      ['attack', 1, 0, 2, 0, 1],
    ],
  );
  assert.deepEqual(
    client.queue().map(({ seq }) => seq),
    [1, 2, 3],
  );
  assert.deepEqual(client.selection(), [
    [1, 0],
    [2, 0],
  ]);
  assert.equal(client.context.selt, 1);
  client.key('d');
  assert.deepEqual(client.selection(), [
    [1, 1],
    [2, 0],
  ]);
  assert.equal(client.sent.length, 4);
  client.click(0, 0);
  client.click(0, 1, true);
  client.key('d');
  assert.deepEqual(client.selection(), [
    [0, 0],
    [0, 2],
  ]);
  assert.equal(client.sent.length, 4);
  client.click(1, 0);
  client.click(2, 2, true);
  client.click(1, 4, true);
  client.key('a');
  assert.deepEqual(client.selection(), [
    [1, 0],
    [2, 2],
    [1, 3],
  ]);
  assert.equal(client.sent.length, 4);
  client.click(1, 0);
  client.click(1, 1, true);
  client.click(1, 2, true);
  client.key('a');
  assert.deepEqual(client.selection(), [
    [1, 0],
    [1, 1],
  ]);
  assert.equal(client.sent.length, 5);
  assert.deepEqual(structuredClone(client.sent[4]), ['attack', { x: 1, y: 1, dx: 1, dy: 0, mode: 2 }]);
});

test('ordered multi-cell groups restore a snapshot, render labels and degrade to one cell in single-line', () => {
  const client = createClient({ multiLine: true });
  client.start();
  client.key('ArrowRight', { shiftKey: true });
  client.key('9', { ctrlKey: true, altKey: true });
  client.click(2, 0, true);
  client.click(1, 3);
  assert.doesNotMatch(client.cell(2, 0).innerHTML, /control-group-label/);
  client.key('9', { altKey: true });
  assert.deepEqual(client.selection(), [
    [0, 1],
    [0, 0],
  ]);
  assert.match(client.cell(0, 1).className, /mountain.*\bselected\b.*has-control-group/);
  assert.match(client.cell(0, 0).className, /selected-secondary has-control-group/);
  for (const col of [0, 1])
    assert.match(client.cell(0, col).innerHTML, /class="control-group-label" title="19">19<\/span>/);
  client.click(2, 3);
  client.click(2, 0, true);
  client.key('9', { ctrlKey: true, altKey: true });
  assert.doesNotMatch(client.cell(0, 0).innerHTML, /control-group-label/);
  client.key('0', { ctrlKey: true });
  assert.match(client.cell(2, 3).innerHTML, /title="0·19">0·19<\/span>/);
  for (const scale of [1, 2]) {
    client.context.scale = scale;
    client.context.render();
    assert.match(client.cell(2, 3).innerHTML, /class="control-group-army".*60.*class="control-group-label"/);
  }
  client.start({ multiLine: false });
  client.key('9', { altKey: true });
  assert.deepEqual(client.selection(), [[2, 3]]);
  assert.doesNotMatch(client.cell(2, 0).className, /selected/);
  assert.deepEqual(client.sent, []);

  const css = read('static/styles/map.css');
  assert.match(css, /\.control-group-label\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*bottom:\s*0;/);
  assert.match(css, /\.has-control-group \.build-badge\s*\{[^}]*bottom:\s*auto;/);
});

test('chat, replay and pre-game inputs keep their own keyboard handling', () => {
  const client = createClient({ multiLine: true });
  const keys = [
    ['ArrowRight', { shiftKey: true }],
    ['a', { ctrlKey: true }],
    ['9', { ctrlKey: true }],
    ['9', {}],
    ['0', { altKey: true }],
    [' ', {}],
    ['d', {}],
    ['z', {}],
  ];
  for (const [key, options] of keys) assert.equal(client.key(key, options), false);
  client.start();
  client.key('9', { ctrlKey: true });
  client.click(2, 0);
  client.context.chat_focus = true;
  for (const [key, options] of keys) assert.equal(client.key(key, options), false);
  client.context.chat_focus = false;
  const chatInput = { matches: (selector) => selector.includes('input') };
  for (const [key, options] of keys) assert.equal(client.key(key, { ...options, target: chatInput }), false);
  assert.deepEqual(client.selection(), [[2, 0]]);
  assert.deepEqual(JSON.parse(client.storage.get(storageKey)), { 9: [[0, 0]] });
  assert.equal(client.context.selt, 1);

  client.context.is_replay = true;
  client.context.render();
  assert.doesNotMatch(client.cell(0, 0).innerHTML, /control-group-label/);
  for (const [key, options] of keys) client.key(key, options);
  client.key('ArrowLeft');
  client.key(' ', { target: chatInput });
  assert.deepEqual(client.replay, ['next', 'autoplay', 'next', 'back']);
  assert.deepEqual(client.selection(), [[2, 0]]);
  assert.deepEqual(client.queue(), []);
  assert.deepEqual(client.sent, []);
});

test('built text tutorial matches its Pug source and documents the new bindings', async () => {
  const inputPath = fileURLToPath(new URL('../views/tutorial-text.pug', import.meta.url));
  const filepath = fileURLToPath(new URL('../static/tutorial-text.html', import.meta.url));
  const html = read('static/tutorial-text.html');
  const generated = await format(pug.renderFile(inputPath, { pretty: false }), {
    ...(await resolveConfig(filepath)),
    parser: 'html',
    filepath,
  });
  assert.ok(html === generated, 'run the page build to sync the text tutorial');
  for (const phrase of [
    '方向键只移动光标',
    '数字编队 0–19',
    'Command+Option+数字',
    'Shift+点击',
    'Command+A',
    '多线选中所有己方主城',
  ]) {
    assert.ok(html.includes(phrase), `text tutorial is missing ${phrase}`);
  }
  assert.doesNotMatch(html, /方向键推兵/);
});
