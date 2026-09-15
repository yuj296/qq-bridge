// qq-wake —— 唤醒流程（纯逻辑，宿主侧插件与独立测试脚本共用）
//
// 一次「唤醒」= 把 QQ 机器人整条链路拉起来，然后给管理员发一句话。
//
//   计划任务守护进程 → SnowLuma（注入 QQ.exe）→ OneBot HTTP → qq-bridge → QQ 私聊
//
// 为什么这些逻辑必须在宿主侧（DSH Node 进程）而不是浏览器里：
//   1. 桥接控制台令牌（state/console-token）不能下发到页面；
//   2. 浏览器直连 127.0.0.1:3100 是跨源，会被桥接的 Origin 校验拒掉；
//   3. 机器完全没起来时浏览器无能为力 —— 必须有进程能去把守护拉起来。
//
// 本文件不 import 任何 DSH 包，所以可以被 scripts/test-wake.mjs 单独跑。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** qq-bridge 仓库根目录（本文件在 <root>/plugins/qq-wake/lib/ 下）。 */
export const BRIDGE_DIR = path.resolve(__dirname, '..', '..', '..');

/** 计划任务名（tools/install-task.ps1 注册的那个）。 */
export const SUPERVISOR_TASK = 'DSH QQ Bot Supervisor';

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

/** 守护进程心跳是否新鲜（守护每 20s 刷一次；判死活只看它，不看计划任务状态）。 */
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

// ── 探活 ────────────────────────────────────────────────────────────────────

/** fetch 失败时给一句能看懂的原因（ECONNREFUSED 比 "TypeError" 有用得多）。 */
function describeFetchError(error) {
  return error?.cause?.code ?? error?.cause?.message ?? error?.name ?? String(error);
}

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

// ── 唤醒 ────────────────────────────────────────────────────────────────────

/** 让计划任务把守护进程拉起来（已在运行/被 IgnoreNew 拒绝都算正常，后面靠探活判定）。 */
function startSupervisorTask() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, detail: '非 Windows，跳过计划任务拉起' });
    execFile('schtasks.exe', ['/run', '/tn', SUPERVISOR_TASK], { windowsHide: true, encoding: 'buffer' }, (error, stdout, stderr) => {
      // schtasks 在中文系统上吐 GBK，按 UTF-8 读会变乱码 —— 用 gbk 解一次
      const decode = (buf) => {
        if (!buf || buf.length === 0) return '';
        try { return new TextDecoder('gbk').decode(buf).trim(); } catch { return String(buf).trim(); }
      };
      const text = `${decode(stdout)} ${decode(stderr)}`.trim();
      const alreadyRunning = /已在运行|currently running|已经运行/i.test(text);
      if (error) return resolve({ ok: false, alreadyRunning, detail: text || `schtasks 失败：${error.message}` });
      resolve({ ok: true, alreadyRunning, detail: text || '已请求启动守护任务' });
    });
  });
}

/** 轮询直到 test() 返回 ok，或超时。 */
async function waitFor(test, { timeoutMs, intervalMs = 2000, onWait }) {
  const deadline = Date.now() + timeoutMs;
  let last = await test();
  let tick = 0;
  while (!last.ok && Date.now() < deadline) {
    if (onWait && tick % 5 === 0) onWait(last, Date.now() - (deadline - timeoutMs));
    tick += 1;
    await sleep(intervalMs);
    last = await test();
  }
  return last;
}

/**
 * 跑一次唤醒：确保机器人起来 → 发消息。
 *
 * @param {object} [options]
 * @param {boolean} [options.send] 是否真的发消息（false 只把链路拉起来，用于自测）。
 * @param {string} [options.message] 唤醒语，默认「睡醒了」。
 * @param {number} [options.timeoutMs] 每段等待的上限。
 * @param {string} [options.bridgeDir] 仓库根目录。
 * @param {(line: string) => void} [options.log] 过程日志回调。
 * @returns {Promise<{ok: boolean, message: string, steps: object[], login?: object, error?: string}>}
 */
export async function runWake(options = {}) {
  const {
    send = true,
    message,
    timeoutMs = 240000,
    bridgeDir = BRIDGE_DIR,
    log = () => {}
  } = options;
  const text = String(message ?? DEFAULT_MESSAGE).trim() || DEFAULT_MESSAGE;
  const steps = [];

  const cfg = readBridgeConfig(bridgeDir);           // 配置读不到就直接抛，调用方转成 500
  const ownerQQ = Number(cfg?.ownerQQ ?? 0);

  // ── 1. 桥接控制台 ──
  let bridge = await probeBridge(cfg, bridgeDir);
  if (bridge.ok) {
    steps.push({ name: 'qq-bridge', ok: true, detail: '已在运行' });
  } else {
    log(`桥接未运行（${bridge.error}），请求计划任务拉起守护进程…`);
    const started = await startSupervisorTask();
    // 「已在运行」说明守护本来就活着，只是桥接还没起来 —— 不是失败
    steps.push({
      name: '拉起守护任务',
      ok: started.ok || started.alreadyRunning === true,
      detail: started.alreadyRunning ? '守护任务已在运行' : started.detail
    });
    bridge = await waitFor(() => probeBridge(cfg, bridgeDir), {
      timeoutMs,
      onWait: (last, waitedMs) => log(`等待桥接控制台… ${Math.round(waitedMs / 1000)}s（${last.error}）`)
    });
    steps.push({ name: 'qq-bridge', ok: bridge.ok, detail: bridge.ok ? '已就绪' : (bridge.error ?? '超时') });
    if (!bridge.ok) {
      return { ok: false, error: `桥接没起来：${bridge.error ?? '超时'}`, message: text, steps };
    }
  }

  // ── 2. OneBot（= SnowLuma 注入成功且 QQ 已登录）──
  let onebot = await probeOneBot(cfg);
  if (!onebot.ok) {
    log(`OneBot 尚未就绪（${onebot.error}），等待 SnowLuma 注入 QQ 客户端…`);
    onebot = await waitFor(() => probeOneBot(cfg), {
      timeoutMs,
      onWait: (last, waitedMs) => log(`等待 OneBot… ${Math.round(waitedMs / 1000)}s（${last.error}）`)
    });
  }
  if (!onebot.ok) {
    steps.push({ name: 'QQ 登录', ok: false, detail: onebot.error ?? '超时' });
    return {
      ok: false,
      error: `QQ 没登录上：${onebot.error ?? '超时'}（SnowLuma 是注入式的，需要 QQ 客户端开着并已登录）`,
      message: text,
      steps
    };
  }
  const nickname = String(onebot.login?.nickname ?? '').trim();
  const botQQ = String(onebot.login?.user_id ?? '').trim();
  steps.push({ name: 'QQ 登录', ok: true, detail: `${nickname || '机器人'}（${botQQ}）` });

  // ── 3. 发唤醒语 ──
  if (!send) {
    steps.push({ name: '发送消息', ok: true, detail: '已跳过（--no-send）' });
    return { ok: true, message: text, steps, login: onebot.login, skippedSend: true };
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
    return { ok: true, message: text, steps, login: onebot.login, messageId: body?.message_id };
  } catch (error) {
    steps.push({ name: '发送消息', ok: false, detail: String(error?.message ?? error) });
    return { ok: false, error: `发送失败：${error?.message ?? error}`, message: text, steps };
  }
}
