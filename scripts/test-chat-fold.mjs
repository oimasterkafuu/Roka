// 房间进出消息折叠（issue #113）自测：
// 1) 客户端折叠纯函数（static/main/core-globals.js 的 chatFoldAppend/chatFoldText，node vm 加载）；
// 2) 服务端 sendLobbySystemMessage 的 chat_message 负载携带可选 fold 字段（tsx 直跑 src）。
// 覆盖：同类连续合并、同名去重（issue #124）、加入/离开交错汇总、超过 3 人截断为「等 N 人」、
// 折叠链断开（非折叠系统消息/普通聊天）后重新起链、服务端 fold 负载形状。
// 运行：pnpm run test:chat-fold（无需构建）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LobbyService } from '../src/server/lobby-service.ts';

// ---------- 第一部分：客户端折叠纯函数 ----------
const sandbox = {
  $: () => ({ text() {}, html() {} }),
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../static/main/core-globals.js', import.meta.url), 'utf8'), sandbox);
const { chatFoldAppend } = sandbox;

const LEAVE = (name) => ({ name, verb: '离开了自定义房间。' });
const JOIN = (name) => ({ name, verb: '加入了自定义房间。' });

// 场景 1：单条离开不折叠，文案与原系统消息一致。
{
  const s = chatFoldAppend(null, LEAVE('Alice'));
  assert.equal(s.text, 'Alice 离开了自定义房间。');
  console.log('场景 1 通过：单条消息文案不变（' + s.text + '）');
}

// 场景 2：连续 3 条离开合并为一条。
{
  let s = chatFoldAppend(null, LEAVE('Alice'));
  s = chatFoldAppend(s, LEAVE('Bob'));
  s = chatFoldAppend(s, LEAVE('Carol'));
  assert.equal(s.text, 'Alice、Bob、Carol 离开了自定义房间。');
  console.log('场景 2 通过：同类连续合并（' + s.text + '）');
}

// 场景 3：加入与离开交错，降级为「进出」汇总。
{
  let s = chatFoldAppend(null, JOIN('Alice'));
  s = chatFoldAppend(s, LEAVE('Bob'));
  assert.equal(s.text, 'Alice、Bob 进出了房间。');
  console.log('场景 3 通过：交错进出汇总（' + s.text + '）');
}

// 场景 4：超过 3 人只列前 3 人 + 等 N 人（同类与混合各一）。
{
  let s = chatFoldAppend(null, LEAVE('Alice'));
  for (const n of ['Bob', 'Carol', 'Dave', 'Eve']) s = chatFoldAppend(s, LEAVE(n));
  assert.equal(s.text, 'Alice、Bob、Carol 等 5 人 离开了自定义房间。');
  let m = chatFoldAppend(null, JOIN('Alice'));
  for (const n of ['Bob', 'Carol', 'Dave']) m = chatFoldAppend(m, LEAVE(n));
  assert.equal(m.text, 'Alice、Bob、Carol 等 4 人 进出了房间。');
  console.log('场景 4 通过：超过 3 人截断（' + s.text + ' / ' + m.text + '）');
}

// 场景 5：链断开后回到首条语义（模拟中间插入普通聊天后重新起链）。
{
  let s = chatFoldAppend(null, LEAVE('Alice'));
  s = chatFoldAppend(s, LEAVE('Bob'));
  assert.equal(s.text, 'Alice、Bob 离开了自定义房间。');
  const fresh = chatFoldAppend(null, JOIN('Carol'));
  assert.equal(fresh.text, 'Carol 加入了自定义房间。');
  console.log('场景 5 通过：折叠链断开重起（' + s.text + ' → ' + fresh.text + '）');
}

// 场景 5.5：同一用户名重复进出只保留一次（issue #124），按首次出现顺序。
{
  let s = chatFoldAppend(null, LEAVE('Alice'));
  s = chatFoldAppend(s, LEAVE('Bob'));
  s = chatFoldAppend(s, LEAVE('Alice'));
  assert.equal(s.text, 'Alice、Bob 离开了自定义房间。');
  let m = chatFoldAppend(null, JOIN('Alice'));
  m = chatFoldAppend(m, JOIN('Alice'));
  m = chatFoldAppend(m, LEAVE('Alice'));
  assert.equal(m.text, 'Alice 进出了房间。');
  console.log('场景 5.5 通过：同名去重（' + s.text + ' / ' + m.text + '）');
}

// ---------- 第二部分：服务端负载 ----------
const service = new LobbyService({}, {});
const payloads = [];
const io = {
  sockets: { sockets: new Map() },
  to() {
    return {
      emit(event, payload) {
        if (event === 'chat_message') payloads.push(payload);
      },
    };
  },
  emit() {},
};

// 场景 6：进出类系统消息携带 fold，普通系统消息不带 fold。
service.sendLobbySystemMessage(io, 'room1', 'Alice 离开了自定义房间。', {
  name: 'Alice',
  verb: '离开了自定义房间。',
});
service.sendLobbySystemMessage(io, 'room1', '房间内全部为 AI 玩家，本局强制以 4x 速度进行。');
assert.equal(payloads.length, 2, '应发出两条 chat_message');
assert.deepEqual(payloads[0].fold, { name: 'Alice', verb: '离开了自定义房间。' });
assert.equal(payloads[0].text, 'Alice 离开了自定义房间。');
assert.equal(payloads[1].fold, undefined, '非进出类消息不应带 fold');
console.log('场景 6 通过：fold 负载仅随进出类消息下发');

console.log('\n全部 7 个场景通过：issue #113/#124 房间进出消息折叠与同名去重');
