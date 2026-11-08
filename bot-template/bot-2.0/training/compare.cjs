'use strict';

// Paired A/B comparison for long-eval reports.
//
// Runs `training/long-eval.cjs` inside two checkouts with identical arguments
// (or reads two existing reports) and compares the two runs match by match.
// Pairing key: (mode, mapSize, seed, swap, opponent, fog).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const PAIR_FIELDS = ['mode', 'mapSize', 'seed', 'swap', 'opponent', 'fog'];

// Evaluation flags forwarded verbatim to long-eval.cjs.
const EVAL_FLAGS = [
  'seeds',
  'offset',
  'prefix',
  'turns',
  'workers',
  'modes',
  'sizes',
  'profile',
  'opponents',
  'fog',
  'seat',
  'decision-ms',
];

// Small, safe suite used when the caller passes no evaluation flags at all.
const DEFAULT_EVAL_ARGS = [
  '--seeds',
  '1',
  '--turns',
  '120',
  '--workers',
  '1',
  '--modes',
  'random',
  '--sizes',
  '0.5',
];

const MAX_WORKERS = 2;
const DEFAULT_ITERATIONS = 2000;
const DEFAULT_BOOTSTRAP_SEED = 20240601;
const LARGE_SCALE_THRESHOLD = 0.68;

class CompareError extends Error {
  constructor(message, kind = 'invalid') {
    super(message);
    this.name = 'CompareError';
    this.kind = kind;
  }
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pairKey(row) {
  return [
    String(row.mode),
    String(Number(row.mapSize)),
    String(row.seed),
    truthy(row.swap) ? '1' : '0',
    String(row.opponent),
    truthy(row.fog) ? '1' : '0',
  ].join('|');
}

function pairLabel(row) {
  return `${row.mode} size=${Number(row.mapSize)} seed=${row.seed} seat=${truthy(row.swap) ? 1 : 0} opponent=${row.opponent} fog=${truthy(row.fog) ? 1 : 0}`;
}

/**
 * Classify one result row.
 * win  -> ownWon === true (no error)
 * draw -> match hit the tick limit without a decision (no error)
 * loss -> anything else, including rows that carry an error
 */
function classify(row) {
  if (row.error) return 'error';
  if (row.ownWon === true) return 'win';
  if (row.ended === false) return 'draw';
  return 'loss';
}

// +1 win / 0 draw / -1 loss (errors count as losses).
function scoreOf(row) {
  const kind = classify(row);
  return kind === 'win' ? 1 : kind === 'draw' ? 0 : -1;
}

function emptyTotals() {
  return { matches: 0, wins: 0, draws: 0, losses: 0, effectiveLosses: 0, errors: 0, score: 0 };
}

function addKind(totals, kind) {
  totals.matches += 1;
  totals.score += kind === 'win' ? 1 : kind === 'draw' ? 0 : -1;
  if (kind === 'win') totals.wins += 1;
  else if (kind === 'draw') {
    totals.draws += 1;
    totals.effectiveLosses += 1;
  } else {
    totals.losses += 1;
    totals.effectiveLosses += 1;
    if (kind === 'error') totals.errors += 1;
  }
}

function addRow(totals, row) {
  addKind(totals, classify(row));
}

function finalizeTotals(totals) {
  const matches = totals.matches || 0;
  const rate = (value) => (matches ? value / matches : 0);
  return {
    matches,
    wins: totals.wins,
    draws: totals.draws,
    losses: totals.losses,
    effectiveLosses: totals.effectiveLosses,
    errors: totals.errors,
    winRate: rate(totals.wins),
    // Half credit for a draw, useful when a draw is "not a loss" for the
    // purpose of a specific question.
    halfDrawWinRate: rate(totals.wins + 0.5 * totals.draws),
    drawRate: rate(totals.draws),
    effectiveLossRate: rate(totals.effectiveLosses),
    meanScore: matches ? totals.score / matches : 0,
  };
}

function aggregateRows(rows) {
  const totals = emptyTotals();
  for (const row of rows) addRow(totals, row);
  return finalizeTotals(totals);
}

function deltaOf(baseline, candidate) {
  return {
    wins: candidate.wins - baseline.wins,
    draws: candidate.draws - baseline.draws,
    losses: candidate.losses - baseline.losses,
    effectiveLosses: candidate.effectiveLosses - baseline.effectiveLosses,
    winRate: candidate.winRate - baseline.winRate,
    halfDrawWinRate: candidate.halfDrawWinRate - baseline.halfDrawWinRate,
    drawRate: candidate.drawRate - baseline.drawRate,
    effectiveLossRate: candidate.effectiveLossRate - baseline.effectiveLossRate,
    meanScore: candidate.meanScore - baseline.meanScore,
  };
}

// mulberry32: tiny deterministic PRNG, no dependencies.
function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function interval(sorted) {
  if (!sorted.length) return null;
  return { low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
}

/**
 * Paired bootstrap over matched pairs: resample pairs with replacement and
 * recompute every delta so the pairing is preserved. Same seed always yields
 * the same interval.
 */
function bootstrapPairs(pairs, options = {}) {
  const iterations = Math.max(0, Math.trunc(Number(options.iterations ?? DEFAULT_ITERATIONS)) || 0);
  const seed = Math.trunc(Number(options.seed ?? DEFAULT_BOOTSTRAP_SEED)) >>> 0;
  const size = pairs.length;
  if (!iterations || !size) {
    return {
      iterations: 0,
      seed,
      samples: size,
      meanDelta: null,
      ci95: null,
      winRateDiffCi95: null,
      drawRateDiffCi95: null,
      effectiveLossDiffCi95: null,
      includesZero: null,
    };
  }
  const random = createRandom(seed);
  const scoreMeans = [];
  const winDiffs = [];
  const drawDiffs = [];
  const lossDiffs = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let score = 0;
    let candidateWins = 0;
    let baselineWins = 0;
    let candidateDraws = 0;
    let baselineDraws = 0;
    let candidateLosses = 0;
    let baselineLosses = 0;
    for (let draw = 0; draw < size; draw += 1) {
      const pair = pairs[Math.floor(random() * size)];
      score += pair.delta;
      if (pair.candidate.kind === 'win') candidateWins += 1;
      if (pair.baseline.kind === 'win') baselineWins += 1;
      if (pair.candidate.kind === 'draw') candidateDraws += 1;
      if (pair.baseline.kind === 'draw') baselineDraws += 1;
      if (pair.candidate.kind !== 'win' && pair.candidate.kind !== 'draw') candidateLosses += 1;
      if (pair.baseline.kind !== 'win' && pair.baseline.kind !== 'draw') baselineLosses += 1;
    }
    scoreMeans.push(score / size);
    winDiffs.push((candidateWins - baselineWins) / size);
    drawDiffs.push((candidateDraws - baselineDraws) / size);
    lossDiffs.push((candidateLosses - baselineLosses) / size);
  }
  const sortedScores = [...scoreMeans].sort((a, b) => a - b);
  const ci95 = interval(sortedScores);
  return {
    iterations,
    seed,
    samples: size,
    meanDelta: scoreMeans.reduce((total, value) => total + value, 0) / scoreMeans.length,
    ci95,
    winRateDiffCi95: interval([...winDiffs].sort((a, b) => a - b)),
    drawRateDiffCi95: interval([...drawDiffs].sort((a, b) => a - b)),
    effectiveLossDiffCi95: interval([...lossDiffs].sort((a, b) => a - b)),
    includesZero: ci95 ? ci95.low <= 0 && ci95.high >= 0 : null,
  };
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizeSettings(settings = {}) {
  return {
    seeds: numberOrNull(settings.seeds),
    turns: numberOrNull(settings.turns),
    modes: normalizeList(settings.modes).sort(),
    sizes: normalizeList(settings.sizes)
      .map(Number)
      .sort((a, b) => a - b),
    opponents: normalizeList(settings.opponents).sort(),
    seats: (Array.isArray(settings.seats) ? settings.seats : [])
      .map(truthy)
      .sort((a, b) => Number(a) - Number(b)),
    fogs: (Array.isArray(settings.fogs) ? settings.fogs : [])
      .map(truthy)
      .sort((a, b) => Number(a) - Number(b)),
  };
}

const REQUIRED_SETTINGS = ['seeds', 'turns', 'modes', 'sizes', 'opponents', 'seats', 'fogs'];

function compareSettings(baselineSettings, candidateSettings) {
  const baseline = normalizeSettings(baselineSettings);
  const candidate = normalizeSettings(candidateSettings);
  const mismatches = [];
  for (const field of REQUIRED_SETTINGS) {
    const left = baseline[field];
    const right = candidate[field];
    if (JSON.stringify(left) !== JSON.stringify(right))
      mismatches.push({ field, baseline: left, candidate: right });
  }
  const informational = [];
  for (const field of ['seedPrefix', 'seedOffset', 'profile']) {
    const left = baselineSettings?.[field] ?? null;
    const right = candidateSettings?.[field] ?? null;
    if (JSON.stringify(left) !== JSON.stringify(right))
      informational.push({ field, baseline: left, candidate: right });
  }
  return { baseline, candidate, mismatches, informational, compatible: mismatches.length === 0 };
}

function indexRows(rows, label) {
  const index = new Map();
  const duplicates = [];
  for (const row of rows) {
    const key = pairKey(row);
    if (index.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key);
      continue;
    }
    index.set(key, row);
  }
  return { index, duplicates: duplicates.map((key) => ({ side: label, key })) };
}

function describeRow(row) {
  const kind = classify(row);
  return {
    kind,
    score: scoreOf(row),
    ownWon: row.ownWon === true,
    ended: row.ended !== false,
    turns: numberOrNull(row.turns),
    winner: row.winner ?? null,
    error: row.error ? String(row.error).slice(0, 500) : null,
  };
}

function buildPairs(baselineRows, candidateRows) {
  const baseline = indexRows(baselineRows, 'baseline');
  const candidate = indexRows(candidateRows, 'candidate');
  const duplicates = [...baseline.duplicates, ...candidate.duplicates];
  const pairs = [];
  const missing = [];
  for (const [key, row] of baseline.index) {
    const other = candidate.index.get(key);
    if (!other) {
      missing.push({ side: 'candidate', key, label: pairLabel(row) });
      continue;
    }
    const baselineEntry = describeRow(row);
    const candidateEntry = describeRow(other);
    const deltaCounts = { win: 0, draw: 0, loss: 0 };
    deltaCounts[candidateEntry.kind === 'error' ? 'loss' : candidateEntry.kind] += 1;
    pairs.push({
      key,
      label: pairLabel(row),
      mode: String(row.mode),
      mapSize: Number(row.mapSize),
      seed: String(row.seed),
      swap: truthy(row.swap),
      opponent: String(row.opponent),
      fog: truthy(row.fog),
      baseline: baselineEntry,
      candidate: candidateEntry,
      delta: candidateEntry.score - baselineEntry.score,
      deltaCounts,
      changed: candidateEntry.kind !== baselineEntry.kind,
    });
  }
  for (const [key, row] of candidate.index) {
    if (baseline.index.has(key)) continue;
    missing.push({ side: 'baseline', key, label: pairLabel(row) });
  }
  return { pairs, duplicates, missing };
}

function groupPairs(pairs, keyOf) {
  const groups = new Map();
  for (const pair of pairs) {
    const key = keyOf(pair);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pair);
  }
  return groups;
}

function summarizePairs(pairs, bootstrap) {
  const baselineTotals = emptyTotals();
  const candidateTotals = emptyTotals();
  const deltaCounts = new Map();
  for (const pair of pairs) {
    addKind(baselineTotals, pair.baseline.kind);
    addKind(candidateTotals, pair.candidate.kind);
    deltaCounts.set(pair.delta, (deltaCounts.get(pair.delta) ?? 0) + 1);
  }
  const baseline = finalizeTotals(baselineTotals);
  const candidate = finalizeTotals(candidateTotals);
  return {
    pairs: pairs.length,
    baseline,
    candidate,
    delta: deltaOf(baseline, candidate),
    deltaDistribution: [...deltaCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([delta, count]) => ({ delta, pairs: count })),
    bootstrap: bootstrap ?? bootstrapPairs(pairs),
  };
}

function breakdown(pairs, keyOf, iterations, seed) {
  const result = {};
  for (const [key, group] of groupPairs(pairs, keyOf)) {
    const summary = summarizePairs(
      group,
      group.length > 1 ? bootstrapPairs(group, { iterations, seed }) : null,
    );
    result[key] = summary;
  }
  return result;
}

/**
 * Compare two long-eval report objects.
 * Never mutates the inputs.
 */
function compareReports(baselineDoc, candidateDoc, options = {}) {
  if (!baselineDoc || typeof baselineDoc !== 'object')
    throw new CompareError('baseline report is not an object');
  if (!candidateDoc || typeof candidateDoc !== 'object')
    throw new CompareError('candidate report is not an object');
  if (!Array.isArray(baselineDoc.results)) throw new CompareError('baseline report has no results[] array');
  if (!Array.isArray(candidateDoc.results)) throw new CompareError('candidate report has no results[] array');

  const iterations = Math.max(0, Math.trunc(Number(options.iterations ?? DEFAULT_ITERATIONS)) || 0);
  const seed = Math.trunc(Number(options.seed ?? DEFAULT_BOOTSTRAP_SEED)) >>> 0;
  const allowMissing = Boolean(options.allowMissing);

  const settings = compareSettings(baselineDoc.settings, candidateDoc.settings);
  const { pairs, duplicates, missing } = buildPairs(baselineDoc.results, candidateDoc.results);

  if (duplicates.length)
    throw new CompareError(
      `duplicate pair keys: ${duplicates
        .slice(0, 5)
        .map((entry) => `${entry.side}:${entry.key}`)
        .join(', ')}${duplicates.length > 5 ? ` (+${duplicates.length - 5} more)` : ''}`,
      'duplicate',
    );

  const issues = [];
  if (!settings.compatible) {
    for (const mismatch of settings.mismatches)
      issues.push({
        kind: 'incompatible',
        field: mismatch.field,
        message: `settings.${mismatch.field} differs: baseline=${JSON.stringify(mismatch.baseline)} candidate=${JSON.stringify(mismatch.candidate)}`,
      });
  }
  for (const entry of missing)
    issues.push({
      kind: 'missing',
      field: entry.side,
      message: `pair only present in ${entry.side === 'baseline' ? 'candidate' : 'baseline'} report: ${entry.label}`,
    });

  const blocking = !settings.compatible || (missing.length > 0 && !allowMissing);
  const summary = summarizePairs(pairs, pairs.length ? bootstrapPairs(pairs, { iterations, seed }) : null);

  const changed = pairs
    .filter((pair) => pair.delta !== 0)
    .map((pair) => ({
      key: pair.key,
      label: pair.label,
      baseline: pair.baseline.kind,
      candidate: pair.candidate.kind,
      delta: pair.delta,
      baselineTurns: pair.baseline.turns,
      candidateTurns: pair.candidate.turns,
    }))
    .sort((a, b) => b.delta - a.delta || a.key.localeCompare(b.key));

  const errorPairs = pairs.filter(
    (pair) => pair.baseline.kind === 'error' || pair.candidate.kind === 'error',
  ).length;

  return {
    ok: !blocking,
    blocking,
    settings,
    coverage: {
      baselineRows: baselineDoc.results.length,
      candidateRows: candidateDoc.results.length,
      matched: pairs.length,
      missingCandidate: missing.filter((entry) => entry.side === 'candidate').length,
      missingBaseline: missing.filter((entry) => entry.side === 'baseline').length,
      duplicates: duplicates.length,
      errorPairs,
      allowMissing,
    },
    aggregate: summary,
    byMode: breakdown(pairs, (pair) => pair.mode, iterations, seed),
    byMapSize: breakdown(pairs, (pair) => String(pair.mapSize), iterations, seed),
    byScale: breakdown(
      pairs,
      (pair) => (pair.mapSize >= LARGE_SCALE_THRESHOLD ? 'large' : 'standard'),
      iterations,
      seed,
    ),
    bySeat: breakdown(pairs, (pair) => (pair.swap ? 'seat1' : 'seat0'), iterations, seed),
    byOpponent: breakdown(pairs, (pair) => pair.opponent, iterations, seed),
    byFog: breakdown(pairs, (pair) => (pair.fog ? 'fog' : 'no-fog'), iterations, seed),
    changed,
    missing,
    issues,
    pairs: options.includePairs === false ? undefined : pairs,
  };
}

function readReport(filename) {
  const resolved = path.resolve(filename);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new CompareError(`cannot read ${resolved}: ${error.message}`, 'io');
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CompareError(`invalid JSON in ${resolved}: ${error.message}`, 'io');
  }
}

function resolveOptions(values) {
  const evalArgs = [];
  const forwarded = {};
  for (const flag of EVAL_FLAGS) {
    if (values[flag] === undefined) continue;
    forwarded[flag] = values[flag];
    evalArgs.push(`--${flag}`, String(values[flag]));
  }
  const defaultsApplied = evalArgs.length === 0;
  if (defaultsApplied) evalArgs.push(...DEFAULT_EVAL_ARGS);

  const profile = forwarded.profile;
  if (profile !== undefined && String(profile) === 'large')
    throw new CompareError(
      '--profile large is not allowed in comparisons; compare a fixed small suite instead',
      'usage',
    );
  const workers = forwarded.workers === undefined ? null : Number(forwarded.workers);
  if (workers !== null && (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS))
    throw new CompareError(`--workers must be an integer in [1, ${MAX_WORKERS}] for comparisons`, 'usage');

  const iterations = values.iterations === undefined ? DEFAULT_ITERATIONS : Number(values.iterations);
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 100000)
    throw new CompareError('--iterations must be an integer in [0, 100000]', 'usage');
  const seed = values.seed === undefined ? DEFAULT_BOOTSTRAP_SEED : Number(values.seed);
  if (!Number.isInteger(seed) || seed < 0)
    throw new CompareError('--seed must be a non-negative integer', 'usage');

  return { evalArgs, defaultsApplied, forwarded, iterations, seed };
}

function resolveSide(label, dir, jsonFile, evalArgs, options) {
  if (jsonFile)
    return { label, source: 'report', path: path.resolve(jsonFile), report: readReport(jsonFile) };
  if (!dir) throw new CompareError(`--${label} or --${label}-json is required`, 'usage');
  const resolved = path.resolve(dir);
  const entry = path.join(resolved, 'training', 'long-eval.cjs');
  if (!fs.existsSync(entry))
    throw new CompareError(`${label} directory has no training/long-eval.cjs: ${resolved}`, 'usage');
  const output = path.join(options.tmpDir, `${label}.json`);
  const args = [entry, ...evalArgs, '--output', output];
  const result = spawnSync(process.execPath, args, {
    cwd: resolved,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw new CompareError(`${label} run failed to start: ${result.error.message}`, 'spawn');
  if (!fs.existsSync(output)) {
    const tail = String(result.stderr || '')
      .trim()
      .split('\n')
      .slice(-5)
      .join('\n');
    throw new CompareError(
      `${label} run exited ${result.status} without writing a report${tail ? `:\n${tail}` : ''}`,
      'spawn',
    );
  }
  return {
    label,
    source: 'run',
    dir: resolved,
    path: output,
    status: result.status,
    report: readReport(output),
  };
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const signed = (value, digits = 1, unit = '') => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}${unit}`;
const ciText = (ci) => (ci ? `[${signed(ci.low, 3)}, ${signed(ci.high, 3)}]` : 'n/a');

function formatGroupTable(title, groups, digits) {
  const lines = [title];
  for (const key of Object.keys(groups).sort()) {
    const group = groups[key];
    const delta = group.delta;
    lines.push(
      `  ${key.padEnd(14)} pairs=${String(group.pairs).padStart(3)}  ` +
        `win ${percent(group.baseline.winRate)} -> ${percent(group.candidate.winRate)} ` +
        `(${signed(delta.winRate * 100, 1, 'pp')})  ` +
        `draw ${percent(group.baseline.drawRate)} -> ${percent(group.candidate.drawRate)} ` +
        `(${signed(delta.drawRate * 100, 1, 'pp')})  ` +
        `effLoss ${percent(group.baseline.effectiveLossRate)} -> ${percent(group.candidate.effectiveLossRate)}  ` +
        `meanScore ${signed(delta.meanScore, digits)} CI ${ciText(group.bootstrap?.ci95)}`,
    );
  }
  return lines;
}

function formatSummary(result, meta = {}) {
  const lines = [];
  lines.push('Paired bot evaluation comparison');
  const side = (label, info) => {
    if (!info) return `  ${label}: n/a`;
    const where = info.source === 'run' ? info.dir : info.path;
    return `  ${label}: ${where} [${info.source}]`;
  };
  lines.push(side('baseline ', meta.baseline));
  lines.push(side('candidate', meta.candidate));
  if (meta.defaultsApplied) lines.push(`  evaluation: default small suite (${DEFAULT_EVAL_ARGS.join(' ')})`);
  else if (meta.evalArgs?.length) lines.push(`  evaluation: ${meta.evalArgs.join(' ')}`);
  lines.push('');

  const coverage = result.coverage;
  lines.push(
    `Pairs: ${coverage.matched} matched (baseline rows ${coverage.baselineRows}, candidate rows ${coverage.candidateRows}); ` +
      `missing baseline ${coverage.missingBaseline}, missing candidate ${coverage.missingCandidate}, ` +
      `duplicates ${coverage.duplicates}, error pairs ${coverage.errorPairs}`,
  );
  const settingsState = result.settings.compatible ? 'compatible' : 'INCOMPATIBLE';
  lines.push(`Settings: ${settingsState}`);
  for (const mismatch of result.settings.mismatches)
    lines.push(
      `  ! ${mismatch.field}: baseline=${JSON.stringify(mismatch.baseline)} candidate=${JSON.stringify(mismatch.candidate)}`,
    );
  for (const info of result.settings.informational)
    lines.push(
      `  ~ ${info.field}: baseline=${JSON.stringify(info.baseline)} candidate=${JSON.stringify(info.candidate)}`,
    );
  lines.push('');

  const aggregate = result.aggregate;
  const delta = aggregate.delta;
  const bootstrap = aggregate.bootstrap;
  lines.push('  metric                  baseline   candidate      delta');
  lines.push(
    `  win rate              ${percent(aggregate.baseline.winRate).padStart(8)}  ` +
      `${percent(aggregate.candidate.winRate).padStart(9)}  ${signed(delta.winRate * 100, 1, 'pp').padStart(9)}`,
  );
  lines.push(
    `  draw rate             ${percent(aggregate.baseline.drawRate).padStart(8)}  ` +
      `${percent(aggregate.candidate.drawRate).padStart(9)}  ${signed(delta.drawRate * 100, 1, 'pp').padStart(9)}`,
  );
  lines.push(
    `  effective loss rate   ${percent(aggregate.baseline.effectiveLossRate).padStart(8)}  ` +
      `${percent(aggregate.candidate.effectiveLossRate).padStart(9)}  ${signed(delta.effectiveLossRate * 100, 1, 'pp').padStart(9)}`,
  );
  lines.push(
    `  half-draw win rate    ${percent(aggregate.baseline.halfDrawWinRate).padStart(8)}  ` +
      `${percent(aggregate.candidate.halfDrawWinRate).padStart(9)}  ${signed(delta.halfDrawWinRate * 100, 1, 'pp').padStart(9)}`,
  );
  lines.push(
    `  mean pair score       ${aggregate.baseline.meanScore.toFixed(3).padStart(8)}  ` +
      `${aggregate.candidate.meanScore.toFixed(3).padStart(9)}  ${signed(delta.meanScore, 3).padStart(9)}`,
  );
  lines.push(
    `  wins/draws/losses     ${`${aggregate.baseline.wins}/${aggregate.baseline.draws}/${aggregate.baseline.losses}`.padStart(8)}  ` +
      `${`${aggregate.candidate.wins}/${aggregate.candidate.draws}/${aggregate.candidate.losses}`.padStart(9)}  ` +
      `${signed(delta.wins, 0).padStart(9)}`,
  );
  if (bootstrap)
    lines.push(
      `  bootstrap 95% CI (mean paired delta, ${bootstrap.iterations} iterations, seed ${bootstrap.seed}): ` +
        `${ciText(bootstrap.ci95)} ${bootstrap.includesZero ? '(includes 0)' : '(excludes 0)'}`,
    );
  lines.push('');

  if (Object.keys(result.byMode).length) lines.push(...formatGroupTable('By mode', result.byMode, 3));
  if (Object.keys(result.byMapSize).length)
    lines.push('', ...formatGroupTable('By map size', result.byMapSize, 3));
  if (Object.keys(result.byScale).length) lines.push('', ...formatGroupTable('By scale', result.byScale, 3));
  if (Object.keys(result.bySeat).length) lines.push('', ...formatGroupTable('By seat', result.bySeat, 3));
  if (Object.keys(result.byOpponent).length)
    lines.push('', ...formatGroupTable('By opponent', result.byOpponent, 3));
  if (Object.keys(result.byFog).length) lines.push('', ...formatGroupTable('By fog', result.byFog, 3));

  if (result.changed.length) {
    lines.push('', `Changed pairs (${result.changed.length})`);
    for (const entry of result.changed.slice(0, 40))
      lines.push(`  ${signed(entry.delta, 0)}  ${entry.baseline} -> ${entry.candidate}  ${entry.label}`);
    if (result.changed.length > 40)
      lines.push(`  ... ${result.changed.length - 40} more (see --output JSON)`);
  } else {
    lines.push('', 'Changed pairs: none');
  }

  if (result.issues.length) {
    lines.push('', `Issues (${result.issues.length})`);
    for (const issue of result.issues.slice(0, 20)) lines.push(`  [${issue.kind}] ${issue.message}`);
    if (result.issues.length > 20) lines.push(`  ... ${result.issues.length - 20} more`);
  }
  lines.push('', result.blocking ? 'Verdict: FAILED (incompatible or missing data)' : 'Verdict: OK');
  return `${lines.join('\n')}\n`;
}

function parseCli(args) {
  const evalOptions = Object.fromEntries(EVAL_FLAGS.map((flag) => [flag, { type: 'string' }]));
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      ...evalOptions,
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      'baseline-json': { type: 'string' },
      'candidate-json': { type: 'string' },
      output: { type: 'string', short: 'o' },
      iterations: { type: 'string' },
      seed: { type: 'string' },
      'allow-missing': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { values };
}

function help() {
  return `Usage: node training/compare.cjs --baseline <dir> --candidate <dir> [evaluation options]

Paired A/B comparison of two bot checkouts. Each side either runs
training/long-eval.cjs with identical arguments (--baseline/--candidate) or
reads an existing report (--baseline-json/--candidate-json). Matches are paired
by (mode, mapSize, seed, swap, opponent, fog); a pair scores +1 for a win, 0 for
a draw and -1 for a loss, and a seeded paired bootstrap reports a 95% CI.

Sources:
  --baseline DIR          Checkout containing training/long-eval.cjs
  --candidate DIR         Checkout containing training/long-eval.cjs
  --baseline-json FILE    Existing long-eval report (no matches are run)
  --candidate-json FILE   Existing long-eval report (no matches are run)

Evaluation options (identical for both sides):
  --seeds N --offset N --prefix TEXT --turns N --workers N (max ${MAX_WORKERS})
  --modes CSV --sizes CSV --profile NAME --opponents CSV --fog VALUE
  --seat 0|1|both --decision-ms N
  With none of these, a small default suite is used:
  ${DEFAULT_EVAL_ARGS.join(' ')}

Comparison options:
  -o, --output FILE       Write the comparison report as JSON
      --iterations N      Bootstrap iterations (default ${DEFAULT_ITERATIONS})
      --seed N            Bootstrap PRNG seed (default ${DEFAULT_BOOTSTRAP_SEED})
      --allow-missing     Tolerate unpaired rows instead of failing
  -q, --quiet             Suppress per-match progress from both runs
  -h, --help              Print this help

Exit code is non-zero when settings are incompatible, pair keys are duplicated,
or (without --allow-missing) rows cannot be paired.
`;
}

const HELP = help;

function main(argv = process.argv.slice(2)) {
  let values;
  try {
    values = parseCli(argv).values;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(HELP());
    return 0;
  }

  let tmpDir = null;
  try {
    const options = resolveOptions(values);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-compare-'));
    const runOptions = { tmpDir, quiet: Boolean(values.quiet) };
    const baseline = resolveSide(
      'baseline',
      values.baseline,
      values['baseline-json'],
      options.evalArgs,
      runOptions,
    );
    const candidate = resolveSide(
      'candidate',
      values.candidate,
      values['candidate-json'],
      options.evalArgs,
      runOptions,
    );

    const result = compareReports(baseline.report, candidate.report, {
      allowMissing: Boolean(values['allow-missing']),
      iterations: options.iterations,
      seed: options.seed,
    });

    const meta = {
      baseline: { source: baseline.source, dir: baseline.dir, path: baseline.path },
      candidate: { source: candidate.source, dir: candidate.dir, path: candidate.path },
      evalArgs: options.evalArgs,
      defaultsApplied: options.defaultsApplied && baseline.source === 'run',
    };

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      tool: 'bot-template/bot-2.0/training/compare.cjs',
      baseline: {
        ...meta.baseline,
        schemaVersion: baseline.report.schemaVersion ?? null,
        settings: baseline.report.settings ?? null,
      },
      candidate: {
        ...meta.candidate,
        schemaVersion: candidate.report.schemaVersion ?? null,
        settings: candidate.report.settings ?? null,
      },
      evaluation: {
        args: options.evalArgs,
        defaultsApplied: meta.defaultsApplied,
        forwarded: options.forwarded,
      },
      ...result,
    };

    process.stdout.write(formatSummary(result, meta));
    if (values.output) {
      const target = path.resolve(values.output);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
      process.stderr.write(`comparison report written to ${target}\n`);
    }
    return result.blocking ? 1 : 0;
  } catch (error) {
    process.stderr.write(`compare: ${error.message}\n`);
    return error instanceof CompareError && error.kind === 'usage' ? 2 : 1;
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  CompareError,
  PAIR_FIELDS,
  DEFAULT_EVAL_ARGS,
  DEFAULT_ITERATIONS,
  DEFAULT_BOOTSTRAP_SEED,
  MAX_WORKERS,
  aggregateRows,
  bootstrapPairs,
  buildPairs,
  classify,
  compareReports,
  compareSettings,
  createRandom,
  formatSummary,
  main,
  pairKey,
  pairLabel,
  parseCli,
  quantile,
  readReport,
  scoreOf,
};
