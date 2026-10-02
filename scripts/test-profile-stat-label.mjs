import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profileHtml = fs.readFileSync(path.join(rootDir, 'static/profile.html'), 'utf8');
const profileJs = fs.readFileSync(path.join(rootDir, 'static/profile.js'), 'utf8');

const check = (label, condition) => {
  assert.ok(condition, label);
  console.log(`  ok - ${label}`);
};

check('上方 p-level 标签显示对局数', /id="p-level">-<\/div>\s*<div class="profile-stat-label">对局数<\/div>/.test(profileHtml));
check('p-level 绑定 profile API 的 ratingGames', /\$\('#p-level'\)\.text\(p\.ratingGames\);/.test(profileJs));
check('p-level-label 继续绑定积分等级', /\$\('#p-level-label'\)\.text\(p\.level && p\.level\.level \? p\.level\.level : 1\);/.test(profileJs));
check('积分等级卡片仍存在', /class="points-level-card"[\s\S]*id="p-level-label"[\s\S]*id="p-level-progress"[\s\S]*id="p-level-next"/.test(profileHtml));

console.log('\n个人主页统计标签测试通过');
