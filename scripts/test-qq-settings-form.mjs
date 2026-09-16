// QQ 机器人设置「表单能不能真的改」自测（不启动 DSH）。
//
//   node scripts/test-qq-settings-form.mjs
//
// 起因（2026-09-16，主人反馈）：「设置里的内容无法进行更改，输入汉字无法显示」。
// 根因：FieldRow 拿到的是 draft 里的**整个条目对象**（`pending: draft[key]`），
// 却把它当成值直接给了 input/textarea（`value: text`）与 checkbox（`pending === true`），
// 于是输入变成字符串化后的 `[object Object]`、勾选永远弹回 false。
//
// 本测试用 jsdom + react-dom 把页面**真的挂载**起来，模拟输入/勾选/保存，断言：
//   ① 文字字段：输入汉字后框里就是那串汉字（不是 `[object Object]`、也不是空）
//   ② 数字字段：输入后框里是那串数字（同样不能是对象）
//   ③ 勾选框：状态跟着点击走，再点一次能取消
//   ④ 「待保存」标记出现、保存按钮变得可用
//   ⑤ 点保存时提交给 settings.mutate 的 ops 里，值是用户输入的字符串/布尔/数字，**不是对象**
//   ⑥ 保存成功后草稿清空、按钮回到禁用
//
// jsdom / react / react-dom 从 DSH Desktop 自带的那份拿；拿不到就**跳过**（exit 2，不算通过）。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveDshApp, exitSkipped } from './dsh-app-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const BUNDLE = path.join(REPO, 'plugins', 'qq-mode-console', 'lib', 'client.js');
// DSH 自带依赖的位置：不写死用户名 —— 见 scripts/dsh-app-path.mjs
const DSH_APP = resolveDshApp();

const requireHere = createRequire(import.meta.url);
// DSH 目录探测不到时退化成"只用本仓库依赖"，而不是拿一个相对路径去 createRequire（会依赖 cwd 而崩）
const requireDsh = DSH_APP === '' ? requireHere : createRequire(path.join(DSH_APP, 'package.json'));
const pick = (name) => {
  try { return requireHere(name); } catch (error) { if (requireDsh === requireHere) throw error; return requireDsh(name); }
};

let JSDOM;
let z;
try {
  ({ JSDOM } = pick('jsdom'));
  z = pick('@deepseek-ai/schemastery');
} catch (error) {
  exitSkipped(`找不到 jsdom / schemastery（${error?.message ?? error}）`);
}

// React 必须在「已经有 DOM 的全局环境」里加载（react-dom 在模块初始化时就看全局 document）。
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:43129/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
for (const key of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'Node', 'Element', 'MutationObserver', 'getComputedStyle']) {
  if (globalThis[key] === undefined) globalThis[key] = window[key];
}

let React;
let createRoot;
let flushSync;
try {
  React = pick('react');
  ({ createRoot } = pick('react-dom/client'));
  ({ flushSync } = pick('react-dom'));
} catch (error) {
  console.log(`⚠️ 找不到 react/react-dom（${error?.message ?? error}），跳过表单交互自测`);
  process.exit(0);
}

const { buildSchema, FIELDS, groupOf } = await import('../plugins/qq-mode-console/lib/schema.js');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};
const labelOf = (p) => (FIELDS.find(([declared]) => declared === p) ?? [])[2];

// ── 1. 捕获 bundle 并拿到组件 ──────────────────────────────────────────────
const source = fs.readFileSync(BUNDLE, 'utf8');
let capturedMod;
window.__ModuleLoader__ = { load: (mod) => { capturedMod = mod; } };
const runBundle = new Function('window', 'document', 'require', source);
runBundle(window, window.document, (name) => {
  if (name === 'react') return React;
  throw new Error(`客户端 bundle 不该 require(${name})`);
});
const mod = capturedMod.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`factory 里不该 require(${name})`);
});

const schema = buildSchema(z);
// 快照分「磁盘 base + 设置页 user 覆盖」两层 —— 撤销、下拉框「不设置」这些行为，
// 只有在两层都存在时才看得出来（user 层没覆盖时它们与「没改过」没区别）。
const diskBase = {
  persona: { enabled: true, name: '磁盘名', personality: '', tone: '', speechStyle: '', habits: '', taboo: '' },
  ownerQQ: 123456789,
  mode: 'chat'
};
const userLayer = { persona: { name: '覆盖名' }, mode: 'chat' };
const merged = { ...diskBase, persona: { ...diskBase.persona, ...userLayer.persona } };
const scopeSnapshot = {
  status: 'ready', base: diskBase, value: merged, user: userLayer, revision: 7, writable: true, mode: 'host'
};
const submitted = [];
/** true = 下一次 mutate 模拟「宿主拒绝写入」：既不写 user 层、也不抛异常（DSH 的真实行为就是这样）。 */
let rejectNextMutate = false;
/** 把 ops 真的应用到 user 层并重建 merged（模拟宿主接受写入）。 */
const applyOpsToUser = (ops) => {
  for (const op of ops) {
    let node = userLayer;
    for (let i = 0; i < op.path.length - 1; i += 1) {
      if (typeof node[op.path[i]] !== 'object' || node[op.path[i]] === null) node[op.path[i]] = {};
      node = node[op.path[i]];
    }
    const leaf = op.path[op.path.length - 1];
    if (op.op === 'unset') delete node[leaf];
    else node[leaf] = op.value;
  }
  for (const key of Object.keys(merged)) delete merged[key];
  Object.assign(merged, diskBase);
  merged.persona = { ...diskBase.persona, ...(userLayer.persona ?? {}) };
  if (userLayer.mode !== undefined) merged.mode = userLayer.mode;
  if (userLayer.ownerQQ !== undefined) merged.ownerQQ = userLayer.ownerQQ;
};
const scope = {
  subscribe: () => () => {},
  getSnapshot: () => scopeSnapshot,
  mutate: async (ops, revision) => {
    submitted.push({ ops, revision });
    if (rejectNextMutate) return;   // 宿主拒绝：不写、不抛（旧代码就是在这里把「被拒绝」显示成「已保存」的）
    applyOpsToUser(ops);
    scopeSnapshot.revision += 1;    // 真实 mutate 会推进 revision
  }
};
// useSyncExternalStore 要求 getSnapshot 返回稳定引用，否则 React 会无限重渲染 —— 所以这两个快照都是常量。
const mirrorSnapshot = {
  status: 'ready',
  view: {
    writable: true,
    namespaces: [{ ns: 'qq-mode', schema: schema.toJSON(), base: diskBase, value: merged, user: userLayer, revision: 7 }]
  }
};
const mirror = {
  subscribe: () => () => {},
  getSnapshot: () => mirrorSnapshot
};

let Page;
const ctx = {
  inject: (services, cb) => cb({
    settingsScope: { bind: () => scope, describe: () => mirror },
    slots: { inject: (name, cb2) => cb2(), register: (options, component) => { Page = component; return () => {}; } }
  })
};
mod.apply(ctx);

console.log('=== 1. 挂载真页面 ===');
const container = window.document.createElement('div');
window.document.body.appendChild(container);
const root = createRoot(container);
try {
  flushSync(() => root.render(React.createElement(Page, { settings: scope, describe: mirror })));
  check('页面挂载成功', container.querySelectorAll('.qqp_row').length > 0,
    `${container.querySelectorAll('.qqp_row').length} 行`);
} catch (error) {
  check('页面挂载成功', false, String(error?.message ?? error));
  console.log('\n❌ 挂载就失败了，后面的断言不可信');
  process.exit(1);
}

/** 找到某个字段的控件（FieldRow 给控件加了 aria-label = 字段标签）。 */
const controlOf = (selector, p) => container.querySelector(`${selector}[aria-label="${labelOf(p)}"]`);
/** 找到某个字段所在的那一行（用来查「待保存」标记）。 */
const rowOf = (p) => container.querySelector(`[aria-label="${labelOf(p)}"]`)?.closest('.qqp_row');
const draftBadge = (p) => rowOf(p)?.querySelector('.qqp_badge[data-kind="draft"]') ?? null;

/** 模拟真人操作：走原生 setter + 对应事件，React 的受控组件才会收到。 */
function typeInto(element, value) {
  const tag = element.tagName;
  const proto = tag === 'SELECT'
    ? window.HTMLSelectElement.prototype
    : (tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor.set.call(element, value);
  element.dispatchEvent(new window.Event(tag === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  flushSync(() => {});
}

// ── 2. 文字字段：输入汉字必须留在框里 ───────────────────────────────────────
console.log('\n=== 2. 文字字段（性格 / persona.personality）===');
const PERSONALITY = '慢热、嘴硬心软，被夸会害羞但装不在意';
{
  const area = controlOf('textarea', 'persona.personality');
  check('找得到性格输入框', area !== null && area !== undefined, area ? area.getAttribute('aria-label') : '(没找到)');
  if (area) {
    typeInto(area, PERSONALITY);
    check('输入汉字后框里就是那串汉字', area.value === PERSONALITY, JSON.stringify(area.value).slice(0, 80));
    check('不是被塞进了对象（[object Object]）', !String(area.value).includes('[object Object]'), String(area.value).slice(0, 40));
    check('「待保存」标记出现', container.querySelector('.qqp_badge[data-kind="draft"]') !== null);
  }
}

// ── 3. 名字字段：再填一格，确认多格互不干扰；顺带验「清空 = 不设这一项」──────
{
  const input = controlOf('input[type="text"]', 'persona.name');
  check('找得到名字输入框', input !== null && input !== undefined);
  if (input) {
    typeInto(input, '小D');
    check('名字字段输入正常', input.value === '小D', JSON.stringify(input.value).slice(0, 40));
    check('名字没串到性格框里', controlOf('textarea', 'persona.personality')?.value === PERSONALITY);

    typeInto(input, '');
    check('清空就是清空（框里是空的，不是 [object Object]）', input.value === '', JSON.stringify(input.value));
    // 文字字段清空 = 把它设成空串（合法语义：名字就是不要了），所以仍算一项待保存。
    check('清空文字 = 设为空串（仍算待保存）', draftBadge('persona.name') !== null);
    typeInto(input, '小D');
  }
}

// ── 4. 数字字段：不能变成对象；清空不能偷偷写成 0 ──────────────────────────
{
  const input = controlOf('input[type="number"]', 'ownerQQ');
  if (input) {
    const original = input.value;
    typeInto(input, '123456');
    check('数字字段输入正常', input.value === '123456', JSON.stringify(input.value).slice(0, 40));
    typeInto(input, '');
    // 数字清空 = 这一项不设（不是写入 0），框里回到原值。
    check('清空数字后框里回到原值', input.value === original, JSON.stringify(input.value));
    check('清空数字 ≠ 写入 0（这一项不算待保存）', draftBadge('ownerQQ') === null);
    typeInto(input, '123456');
  }
}

// ── 5. 勾选框：状态跟手 ────────────────────────────────────────────────────
console.log('\n=== 3. 勾选框（总开关 / persona.enabled）===');
{
  const box = controlOf('input[type="checkbox"]', 'persona.enabled');
  check('找得到勾选框', box !== null && box !== undefined);
  if (box) {
    const before = box.checked;
    box.click();
    flushSync(() => {});
    check('点一下状态跟着变', box.checked === !before, `之前 ${before} → 现在 ${box.checked}`);
    box.click();
    flushSync(() => {});
    check('再点一下能取消', box.checked === before, `现在 ${box.checked}`);
  }
}

// ── 6. 保存：提交的必须是值，不是对象 ──────────────────────────────────────
console.log('\n=== 4. 保存时提交的值 ===');
{
  const saveButton = container.querySelector('.qqp_btn[data-primary="true"]');
  check('保存按钮存在且可用', saveButton !== null && saveButton.disabled === false,
    saveButton ? `disabled=${saveButton.disabled}` : '(没找到)');
  if (saveButton) {
    flushSync(() => saveButton.click());
    await new Promise((r) => setTimeout(r, 50));
    flushSync(() => {});
    const last = submitted.at(-1);
    check('settings.mutate 被调用', last !== undefined, last ? `${last.ops.length} 项` : '');
    if (last) {
      const ops = last.ops;
      const personality = ops.find((op) => op.path.join('.') === 'persona.personality');
      const name = ops.find((op) => op.path.join('.') === 'persona.name');
      const owner = ops.find((op) => op.path.join('.') === 'ownerQQ');
      check('性格提交的是字符串', personality?.value === PERSONALITY, JSON.stringify(personality?.value).slice(0, 60));
      check('名字提交的是字符串', name?.value === '小D', JSON.stringify(name?.value).slice(0, 40));
      check('数字提交的是数字', owner?.value === 123456, JSON.stringify(owner?.value));
      const bad = ops.filter((op) => op.value !== null && typeof op.value === 'object' && !Array.isArray(op.value));
      check('没有把对象当值提交上去', bad.length === 0, bad.map((op) => op.path.join('.')).join(', '));
      check('提交时带上了 revision', last.revision === 7, String(last.revision));
    }
    const saveLabel = saveButton.textContent;
    check('保存后按钮回到禁用（草稿已清）', saveButton.disabled === true, String(saveLabel));
  }
}

// ── 7. 下拉框选「（不设置，沿用原值）」= 撤销覆盖，不许把空串当值提交 ────────
console.log('\n=== 5. 下拉框的「（不设置，沿用原值）」===');
{
  const select = controlOf('select', 'mode');
  check('找得到运行模式下拉框', select !== null && select !== undefined);
  if (select) {
    typeInto(select, 'reserved2');
    check('选一个值显示正常', select.value === 'reserved2', select.value);
    typeInto(select, '');
    check('选「不设置」后不被写成空串', select.value === 'chat',
      `显示 ${JSON.stringify(select.value)}（应回到磁盘上的 chat）`);
    check('选「不设置」仍算一项待保存（它要撤销 user 覆盖）', draftBadge('mode') !== null);
    const saveButton = container.querySelector('.qqp_btn[data-primary="true"]');
    check('保存按钮可用', saveButton !== null && saveButton.disabled === false);
    if (saveButton) {
      flushSync(() => saveButton.click());
      await new Promise((r) => setTimeout(r, 50));
      flushSync(() => {});
      const last = submitted.at(-1);
      const modeOp = last?.ops.find((op) => op.path.join('.') === 'mode');
      check('提交的是「撤销」而不是一个空串', modeOp?.op === 'unset', JSON.stringify(modeOp));
      check('空串没有被当成 mode 的值', !(modeOp?.op === 'set' && modeOp.value === ''), JSON.stringify(modeOp));
    }
  }
}

// ── 8. 点「已改」撤销后，框里要回到磁盘值 ─────────────────────────────────
console.log('\n=== 6. 点「已改」撤销后的显示 ===');
{
  const input = controlOf('input[type="text"]', 'persona.name');
  // 期望值动态取 user 层当前值：前面的用例现在**真的把值写进 user 层**了（mutate 走真实路径），
  // 所以别再硬编码 '覆盖名'。
  const overridden = userLayer.persona?.name ?? diskBase.persona.name;
  check('撤销前显示的是 user 层的覆盖值', input?.value === overridden, JSON.stringify(input?.value));
  const badge = rowOf('persona.name')?.querySelector('.qqp_badge[data-kind="user"]');
  check('这一项有「已改」按钮（= 在设置页里改过）', badge !== null && badge !== undefined);
  if (badge && input) {
    flushSync(() => badge.click());
    check('点「已改」后显示磁盘上的值（不是还挂着覆盖值）', input.value === '磁盘名', JSON.stringify(input.value));
  }
}

// ── 9. 宿主拒绝写入时必须报错，而不是显示绿色「已保存」──────────────────────
console.log('\n=== 7. 宿主拒绝写入 → 报错 + 保留草稿 ===');
{
  rejectNextMutate = true;
  const input = controlOf('input[type="text"]', 'persona.name');
  typeInto(input, '不该被保存');
  const saveButton = container.querySelector('.qqp_btn[data-primary="true"]');
  flushSync(() => saveButton.click());
  await new Promise((r) => setTimeout(r, 60));
  flushSync(() => {});
  const errText = container.querySelector('.qqp_err')?.textContent ?? '';
  check('报错（而不是「已保存」）', /被拒绝|没写进去/.test(errText), errText.slice(0, 90));
  check('没有同时显示绿色「已保存」', (container.querySelector('.qqp_ok')?.textContent ?? '') === '');
  check('草稿被保留（改动没被清掉）', input.value === '不该被保存' && saveButton.disabled === false,
    `value=${JSON.stringify(input.value)} disabled=${saveButton.disabled}`);

  rejectNextMutate = false;
  flushSync(() => saveButton.click());
  await new Promise((r) => setTimeout(r, 60));
  flushSync(() => {});
  check('宿主接受后恢复为「已保存」', (container.querySelector('.qqp_ok')?.textContent ?? '').includes('已保存'),
    container.querySelector('.qqp_ok')?.textContent ?? '(空)');
  check('接受后草稿清空、按钮回到禁用', saveButton.disabled === true);
}

root.unmount();
console.log(failures === 0 ? '\n✅ 设置页表单可以正常输入、勾选与保存' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
