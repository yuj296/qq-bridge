// QQ 机器人设置「页面」自测（不启动 DSH）
//
//   node scripts/test-qq-settings-page.mjs
//
// 验的是浏览器半侧最容易写错的两件事：
//   1. 注册到哪个槽位、什么顺序 —— 必须是 settings.section / order=1（排在「通用设置」下面）
//   2. 拿真 schema 渲染出来的页面长什么样 —— 分组标题、分组说明、字段说明、行数对不对
//
// React / react-dom 从 DSH Desktop 自带的那份拿；拿不到就跳过。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const BUNDLE = path.join(REPO, 'plugins', 'qq-mode-console', 'lib', 'client.js');
const DSH_APP = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Desktop\\resources\\app';

const req = createRequire(path.join(DSH_APP, 'package.json'));
let React;
let ReactDOMServer;
let z;
try {
  React = req('react');
  ReactDOMServer = req('react-dom/server');
  z = req('@deepseek-ai/schemastery');
} catch (error) {
  console.log(`⚠️ 找不到 react/react-dom/schemastery（${error?.message ?? error}），跳过`);
  process.exit(0);
}

const { buildSchema, FIELDS, GROUPS, groupOf } = await import('../plugins/qq-mode-console/lib/schema.js');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

// ── 1. 加载 bundle，拿到 apply ──────────────────────────────────────────────
const source = fs.readFileSync(BUNDLE, 'utf8');
let captured;
globalThis.window = { __ModuleLoader__: { load: (mod) => { captured = mod; } } };
const factoryRun = new Function('window', 'document', 'require', source);
factoryRun(globalThis.window, undefined, (name) => {
  if (name === 'react') return React;
  throw new Error(`客户端 bundle 不该 require(${name})`);
});
check('bundle 调用了 window.__ModuleLoader__.load', captured !== undefined);
check('模块 id 是包名 qq-mode-console', captured?.id === 'qq-mode-console', String(captured?.id));
const mod = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`factory 里不该 require(${name})`);
});

// ── 2. 用假 ctx 跑 apply，看它注册到哪 ─────────────────────────────────────
const schema = buildSchema(z);
const descriptorRow = { ns: 'qq-mode', schema: schema.toJSON(), value: {}, base: {}, user: {}, applies: 'live', revision: 0 };
const scope = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 3, writable: true, mode: 'host' }),
  mutate: async () => {}
};
const mirror = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: 'ready', view: { writable: true, namespaces: [descriptorRow] } })
};

let registered;
const settingsCtx = {
  settingsScope: { bind: () => scope, describe: () => mirror },
  slots: {
    inject: (name, cb) => { cb(); },
    register: (options, component) => { registered = { options, component }; return () => {}; }
  }
};
const ctx = { inject: (services, cb) => { cb(settingsCtx); } };

try {
  mod.apply(ctx);
} catch (error) {
  check('apply 不抛异常', false, String(error?.message ?? error));
}

console.log('=== 1. 注册到哪个槽位 ===');
check('注册进 settings.section', registered?.options?.name === 'settings.section', String(registered?.options?.name));
check('分区 id = qq-bot', registered?.options?.id === 'qq-bot', String(registered?.options?.id));
check('order = 1（紧跟「通用设置」的 0，排在模型/插件之前）', registered?.options?.order === 1, String(registered?.options?.order));
check('导航标题是「QQ 机器人」', registered?.options?.label?.() === 'QQ 机器人', String(registered?.options?.label?.()));
check('导出了 apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject));
check('注册的是 React 组件', typeof registered?.component === 'function');

// ── 3. 用真 schema 渲染页面 ────────────────────────────────────────────────
console.log('\n=== 2. 渲染结果 ===');
let html = '';
try {
  html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(registered.component, { settings: scope, describe: mirror })
  );
  check('渲染不抛异常', true);
} catch (error) {
  check('渲染不抛异常', false, String(error?.message ?? error));
}

check('页面标题存在', html.includes('QQ 机器人设置'));
check('顶部说明写了生效方式', html.includes('每 5 秒') || html.includes('5 秒内生效'));
check('保存按钮存在', html.includes('保存'));
const sectionCount = (html.match(/class="qqp_sec"/g) ?? []).length;
check('分组数量与字段表一致', sectionCount === new Set(FIELDS.map(([p]) => groupOf(p))).size,
  `渲染 ${sectionCount} / 期望 ${new Set(FIELDS.map(([p]) => groupOf(p))).size}`);

// 分组标题与计数（每个分组标题下都会写「N 项」）
const counts = new Map();
for (const [p] of FIELDS) counts.set(groupOf(p), (counts.get(groupOf(p)) ?? 0) + 1);
let titleOk = true;
let countOk = true;
for (const [key, n] of counts) {
  if (!html.includes(GROUPS[key].title)) titleOk = false;
  if (!html.includes(`${n} 项`)) countOk = false;
}
check('每个分组的标题都渲染了', titleOk);
check('每个分组的项数都渲染了', countOk);

// 默认展开的分组里应当有字段行；social / socialV2 默认收起
// 注意别把 class="qqp_rowTop" 也算进去
const collapsedGroups = new Set(['social', 'socialV2']);
const expectedRows = [...counts.entries()]
  .filter(([key]) => !collapsedGroups.has(key))
  .reduce((sum, [, n]) => sum + n, 0);
const rows = (html.match(/class="qqp_row(?=[" ])/g) ?? []).length;
check('默认展开的分组渲染了字段行', rows === expectedRows,
  `渲染 ${rows} 行 / 期望 ${expectedRows} 行（收起 social + socialV2）`);
check('字段说明渲染进了页面（拿 ownerQQ 的说明验）', html.includes('只有这个号能批复权限'));

console.log('\n=== 3. 字段说明覆盖 ===');
{
  const json = schema.toJSON();
  const missing = [];
  for (const [p] of FIELDS) {
    const segments = p.split('.');
    let uid = json.uid;
    for (const segment of segments) uid = json.refs[String(uid)]?.dict?.[segment];
    const desc = json.refs[String(uid)]?.meta?.description ?? '';
    if (!desc.includes('｜')) missing.push(p);
  }
  check('每个字段都带「标签｜说明」两段', missing.length === 0, missing.slice(0, 6).join(', '));
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100).unref?.();
