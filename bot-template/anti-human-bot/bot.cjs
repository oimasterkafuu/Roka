'use strict';
const { io } = require('socket.io-client');
const { attachBot } = require('./bot/client.cjs');
const fs = require('node:fs');
const path = require('node:path');
const parameterFile = process.env.BOT_PARAMS || path.join(__dirname, 'bot', 'champion.json');
const { DEFAULT_PARAMS, PARAM_RANGES } = require('./bot/params.cjs');
let params = { ...DEFAULT_PARAMS };
if (process.env.BOT_PARAMS && !fs.existsSync(parameterFile)) throw new Error('BOT_PARAMS 指定文件不存在');
if (fs.existsSync(parameterFile)) {
  const config = JSON.parse(fs.readFileSync(parameterFile, 'utf8'));
  if (!config.params || typeof config.params !== 'object' || Array.isArray(config.params)) throw new Error('参数文件缺少 params 对象');
  for (const [key,value] of Object.entries(config.params)) {
    if (!PARAM_RANGES[key] || !Number.isFinite(value) || value < PARAM_RANGES[key][0] || value > PARAM_RANGES[key][1]) throw new Error(`参数无效: ${key}`);
    params[key] = value;
  }
}
const digest = require('node:crypto').createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0,12);
console.log(`[策略] 参数版本=${digest} 来源=${fs.existsSync(parameterFile) ? parameterFile : '默认'} 参数=${JSON.stringify(params)}`);
const token = process.env.BOT_TOKEN;
if (!token) throw new Error('请通过 BOT_TOKEN 环境变量提供鉴权令牌');
const socket = io(process.env.BOT_SERVER || 'https://roka.oim.moe:444/', {
  autoConnect: false, transports: ['websocket', 'polling'], auth: { token }, reconnection: true,
});
const bot = attachBot(socket, {
  roomName: process.argv.find((a) => a.startsWith('--room='))?.slice(7) || process.env.BOT_ROOM || 'bot',
  params,
  log: (message) => console.log(`${new Date().toISOString()} ${message}`),
});
function shutdown() { bot.close(); socket.disconnect(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
socket.connect();
