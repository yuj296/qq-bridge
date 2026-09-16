// 控制台增强功能综合测试（node 直接调 API）
//
// 做法：把当前 src/ 复制成一个**隔离实例**（自己的 config.json / state / roles / 控制台端口 3210），
// 用假 OneBot（HTTP 3211 + WS 3212）连它，再对它的控制台 API 断言。这样：
//   · 测的是**磁盘上当前的源码**，不受运行中那台桥接进程影响（它可能是改造前启动的旧代码）；
//   · 不会往真 QQ 发消息，也不会把测试数据写进线上 config.json / roles/。
//
// 用法：node scripts/test-console.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = path.join(REPO, '.console-test');
const BOT_QQ = 20003;
const OWNER_QQ = 10001;
const TEST_QQ = 123456789;      // 临时加进私聊白名单的测试号（私聊测试发送用）
const OUTSIDE_QQ = 987654321;   // 不在白名单，用于「发送被拒」用例
const CONSOLE_PORT = 3210;
const HTTP_PORT = 3211;
const WS_PORT = 3212;
const BASE = `http://127.0.0.1:${CONSOLE_PORT}`;
const TOKEN = 'console-test-token-0123456789'; // 桥接要求 16~128 位 [A-Za-z0-9_-]
// 管理端最敏感的写操作（改令牌/白名单/重启/清工作区）现在额外要求「同源 Origin 或
// x-console-admin: 1」——目的是让持有控制台令牌的 MCP 子进程改不了这些。测试脚本以
// 管理端身份调用，所以显式声明这个头。
const authHeaders = { 'x-console-token': TOKEN, 'x-console-admin': '1' };
const TEST_ROLE = '控制台自测人格Tmp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 控制台鉴权走 x-console-token；超时/无响应也归一化成失败的返回体（而不是把整个脚本挂死）
const api = async (p, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  try {
    const res = await fetch(BASE + p, {
      method: method || 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    return { status: res.status, body: await res.json() };
  } catch (e) {
    return { status: 0, body: { ok: false, error: `请求失败/超时：${e?.message ?? e}` }, transport: true };
  }
};

let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

let child = null;
let wss = null;
let httpServer = null;

try {
  // ── 0. 搭隔离实例 ─────────────────────────────────────────────────────────
  console.log('=== 0. 隔离实例（复制 src + 独立 config/state/roles/端口）===');
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(TMP, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO, 'public'), path.join(TMP, 'public'), { recursive: true });
  fs.cpSync(path.join(REPO, 'roles'), path.join(TMP, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    ownerQQ: OWNER_QQ,
    consoleToken: TOKEN,
    snowluma: { wsUrl: `ws://127.0.0.1:${WS_PORT}`, httpUrl: `http://127.0.0.1:${HTTP_PORT}` },
    allow: { private: [OWNER_QQ] },
    deny: { private: [] },
    consolePort: CONSOLE_PORT,
    sessionCwd: TMP,
    agentPreset: 'qq-chat',
    socialV2: { enabled: true }
  }, null, 2));
  fs.writeFileSync(path.join(TMP, 'state', 'mode.json'), JSON.stringify({ mode: 'chat' }));
  fs.writeFileSync(path.join(TMP, 'state', 'current-role.json'), JSON.stringify({ role: '小鲸鱼', mode: 'active' }));
  ok('隔离实例已就绪', fs.existsSync(path.join(TMP, 'src', 'bridge.js')), TMP);

  // 假 OneBot：HTTP + WS 都回 ok，任何 send_* 都返回 message_id
  httpServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
  await new Promise((r) => httpServer.listen(HTTP_PORT, '127.0.0.1', r));

  let bridgeWs = null;
  wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    bridgeWs = ws;
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.echo === undefined) return;
      const data = msg.action === 'get_login_info'
        ? { user_id: BOT_QQ, nickname: '小鲸鱼' }
        : (/^send_/.test(String(msg.action)) ? { message_id: 1 } : {});
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
    });
  });
  await new Promise((r) => wss.on('listening', r));
  ok(`假 OneBot 已监听（HTTP ${HTTP_PORT} / WS ${WS_PORT}）`, true);

  child = spawn(process.execPath, [path.join(TMP, 'src', 'bridge.js')], {
    cwd: TMP,
    stdio: ['ignore', 'inherit', 'inherit']
  });
  console.log('  · 桥接进程已启动 pid=' + child.pid);

  let consoleReady = false;
  for (let i = 0; i < 80; i++) {
    const probe = await api('/api/status');
    if (probe.status === 200) { consoleReady = true; break; }
    await sleep(500);
  }
  ok('隔离实例控制台已就绪', consoleReady, BASE);

  // ── 1. 页面 ───────────────────────────────────────────────────────────────
  console.log('\n=== 1. 页面 ===');
  let r = null;
  const page = await fetch(BASE + '/', { headers: authHeaders, signal: AbortSignal.timeout(15000) });
  const html = await page.text();
  ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格（角色扮演）') && html.includes('测试发送'), `长度 ${html.length}`);

  // ── 2. 角色 ───────────────────────────────────────────────────────────────
  console.log('\n=== 2. 角色 ===');
  r = await api('/api/roles');
  const origRole = r.body.current ?? null;
  ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

  r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
  ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
  r = await api('/api/roles');
  ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

  r = await api('/api/role', 'POST', { role: TEST_ROLE });
  ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
  r = await api('/api/role', 'POST', { role: null });
  ok('清除角色', r.body.ok === true && r.body.role === null);
  if (origRole) {
    r = await api('/api/role', 'POST', { role: origRole });
    ok('恢复原角色', r.body.ok === true && r.body.role === origRole, origRole);
  }

  // ── 3. 会话映射 / 挂起列表 ────────────────────────────────────────────────
  console.log('\n=== 3. 会话映射 / 挂起列表 ===');
  r = await api('/api/sessions');
  ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

  r = await api('/api/pending');
  ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

  // ── 4. 白名单：读原值 → 加测试私聊号 → 恢复 ────────────────────────────────
  console.log('\n=== 4. 白名单（只针对私聊）===');
  r = await api('/api/whitelist');
  const origAllow = r.body.allow;
  ok('白名单读取', origAllow && Array.isArray(origAllow.private), JSON.stringify(origAllow));
  const testPrivates = [...new Set([...(origAllow.private || []), TEST_QQ])];
  r = await api('/api/whitelist', 'POST', { allow: { private: testPrivates }, deny: { private: [] } });
  ok('白名单写入（含测试私聊号）', r.body.ok === true && r.body.allow.private.includes(TEST_QQ), JSON.stringify(r.body.allow));
  r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [] } });
  // 读接口返回的是字符串号（normalizeIdList），写接口回的是数字号（toNum），比较时按数字归一
  const normIds = (x) => JSON.stringify([...(x?.private ?? [])].map(Number).sort((a, b) => a - b));
  ok('白名单恢复原值', r.body.ok === true && normIds(r.body.allow) === normIds(origAllow) && !('groups' in (r.body.allow || {})), JSON.stringify(r.body.allow));

  // ── 5. 群聊能力已从控制台移除（回归断言）─────────────────────────────────
  console.log('\n=== 5. 群聊能力已从控制台移除（回归断言）===');
  const pageSrc = fs.readFileSync(path.join(REPO, 'public', 'console.html'), 'utf8');
  const pageServed = html;
  const countQun = (pageSrc.match(/群/g) || []).length;
  ok('控制台页面里不再出现「群」字样', countQun === 0, `public/console.html 命中 ${countQun} 处`);
  ok('控制台返回的页面里也没有「群」字样', !pageServed.includes('群'));

  const deadFields = ['sendGroup', 'sendBurst', 'getActiveMembers', 'allow.groups', 'deny.groups', 'allowGroups',
    'proactiveEnabled', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'activeDuration',
    'triggerProbability', 'mustReplyKeywords', 'skipProbability'];
  const hitFields = deadFields.filter((f) => pageSrc.includes(f));
  ok('页面不再引用已删字段', hitFields.length === 0, hitFields.join(', '));

  // 内联脚本语法 + getElementById 全部命中（防止「删了控件忘了删逻辑」）
  const blocks = [...pageSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let syntaxErr = null;
  for (const b of blocks) { try { new Function(b); } catch (e) { syntaxErr = e.message; } }
  ok('页面内联脚本语法可编译', blocks.length > 0 && !syntaxErr, syntaxErr || `${blocks.length} 个 script 块`);
  const ids = new Set([...pageSrc.matchAll(/ id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...pageSrc.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  const dangling = refs.filter((x) => !ids.has(x));
  ok('页面没有指向已删控件的 getElementById', dangling.length === 0, dangling.join(', '));

  // 白名单接口：只有 allow.private / deny.private / ownerQQ
  r = await api('/api/whitelist');
  const wlKeys = Object.keys(r.body).sort().join(',');
  ok('GET /api/whitelist 不含 groups 字段',
    !('groups' in (r.body.allow || {})) && !('groups' in (r.body.deny || {})) && wlKeys === 'allow,deny,ownerQQ',
    wlKeys);

  // POST 传 groups：不能写进 config.json
  r = await api('/api/whitelist', 'POST', {
    allow: { private: origAllow.private || [], groups: [999888777] },
    deny: { private: [], groups: [111222333] }
  });
  const cfgAfter = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
  ok('POST /api/whitelist 传 groups 不会写进 config.json',
    r.body.ok === true && !('groups' in (cfgAfter.allow || {})) && !('groups' in (cfgAfter.deny || {})),
    JSON.stringify({ allow: cfgAfter.allow, deny: cfgAfter.deny }));

  // 状态接口：不含 allowGroups
  r = await api('/api/status');
  ok('GET /api/status 不含 allowGroups', !('allowGroups' in r.body) && Array.isArray(r.body.allowPrivate), Object.keys(r.body).join(','));

  // 已删路由
  r = await api('/api/send/group', 'POST', { groupId: 123456789, message: 'x' });
  ok('POST /api/send/group 已删除（404）', r.status === 404 && r.body.ok === false, `${r.status} ${JSON.stringify(r.body)}`);
  r = await api('/api/socialV2/active-members', 'POST', { key: `private:${OWNER_QQ}` });
  ok('POST /api/socialV2/active-members 已删除（404）', r.status === 404 && r.body.ok === false, `${r.status} ${JSON.stringify(r.body)}`);

  // ── 6. 页面保存路径冒烟 ───────────────────────────────────────────────────
  console.log('\n=== 6. 页面保存路径冒烟 ===');
  // 页面「保存社交配置」走的那条路径仍然可用（这次页面删掉了若干控件，顺带冒烟一次）
  r = await api('/api/social', 'POST', { activeCheckMinMs: 10000, activeCheckMaxMs: 30000, contextWindow: 20, maxReplyChars: 500, burstEnabled: true });
  ok('POST /api/social 仍可用（页面保存社交配置路径）', r.body.ok === true && Number(r.body.config?.contextWindow) === 20, JSON.stringify(r.body.config ? 'config ok' : r.body));

  // ── 7. 清理测试人格 ───────────────────────────────────────────────────────
  console.log('\n=== 7. 清理测试人格 ===');
  const tmpRolesDir = path.join(TMP, 'roles');
  const tmpRolePath = path.join(tmpRolesDir, TEST_ROLE + '.md');
  const roleExisted = fs.existsSync(tmpRolePath);
  const rolesBefore = fs.existsSync(tmpRolesDir) ? fs.readdirSync(tmpRolesDir) : [];
  let delErr = null;
  try { fs.rmSync(tmpRolePath, { force: true }); } catch (e) { delErr = `rmSync:${e?.code}`; }
  if (fs.existsSync(tmpRolePath)) {
    // 实测：本机 rmSync(force) 对「由子进程刚创建的文件」会静默不生效（不抛错也不删），
    // 所以这里补一次 unlinkSync 兜底，并把现象打进断言附加信息里。
    delErr = (delErr ? delErr + ' ' : '') + 'rmSync 未生效';
    try { fs.unlinkSync(tmpRolePath); } catch (e) { delErr += ` unlinkSync:${e?.code}`; }
  }
  r = await api('/api/roles');
  ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE),
    `删除前存在=${roleExisted} 删除后存在=${fs.existsSync(tmpRolePath)} 目录=${JSON.stringify(rolesBefore)} 删除过程=${delErr} API=${JSON.stringify(r.body.roles)}`);
  ok('测试人格没有落进仓库 roles/', !fs.existsSync(path.join(REPO, 'roles', TEST_ROLE + '.md')));

  // ── 8. 私聊测试发送（走假 OneBot，不会真发 QQ）────────────────────────────
  console.log('\n=== 8. 私聊测试发送 ===');
  r = await api('/api/whitelist', 'POST', { allow: { private: testPrivates }, deny: { private: [] } });
  ok('测试私聊号已加入白名单（发送前置条件）', r.body.ok === true && r.body.allow.private.includes(TEST_QQ), JSON.stringify(r.body.allow));

  r = await api('/api/test-send', 'POST', { kind: 'private', id: String(TEST_QQ), message: '【控制台自测】私聊测试发送成功 ✅' });
  ok('私聊测试发送', r.body.ok === true, JSON.stringify(r.body));

  r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [] } });
  ok('测试私聊号已移出白名单', r.body.ok === true && !r.body.allow.private.includes(TEST_QQ), JSON.stringify(r.body.allow));

  r = await api('/api/test-send', 'POST', { kind: 'private', id: String(OUTSIDE_QQ), message: 'x' });
  ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));
} catch (e) {
  ok('测试过程未抛异常', false, String(e?.stack ?? e).split('\n')[0]);
} finally {
  try { child?.kill(); } catch {}
  try { wss?.close(); } catch {}
  try { httpServer?.close(); } catch {}
  await sleep(600);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
