// 兵力数字缩字档（issue #116）自测：
// 1) static/main/core-globals.js 的 armyCountShrinkClass 纯函数（node vm 加载）——
//    3 位/5 位/7 位/8+ 位的档位映射，≤4 位返回空串（默认字号不被放大）；
// 2) static/styles/map.css 解析校验——army-num-d5~d8 各档 em 系数 < 1（只缩不放大）
//    且随位数单调不增；
// 3) 用 @napi-rs/canvas 注册本地 Quicksand-Regular.otf 实测文本宽度：
//    对 s1~s6 每个尺寸档，5~8 位全「0」（最宽数字）按对应档位字号测量，
//    断言渲染宽度 ≤ 格子内容宽度（content-box + padding 0，边框在盒外）。
// 运行：pnpm run test:army-num-font（无需构建）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// ---------- 第一部分：档位映射纯函数 ----------
const sandbox = {
  $: () => ({ text() {}, html() {} }),
  console,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../static/main/core-globals.js', import.meta.url), 'utf8'), sandbox);
const { armyCountShrinkClass } = sandbox;

assert.equal(armyCountShrinkClass(1), '');
assert.equal(armyCountShrinkClass(3), '');
assert.equal(armyCountShrinkClass(4), '');
assert.equal(armyCountShrinkClass(5), 'army-num army-num-d5');
assert.equal(armyCountShrinkClass(6), 'army-num army-num-d6');
assert.equal(armyCountShrinkClass(7), 'army-num army-num-d7');
assert.equal(armyCountShrinkClass(8), 'army-num army-num-d8');
assert.equal(armyCountShrinkClass(9), 'army-num army-num-d8');
console.log('第一部分通过：位数 → 档位类映射（≤4 位不缩放，5/6/7/8+ 位各入档）');

// ---------- 第二部分：map.css 档位系数解析 ----------
const css = fs.readFileSync(new URL('../static/styles/map.css', import.meta.url), 'utf8');

// 各尺寸档格子边长与默认字号（s1 的字号在 .s1 .txt 上）。
const scales = [];
for (let s = 1; s <= 6; s++) {
  const block = css.match(new RegExp('\\.s' + s + ' \\{([^}]*)\\}'));
  assert.ok(block, '.s' + s + ' 规则缺失');
  const width = Number(block[1].match(/width:\s*(\d+)px/)[1]);
  let fontSize;
  if (s === 1) {
    const txt = css.match(/\.s1 \.txt \{([^}]*)\}/);
    fontSize = Number(txt[1].match(/font-size:\s*([\d.]+)px/)[1]);
  } else {
    fontSize = Number(block[1].match(/font-size:\s*([\d.]+)px/)[1]);
  }
  scales.push({ s, width, fontSize });
}

const tiers = {};
let prevFactor = Infinity;
for (const d of [5, 6, 7, 8]) {
  const rule = css.match(new RegExp('\\.army-num-d' + d + ' \\{([^}]*)\\}'));
  assert.ok(rule, '.army-num-d' + d + ' 规则缺失');
  const factor = Number(rule[1].match(/font-size:\s*([\d.]+)em/)[1]);
  assert.ok(factor < 1, 'd' + d + ' 系数必须 < 1（只缩不放大）');
  assert.ok(factor <= prevFactor, '系数须随位数单调不增');
  prevFactor = factor;
  tiers[d] = factor;
}
console.log('第二部分通过：各档 em 系数均 < 1 且单调不增', tiers);

// ---------- 第三部分：真实字体实测宽度 ----------
GlobalFonts.registerFromPath(
  new URL('../static/Quicksand-Regular.otf', import.meta.url).pathname,
  'Quicksand',
);
const ctx = createCanvas(1, 1).getContext('2d');

function factorFor(digits) {
  if (digits <= 4) return 1;
  if (digits >= 8) return tiers[8];
  return tiers[digits];
}

// #map td 为 content-box + padding 0：内容宽 = 格宽（边框在盒外）。
// 以最宽数字「0」铺满为 worst case：缩字档（5~8 位）必须在每个尺寸档完整放入；
// ≤4 位走默认字号（issue #116 要求默认不放大也不缩小，维持现状行为）。
for (const { s, width, fontSize } of scales) {
  for (let digits = 5; digits <= 8; digits++) {
    const size = fontSize * factorFor(digits);
    ctx.font = size + 'px Quicksand';
    const text = '0'.repeat(digits);
    const measured = ctx.measureText(text).width;
    assert.ok(
      measured <= width,
      `s${s} ${digits} 位：实测 ${measured.toFixed(1)}px > 内容宽 ${width}px（字号 ${size.toFixed(1)}px）`,
    );
  }
  const samples = [3, 5, 7].map((d) => {
    const size = fontSize * factorFor(d);
    ctx.font = size + 'px Quicksand';
    return `${d} 位@${size.toFixed(1)}px→${ctx.measureText('0'.repeat(d)).width.toFixed(1)}px`;
  });
  console.log(`  s${s}：格宽 ${width}px，5~8 位全「0」实测均放入（${samples.join('，')}）`);
}
console.log('第三部分通过：Quicksand 实测各尺寸档 5~8 位数字完整放入格内');
console.log('test-army-num-font 全部通过');
