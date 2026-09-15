// qq-wake —— 唤醒流程（纯逻辑，宿主侧插件与独立测试脚本共用）
//
// 一次「唤醒」= 点一下按键，把 QQ 机器人整条链路拉起来，然后给管理员发一句话。
//
//   SnowLuma（注入 QQ.exe）→ OneBot HTTP → qq-bridge → QQ 私聊
//
// **没有自动启动**：不注册计划任务、不开机自启、不做常驻守护。
// 机器人只在「点唤醒」时被拉起 —— 这是用户的明确要求（见 AGENTS.md §5）。
//
// 为什么这些逻辑必须在宿主侧（DSH Node 进程）而不是浏览器里：
//   1. 桥接控制台令牌（state/console-token）不能下发到页面；
//   2. 浏览器直连 127.0.0.1:3100 是跨源，会被桥接的 Origin 校验拒掉；
//   3. 机器完全没起来时浏览器无能为力 —— 必须有进程能去把两个 node 进程拉起来。
//
// 本文件不 import 任何 DSH 包，所以可以被 scripts/test-wake.mjs 单独跑。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** qq-bridge 仓库根目录（本文件在 <root>/plugins/qq-wake/lib/ 下）。 */
export const BRIDGE_DIR = path.resolve(__dirname, '..', '..', '..');

/** SnowLuma 安装目录（可用插件 config.snowlumaDir 覆盖）。 */
export const DEFAULT_SNOWLUMA_DIR = 'C:\\SnowLuma';

/** SnowLuma WebUI 端口（用它判断进程起没起来）。 */
const SNOWLUMA_PORT = 5099;

/** 默认唤醒语。可用插件 config.message 覆盖。 */
export const DEFAULT_MESSAGE = '睡醒了';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── 配置与本地状态 ──────────────────────────────────────────────────────────

/**
 * 读 qq-bridge 的 config.json。
 * @param {string} [bridgeDir] 仓库根目录。
 * @returns {object} 解析后的配置对象。
 */
export function readBridgeConfig(bridgeDir = BRIDGE_DIR) {
  const file = path.join(bridgeDir, 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`读不到 ${file}（qq-bridge 没安装或路径不对）`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON: ${error?.message ?? error}`);
  }
}

/** 读桥接控制台令牌（桥接自己生成并持久化在这里）。 */
export function readConsoleToken(bridgeDir = BRIDGE_DIR) {
  try {
    return fs.readFileSync(path.join(bridgeDir, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 守护心跳（tools/ 里的自启守护是可选项，默认不装）。
 * 现在机器人由「唤醒」按键按需拉起，心跳只作为参考信息。
 */
export function readHeartbeat(bridgeDir = BRIDGE_DIR, freshMs = 90000) {
  const file = path.join(bridgeDir, 'state', 'supervisor', 'supervisor.heartbeat');
  try {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8').trim();
    return { alive: Date.now() - stat.mtimeMs < freshMs, at: text, mtimeMs: stat.mtimeMs };
  } catch {
    return { alive: false, at: '', mtimeMs: 0 };
  }
}

// ── 进程/端口小工具 ─────────────────────────────────────────────────────────

/** 找 node 可执行文件：系统 node 优先，否则用当前进程那个（DSH 自带的也能跑）。 */
function resolveNodeExe() {
  const system = 'C:\\Program Files\\nodejs\\node.exe';
  if (fs.existsSync(system)) return system;
  return process.execPath;
}

/** 读 pid 文件里的 pid（不存在/非法返回 0）。 */
function readPidFile(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** 进程还活着吗。 */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 端口在监听吗。 */
function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * 后台启动一个 node 脚本并记下 pid。
 * detached + unref：DSH 关掉后这两个进程继续跑，下次唤醒会复用它们。
 *
 * 注意两个坑：
 *   * `spawn` 失败（node.exe 路径不存在等）是**异步** emit 'error' 的，
 *     没有监听器时 Node 会抛未捕获异常 —— 那是把 DSH harness 整个搞崩。
 *     所以这里先同步检查可执行文件存在，再挂一个 error 监听兜底。
 *   * 拿不到 pid 时不写 pid 文件（写 "undefined" 会让下次唤醒读到脏值）。
 * @returns {number} 子进程 pid，起不来时返回 0。
 */
function spawnDetached(nodeExe, script, cwd, pidFile, log) {
  if (!fs.existsSync(nodeExe)) {
    log(`找不到 node 可执行文件：${nodeExe}`);
    return 0;
  }
  let child;
  try {
    child = spawn(nodeExe, [script], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (error) {
    log(`启动 ${path.basename(script)} 失败：${error?.message ?? error}`);
    return 0;
  }
  child.on('error', (error) => {
    log(`启动 ${path.basename(script)} 出错：${error?.message ?? error}`);
  });
  child.unref();
  if (!child.pid) {
    log(`启动 ${path.basename(script)} 失败：没有拿到进程号`);
    return 0;
  }
  try {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(child.pid), 'ascii');
  } catch {}
  log(`已启动 ${path.basename(script)}（PID=${child.pid}）`);
  return child.pid;
}

/** 这个 pid 现在真的是 node 进程吗（Windows 上问 tasklist；防止 pid 复用误杀）。 */
function isNodeProcess(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'buffer'
    });
    let text_;
    try { text_ = new TextDecoder('gbk').decode(out); } catch { text_ = String(out); }
    return /node\.exe/i.test(text_);
  } catch {
    return false;   // 问不出来就当作"不是"，宁可不杀
  }
}

/**
 * 停掉 pid 文件里记着的进程。
 * 只动「我们自己启动过、而且现在确实还是 node」的那个 —— pid 文件可能很旧，
 * 而 pid 会被系统复用，直接 kill 可能杀掉你别的程序。
 */
function killTracked(pidFile, log, label) {
  const pid = readPidFile(pidFile);
  if (!pid || !isAlive(pid)) return false;
  if (!isNodeProcess(pid)) {
    log(`${label} 的 pid 文件已过期（PID=${pid} 现在不是 node 进程），跳过，不清 PID 文件`);
    return false;
  }
  try {
    process.kill(pid);
    log(`${label}（PID=${pid}）已停止，准备重启`);
    return true;
  } catch (error) {
    log(`停止 ${label} 失败：${error?.message ?? error}`);
    return false;
  }
}

// ── 探活 ────────────────────────────────────────────────────────────────────

/** 带超时的 fetch（避免探活把唤醒流程卡死）。 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** fetch 失败时给一句能看懂的原因（ECONNREFUSED 比 "TypeError" 有用得多）。 */
function describeFetchError(error) {
  return error?.cause?.code ?? error?.cause?.message ?? error?.name ?? String(error);
}

/**
 * 桥接本地控制台探活。
 * @returns {Promise<{ok: boolean, status?: object, error?: string}>}
 */
export async function probeBridge(cfg, bridgeDir = BRIDGE_DIR) {
  const port = Number(cfg?.consolePort ?? 3100);
  const token = readConsoleToken(bridgeDir);
  if (!token) return { ok: false, error: 'state/console-token 不存在（桥接从未启动过？）' };
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/status`, {
      headers: { 'x-console-token': token }
    });
    if (res.status === 401) return { ok: false, error: '控制台令牌已失效（桥接重启后重新生成过？）' };
    if (!res.ok) return { ok: false, error: `控制台返回 HTTP ${res.status}` };
    return { ok: true, status: await res.json() };
  } catch (error) {
    return { ok: false, error: `连不上控制台 127.0.0.1:${port}（${describeFetchError(error)}）` };
  }
}

/**
 * OneBot 探活（直接问 SnowLuma 的 HTTP API，比桥接状态更早可用）。
 * @returns {Promise<{ok: boolean, login?: object, error?: string}>}
 */
export async function probeOneBot(cfg) {
  const base = String(cfg?.snowluma?.httpUrl ?? '').trim();
  if (!base) return { ok: false, error: 'config.json 没配 snowluma.httpUrl' };
  const token = String(cfg?.snowluma?.accessToken ?? '').trim();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchWithTimeout(`${base.replace(/\/$/, '')}/get_login_info`, { headers }, 6000);
    if (!res.ok) return { ok: false, error: `OneBot 返回 HTTP ${res.status}` };
    const body = await res.json();
    if (body?.status !== 'ok') return { ok: false, error: `OneBot status=${body?.status ?? '未知'}` };
    return { ok: true, login: body.data ?? {} };
  } catch (error) {
    return { ok: false, error: `OneBot 无响应（${describeFetchError(error)}）` };
  }
}

/**
 * 一眼看清机器人当前状态（给按钮做提示用）。
 * @returns {Promise<{supervisor: object, bridge: object, onebot: object, awake: boolean}>}
 */
export async function probeStatus(bridgeDir = BRIDGE_DIR) {
  let cfg = null;
  let configError = '';
  try {
    cfg = readBridgeConfig(bridgeDir);
  } catch (error) {
    configError = error?.message ?? String(error);
  }
  const supervisor = readHeartbeat(bridgeDir);
  const bridge = cfg === null ? { ok: false, error: configError } : await probeBridge(cfg, bridgeDir);
  const onebot = cfg === null ? { ok: false, error: configError } : await probeOneBot(cfg);
  return {
    supervisor,
    bridge,
    onebot,
    awake: Boolean(bridge.ok && onebot.ok)
  };
}

// ── 拉起链路 ────────────────────────────────────────────────────────────────

/** 轮询直到 test() 返回 ok，或超时。 */
async function waitFor(test, { timeoutMs, intervalMs = 2000, onWait }) {
  const startedAt = Date.now();
  let last = await test();
  while (!last.ok && Date.now() - startedAt < timeoutMs) {
    if (onWait) onWait(last, Date.now() - startedAt);
    await sleep(intervalMs);
    last = await test();
  }
  return last;
}

/**
 * 确保 SnowLuma 起来且 OneBot 可用（OneBot 可用 == 注入成功且 QQ 已登录）。
 * @returns {Promise<{ok: boolean, started: boolean, detail: string, login?: object}>}
 */
async function ensureSnowLuma(cfg, { snowlumaDir, timeoutMs, log }) {
  const onebot = await probeOneBot(cfg);
  if (onebot.ok) return { ok: true, started: false, detail: '已在运行', login: onebot.login };

  const entry = path.join(snowlumaDir, 'index.mjs');
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      started: false,
      detail: `找不到 ${entry}（SnowLuma 装在别处？可用插件 config.snowlumaDir 指定）`
    };
  }

  // 端口在听但 OneBot 不通 = 注入管道断了（QQ 客户端重启过）。
  // 只能重启 SnowLuma；但只动「我们自己启动过的那一个」，不去杀别人的进程。
  const pidFile = path.join(BRIDGE_DIR, 'state', 'supervisor', 'snowluma.pid');
  if (await portOpen(SNOWLUMA_PORT)) {
    if (!killTracked(pidFile, log, 'SnowLuma')) {
      return {
        ok: false,
        started: false,
        detail: '端口 5099 被占用但 OneBot 不响应，而且那不是本插件启动的进程 —— 请手动重启 SnowLuma'
      };
    }
    for (let i = 0; i < 20 && (await portOpen(SNOWLUMA_PORT)); i += 1) await sleep(500);
  }

  const pid = spawnDetached(resolveNodeExe(), entry, snowlumaDir, pidFile, log);
  if (pid === 0) return { ok: false, started: false, detail: 'SnowLuma 启动失败（node 起不来，见桥接/DSH 日志）' };
  const ready = await waitFor(() => probeOneBot(cfg), {
    timeoutMs,
    onWait: (last, waited) => log(`等待 SnowLuma 注入 QQ… ${Math.round(waited / 1000)}s（${last.error}）`)
  });
  if (!ready.ok) {
    return { ok: false, started: true, detail: `SnowLuma 起来了但 OneBot 没通：${ready.error}` };
  }
  return { ok: true, started: true, detail: '已启动并登录', login: ready.login };
}

/**
 * 确保 qq-bridge 起来（必须在 OneBot 可用之后 —— 桥接连不上 SnowLuma 会直接退出）。
 * @returns {Promise<{ok: boolean, started: boolean, detail: string}>}
 */
async function ensureBridge(cfg, { bridgeDir, timeoutMs, log }) {
  const current = await probeBridge(cfg, bridgeDir);
  if (current.ok) return { ok: true, started: false, detail: '已在运行' };

  const entry = path.join(bridgeDir, 'src', 'bridge.js');
  if (!fs.existsSync(entry)) return { ok: false, started: false, detail: `找不到 ${entry}` };

  const pidFile = path.join(bridgeDir, 'state', 'supervisor', 'bridge.pid');
  const pid = spawnDetached(resolveNodeExe(), entry, bridgeDir, pidFile, log);
  if (pid === 0) return { ok: false, started: false, detail: '桥接启动失败（node 起不来，见 DSH 日志）' };
  const ready = await waitFor(() => probeBridge(cfg, bridgeDir), {
    timeoutMs,
    onWait: (last, waited) => log(`等待桥接控制台… ${Math.round(waited / 1000)}s（${last.error}）`)
  });
  return ready.ok
    ? { ok: true, started: true, detail: '已启动' }
    : { ok: false, started: true, detail: `桥接没起来：${ready.error ?? '超时'}` };
}

// ── 唤醒 ────────────────────────────────────────────────────────────────────

/**
 * 跑一次唤醒：拉起机器人 → 发消息。
 *
 * **同一时刻只跑一次**：并发调用（连点按键、两个页面同时点）直接复用同一次流程的结果。
 * 否则两路会同时看到「SnowLuma 没在跑」→ 各起一个，端口打架、QQ 被重复注入。
 *
 * @param {object} [options] 见 {@link runWakeOnce}。
 * @returns {Promise<object>} 同一次唤醒的结果。
 */
export function runWake(options = {}) {
  if (inFlightWake !== null) {
    options.log?.('已有一次唤醒在进行中，这次直接复用它的结果');
    return inFlightWake;
  }
  inFlightWake = runWakeOnce(options).finally(() => { inFlightWake = null; });
  return inFlightWake;
}

/** 正在进行的唤醒（单飞锁）。 */
let inFlightWake = null;

/**
 * 唤醒流程本体（只被 {@link runWake} 调用）。
 *
 * @param {object} [options]
 * @param {boolean} [options.send] 是否真的发消息（false 只把链路拉起来，用于自测）。
 * @param {string} [options.message] 唤醒语，默认「睡醒了」。
 * @param {number} [options.timeoutMs] 每段等待的上限。
 * @param {string} [options.bridgeDir] 仓库根目录。
 * @param {string} [options.snowlumaDir] SnowLuma 目录，默认 C:\SnowLuma。
 * @param {(line: string) => void} [options.log] 过程日志回调。
 * @returns {Promise<{ok: boolean, message: string, steps: object[], login?: object, error?: string}>}
 */
async function runWakeOnce(options = {}) {
  const {
    send = true,
    message,
    timeoutMs = 240000,
    bridgeDir = BRIDGE_DIR,
    snowlumaDir = DEFAULT_SNOWLUMA_DIR,
    log = () => {}
  } = options;
  const text = String(message ?? DEFAULT_MESSAGE).trim() || DEFAULT_MESSAGE;
  const steps = [];

  const cfg = readBridgeConfig(bridgeDir);           // 配置读不到就直接抛，调用方转成 500
  const ownerQQ = Number(cfg?.ownerQQ ?? 0);

  // ── 1. SnowLuma + QQ 登录（OneBot 可用 == 注入成功且已登录）──
  const snow = await ensureSnowLuma(cfg, { snowlumaDir, timeoutMs, log });
  const snowDetail = snow.ok && snow.started
    ? `${snow.detail}：${String(snow.login?.nickname ?? '机器人')}（${String(snow.login?.user_id ?? '?')}）`
    : snow.detail;
  steps.push({ name: 'SnowLuma / QQ 登录', ok: snow.ok, detail: snowDetail });
  if (!snow.ok) {
    return {
      ok: false,
      error: `QQ 没登录上：${snow.detail}（SnowLuma 是注入式的，需要 QQ 客户端开着并已登录）`,
      message: text,
      steps
    };
  }

  // ── 2. qq-bridge ──
  const bridge = await ensureBridge(cfg, { bridgeDir, timeoutMs, log });
  steps.push({ name: 'qq-bridge', ok: bridge.ok, detail: bridge.detail });
  if (!bridge.ok) {
    return { ok: false, error: bridge.detail, message: text, steps };
  }

  // ── 3. 发唤醒语 ──
  if (!send) {
    steps.push({ name: '发送消息', ok: true, detail: '已跳过（--no-send）' });
    return { ok: true, message: text, steps, login: snow.login, skippedSend: true };
  }
  if (!Number.isFinite(ownerQQ) || ownerQQ <= 0) {
    steps.push({ name: '发送消息', ok: false, detail: 'config.json 没配 ownerQQ' });
    return { ok: false, error: 'config.json 没配 ownerQQ', message: text, steps };
  }

  const token = readConsoleToken(bridgeDir);
  const port = Number(cfg?.consolePort ?? 3100);
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/test-send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ kind: 'private', id: ownerQQ, message: text })
    }, 20000);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok !== true) {
      const detail = body?.error ?? `HTTP ${res.status}`;
      steps.push({ name: '发送消息', ok: false, detail });
      return { ok: false, error: `发送失败：${detail}`, message: text, steps };
    }
    steps.push({ name: '发送消息', ok: true, detail: `已发到 ${ownerQQ}：${text}` });
    log(`已发送：${text}`);
    return { ok: true, message: text, steps, login: snow.login, messageId: body?.message_id };
  } catch (error) {
    steps.push({ name: '发送消息', ok: false, detail: String(error?.message ?? error) });
    return { ok: false, error: `发送失败：${error?.message ?? error}`, message: text, steps };
  }
}
