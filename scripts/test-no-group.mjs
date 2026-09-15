// 回归测试：群聊能力已彻底移除，只保留私聊。
//
// 做法：把当前 src/ 复制成一个隔离实例（自己的 config.json / state / 端口），
// 用假 OneBot 服务端（HTTP 3010 + WS 3011）连它，先灌一条**群消息**、再灌一条**私聊**，然后断言：
//   ① 群消息完全不进桥接（social-v2 状态里没有 group: 会话；假 OneBot 没收到任何群目标发送）
//   ② 私聊照常被处理（social-v2 状态里出现 private:10001）—— 证明桥接是活的、不是"什么都不干"
//   ③ 源码层：bridge.js 里不再注册群消息处理、不再有群发送分支
//
// 用法：node scripts/test-no-group.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = path.join(REPO, '.degroup-test');
const BOT_QQ = 20002;
const OWNER_QQ = 10001;
const GROUP_ID = 900001;
const OTHER_QQ = 10002;
const HTTP_PORT = 3010;
const WS_PORT = 3011;

const results = [];
const ok = (name, extra = '') => { results.push({ pass: true, name }); console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); };
const bad = (name, extra = '') => { results.push({ pass: false, name }); console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本机实测：fs.rmSync(recursive/force) 对「由子进程刚创建的文件」会静默不删（不抛错也不删），
// 所以这里手写兜底：先 rmSync，再逐文件 unlinkSync。
function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!fs.existsSync(dir)) return;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { fs.unlinkSync(p); } catch {} }
    }
  };
  try { walk(dir); fs.rmdirSync(dir, { recursive: true }); } catch {}
}

// ── 1. 源码静态断言 ─────────────────────────────────────────────────────────
console.log('=== 1. 源码：群聊入口已移除 ===');
const bridgeSrc = fs.readFileSync(path.join(REPO, 'src', 'bridge.js'), 'utf8');
const statics = [
  ['不再注册群消息处理', !bridgeSrc.includes('onGroupMessage')],
  ['不再处理 group 类型入站', !bridgeSrc.includes("handleIncoming('group'")],
  ['不再有群发送分支', !bridgeSrc.includes('sendGroupMessage')],
  ['不再有群拍一拍分支', !bridgeSrc.includes('group_poke')],
  ['不再解析群成员名片', !bridgeSrc.includes('resolveGroupMemberName')],
  ['会话 key 只接受 private:', !bridgeSrc.includes('(group|private)')],
  ['不再读 allow.groups / deny.groups', !/allow\?\.groups|deny\?\.groups|allow\.groups|deny\.groups/.test(bridgeSrc)],
  ['群专属社交分支已删（活跃退场/群里开话题/选择性沉默）',
    !bridgeSrc.includes('triggerActiveDurationExit') && !bridgeSrc.includes('buildProactivePrompt') &&
    !bridgeSrc.includes('activeDurationEnabled') && !bridgeSrc.includes('proactiveProbability')],
  ['speakerIds（指定群友唤醒）已删', !bridgeSrc.includes('speakerIds')],
];
for (const [name, cond] of statics) cond ? ok(name) : bad(name);

// ── 2. 搭隔离实例 ───────────────────────────────────────────────────────────
console.log('\n=== 2. 搭隔离实例（复制 src + 独立 config/state/端口）===');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });fs.cpSync(path.join(REPO, 'src'), path.join(TMP, 'src'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  ownerQQ: OWNER_QQ,
  snowluma: { wsUrl: `ws://127.0.0.1:${WS_PORT}`, httpUrl: `http://127.0.0.1:${HTTP_PORT}` },
  allow: { private: [OWNER_QQ] },
  deny: { private: [] },
  consolePort: 3110,
  sessionCwd: TMP,
  agentPreset: 'qq-chat',
  socialV2: { enabled: true }
}, null, 2));
fs.writeFileSync(path.join(TMP, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
ok('隔离实例已就绪', TMP);

// ── 3. 假 OneBot ────────────────────────────────────────────────────────────
const seenApi = [];
const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seenApi.push({ action: String(req.url ?? '').replace(/^\//, ''), body: body.slice(0, 200) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => httpServer.listen(HTTP_PORT, '127.0.0.1', r));

const wsApi = [];
let bridgeWs = null;
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  bridgeWs = ws;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.echo === undefined) return;
    wsApi.push({ action: msg.action, params: msg.params ?? {} });
    const data = msg.action === 'get_login_info'
      ? { user_id: BOT_QQ, nickname: '小鲸鱼' }
      : (/^send_/.test(String(msg.action)) ? { message_id: 1 } : {});
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
  });
});
await new Promise((r) => wss.on('listening', r));
ok(`假 OneBot 已监听（HTTP ${HTTP_PORT} / WS ${WS_PORT}）`);

// ── 4. 起桥接（stdio 继承，避免沙箱拦管道）──────────────────────────────────
const child = spawn(process.execPath, [path.join(TMP, 'src', 'bridge.js')], {
  cwd: TMP,
  stdio: ['ignore', 'inherit', 'inherit']
});
console.log('  · 桥接进程已启动 pid=' + child.pid);

const connected = await (async () => {
  for (let i = 0; i < 60; i++) { if (bridgeWs) return true; await sleep(500); }
  return false;
})();
connected ? ok('桥接已连上假 OneBot') : bad('桥接未连上假 OneBot（后续断言不可信）');

const readState = () => {
  try { return fs.readFileSync(path.join(TMP, 'state', 'social-v2.json'), 'utf8'); } catch { return ''; }
};
const inject = (evt) => {
  if (!bridgeWs) return false;
  bridgeWs.send(JSON.stringify({
    post_type: 'message', message_id: Math.floor(Math.random() * 1e6), self_id: BOT_QQ,
    time: Math.floor(Date.now() / 1000), ...evt
  }));
  return true;
};

// ── 5. 灌一条群消息：必须什么都不发生 ──────────────────────────────────────
console.log('\n=== 3. 群消息：必须被完全忽略 ===');
await sleep(2500);
const before = readState();
inject({
  message_type: 'group', sub_type: 'normal', group_id: GROUP_ID, user_id: OTHER_QQ,
  sender: { user_id: OTHER_QQ, nickname: '路人甲', card: '路人甲' },
  message: [{ type: 'text', data: { text: '小鲸鱼在吗' } }], raw_message: '小鲸鱼在吗', font: 0
});
await sleep(8000);
const afterGroup = readState();
afterGroup.includes('group:') ? bad('状态里出现了 group: 会话', afterGroup.slice(0, 200)) : ok('群消息没有产生任何 group: 会话');
afterGroup === before ? ok('群消息完全没有改动状态文件') : bad('群消息改动了状态文件');
const groupSend = wsApi.filter((c) => /group_id|group_poke|send_group/.test(JSON.stringify(c.params)) || /group/.test(String(c.action)));
groupSend.length === 0 ? ok('假 OneBot 没收到任何群目标 API 调用') : bad('出现了群目标调用', JSON.stringify(groupSend).slice(0, 200));
const groupHttp = seenApi.filter((c) => /group/.test(String(c.action)));
groupHttp.length === 0 ? ok('没有群相关 HTTP API 调用') : bad('出现了群相关 HTTP 调用', JSON.stringify(groupHttp).slice(0, 120));

// ── 6. 契约：/api/send/reply 读 userId、/api/send/group 已删 ────────────────
console.log('\n=== 5. 发送接口契约（MCP 的 qq_reply 依赖这条）===');
let consoleToken = '';
for (let i = 0; i < 20 && !consoleToken; i++) {
  try { consoleToken = fs.readFileSync(path.join(TMP, 'state', 'console-token'), 'utf8').trim(); } catch {}
  if (!consoleToken) await sleep(500);
}
consoleToken ? ok('已读到隔离实例的控制台令牌（用于越过全局令牌闸门）') : bad('读不到控制台令牌，契约断言不可信');
const post = async (p, body) => {
  try {
    const res = await fetch(`http://127.0.0.1:3110${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(consoleToken ? { 'x-console-token': consoleToken } : {}) },
      body: JSON.stringify(body)
    });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: String(error?.message ?? error) };
  }
};
const replyRes = await post('/api/send/reply', { userId: String(OWNER_QQ), replyToMessageId: 1, message: 'x' });
(!replyRes.text.includes('目标 id 和 message 不能为空') && replyRes.status !== 401)
  ? ok('/api/send/reply 读 userId（不再因为 groupId 空而 400）', `status=${replyRes.status} ${replyRes.text.slice(0, 60).replace(/\s+/g, ' ')}`)
  : bad('/api/send/reply 仍在读 groupId（或令牌没生效）', `${replyRes.status} ${replyRes.text.slice(0, 120)}`);
const groupRes = await post('/api/send/group', { groupId: GROUP_ID, message: 'x' });
(groupRes.status === 404 || groupRes.status === 401 || /not found|Cannot POST|未知|Invalid/i.test(groupRes.text) || groupRes.text.trim() === '')
  ? ok('/api/send/group 已不存在', `status=${groupRes.status}`)
  : bad('/api/send/group 仍被处理', `${groupRes.status} ${groupRes.text.slice(0, 120)}`);

// ── 7. 灌一条私聊：必须照常处理（证明桥接活着）─────────────────────────────
console.log('\n=== 6. 私聊：必须照常处理（对照组）===');
inject({
  message_type: 'private', sub_type: 'friend', user_id: OWNER_QQ,
  sender: { user_id: OWNER_QQ, nickname: '主人' },
  message: [{ type: 'text', data: { text: '（群聊改造回归测试，可忽略）' } }],
  raw_message: '（群聊改造回归测试，可忽略）', font: 0
});
let sawPrivate = false;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  if (readState().includes(`private:${OWNER_QQ}`)) { sawPrivate = true; break; }
}
sawPrivate ? ok(`私聊已建会话 private:${OWNER_QQ}（桥接正常工作）`) : bad('私聊没有被处理（可能桥接没起来）');

// ── 7. 私聊发送链路必须真的通（回归：会话 key 解析 + 白名单 + 发送）─────────
console.log('\n=== 7. 私聊发送链路必须真的把消息发到 QQ ===');
let agentToken = '';
try {
  const stV2 = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'social-v2.json'), 'utf8'));
  agentToken = stV2?.conversations?.[`private:${OWNER_QQ}`]?.agentToken ?? '';
} catch {}
if (!agentToken) {
  bad('拿不到会话令牌，跳过发送链路断言');
} else {
  // 桥接走 OneBot HTTP API 发送（onebotSend → httpUrl），所以数 HTTP 侧的调用
  const countSends = () => seenApi.filter((c) => c.action === 'send_private_msg').length
    + wsApi.filter((c) => c.action === 'send_private_msg').length;
  const beforeSends = countSends();
  const sendRes = await post('/api/send/private', {
    userId: String(OWNER_QQ), message: '回归自测：私聊发送链路', token: agentToken
  });
  await sleep(3000);
  const afterSends = countSends();
  afterSends > beforeSends
    ? ok('私聊发送到达 QQ（假 OneBot 收到 send_private_msg）', `${beforeSends} -> ${afterSends}`)
    : bad('私聊发送没有到达 QQ（key 解析/白名单/发送链可能有回归）', `status=${sendRes.status} ${sendRes.text.slice(0, 160)}`);
}

// ── 8. 收尾 ────────────────────────────────────────────────────────────────
try { child.kill(); } catch {}
wss.close(); httpServer.close();
await sleep(600);
rmrf(TMP);

const failed = results.filter((r) => !r.pass);
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { failed.forEach((f) => console.log('  ✗ ' + f.name)); process.exit(1); }
console.log('✅ 群聊已被彻底移除，私聊不受影响');
process.exit(0);
