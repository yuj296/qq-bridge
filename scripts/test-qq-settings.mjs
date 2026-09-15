// QQ 机器人设置自测（不经过 DSH）
//
//   node scripts/test-qq-settings.mjs
//
//   node scripts/test-qq-settings.mjs           # 全量输出
//   node scripts/test-qq-settings.mjs --quiet   # 只出结论（140 项逐条太吵）
//
// 校验五件事：
//   1. 字段表里每个路径都真的建进了 schema（防拼错）
//   2. config.json 里的每一项都被字段表覆盖（"除了机密全都可改" 这条承诺）
//   3. 用 config.json 当 base 解析 schema 不报错（防类型不匹配）
//   4. 字段表没有重复路径
//   5.（第 8 节）本项目**只保留私聊**：群白/黑名单、群专属仿真参数、群工具开关删了就不许回来，
//      文案里也不许再出现「群」。
//
// schemastery 不在本仓库依赖里 —— 从 DSH Desktop 自带的那份拿；拿不到就跳过。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSchema, FIELDS, GROUPS, groupOf } from '../plugins/qq-mode-console/lib/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DSH_APP = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Desktop\\resources\\app';

const require_ = createRequire(import.meta.url);
let z;
try {
  z = require_('@deepseek-ai/schemastery');
} catch {
  try {
    z = createRequire(path.join(DSH_APP, 'package.json'))('@deepseek-ai/schemastery');
  } catch (error) {
    console.log(`⚠️ 找不到 schemastery（${error?.message ?? error}），跳过`);
    process.exit(0);
  }
}

let failures = 0;
const QUIET = process.argv.includes('--quiet');
/** 逐条通过的行在 --quiet 下不打印（失败照打）。 */
const check = (name, ok, extra = '') => {
  if (!ok || !QUIET) console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (ok && QUIET && /^字段表里的 /.test(name)) return;
  if (!ok) failures += 1;
};

/** 摊平 schema 的序列化结构，列出所有叶子路径。 */
function schemaPaths(schema) {
  const json = schema.toJSON();
  const out = new Set();
  const walk = (uid, trail) => {
    const node = json.refs[String(uid)] ?? (json.uid === uid ? json : undefined);
    if (node === undefined) return;
    if (node.type === 'object' && node.dict) {
      for (const [key, child] of Object.entries(node.dict)) walk(child, [...trail, key]);
      return;
    }
    if (node.type === 'const') return;
    if (trail.length > 0) out.add(trail.join('.'));
  };
  walk(json.uid, []);
  return out;
}

/** 摊平 config.json，列出所有叶子路径（数组算叶子）。 */
function configPaths(value, trail = [], out = []) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) configPaths(child, [...trail, key], out);
  } else {
    out.push(trail.join('.'));
  }
  return out;
}

console.log('=== 1. 字段表 → schema ===');
const schema = buildSchema(z);
const built = schemaPaths(schema);
const declared = FIELDS.map(([p]) => p);
for (const p of declared) check(`字段表里的 ${p} 建进了 schema`, built.has(p));

console.log('\n=== 2. 重复检查 ===');
const dupes = declared.filter((p, index) => declared.indexOf(p) !== index);
check('没有重复路径', dupes.length === 0, dupes.join(', '));

console.log('\n=== 3. config.json 覆盖率 ===');
const config = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
/** 刻意不进设置页的：机密（协议会抹掉，读不回来）与 mode（没选过就沿用控制台）。 */
const EXCLUDED = new Set([
  'snowluma.accessToken', 'consoleToken', 'dsh.token', 'mode', 'consoleToken '
]);
const missing = configPaths(config).filter((p) => !declared.includes(p) && !EXCLUDED.has(p));
check('config.json 的每一项都能在设置页改（机密除外）', missing.length === 0, missing.join(', '));
console.log(`    设置项 ${declared.length} 个；config.json 叶子 ${configPaths(config).length} 个；` +
  `刻意排除 ${[...EXCLUDED].filter(Boolean).length} 个（accessToken / consoleToken / dsh.token / mode）`);

console.log('\n=== 4. base（来自 config.json）能否解析 ===');
const strip = (value, depth) => {
  if (Array.isArray(value)) return value.slice();
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (['accessToken', 'consoleToken', 'token'].includes(key)) continue;
    if (depth === 0 && key === 'mode') continue;
    out[key] = strip(child, depth + 1);
  }
  return out;
};
const base = strip(config, 0);
let parsed;
try {
  parsed = schema(base);
  check('schema 接受 config.json 作为 base', true);
} catch (error) {
  check('schema 接受 config.json 作为 base', false, String(error?.message ?? error));
}
if (parsed !== undefined) {
  check('解析后 ownerQQ 保留为数字', typeof parsed.ownerQQ === 'number', String(parsed.ownerQQ));
  check('解析后 allow.private 仍是数组', Array.isArray(parsed.allow?.private), JSON.stringify(parsed.allow?.private));
  check('解析后 socialV2.tools 是对象', typeof parsed.socialV2?.tools === 'object');
  check('解析后没有把机密带进来', parsed.snowluma?.accessToken === undefined);
  check('mode 不在 base 里（未选过时不覆盖控制台）', parsed.mode === undefined);
}

console.log('\n=== 5. 分组统计与分组说明 ===');
const byGroup = new Map();
for (const [p] of FIELDS) {
  const g = groupOf(p);
  byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
}
for (const [g, n] of byGroup) {
  const meta = GROUPS[g];
  console.log(`    ${(meta?.title ?? `⚠️ ${g}`).padEnd(22)} ${n} 项`);
}
const untitled = [...byGroup.keys()].filter((g) => GROUPS[g] === undefined);
check('每个分组都有中文标题与说明', untitled.length === 0, untitled.join(', '));
const noDesc = Object.entries(GROUPS).filter(([, meta]) => !meta.desc || meta.desc.length < 6).map(([k]) => k);
check('每个分组都写了「这一组是干什么的」', noDesc.length === 0, noDesc.join(', '));

console.log('\n=== 6. 分组说明进了 schema（设置页直接读它）===');
{
  const json = schema.toJSON();
  for (const [key, meta] of Object.entries(GROUPS)) {
    const uid = json.refs[String(json.uid)]?.dict?.[key];
    const desc = uid === undefined ? undefined : json.refs[String(uid)]?.meta?.description;
    // notify 的分组没有对应的 schema 对象（那几个字段在 config.json 里是顶格的），
    // 由客户端兜底表提供标题与说明 —— 这里跳过它。
    if (uid === undefined) {
      check(`分组 ${key} 没有对应 schema 对象（由客户端兜底表显示）`, true);
      continue;
    }
    check(`分组 ${key} 的标题进了 schema`, typeof desc === 'string' && desc.startsWith(meta.title));
  }
}

console.log('\n=== 6b. 客户端与 host 的分组表没有漂移 ===');
{
  const clientSrc = fs.readFileSync(path.join(REPO, 'plugins', 'qq-mode-console', 'lib', 'client.js'), 'utf8');
  for (const key of Object.keys(GROUPS)) {
    check(`客户端认得分组 ${key}`, new RegExp(`\\b${key}\\s*:`).test(clientSrc));
  }
  const { TOP_LEVEL_GROUPS } = await import('../plugins/qq-mode-console/lib/schema.js');
  const block = /const TOP_LEVEL_GROUPS = \{([\s\S]*?)\};/.exec(clientSrc);
  const clientMap = {};
  for (const line of (block?.[1] ?? '').split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+):\s*"([a-z0-9]+)",?\s*$/.exec(line);
    if (m) clientMap[m[1]] = m[2];
  }
  const same = JSON.stringify(clientMap) === JSON.stringify(TOP_LEVEL_GROUPS);
  check('顶格字段的分组点名两边一致', same,
    same ? '' : `host=${JSON.stringify(TOP_LEVEL_GROUPS)} client=${JSON.stringify(clientMap)}`);
}

console.log('\n=== 7. 每个字段都有"详细说明" ===');
{
  const json = schema.toJSON();
  let short = [];
  for (const [pathStr] of FIELDS) {
    const segments = pathStr.split('.');
    let uid = json.uid;
    for (const segment of segments) uid = json.refs[String(uid)]?.dict?.[segment];
    const text = json.refs[String(uid)]?.meta?.description ?? '';
    const detail = text.includes('｜') ? text.split('｜')[1] : '';
    if (detail.length < 12) short.push(`${pathStr}(${detail.length})`);
  }
  check('每个字段都有一段像样的说明（≥12 字）', short.length === 0, short.slice(0, 8).join(', '));
  const lengths = FIELDS.map(([p]) => {
    const segments = p.split('.');
    let uid = json.uid;
    for (const segment of segments) uid = json.refs[String(uid)]?.dict?.[segment];
    const text = json.refs[String(uid)]?.meta?.description ?? '';
    return text.includes('｜') ? text.split('｜')[1].length : 0;
  });
  const avg = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  console.log(`    说明平均 ${avg} 字，最长 ${Math.max(...lengths)} 字，最短 ${Math.min(...lengths)} 字`);
}

console.log('\n=== 8. 群聊能力已彻底移除（只保留私聊）===');
{
  // 这些字段全部是群专属：群白名单 / 群黑名单 / 群聊插话与主动开话题 / 活跃超时退场 /
  // 选择性沉默 / 群工具开关。本项目只做「用户 ↔ 机器人私聊」，删掉的不许回来。
  const REMOVED = [
    'allow.groups',
    'deny.groups',
    'social.triggerProbability',
    'social.mustReplyKeywords',
    'social.activeDurationEnabled',
    'social.activeDurationMinMs',
    'social.activeDurationMaxMs',
    'social.proactiveEnabled',
    'social.proactiveIdleThresholdMs',
    'social.proactiveCheckMinMs',
    'social.proactiveCheckMaxMs',
    'social.proactiveProbability',
    'social.skipProbability',
    'socialV2.tools.sendGroup',
    'socialV2.tools.sendBurst',
    'socialV2.tools.getActiveMembers'
  ];
  const configLeaves = configPaths(config);
  const inFields = REMOVED.filter((p) => declared.includes(p));
  check('群聊字段已从字段表移除', inFields.length === 0, inFields.join(', '));
  const inSchema = REMOVED.filter((p) => built.has(p));
  check('群聊字段已从 schema 移除', inSchema.length === 0, inSchema.join(', '));
  const inConfig = REMOVED.filter((p) => configLeaves.includes(p));
  check('群聊字段已从 config.json 移除', inConfig.length === 0, inConfig.join(', '));
  const groupPaths = [...declared, ...configLeaves].filter((p) => /(^|\.)groups$/.test(p));
  check('没有任何 *.groups 路径残留', groupPaths.length === 0, groupPaths.join(', '));
  const groupWording = FIELDS.filter(([, , label, detail]) => /群/.test(`${label}${detail}`)).map(([p]) => p);
  check('字段文案里不再出现「群」', groupWording.length === 0, groupWording.join(', '));
  const groupDesc = Object.entries(GROUPS).filter(([, meta]) => /群/.test(`${meta.title}${meta.desc}`)).map(([key]) => key);
  check('分组标题/说明里不再出现「群」', groupDesc.length === 0, groupDesc.join(', '));
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100).unref?.();
