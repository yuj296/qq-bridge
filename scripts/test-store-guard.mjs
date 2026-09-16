// 回归：本地库文件的「读不出来」与「库是空的」必须区分开。
//
//   node scripts/test-store-guard.mjs
//
// 背景（2026-09-16 审计实测复现）：`loadStickerStore` / `loadSlang` 过去把「文件损坏」和「库为空」
// 都返回 `[]`，而 `saveStickerStoreSafe()` / `saveSlangStore()` 会把内存里的空列表原子写回 ——
// `state/stickers.json` 一旦被写坏，收藏表情的备注/标签/使用次数就被**无声清零**。
// 现在读失败返回 `ok:false`，调用方进入只读降级（拒绝写回 + 记警告）。
//
// 本测试同时断言"读失败语义"和"调用方真的用了它"（后者是源码断言：光有 API 而调用方不理会，
// 等于没修）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStickerStore, loadStickerStore } from '../src/sticker-lib.js';
import { readSlangStore, loadSlang } from '../src/slang-learner.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmrf(p);
    else { try { fs.unlinkSync(p); } catch {} }
  }
  try { fs.rmdirSync(dir, { recursive: true }); } catch {}
}

console.log('=== 1. 表情库：读失败与空库必须可区分 ===');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-guard-'));
try {
  const missing = readStickerStore(path.join(dir, 'nope.json'));
  check('文件不存在 → 全新库（ok=true, missing=true）',
    missing.ok === true && missing.missing === true && missing.entries.length === 0, JSON.stringify(missing));

  const brokenPath = path.join(dir, 'broken.json');
  fs.writeFileSync(brokenPath, '{ 这不是合法的 JSON', 'utf8');
  const broken = readStickerStore(brokenPath);
  check('内容损坏 → ok=false（**不许当成空库**）', broken.ok === false && broken.missing === false, JSON.stringify(broken));
  check('损坏时给出原因（可写进日志）', typeof broken.reason === 'string' && broken.reason.length > 4, broken.reason);

  const notArrayPath = path.join(dir, 'object.json');
  fs.writeFileSync(notArrayPath, '{"entries":[]}', 'utf8');
  check('内容是对象而不是数组 → ok=false', readStickerStore(notArrayPath).ok === false);

  const emptyPath = path.join(dir, 'empty.json');
  fs.writeFileSync(emptyPath, '', 'utf8');
  check('空文件 → 全新库（不是损坏）', readStickerStore(emptyPath).ok === true);

  const goodPath = path.join(dir, 'good.json');
  fs.writeFileSync(goodPath, JSON.stringify([{ id: 'abc', localNote: '好图', tags: ['难绷'] }]), 'utf8');
  const good = readStickerStore(goodPath);
  check('正常文件 → 读出条目', good.ok === true && good.entries.length === 1 && good.entries[0].localNote === '好图', JSON.stringify(good.entries[0] ?? {}));

  check('兼容层 loadStickerStore 仍返回数组', Array.isArray(loadStickerStore(goodPath)) && Array.isArray(loadStickerStore(brokenPath)));

  console.log('\n=== 2. 黑话库：同款语义 ===');
  const slangBroken = path.join(dir, 'slang-broken.json');
  fs.writeFileSync(slangBroken, 'not json at all', 'utf8');
  check('黑话库损坏 → ok=false', readSlangStore(slangBroken).ok === false);
  check('黑话库不存在 → 全新库', readSlangStore(path.join(dir, 'slang-nope.json')).ok === true);
  check('兼容层 loadSlang 仍返回数组', Array.isArray(loadSlang(slangBroken)));

  console.log('\n=== 3. 调用方真的用了「读失败」标志（源码断言）===');
  const bridgeSrc = fs.readFileSync(path.join(REPO, 'src', 'bridge.js'), 'utf8');
  check('表情库：读失败时记警告', /表情库读取失败，本次运行不会写回它/.test(bridgeSrc));
  check('表情库：保存前检查只读降级', /if \(!stickerStoreWritable\)/.test(bridgeSrc));
  check('黑话库：读失败时记警告', /黑话库读取失败，本次运行不会写回它/.test(bridgeSrc));
  check('黑话库：保存前检查只读降级', /if \(!slangStoreWritable\)/.test(bridgeSrc));
  check('降级只提示一次（不刷屏）', /stickerStoreSkipLogged/.test(bridgeSrc) && /slangStoreSkipLogged/.test(bridgeSrc));
} finally {
  rmrf(dir);
}

console.log(failures === 0 ? '\n✅ 本地库读失败已与空库区分，损坏时不会写回' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
