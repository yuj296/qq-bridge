#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置（DSH 0.1.2 适配版）
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载三个 MCP server：
//      mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe
//   3. 同一个 patch 层挂载 qq-mode-console / qq-wake 两个 UI 插件（必须 file:// 形式）
//   4. 兜底创建 state/mode.json
//   5. 体检：仓库 bundle patch 与本脚本写的 patch 段有没有插同一个 loader entry id
//      （同 id 会让 DSH 启动直接抛 duplicate loader entry id，harness 起不来）
//
// 用法：
//   node scripts/setup-dsh.mjs [profile] [--dry-run]
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
//
// ── 与旧版（0.1.1）脚本的差异 ────────────────────────────────────────────────
// DSH 0.1.2 起：
//   * `@deepseek-ai/dsh-host-apiproxy` 被删除，profile 的 bundle 由 DSH Desktop
//     的 market 生成器接管（package.json 里有 dsh.desktop.generationProjection
//     与 pnpm.overrides 的 link: 路径）。
//   * 旧脚本会往 profile 的 package.json 里写 `"qq-mode-console": "link:<abs>"`
//     并把它加进 dsh.profile.bundles，然后依赖 `dsh plugin --profile web install`
//     去真正安装。这会和 Desktop 的生成器管理打架；一旦 bundles 里登记了
//     解析不到的 bundle，DSH 会直接起不来（cannot resolve profile bundle）。
//   * 而 `dsh` CLI 在 DSH Desktop 环境下通常不在 PATH，那一步会被跳过，
//     于是「登记了但没装」——正好落进上面那个失败模式。
//
// 新版改为：把 qq-mode-console / qq-wake 用 `file://` specifier 直接挂在用户 patch 层。
//   Cordis loader 的 import(name) 对非 `.` 开头的 specifier 直接走动态 import，
//   而 file:// URL 是合法 ESM specifier，因此无需装配/bundle 注册/pnpm install，
//   也完全不碰 profile 的 package.json。插件通过仓库自带的 node_modules 解析
//   `@deepseek-ai/schemastery`。移除时删掉 patch 里的对应条目即可，无残留。
//
//   ── 为什么**必须**是 file://，不能改成包内子路径 specifier（2026-09-15 实测）──────
//   dsh-client-modules 定位客户端半侧时，会先算 exactPackageSpecifier(loaderName)：
//   只有「裸包名」或「@scope/name」才有值，`qq-bridge/plugins/qq-mode-console` 这种
//   带子路径的一律返回 undefined，随后 locatePkgJson() 直接 return undefined ——
//   宿主半侧照常加载，客户端半侧被**静默跳过**，表现是设置页「QQ 机器人」卡片和
//   侧边栏「唤醒」按键凭空消失（没有任何报错）。file:// 入口属于 path-like，才会按
//   「最近的 package.json」找到 plugins/<name>/package.json（dsh.client.platform=web
//   + exports["./client"]）。参见 dsh-client-modules/lib/index.js:132-138、651-716。
//
//   ── 为什么根目录 cordis.patch.yml 里不能再插这两个 id ──────────────────────────
//   qq-bridge 作为 profile 依赖装着、又声明了 dsh.bundle，DSH Desktop 启动时的自愈
//   `healProfileBundles()` 就会把它自动补进 `dsh.profile.bundles` 并重写 profile 的
//   package.json（改一次写回一次，手改没用）。于是 bundle 层一定会应用
//   `qq-bridge/cordis.patch.yml`：那里若也插 qq-mode-console / qq-wake，就会和本层
//   同 id 撞车，DSH 抛 `duplicate loader entry id` 直接起不来。所以 bundle patch 只留
//   宿主行 qq-bridge-host，`checkLayerOverlap()` 每次会做一次重叠体检。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PROFILE = args.find((a) => !a.startsWith('--')) || 'web';

const BEGIN_MARKER = '# === qq-bridge MCP BEGIN ===';
const END_MARKER = '# === qq-bridge MCP END ===';

function log(msg) {
  console.log(`[setup-dsh]${DRY_RUN ? ' (dry-run)' : ''} ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyPreset(name) {
  const src = path.join(REPO_ROOT, 'dsh', 'agent-presets', name);
  const dest = path.join(DSH_HOME, '.agent-presets', name);
  if (!fs.existsSync(src)) fatal(`preset source not found: ${src}`);
  if (DRY_RUN) {
    log(`would install preset: ${name} -> ${dest}`);
    return;
  }
  ensureDir(path.dirname(dest));
  fs.cpSync(src, dest, { recursive: true, force: true });
  log(`preset installed: ${name}`);
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** profile patch 层里引用本地插件：file:// URL（跨盘也能用，不受相对路径限制）。 */
function pluginSpecifier(pluginDir, entryRel = 'lib/index.js') {
  const entry = path.join(REPO_ROOT, 'plugins', pluginDir, entryRel);
  if (!fs.existsSync(entry)) fatal(`plugin entry not found: ${entry}`);
  return pathToFileURL(entry).href;
}

function patchBlock() {
  const node = process.execPath;
  const servers = {
    'mcp-snowluma': path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'),
    'mcp-snowluma-host': path.join(REPO_ROOT, 'src', 'mcp-host-server.js'),
    'mcp-web-search-safe': path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'),
  };
  let out = `${BEGIN_MARKER}\n`;
  for (const [id, script] of Object.entries(servers)) {
    if (!fs.existsSync(script)) fatal(`MCP server script not found: ${script}`);
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${id.replace('mcp-', '')}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(script)}\n`;
    if (id === 'mcp-snowluma') {
      out += `        toolCallTimeoutMs: 725000\n`;
    }
  }
  // 控制台插件：只注册 qq-mode settings 命名空间（设置页卡片）。
  // 可选；不装也能用 —— 桥接自己的控制台（默认 127.0.0.1:3100）同样能切模式。
  out += `- insert:\n`;
  out += `    - id: qq-mode-console\n`;
  out += `      name: ${yamlSingleQuote(pluginSpecifier('qq-mode-console'))}\n`;
  out += `      config: {}\n`;
  // 唤醒按键插件：宿主侧注册 /api/qq-wake 路由，客户端侧在侧边栏「技能中心」下面
  // 注入一个「唤醒」行。客户端半侧由 dsh-client-modules 从「挂载文件最近的
  // package.json」里读 dsh.client 声明 + exports["./client"]，所以这里指向
  // lib/index.js 就够了 —— 它会顺着目录找到 plugins/qq-wake/package.json。
  out += `- insert:\n`;
  out += `    - id: qq-wake\n`;
  out += `      name: ${yamlSingleQuote(pluginSpecifier('qq-wake'))}\n`;
  out += `      config: {}\n`;
  out += `${END_MARKER}\n`;
  return out;
}

function patchCordis() {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const block = patchBlock();

  let text = '';
  if (fs.existsSync(patchFile)) text = fs.readFileSync(patchFile, 'utf8');

  const hasBlock = text.includes(BEGIN_MARKER) && text.includes(END_MARKER);
  const hasLegacy = text.includes('mcp-snowluma-safe.js') || text.includes('id: mcp-snowluma');

  if (hasBlock) {
    text = text.replace(
      /[^\n]*# === qq-bridge MCP BEGIN ===[\s\S]*?# === qq-bridge MCP END ===[^\n]*\n?/,
      block,
    );
    log('cordis.patch.yml: qq-bridge 区块已更新');
  } else if (hasLegacy) {
    log('cordis.patch.yml 里已有 mcp-snowluma 相关条目但没有标记块；请手动核对路径是否指向本仓库，脚本未改动。');
    return;
  } else {
    // DSH 模板自带、独立成行的空数组 `[]` 必须剥离，否则追加的列表会与它组成
    // 两个 YAML 根节点，DSH 重启报 “end of the stream or a document separator is expected”。
    text = text.replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/gm, '');
    if (text.trim().length > 0) {
      if (!text.endsWith('\n')) text += '\n';
      text += `\n${block}`;
    } else {
      text += block;
    }
    log('cordis.patch.yml: qq-bridge 区块已追加');
  }

  if (DRY_RUN) {
    log(`would write ${patchFile}:`);
    console.log('-----8<-----');
    console.log(text);
    console.log('----->8-----');
    return;
  }

  ensureDir(profileDir);
  if (fs.existsSync(patchFile)) {
    const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(patchFile, backup);
    log(`已备份原文件: ${path.basename(backup)}`);
  }
  fs.writeFileSync(patchFile, text, 'utf8');
  log(`cordis.patch.yml 已写入: ${patchFile}`);
}

/** 从一段 patch 列表文本里抠出所有 `id:` 值。 */
function collectEntryIds(text) {
  const ids = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * 体检：仓库自己的 bundle patch（根目录 `cordis.patch.yml`，被 package.json 的
 * `dsh.bundle.patch` 指向）和本脚本写进 profile patch 层的这一段，**有没有插同一个 id**。
 *
 * DSH 的插件树按「bundle 层 → 用户 patch 层 → --patch 覆盖层」依次应用，entry id 全局唯一；
 * 同 id 插两遍会直接抛
 * `dsh: plugin tree failed to load: ... duplicate loader entry id: <id>`，
 * 整个 harness 起不来（实测 2026-09-15 就是这样挂的）。
 *
 * 而 bundle 层是**躲不开的**：只要 qq-bridge 是 profile 的依赖、又声明了 dsh.bundle，
 * DSH Desktop 启动时的自愈 `healProfileBundles()`（out/main/index.js:9908）就会把它补进
 * `dsh.profile.bundles` 并重写 profile 的 package.json —— 改一次写回去一次。
 * 所以两个 UI 插件只能挂在 bundle patch **之外**的一侧。只读检查，不改任何文件。
 */
function checkLayerOverlap() {
  const bundlePatchPath = path.join(REPO_ROOT, 'cordis.patch.yml');
  let bundleIds;
  try {
    bundleIds = collectEntryIds(fs.readFileSync(bundlePatchPath, 'utf8'));
  } catch (e) {
    log(`体检跳过：读不动 ${bundlePatchPath}（${e.message}）`);
    return;
  }
  const patchIds = collectEntryIds(patchBlock());
  const overlap = [...patchIds].filter((id) => bundleIds.has(id));
  if (overlap.length === 0) {
    log(`体检 OK：bundle 层与 patch 层无同 id 重叠（bundle 层 ${bundleIds.size} 个 id，patch 层 ${patchIds.size} 个）`);
    return;
  }
  console.error('');
  console.error(`[setup-dsh] ⚠️  隐患：这些 id 同时出现在 bundle 层和 patch 层 —— ${overlap.join(', ')}`);
  console.error('    bundle 层：cordis.patch.yml（qq-bridge 作为 bundle 被应用时）');
  console.error('    patch 层：本脚本写进 profile cordis.patch.yml 的那一段');
  console.error('    DSH 启动会报 "duplicate loader entry id: <id>"，harness 直接起不来。');
  console.error('    修法：从其中一侧删掉重复的行。两个 UI 插件（qq-mode-console / qq-wake）');
  console.error('    必须留在 patch 层的 file:// 一侧 —— 包内子路径 specifier 挂不出客户端半侧');
  console.error('    （设置页卡片 / 侧边栏「唤醒」按键会消失）。详见 INSTALL.md 第 8.1 节。');
  console.error('');
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log('state/mode.json 已存在，保持不动（可能是用户配置）');
    return;
  }
  if (DRY_RUN) {
    log(`would create ${modeFile} with mode=reserved2`);
    return;
  }
  ensureDir(stateDir);
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: 'router-standard' }, null, 2)}\n`, 'utf8');
  log('state/mode.json 已创建（mode=reserved2，DSH settings 不可用时的兜底）');
}

log(`DSH_HOME = ${DSH_HOME}`);
log(`profile  = ${PROFILE}`);
log(`仓库     = ${REPO_ROOT}`);
console.log('');

copyPreset('qq-chat');
copyPreset('qq-chat-v2');
patchCordis();
ensureLocalModeFile();
checkLayerOverlap();

console.log('');
log('完成。下一步：');
log('  1) DSH 的 preset 是按需从磁盘读取的，qq-chat / qq-chat-v2 立即生效，无需重启。');
log('  2) profile 的 patch 层是 live reload 的，MCP 与 qq-mode 卡片通常也会即时生效；');
log('     若没看到 mcp__snowluma__* 工具或 qq-mode 设置卡片，重启一次 DSH 即可。');
log('  3) 本脚本不再改动 profile 的 package.json，也不依赖 dsh CLI。');
