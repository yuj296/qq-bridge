// qq-wake 客户端半侧自测：用 jsdom 造一个仿 DSH 侧边栏，验证「唤醒」行
// 真的落在「技能中心」下面，点击会打宿主路由。
//
//   node scripts/test-wake-client.mjs
//
// jsdom 不是本仓库依赖，脚本会去 DSH Desktop 自带的那份拿；拿不到就**跳过**（exit 2，不算通过）。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveDshApp, exitSkipped } from './dsh-app-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(__dirname, '..', 'plugins', 'qq-wake', 'lib', 'client.js');
// DSH 自带的 jsdom 在哪：不写死用户名 —— 见 scripts/dsh-app-path.mjs
const DSH_APP = resolveDshApp();

const require_ = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require_('jsdom'));
} catch {
  try {
    if (DSH_APP === '') throw new Error('没找到 DSH Desktop 应用目录');
    ({ JSDOM } = createRequire(path.join(DSH_APP, 'package.json'))('jsdom'));
  } catch (error) {
    exitSkipped(`找不到 jsdom（${error?.message ?? error}）`);
  }
}

const source = fs.readFileSync(BUNDLE, 'utf8');

/** 仿 DSH 侧边栏外壳：logo 行（含新会话按钮）+ 社区插件功能行 + 工作区区域。 */
const SHELL = `<!doctype html><html><body>
  <div data-pane="sidebar">
    <div class="logoRow_abc"><button class="newSession_xyz">新会话</button></div>
    <button data-dsh-taskboard-entry>任务看板</button>
    <button data-dsh-skill-explorer-entry>技能中心</button>
    <button data-dsh-ssh-entry>SSH</button>
    <div class="workspaces_abc"><a>QQ 聊天</a></div>
  </div>
</body></html>`;

/** 跑一遍 bundle：捕获 factory → 物化 → apply。 */
function mountRow({ html = SHELL, fetchImpl } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [];
  const fetchStub = fetchImpl ?? ((url, options) => {
    calls.push({ url, options });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, awake: false })
    });
  });

  let captured;
  window.__ModuleLoader__ = { load: (mod) => { captured = mod; } };
  // 用参数注入而不是全局，避免污染 jsdom 环境
  const run = new Function(
    'window', 'document', 'MutationObserver', 'HTMLElement', 'fetch', 'console', 'setTimeout', 'clearTimeout',
    source
  );
  run(window, window.document, window.MutationObserver, window.HTMLElement, fetchStub, console, setTimeout, clearTimeout);

  if (!captured) throw new Error('bundle 没有调用 window.__ModuleLoader__.load');
  const exports = captured.factory(() => ({}));
  const ctx = { effect: (fn) => fn() };
  exports.apply(ctx);

  return { dom, window, id: captured.id, exports, calls };
}

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

console.log('=== 场景 1：技能中心存在（正常外壳）===');
{
  const { window, id, exports, calls } = mountRow();
  const row = window.document.querySelector('[data-dsh-qq-wake-entry]');
  const skill = window.document.querySelector('[data-dsh-skill-explorer-entry]');
  check('模块 id 是包名 qq-wake', id === 'qq-wake', `id=${id}`);
  check('导出了 apply/inject', typeof exports.apply === 'function' && Array.isArray(exports.inject));
  check('「唤醒」行已注入', row !== null);
  check('行文本是「唤醒」', row?.textContent?.includes('唤醒') === true, JSON.stringify(row?.textContent));
  check('紧跟在技能中心下面', row !== null && skill?.nextElementSibling === row);
  check('带 semantic 属性', row?.getAttribute('data-dsh-plugin') === 'qq-wake' && row?.getAttribute('data-dsh-part') === 'sidebar-entry');
  check('挂载时读了一次状态', calls.some((c) => String(c.url).includes('/api/qq-wake/status')));
}

console.log('\n=== 场景 2：没有技能中心（退回功能行家族末尾 / 新会话下方）===');
{
  const html = SHELL.replace('<button data-dsh-skill-explorer-entry>技能中心</button>', '');
  const { window } = mountRow({ html });
  const row = window.document.querySelector('[data-dsh-qq-wake-entry]');
  const ssh = window.document.querySelector('[data-dsh-ssh-entry]');
  check('「唤醒」行仍注入', row !== null);
  check('落在家族最后一行（SSH）后面', row !== null && ssh?.nextElementSibling === row);
}

console.log('\n=== 场景 3：点一下 → 打 /api/qq-wake/wake（POST + JSON）===');
{
  const { window, calls } = mountRow();
  const row = window.document.querySelector('[data-dsh-qq-wake-entry]');
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const wake = calls.find((c) => String(c.url).includes('/api/qq-wake/wake'));
  check('调用了唤醒路由', wake !== undefined);
  check('方法是 POST', wake?.options?.method === 'POST');
  check('content-type 是 JSON', String(wake?.options?.headers?.['content-type']).includes('application/json'));
}

console.log('\n=== 场景 4：外壳还没渲染（挂载时不能抛）===');
{
  let threw = false;
  try {
    mountRow({ html: '<!doctype html><html><body><div id="root"></div></body></html>' });
  } catch (error) {
    threw = true;
    console.log('    ', error?.message);
  }
  check('apply 没有抛异常（外壳未就绪时应静默等待）', !threw);
}

console.log(failures === 0 ? '\n✅ 客户端半侧自测全部通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100).unref?.();
