// 回归测试：桥接实例锁被「pid 复用」卡死时能不能自愈。
//
// 背景（真实故障）：旧桥接被硬杀时来不及删 state/bridge.lock；Windows 把那个 pid 复用给了
// 系统进程 dwm（pid 1112），于是新桥接的存活检查 process.kill(pid,0) 报 EPERM → 桥接打印
// 「已有实例在运行」并 exit 2，而唤醒流程不会清锁 → 点「唤醒」静默失败、bridge.log 一行都没有。
//
// 本测试覆盖两处修复：
//   ① plugins/qq-wake/lib/wake.js 的 clearStaleLock()：启动前清掉「pid 不是活着的 node」的锁
//   ② src/bridge.js 的 acquireLock()：EPERM 也当过期锁（不再 exit 2）
//
// 用法：node scripts/test-wake-lock.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { clearStaleLock } from '../plugins/qq-wake/lib/wake.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = path.join(REPO, '.wake-lock-test');
const HTTP_PORT = 3020;
const WS_PORT = 3021;
const CONSOLE_PORT = 3120;

const results = [];
const ok = (name, extra = '') => { results.push(true); console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); };
const bad = (name, extra = '') => { results.push(false); console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!fs.existsSync(dir)) return;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { fs.unlinkSync(p); } catch {} }
    }
  };
  try { walk(dir); fs.rmdirSync(dir, { recursive: true }); } catch {}
}

// ── 1. clearStaleLock 单测 ──────────────────────────────────────────────────
console.log('=== 1. clearStaleLock：该清的清、该留的留 ===');
const unitRoot = path.join(TMP, 'unit');
fs.mkdirSync(path.join(unitRoot, 'state'), { recursive: true });
const lockPath = path.join(unitRoot, 'state', 'bridge.lock');

const noLock = clearStaleLock(unitRoot);
(!noLock.cleared && noLock.pid === 0)
  ? ok('没有锁文件 → 不动', noLock.reason)
  : bad('没有锁文件时不该清', JSON.stringify(noLock));

fs.writeFileSync(lockPath, '');
const emptyLock = clearStaleLock(unitRoot);
(!emptyLock.cleared)
  ? ok('锁文件为空 → 交给桥接自己判', emptyLock.reason)
  : bad('空锁不该由这里删', JSON.stringify(emptyLock));

fs.writeFileSync(lockPath, 'abc');
const junkLock = clearStaleLock(unitRoot);
(!junkLock.cleared)
  ? ok('锁内容非数字 → 交给桥接自己判', junkLock.reason)
  : bad('非法内容不该由这里删', JSON.stringify(junkLock));

// pid 4 = Windows System：process.kill(4,0) 报 EPERM（和这次故障的 dwm 同型）
fs.writeFileSync(lockPath, '4');
const foreignLock = clearStaleLock(unitRoot);
(foreignLock.cleared && !fs.existsSync(lockPath))
  ? ok('pid 被非 node 进程占用 → 清掉', foreignLock.reason)
  : bad('被复用的锁没清掉', JSON.stringify(foreignLock));

fs.writeFileSync(lockPath, '999999');
const deadLock = clearStaleLock(unitRoot);
(deadLock.cleared && !fs.existsSync(lockPath))
  ? ok('pid 已不存在 → 清掉', deadLock.reason)
  : bad('死 pid 的锁没清掉', JSON.stringify(deadLock));

fs.writeFileSync(lockPath, String(process.pid));
const liveLock = clearStaleLock(unitRoot);
(!liveLock.cleared && fs.existsSync(lockPath))
  ? ok('pid 是活着的 node（可能真在跑）→ 不碰', liveLock.reason)
  : bad('活着的 node 实例的锁被误删了', JSON.stringify(liveLock));

// ── 2. 端到端：预置「被复用」的陈旧锁，桥接必须自己起来 ────────────────────
console.log('\n=== 2. 端到端：桥接带一个陈旧锁也必须能起来 ===');
rmrf(TMP);
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
fs.cpSync(path.join(REPO, 'src'), path.join(TMP, 'src'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  ownerQQ: 10001,
  snowluma: { wsUrl: `ws://127.0.0.1:${WS_PORT}`, httpUrl: `http://127.0.0.1:${HTTP_PORT}` },
  allow: { private: [10001] },
  deny: { private: [] },
  consolePort: CONSOLE_PORT,
  sessionCwd: TMP
}, null, 2));
fs.writeFileSync(path.join(TMP, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
// 关键：预置一个「pid 被系统进程复用」的锁（pid 4 = System，signal 0 报 EPERM）
const e2eLock = path.join(TMP, 'state', 'bridge.lock');
fs.writeFileSync(e2eLock, '4');
ok('已预置陈旧锁（内容 4，signal 0 报 EPERM）', `PID=${process.pid} 的测试进程不会受影响`);

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }));
});
await new Promise((r) => httpServer.listen(HTTP_PORT, '127.0.0.1', r));
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    const data = m.action === 'get_login_info' ? { user_id: 20002, nickname: '小鲸鱼' } : {};
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: m.echo }));
  });
});
await new Promise((r) => wss.on('listening', r));
ok(`假 OneBot 就绪（HTTP ${HTTP_PORT} / WS ${WS_PORT}）`);

const child = spawn(process.execPath, [path.join(TMP, 'src', 'bridge.js')], {
  cwd: TMP, stdio: ['ignore', 'inherit', 'inherit']
});

let up = false;
let token = '';
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { token = fs.readFileSync(path.join(TMP, 'state', 'console-token'), 'utf8').trim(); } catch {}
  if (!token) continue;
  try {
    const res = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/status`, { headers: { 'x-console-token': token } });
    if (res.ok) { up = true; break; }
  } catch {}
}
up ? ok('桥接带着陈旧锁照样起来了（EPERM 已按过期锁处理）') : bad('桥接没能起来（陈旧锁仍卡住它）');

let lockNow = '';
try { lockNow = fs.readFileSync(e2eLock, 'utf8').trim(); } catch {}
lockNow === String(child.pid)
  ? ok('锁已换成新实例自己的 pid', lockNow)
  : bad('锁内容不对', `期望 ${child.pid}，实际 ${JSON.stringify(lockNow)}`);
lockNow !== '4' ? ok('被复用的旧 pid 没有留在锁里') : bad('旧 pid 4 还在锁里');

try { child.kill(); } catch {}
wss.close(); httpServer.close();
await sleep(600);
rmrf(TMP);

const failed = results.filter((r) => !r).length;
console.log(`\n===== 汇总：${results.length - failed}/${results.length} 通过 =====`);
if (failed) process.exit(1);
console.log('✅ 实例锁自愈能力正常（唤醒不再被 pid 复用卡死）');
process.exit(0);
