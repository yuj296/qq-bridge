// SnowLuma 进程管理 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行），
// 给 agent 提供 SnowLuma 网关的状态查询与启停工具。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（HTTP get_login_info）
//   start_snowluma    —— 未运行时启动 launcher.bat 并等待网关就绪（最长 50s）
//   stop_snowluma     —— 停止 SnowLuma（按 launcher 完整路径 + 镜像名匹配进程）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 系统目录里的可执行文件一律用绝对路径调用：Windows 上裸文件名会先搜当前目录，
// 而本进程权限高于 agent 沙箱，同目录放一个同名 exe 就能劫持。
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const SYSTEM32 = path.join(SYSTEM_ROOT, 'System32');
const POWERSHELL_EXE = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKLIST_EXE = path.join(SYSTEM32, 'tasklist.exe');
const TASKKILL_EXE = path.join(SYSTEM32, 'taskkill.exe');
const CMD_EXE = process.env.ComSpec || path.join(SYSTEM32, 'cmd.exe');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const launcher = c.snowluma?.launcherPath ?? '';
  // httpUrl 可以是用户随手填的坏值：解析失败时回退默认端口，别把裸 Invalid URL 抛给 agent。
  let httpPort = '80';
  try {
    httpPort = new URL(httpUrl).port || '80';
  } catch {
    httpPort = '80';
  }
  return {
    httpUrl,
    httpPort,
    token: c.snowluma?.accessToken ?? '',
    launcher,
    homeDir: c.snowluma?.homeDir ?? (launcher ? path.dirname(launcher) : ''),
    // 进程控制默认关闭：只有 config.json 显式设置 snowluma.allowProcessControl=true 才允许启停
    allowProcessControl: c.snowluma?.allowProcessControl === true
  };
}

function getConsolePort() {
  try {
    const c = getConfig();
    return Number(c.consolePort) || 3100;
  } catch {
    return 3100;
  }
}

// 与 bridge 的合法性规则保持一致：长度 16–128 且只含 [A-Za-z0-9_-]。
function consoleTokenValid(token) {
  const t = String(token ?? '').trim();
  return t.length >= 16 && t.length <= 128 && /^[A-Za-z0-9_-]+$/.test(t);
}

function readConsoleToken() {
  // config 里写了不合法（太短/含非法字符）的值时 bridge 会忽略它并回退到
  // state/console-token，本文件必须用同一条规则校验，否则会拿着废令牌一直 401。
  try {
    const configured = String(getConfig().consoleToken ?? '').trim();
    if (consoleTokenValid(configured)) return configured;
  } catch {}
  try {
    const fromState = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
    if (consoleTokenValid(fromState)) return fromState;
  } catch {}
  throw new Error('控制台令牌不可用：config.json 的 consoleToken 不合法（需 16–128 位 [A-Za-z0-9_-]）且读不到 state/console-token，请确认桥接已启动');
}

// 进程控制只允许在 closed-agent（仅管理员私聊）模式下使用，防止 chat/reserved 的 agent 被对方诱导启停 SnowLuma。
async function bridgeModeAllowsProcessControl() {
  try {
    const token = readConsoleToken();
    const res = await fetch(`http://127.0.0.1:${getConsolePort()}/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.mode === 'closed-agent';
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

// 只接受 SnowLuma 会产生的那两种镜像名：launcher 拉起的是 node，注入宿主是 QQ。
const SNOWLUMA_IMAGE_NAMES = new Set(['node.exe', 'qq.exe']);
// pid 多时只处理前若干个：每 pid 一次 tasklist + 一次 taskkill，太多会顶穿工具超时预算。
const MAX_HANDLED_PIDS = 3;

function normalizeWinPath(p) {
  return String(p || '').toLowerCase().replace(/\//g, '\\');
}

// 用绝对路径的 tasklist 查该 pid 的镜像名；查不到（进程已退出/无权限）返回 ''。
function processImageName(pid) {
  try {
    const out = execFileSync(TASKLIST_EXE, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    const m = String(out).match(/"[^"]*","([^"]+)"/);
    return m ? m[1].trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

function findSnowLumaPids() {
  // 先按 OneBot HTTP 端口找监听进程，再要求「命令行命中 launcher 的完整路径」
  // 且「镜像名是 node.exe/QQ.exe」两条同时成立，避免白名单外的进程被 taskkill。
  // 注意：不能再用 homeDir 目录前缀匹配 —— 配成 C:\ 时几乎命中一切。
  const { httpPort, launcher } = getHostConfig();
  const portNum = Number(httpPort);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return { pids: [], skipped: ['httpPort 不合法，未做端口扫描'] };
  const launchPath = normalizeWinPath(launcher);
  if (!launchPath) return { pids: [], skipped: ['未配置 snowluma.launcherPath，无法确认进程归属'] };
  const pids = new Set();
  try {
    const byPort = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${portNum} } | Select-Object -ExpandProperty OwningProcess -Unique`;
    const out = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command', byPort], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    for (const s of out.split(/\s+/)) {
      const n = Number(s.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  } catch {}
  const all = [...pids];
  const handled = all.slice(0, MAX_HANDLED_PIDS);
  const skipped = all.slice(MAX_HANDLED_PIDS).map((pid) => `pid ${pid} 超出单次处理上限（最多 ${MAX_HANDLED_PIDS} 个）`);
  const result = [];
  for (const pid of handled) {
    try {
      const cmd = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { timeout: 10000, windowsHide: true, encoding: 'utf8' }).trim();
      if (!normalizeWinPath(cmd).includes(launchPath)) {
        skipped.push(`pid ${pid} 命令行未命中 launcher 完整路径，跳过`);
        continue;
      }
      const image = processImageName(pid);
      if (!SNOWLUMA_IMAGE_NAMES.has(image)) {
        skipped.push(`pid ${pid} 镜像名是 ${image || '（查不到）'}，不是 node.exe/QQ.exe，跳过`);
        continue;
      }
      result.push(pid);
    } catch {
      // 拿不到命令行时宁可不杀，避免误伤
      skipped.push(`pid ${pid} 读不到命令行，跳过`);
    }
  }
  return { pids: result, skipped };
}

const server = new McpServer({ name: 'snowluma-host', version: '0.1.0' });

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（HTTP 探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只有显式开启进程控制且当前为 closed-agent 时，才暴露本机路径/PID 这类敏感信息。
    const admin = hc.allowProcessControl && await bridgeModeAllowsProcessControl();
    const extra = admin ? { launcher: hc.launcher, homeDir: hc.homeDir, process: findSnowLumaPids() } : {};
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...info, ...extra }, null, 2) }]
    };
  }
);

if (getHostConfig().allowProcessControl) {
  server.tool(
    'start_snowluma',
    '启动 SnowLuma（launcher.bat，独立窗口）并等待 OneBot 网关就绪，最多等 50 秒（DSH 工具默认超时 60 秒）。已在运行时直接返回当前状态；若 50 秒内仍未就绪，可能只是启动较慢，可稍后再调 snowluma_status 确认。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.launcher) {
        return { content: [{ type: 'text', text: '拒绝：未配置 snowluma.launcherPath。' }], isError: true };
      }
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const before = await gatewayInfo();
      if (before.reachable && before.online) {
        return { content: [{ type: 'text', text: JSON.stringify({ started: false, alreadyOnline: true, info: before }) }] };
      }
      let spawnError = null;
      const child = spawn(CMD_EXE, ['/c', 'start', '', `"${hc.launcher}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => { spawnError = err; });
      child.unref();
      let info = null;
      // 内部等待上限 50s（25 × 2s）：留出余量给 DSH 的 60s 工具超时，别让工具本身先被掐断。
      for (let i = 0; i < 25; i += 1) {
        if (spawnError) {
          return { content: [{ type: 'text', text: `启动失败：${spawnError?.message ?? spawnError}` }], isError: true };
        }
        await sleep(2000);
        info = await gatewayInfo();
        if (info.reachable && info.online) {
          return { content: [{ type: 'text', text: JSON.stringify({ started: true, readyAfterMs: (i + 1) * 2000, info }) }] };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ started: false, timeout: true, waitedMs: 50000, hint: '50 秒内未就绪，可能只是启动较慢；可稍后再调 snowluma_status 确认', lastInfo: info ?? before }) }] };
    }
  );

  server.tool(
    'stop_snowluma',
    '停止 SnowLuma 进程（按 launcher 完整路径 + 镜像名 node.exe/QQ.exe 双重确认后 taskkill）。谨慎使用：会断开当前 QQ 连接。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const { pids, skipped } = findSnowLumaPids();
      if (pids.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ stopped: false, reason: 'no process found', skipped }) }] };
      }
      const killed = [];
      for (const pid of pids) {
        try {
          execFileSync(TASKKILL_EXE, ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
          killed.push(pid);
        } catch (error) {
          // 进程可能已退出
          skipped.push(`pid ${pid} taskkill 失败（可能已退出）`);
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ stopped: true, killed, skipped }) }] };
    }
  );
}

await server.connect(new StdioServerTransport());
