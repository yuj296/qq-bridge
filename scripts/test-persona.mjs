// 回归测试：设置页「性格与人设」组真的进了提示词。
//
// 做法：把当前 src/ 复制成隔离实例（独立 config / state / 端口），用假 OneBot 连它，
// 再直接查桥接自己的 `/api/socialV2/prompt`——这正是 `qq_get_prompt` 工具的数据源，
// 返回的 `role.hint` 就是桥接注入给 agent 的那段人设前缀（单条投递 / 一代社交 /
// 上下文投递 / 二代 getPrompt 共用的同一个出口）。四种情形都要成立：
//   ① 角色卡 + 性格都填 → 两段都在，且**角色卡在前、性格在后**（越靠后越优先）
//   ② 二代（reserved2）路径 → 性格段不被一代指令过滤器误删
//   ③ persona.enabled=false → 性格段一个字都不注入（角色卡照旧）
//   ④ 六格全留空且没建角色卡 → role.hint 是空串（不填就不改它的人设，即保持现状）
//
// 用法：node scripts/test-persona.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { FIELDS, GROUPS } from '../plugins/qq-mode-console/lib/schema.js';
import { applyOverrides } from '../src/settings-merge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = path.join(REPO, '.persona-test');
const BOT_QQ = 20002;
const OWNER_QQ = 10001;
const OB_HTTP = 3012;
const OB_WS = 3013;
const CONSOLE_PORT = 3120;
const ROLE_NAME = '测试角色';
const ROLE_MARK = '角色卡标记：嘴硬心软的老朋友';

const PERSONA_FULL = {
  enabled: true,
  name: '小D',
  personality: '慢热、嘴硬心软',
  tone: '随意直接，不堆敬语',
  speechStyle: '短句为主，不用 emoji',
  habits: '同意时先说"行"',
  taboo: '不许自称 AI 助手'
};

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

// ── 1. 源码 / 字段表静态断言 ────────────────────────────────────────────────
console.log('=== 1. 字段表与源码：性格设置接线在位 ===');
const PERSONA_PATHS = [
  'persona.enabled', 'persona.name', 'persona.personality',
  'persona.tone', 'persona.speechStyle', 'persona.habits', 'persona.taboo'
];
{
  const declared = FIELDS.map(([p]) => p);
  const missing = PERSONA_PATHS.filter((p) => !declared.includes(p));
  missing.length === 0 ? ok('7 个 persona.* 字段都在字段表里') : bad('字段表缺项', missing.join(', '));
  GROUPS.persona !== undefined ? ok('分组「性格与人设」已定义', GROUPS.persona.title) : bad('GROUPS 里没有 persona');

  const schemaSrc = fs.readFileSync(path.join(REPO, 'plugins', 'qq-mode-console', 'lib', 'schema.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(REPO, 'plugins', 'qq-mode-console', 'lib', 'client.js'), 'utf8');
  /persona\s*:\s*\{/.test(clientSrc) ? ok('客户端半侧有 persona 分组兜底表') : bad('client.js 缺 persona 分组（设置页不会渲染它）');
  /GROUP_ORDER = \[[^\]]*"persona"/.test(clientSrc) ? ok('分组顺序表里 persona 靠前（紧跟基本）') : bad('GROUP_ORDER 里没有 persona');

  const example = JSON.parse(fs.readFileSync(path.join(REPO, 'config.example.json'), 'utf8'));
  const exKeys = Object.keys(example.persona ?? {});
  const same = PERSONA_PATHS.every((p) => exKeys.includes(p.split('.')[1]));
  same ? ok('config.example.json 里有完整的 persona 段') : bad('config.example.json 的 persona 段不全', exKeys.join(', '));

  const bridgeSrc = fs.readFileSync(path.join(REPO, 'src', 'bridge.js'), 'utf8');
  const statics = [
    ['bridge.js 有 personaBlock()', /function personaBlock\(\)/.test(bridgeSrc)],
    ['currentRoleHint() 调用了 personaBlock()', /const persona = personaBlock\(\)/.test(bridgeSrc)],
    ['性格段拼在角色卡之后（越靠后越优先）', /\$\{roleText\}\\n\\n\$\{persona\}/.test(bridgeSrc)],
    ['角色卡缺失时仍注入性格段', /if \(!rs\.role\) return persona;/.test(bridgeSrc)],
    ['身份判定行没被动过（【消息来源】仍在）', (bridgeSrc.match(/【消息来源】/g) ?? []).length >= 3],
    ['loadConfig 里有 persona 默认段', /persona: \{\s*\n\s*enabled: true/.test(bridgeSrc)],
    ['性格段标题里不含「消息来源」（不会污染身份判定）', !/personaBlock[\s\S]{0,1200}消息来源/.test(bridgeSrc)]
  ];
  for (const [name, cond] of statics) cond ? ok(name) : bad(name);
}

// ── 1b. 设置页那一半：user 层只覆盖你改过的那一格（纯函数，不需要实例）──────
console.log('\n=== 1b. 设置页 → cfg：只覆盖你在页面里改过的那一格 ===');
{
  const fresh = {
    persona: { enabled: true, name: '旧名', personality: '旧性格', tone: '', speechStyle: '', habits: '', taboo: '' }
  };
  const cfg = { ...structuredClone(fresh), ownerQQ: 1, allow: { private: [1] }, consolePort: 3100 };
  const round1 = applyOverrides({
    target: cfg,
    user: { persona: { personality: '新性格' } },
    applied: new Set(),
    freshConfig: null
  });
  cfg.persona?.personality === '新性格' ? ok('改过的那一格被覆盖进 cfg') : bad('改过的格子没生效', JSON.stringify(cfg.persona));
  cfg.persona?.name === '旧名' ? ok('同一组里没改的格子一个字都没动') : bad('未改动的格子被牵连', JSON.stringify(cfg.persona));
  (cfg.ownerQQ === 1 && Array.isArray(cfg.allow?.private) && cfg.consolePort === 3100)
    ? ok('cfg 其它部分没被牵连') : bad('cfg 其它部分被改动了');

  const round2 = applyOverrides({ target: cfg, user: {}, applied: round1.applied, freshConfig: fresh });
  cfg.persona?.personality === '旧性格' ? ok('在设置页撤销后回到磁盘上的值') : bad('撤销没有还原', JSON.stringify(cfg.persona));
  round2.revoked.includes('persona.personality') ? ok('撤销被识别为 persona.personality') : bad('撤销路径不对', round2.revoked.join(', '));

  const cfg2 = { persona: { enabled: true } };
  applyOverrides({ target: cfg2, user: { persona: { enabled: false } }, applied: new Set(), freshConfig: null });
  cfg2.persona.enabled === false ? ok('总开关关掉能传进 cfg（personaBlock 会据此不注入）') : bad('开关没生效');
}

// ── 2. 搭隔离实例（src 只复制一次，config/mode 每个场景重写）──────────────────
console.log('\n=== 2. 搭隔离实例（复制 src + 独立 config/state/端口）===');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
fs.cpSync(path.join(REPO, 'src'), path.join(TMP, 'src'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'roles'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'roles', ROLE_NAME + '.md'), `# ${ROLE_NAME}\n\n${ROLE_MARK}\n`);

const seenApi = [];
const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seenApi.push({ action: String(req.url ?? '').replace(/^\//, ''), body: body.slice(0, 120) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => httpServer.listen(OB_HTTP, '127.0.0.1', r));

const wss = new WebSocketServer({ port: OB_WS, host: '127.0.0.1' });
wss.on('connection', (ws) => {
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
ok(`假 OneBot 已监听（HTTP ${OB_HTTP} / WS ${OB_WS}）`);

let child = null;

/** 起一个隔离桥接，等它把 /api/socialV2/prompt 服务起来，返回 role.hint。 */
async function hintWith({ mode, persona, withRole }) {
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    ownerQQ: OWNER_QQ,
    snowluma: { wsUrl: `ws://127.0.0.1:${OB_WS}`, httpUrl: `http://127.0.0.1:${OB_HTTP}` },
    // 故意指向死端口 + 不存在的 harness.log：隔离实例必须够不着真 DSH。
    // 否则它会从 DSH 设置页的 qq-mode 命名空间拉 mode 与 persona，把测试用的 config 覆盖掉，
    // 结果就会随「主人当前在设置页里填了什么」而变 —— 那样的测试不可信。
    dsh: { baseUrl: 'http://127.0.0.1:9', harnessLog: 'D:\\nonexistent\\harness.log' },
    allow: { private: [OWNER_QQ] },
    deny: { private: [] },
    consolePort: CONSOLE_PORT,
    sessionCwd: TMP,
    agentPreset: 'qq-chat',
    persona,
    socialV2: { enabled: true }
  }, null, 2));
  fs.writeFileSync(path.join(TMP, 'state', 'mode.json'), JSON.stringify({ mode }));
  if (withRole) {
    fs.writeFileSync(path.join(TMP, 'state', 'current-role.json'), JSON.stringify({ role: ROLE_NAME, mode: 'active' }));
  } else {
    try { fs.unlinkSync(path.join(TMP, 'state', 'current-role.json')); } catch {}
  }
  try { fs.unlinkSync(path.join(TMP, 'state', 'bridge.lock')); } catch {}
  try { fs.unlinkSync(path.join(TMP, 'state', 'console-token')); } catch {}

  child = spawn(process.execPath, [path.join(TMP, 'src', 'bridge.js')], {
    cwd: TMP,
    stdio: ['ignore', 'ignore', 'inherit']   // stdout 静音（四个实例的启动日志太吵），stderr 留着看错误
  });

  // 控制台走全局令牌闸门（config 没写 consoleToken 时桥接自己生成一个），先等它落盘。
  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    await sleep(500);
    try { token = fs.readFileSync(path.join(TMP, 'state', 'console-token'), 'utf8').trim(); } catch {}
  }
  if (!token) return null;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/socialV2/prompt?key=private:${OWNER_QQ}`, {
        headers: { 'x-console-token': token }
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.ok === true) return String(data.role?.hint ?? '');
      }
    } catch {}
    await sleep(500);
  }
  return null;
}

async function stopBridge() {
  if (child === null) return;
  const dead = new Promise((r) => child.once('exit', r));
  try { child.kill(); } catch {}
  await Promise.race([dead, sleep(5000)]);
  child = null;
  try { fs.unlinkSync(path.join(TMP, 'state', 'bridge.lock')); } catch {}
  await sleep(800);
}

// ── 3. 角色卡 + 性格都填（一代 chat 路径）────────────────────────────────────
console.log('\n=== 3. 角色卡 + 性格都填：两段都在，且性格在后 ===');
{
  const hint = await hintWith({ mode: 'chat', persona: PERSONA_FULL, withRole: true });
  if (hint === null) {
    bad('拿不到 role.hint（隔离实例没起来，后续断言不可信）');
  } else {
    const hasRole = hint.includes(ROLE_MARK);
    const hasPersona = hint.includes('【性格设定】');
    hasRole && hasPersona ? ok('角色卡与性格段都在提示词里') : bad('有一段没注入', `role=${hasRole} persona=${hasPersona}`);
    if (hasRole && hasPersona) {
      hint.indexOf(ROLE_MARK) < hint.indexOf('【性格设定】')
        ? ok('角色卡在前、性格在后（冲突时以性格为准）')
        : bad('顺序反了：性格段跑到角色卡前面去了');
    }
    const missing = Object.values(PERSONA_FULL).filter((v) => typeof v === 'string' && !hint.includes(v));
    missing.length === 0 ? ok('六格内容都真的写进了提示词') : bad('有内容没进提示词', missing.join(' / '));
    !hint.includes('消息来源') ? ok('性格段没有污染身份判定行') : bad('性格段里混进了「消息来源」字样');
  }
  await stopBridge();
}

// ── 4. 二代（reserved2）路径：过滤器不能吃掉性格段 ──────────────────────────
console.log('\n=== 4. 二代路径：性格段不被一代指令过滤器误删 ===');
{
  const hint = await hintWith({ mode: 'reserved2', persona: PERSONA_FULL, withRole: true });
  if (hint === null) {
    bad('拿不到 role.hint');
  } else {
    (hint.includes('【性格设定】') && hint.includes(PERSONA_FULL.taboo) && hint.includes(ROLE_MARK))
      ? ok('二代 qq_get_prompt 里角色卡与性格段都在')
      : bad('二代路径丢了内容', hint.slice(0, 200));
  }
  await stopBridge();
}

// ── 5. 总开关关掉：一个字都不注入 ──────────────────────────────────────────
console.log('\n=== 5. persona.enabled=false：性格段完全不注入 ===');
{
  const hint = await hintWith({ mode: 'chat', persona: { ...PERSONA_FULL, enabled: false }, withRole: true });
  if (hint === null) {
    bad('拿不到 role.hint');
  } else {
    (!hint.includes('【性格设定】') && !hint.includes(PERSONA_FULL.personality))
      ? ok('关掉开关后性格内容一个字都没注入')
      : bad('关掉开关后仍然注入了性格段', hint.slice(0, 200));
    hint.includes(ROLE_MARK) ? ok('关掉开关不影响角色卡（各管各的）') : bad('角色卡被连带干掉了');
  }
  await stopBridge();
}

// ── 6. 六格全留空 + 没建角色卡：保持现状（不注入）──────────────────────────
console.log('\n=== 6. 全留空 + 无角色卡：等于没加过这组设置 ===');
{
  const hint = await hintWith({
    mode: 'chat',
    persona: { enabled: true, name: '', personality: '', tone: '', speechStyle: '', habits: '', taboo: '' },
    withRole: false
  });
  if (hint === null) {
    bad('拿不到 role.hint');
  } else {
    hint.trim() === ''
      ? ok('role.hint 是空串 —— 不填就不改它的人设')
      : bad('全空却注入了东西', hint.slice(0, 200));
  }
  await stopBridge();
}

// ── 7. 收尾 ────────────────────────────────────────────────────────────────
wss.close(); httpServer.close();
await sleep(400);
rmrf(TMP);

const failed = results.filter((r) => !r.pass);
console.log(`\n===== 汇总：${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) { failed.forEach((f) => console.log('  ✗ ' + f.name)); process.exit(1); }
console.log('✅ 性格设置真的进了提示词，留空时行为与改前一致');
process.exit(0);
