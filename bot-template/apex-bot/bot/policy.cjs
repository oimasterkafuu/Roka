'use strict';
const { createController } = require('./controller.cjs');
function createPolicy(playerId) { const controller = createController(playerId); const policy = (state) => controller.choose(state); policy.stats = () => controller.stats(); return policy; }
module.exports = { createPolicy };
