'use strict';

const { io } = require('socket.io-client');
const { attachStrategy } = require('./strategy');
const { BOT_SERVER = 'http://127.0.0.1:23333', BOT_ROOM, BOT_TOKEN, BOT_TEAM = '1' } = process.env;
if (!BOT_ROOM || !BOT_TOKEN) throw new Error('BOT_ROOM and BOT_TOKEN are required');
const team = Number(BOT_TEAM);
if (!Number.isInteger(team) || team < 1 || team > 16) throw new Error('BOT_TEAM must be 1..16');
const socket = io(BOT_SERVER, { auth: { token: BOT_TOKEN }, autoConnect: false });
attachStrategy(socket, { room: BOT_ROOM, team, autoReady: process.env.BOT_AUTO_READY !== '0' });
socket.on('connect_error', (error) => console.error(error.message));
socket.connect();
