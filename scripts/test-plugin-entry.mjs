// 插件入口冒烟自测（不经过 DSH）
//
//   node scripts/test-plugin-entry.mjs
//
// 为什么单独有这么一支：DSH 启动时会按 `cordis.patch.yml` 里的插件清单
// **静态 import** 每个插件入口。入口只要有一个链接期错误，比如
// 「导入了 schema.js 里并不存在的导出」，整个 harness 直接起不来：
//
//   Harness could not start.
//   Error: dsh: plugin tree failed to load: failed to apply loader entry include
//   (cordis:include): failed to import loader entry qq-mode-console (...):
//   The requested module './schema.js' does not provide an export named 'GROUP_TITLES'
//
// 这类错误在别处测不出来：test-qq-settings.mjs / test-qq-settings-page.mjs 只加载
// schema.js 与 client.js，**从来不 import 插件入口**，所以入口和 schema 之间
// 漂移了照样全绿。本脚本就是补这一刀。
//
// 校验四件事：
//   1. 每个 plugins/<name> 的入口能被 node 真的 import 进来（挡住导出名漂移、模块找不到）
//   2. 入口导出了 cordis 插件的契约（name 字符串且与目录名一致、apply 函数、inject 是字符串数组）
//   3. package.json 声明了 dsh.client 时，exports["./client"] 指向的文件真的存在
//   4. cordis.patch.yml 里的 id 与包名一致（DSH 靠 id 去重与引用）

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PLUGINS = path.join(REPO, 'plugins');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

const dirs = fs
  .readdirSync(PLUGINS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (dirs.length === 0) {
  // 退出码 2 = 跳过（本支没有验证任何东西）—— 别用 0 冒充"全绿"（2026-09-16 审计）。
  console.log('⚠️ 跳过（本支未验证任何东西）：plugins/ 下没有插件目录 —— 仓库结构不对？');
  process.exit(2);
}

console.log(`=== 插件入口冒烟：${dirs.length} 个（${dirs.join(', ')}）===`);

for (const dir of dirs) {
  console.log(`\n--- ${dir}`);

  const dirAbs = path.join(PLUGINS, dir);
  const pkgPath = path.join(dirAbs, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    check('package.json 存在', false, '缺了 DSH 认不出这是插件');
    continue;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    check('package.json 可解析', false, error?.message ?? String(error));
    continue;
  }

  const entryRel = pkg.exports?.['.']?.default ?? pkg.main;
  if (!entryRel) {
    check('声明了入口', false, 'package.json 既没有 exports["."].default 也没有 main');
    continue;
  }

  const entryAbs = path.join(dirAbs, entryRel);
  if (!fs.existsSync(entryAbs)) {
    check('入口文件存在', false, entryAbs);
    continue;
  }

  // 关键一步：真的 import 一次。链接期错误（缺导出、解析不到模块）在这里现形。
  let mod;
  try {
    mod = await import(pathToFileURL(entryAbs).href);
    check('入口可 import', true, entryRel);
  } catch (error) {
    check('入口可 import', false, '');
    console.log(`      ${error?.constructor?.name}: ${error?.message}`);
    console.log('      ↑ 这一条会让整个 DSH harness 起不来（cordis:include 静态 import 失败）');
    continue;
  }

  check('导出 name（字符串）', typeof mod.name === 'string', String(mod.name ?? ''));
  check('name 与目录名一致', mod.name === dir, mod.name === dir ? '' : `name=${mod.name} 目录=${dir}`);
  check('导出 apply（函数）', typeof mod.apply === 'function');
  if (mod.inject !== undefined) {
    const ok = Array.isArray(mod.inject) && mod.inject.every((s) => typeof s === 'string');
    check('inject 是字符串数组', ok, JSON.stringify(mod.inject));
  }

  // 客户端半侧：DSH 靠 package.json 的 dsh.client 声明去找 exports["./client"]。
  if (pkg.dsh?.client) {
    const clientRel = pkg.exports?.['./client']?.default;
    if (!clientRel) {
      check('dsh.client 有对应的 exports["./client"]', false, '声明了 dsh.client 却没写 exports["./client"]');
    } else {
      check('客户端半侧文件存在', fs.existsSync(path.join(dirAbs, clientRel)), clientRel);
    }
  }

  // cordis.patch.yml：DSH 按 id 去重与引用，id 和包名漂了会挂错节点。
  const patchPath = path.join(dirAbs, 'cordis.patch.yml');
  if (fs.existsSync(patchPath)) {
    const text = fs.readFileSync(patchPath, 'utf8');
    check('cordis.patch.yml 的 id 与包名一致', text.includes(`id: ${pkg.name}`));
  }
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100).unref?.();
