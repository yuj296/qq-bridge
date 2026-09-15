// 设置合并规则自测（纯逻辑，不启动 DSH / 桥接）
//
//   node scripts/test-settings-merge.mjs
//
// 这支配的就是「谁说了算」这件事，以及一个真实踩过的坑：
// 早期实现拿设置页解析出来的**整值**（base + user）覆盖 cfg，而 base 是 DSH 启动那一刻
// 的 config.json 快照 —— 于是运行期间由**桥接控制台**改的配置（白名单、黑话、社交参数）
// 会在 5 秒后被那个陈旧快照改回去，用户看到的是「控制台改了没用」。

import { mergeInto, leafPaths, restorePath, applyOverrides } from '../src/settings-merge.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};
const clone = (value) => structuredClone(value);

// 模拟一份运行中的 cfg（= 启动时从 config.json 载入的结果）
const baseCfg = () => ({
  ownerQQ: 111,
  notifyTaskDone: true,
  notifyTaskDoneMinTurnMs: 300000,
  allow: { private: [111], groups: [] },
  social: { triggerProbability: 0.1, burstEnabled: true },
  socialV2: { send: { maxSendPerMinute: 8 } }
});

console.log('=== 1. mergeInto：标量 / 嵌套 / 数组 ===');
{
  const cfg = baseCfg();
  const changed = mergeInto(cfg, { notifyTaskDone: false, social: { triggerProbability: 0.9 } });
  check('标量被覆盖', cfg.notifyTaskDone === false);
  check('嵌套字段被覆盖', cfg.social.triggerProbability === 0.9);
  check('同层未提到的字段不动', cfg.social.burstEnabled === true);
  check('未提到的顶层分支不动', cfg.notifyTaskDoneMinTurnMs === 300000);
  check('返回改动路径', changed.includes('notifyTaskDone') && changed.includes('social.triggerProbability'));
  check('值没变就不算改动', mergeInto(cfg, { notifyTaskDone: false }).length === 0);
}

console.log('\n=== 2. 数组整族替换（白名单不能被逐项合并）===');
{
  const cfg = baseCfg();
  mergeInto(cfg, { allow: { private: [111, 222] } });
  check('数组被整体替换', JSON.stringify(cfg.allow.private) === '[111,222]');
  mergeInto(cfg, { allow: { private: [] } });
  check('清空数组也生效（空数组是有效值）', JSON.stringify(cfg.allow.private) === '[]');
  check('空数组不会顺手把 groups 抹掉', Array.isArray(cfg.allow.groups));
}

console.log('\n=== 3. null / undefined 不当成「清空」 ===');
{
  const cfg = baseCfg();
  mergeInto(cfg, { notifyTaskDone: null, social: { triggerProbability: undefined } });
  check('null 被忽略', cfg.notifyTaskDone === true);
  check('undefined 被忽略', cfg.social.triggerProbability === 0.1);
}

console.log('\n=== 4. leafPaths ===');
{
  const paths = leafPaths({ a: 1, b: { c: 2, d: [1, 2] }, e: {} });
  check('摊平叶子路径', paths.has('a') && paths.has('b.c') && paths.has('b.d'), [...paths].join(', '));
  check('空对象不算叶子', !paths.has('e'));
}

console.log('\n=== 5. 只认 user 层：控制台改的东西不会被设置页快照改回去 ===');
{
  // 场景：DSH 启动时 config.json 里 allow.private=[111]（这就是 base 快照），
  // 之后用户在**桥接控制台**里把白名单加成了 [111,222]（cfg 与磁盘都变了）。
  const cfg = baseCfg();
  cfg.allow.private = [111, 222];
  const userLayer = {};                       // 用户没在设置页里改过白名单
  const result = applyOverrides({ target: cfg, user: userLayer, applied: new Set(), freshConfig: { allow: { private: [111] } } });
  check('用户没改过 → 一个字都不动', result.changed.length === 0);
  check('控制台加的白名单还在', JSON.stringify(cfg.allow.private) === '[111,222]');
}

console.log('\n=== 6. 用户改过的字段说了算 ===');
{
  const cfg = baseCfg();
  const userLayer = { allow: { private: [111, 222, 333] } };
  const result = applyOverrides({ target: cfg, user: userLayer, applied: new Set(), freshConfig: null });
  check('按 user 层覆盖', JSON.stringify(cfg.allow.private) === '[111,222,333]');
  check('applied 记住了这条路径', result.applied.has('allow.private'), [...result.applied].join(', '));
}

console.log('\n=== 7. 设置页里撤销 → 回到磁盘上的值（而不是卡在旧覆盖上）===');
{
  const cfg = baseCfg();
  // 上一轮用户把插话概率改成 0.9（已被施加）
  cfg.social.triggerProbability = 0.9;
  const applied = new Set(['social.triggerProbability']);
  // 这一轮用户在设置页里点了「已改」重置 → user 层空了；磁盘上还是 0.1
  const freshConfig = { social: { triggerProbability: 0.1 } };
  const result = applyOverrides({ target: cfg, user: {}, applied, freshConfig });
  check('识别出被撤销的路径', result.revoked.includes('social.triggerProbability'), JSON.stringify(result.revoked));
  check('值还原成 config.json 的 0.1', cfg.social.triggerProbability === 0.1);
  check('applied 里不再留着它', !result.applied.has('social.triggerProbability'));
}

console.log('\n=== 8. 撤销后磁盘上也没有这个键 → 删掉（真正回默认）===');
{
  const cfg = baseCfg();
  cfg.ackMessage = '在的';
  const applied = new Set(['ackMessage']);
  const result = applyOverrides({ target: cfg, user: {}, applied, freshConfig: { ownerQQ: 111 } });
  check('键被删掉', !('ackMessage' in cfg), JSON.stringify(cfg.ackMessage));
  check('识别为撤销', result.revoked.includes('ackMessage'));
}

console.log('\n=== 9. restorePath 的边界 ===');
{
  const cfg = { a: { b: 1 }, c: 2 };
  check('源里有 → 搬回来', restorePath(cfg, { a: { b: 9 } }, ['a', 'b']) === true && cfg.a.b === 9);
  check('值相同 → 不算变化', restorePath(cfg, { a: { b: 9 } }, ['a', 'b']) === false);
  check('路径不存在于 target → 不动（不报错）', restorePath(cfg, { x: 1 }, ['y', 'z']) === false);
  check('源里没有 → 删除', restorePath(cfg, { a: {} }, ['a', 'b']) === true && !('b' in cfg.a));
  check('空路径 → 不动', restorePath(cfg, {}, []) === false);
}

console.log('\n=== 10. 深拷贝：改 cfg 不会污染 user 层原对象 ===');
{
  const cfg = baseCfg();
  const userLayer = { allow: { private: [1, 2] } };
  applyOverrides({ target: cfg, user: userLayer, applied: new Set(), freshConfig: null });
  cfg.allow.private.push(3);
  check('user 层没被连带改动', JSON.stringify(userLayer.allow.private) === '[1,2]');
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100).unref?.();
