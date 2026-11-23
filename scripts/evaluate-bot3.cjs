'use strict';

// Bot(3.0) acceptance harness. Reuses the relay evaluator so every seat sees
// the real engine frames and each opponent is loaded through its public
// hosted-bot entry point. Override any value through the environment:
//
//   SEEDS=bot3-baseline-1 TICKS=1000 node scripts/evaluate-bot3.cjs
//
// This wrapper only supplies the Bot(3.0) defaults. Lower-level options such
// as OPPONENTS, MAPS and MODES are documented in scripts/evaluate-relay.cjs.
process.env.RELAY_ENTRY ||= '../bot-template/bot-3.0/strategy';
process.env.SELF_ID ||= 'bot3';
process.env.OPPONENTS ||= 'apex,anti,v2,relay';
process.env.MAPS ||= 'random,maze,archipelago,mediterranean';
// Three bits are large/fog/multi. '0xx' keeps the official 1v1 small map.
process.env.MODES ||= '000,001,010,011';
process.env.TICKS ||= '1000';

require('./evaluate-relay.cjs');
