// 回归：agent preset 的「执行期白名单」（`tools.guard`）真的拒绝越权工具。
//
//   node scripts/test-preset-guard.mjs
//
// 为什么要有这支：这个 guard 是 QQ agent 的**安全硬边界** —— 只允许 QQ MCP 工具
//（`mcp__snowluma__` / `mcp__snowluma-host__` / `mcp__web-search-safe__`）与两个无害模型侧工具。
// 但在此之前**全仓库没有任何脚本调过它**：`test-plugin-entry.mjs` 只扫 `plugins/`，
// `test-preset-012.mjs` 只让 agent 回一句话。也就是说，"返回字符串 = 拒绝"这个约定一旦写反或失效，
// 整条边界形同虚设而所有测试照旧全绿（2026-09-16 审计）。
//
// 做法：直接 import preset 里的插件、用假 ctx 捕获 guard，再拿越权工具名真调一次。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = path.join(REPO, 'dsh', 'agent-presets');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

/** 不该被 QQ agent 拿到的工具名（本机执行 / 文件读写 / 开发注入 / 子代理）。 */
const FORBIDDEN = [
  'bash', 'pwsh', 'write', 'read', 'glob', 'grep',
  'dev_inject_plugin', 'dev_reload_package', 'dev_build_plugin', 'dev_stage_promote',
  'subagent', 'workflow', 'ralph', 'agent_teams_create'
];

/** 白名单内：QQ MCP 工具 + 两个无害模型侧工具。 */
const ALLOWED = [
  'mcp__snowluma__qq_send_message',
  'mcp__snowluma__qq_reply',
  'mcp__snowluma-host__snowluma_status',
  'mcp__web-search-safe__web_search',
  'mcp__web-search-safe__web_fetch',
  'ask_user_question',
  'todo_write'
];

const presetDirs = fs.readdirSync(PRESETS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^qq-chat/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
check('找得到 qq-chat 系 preset', presetDirs.length >= 2, presetDirs.join(', '));

for (const preset of presetDirs) {
  console.log(`\n--- ${preset}`);
  const file = path.join(PRESETS, preset, 'qq-tool-restrict.mjs');
  if (!fs.existsSync(file)) {
    check(`${preset}/qq-tool-restrict.mjs 存在`, false);
    continue;
  }
  const mod = await import(pathToFileURL(file).href);
  const guards = [];
  const restricted = [];
  mod.apply({
    tools: {
      restrict: (arg) => { restricted.push(arg); },
      guard: (fn) => { guards.push(fn); }
    }
  });
  check('注册了执行期 guard', guards.length === 1, `${guards.length} 个`);
  if (guards.length !== 1) continue;
  const guard = guards[0];

  const leaked = FORBIDDEN.filter((name) => guard({ name }) === undefined);
  check(`越权工具全部被拒（试了 ${FORBIDDEN.length} 个）`, leaked.length === 0, leaked.join(', '));

  const wronglyDenied = ALLOWED.filter((name) => guard({ name }) !== undefined);
  check(`白名单工具全部放行（试了 ${ALLOWED.length} 个）`, wronglyDenied.length === 0,
    wronglyDenied.map((name) => `${name} → ${guard({ name })}`).join(' | '));

  check('拿不到工具名时 fail-closed 拒绝', typeof guard({}) === 'string', String(guard({})).slice(0, 60));
  const reason = guard({ name: 'bash' });
  check('拒绝时给出可读原因', typeof reason === 'string' && reason.length > 10, String(reason).slice(0, 70));
  check('restrict 覆盖了危险全局工具（≥10 条）', restricted.length >= 10, `${restricted.length} 条`);
}

console.log(failures === 0 ? '\n✅ preset 权限白名单真的会拒绝越权工具' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
