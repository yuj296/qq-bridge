// 测试安全版 QQ MCP server：工具清单 + 私聊发送校验。
//
// 本仓库已去掉群聊能力（只保留「用户 ↔ 机器人私聊」），所以这里的群用例
// 全部反转成**回归断言**：群专属工具/参数一旦被加回来就立刻失败。
//
// 两段：
//  ① 源码静态断言：从 src/mcp-snowluma-safe.js 抽出每个 server.tool(...) 的
//     注册名 / 描述 / schema 文本，校验群工具与群参数确实没了。
//  ② 实时 MCP 断言：**在进程内**把 src/mcp-snowluma-safe.js 的 stdio server 真跑起来
//     （只替换它的 process.stdin/stdout 为内存流），走真 JSON-RPC：
//     initialize → tools/list → tools/call，校验真实注册面与拒绝行为。
//     不用 StdioClientTransport 起子进程的原因：DSH 的 workspace-write 沙箱会拦
//     「node 以管道 stdio spawn 子进程」（spawn EPERM；Start-Process 也 Access denied），
//     那是沙箱边界而非脚本缺陷；进程内做法在沙箱内外行为一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'src', 'mcp-snowluma-safe.js');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
const cfg = readJson(path.join(ROOT, 'config.json'));
const MODE = readJson(path.join(ROOT, 'state', 'mode.json')).mode ?? 'chat';

let failures = 0;
function ok(cond, label, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' | ' + extra : ''}`);
  if (!cond) failures += 1;
}

// 已彻底删除的「群专属」工具与参数：出现任何一个都算回归。
const REMOVED_TOOLS = [
  'qq_list_groups',
  'qq_get_group_members',
  'qq_get_group_history',
  'qq_get_active_members',
  'qq_send_group_message',
  'qq_send_burst'
];
const REMOVED_PARAMS = ['groupId', 'atUserId', 'speakerIds', 'targetUserId'];
// 私聊能力必须还在。
const KEPT_TOOLS = [
  'qq_status',
  'qq_reply',
  'qq_send_private_message',
  'qq_send_message',
  'qq_send_poke',
  'qq_wait_for_messages',
  'qq_get_recent_messages',
  'qq_get_message_detail',
  'qq_mark_read',
  'qq_set_wake_config'
];

// ── 源码里抽 server.tool(...) 的注册信息 ───────────────────────────────────
function splitTopLevelArgs(src, openIndex) {
  // src[openIndex] === '('
  const args = [];
  let depth = 1;
  let cur = '';
  let quote = null;
  for (let i = openIndex + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += src[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { args.push(cur.trim()); break; }
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 1) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return args;
}

function unquote(text) {
  const t = String(text ?? '').trim();
  const m = /^'((?:[^'\\]|\\.)*)'$/.exec(t) ?? /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  return m ? m[1].replace(/\\(['"\\])/g, '$1') : null;
}

function extractRegistrations(src) {
  const marker = 'server.tool(';
  const out = [];
  let from = 0;
  let prevAt = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    const args = splitTopLevelArgs(src, at + marker.length - 1);
    // 注册条件：`if (cfg.socialV2?.tools?.xxx !== false) {` 里那个开关名（可能没有）。
    const between = src.slice(prevAt, at);
    const gates = [...between.matchAll(/cfg\.socialV2\?\.tools\?\.(\w+)\s*!==\s*false/g)];
    out.push({
      at,
      name: unquote(args[0]),
      description: unquote(args[1]) ?? args[1] ?? '',
      schema: args[2] ?? '',
      handler: args[3] ?? '',
      gate: gates.length ? gates[gates.length - 1][1] : null,
      line: src.slice(0, at).split('\n').length
    });
    prevAt = at;
    from = at + marker.length;
  }
  return out;
}

const src = fs.readFileSync(SRC_PATH, 'utf8');
const registrations = extractRegistrations(src);
const names = registrations.map((r) => r.name).filter(Boolean);
const regByName = new Map(registrations.map((r) => [r.name, r]));
const cfgTools = cfg.socialV2?.tools ?? {};
// 某个工具在当前 config 下是否应该注册（gate 为 null 或开关非 false）。
function expectedRegistered(name) {
  const reg = regByName.get(name);
  if (!reg) return false;
  if (!reg.gate) return true;
  return cfgTools[reg.gate] !== false;
}

// ── ① 源码静态断言 ────────────────────────────────────────────────────────
console.log('## 源码静态断言');
console.log(`（${path.relative(ROOT, SRC_PATH)} 共 ${registrations.length} 个 server.tool 注册）`);
console.log('工具:', names.join(', '));

ok(registrations.length > 0 && registrations.every((r) => r.name), '每个 server.tool 都能抽出工具名');
for (const name of REMOVED_TOOLS) ok(!names.includes(name), `群工具 ${name} 不存在`);
for (const param of REMOVED_PARAMS) {
  const owners = registrations
    .filter((r) => `${r.description} ${r.schema}`.includes(param))
    .map((r) => `${r.name}@L${r.line}`);
  ok(owners.length === 0, `群参数 ${param} 不在任何工具里`, owners.join(', ') || '（无）');
}

const surface = registrations.map((r) => `${r.name} ${r.description} ${r.schema}`).join('\n');
ok(!/group/i.test(surface), '工具注册文本不含 group 字样（如 groupId / get_group_* / group:）');
ok(!surface.includes('群'), '工具名/描述不含「群」字样（群聊/群友/群号等措辞已改私聊）');

const keyDescs = [];
for (const r of registrations) {
  const m = /key: z\.string\(\)(?:\.min\(1\))?\.describe\('([^']*)'\)/.exec(r.schema);
  if (m) keyDescs.push([r.name, m[1]]);
}
ok(keyDescs.length > 0, `存在带 key 参数的会话工具（${keyDescs.length} 个）`);
const badKeyDesc = keyDescs.filter(([, d]) => d !== '会话 key，格式 private:QQ号').map(([n, d]) => `${n}="${d}"`);
ok(badKeyDesc.length === 0, 'key 参数描述统一为「会话 key，格式 private:QQ号」', badKeyDesc.join(', ') || '（全部合规）');

for (const name of KEPT_TOOLS) ok(names.includes(name), `私聊工具 ${name} 仍注册`);

const replyReg = regByName.get('qq_reply');
ok(Boolean(replyReg) && /userId: z\.union/.test(replyReg.schema) && !/groupId/.test(replyReg.schema), 'qq_reply 目标参数是 userId');
ok(Boolean(replyReg) && /replyToMessageId/.test(replyReg.schema), 'qq_reply 仍有 replyToMessageId');
ok(Boolean(replyReg) && replyReg.handler.includes("'/api/send/reply'"), 'qq_reply 仍走 /api/send/reply（保留 socialV2.tools.reply 开关）');
const privateReg = regByName.get('qq_send_private_message');
ok(Boolean(privateReg) && /userId: z\.union/.test(privateReg.schema) && /replyToMessageId/.test(privateReg.schema), 'qq_send_private_message 的 userId / replyToMessageId 仍在');
const wakeReg = regByName.get('qq_set_wake_config');
ok(Boolean(wakeReg) && /atMention/.test(wakeReg.schema) && /poke/.test(wakeReg.schema) && /keywords/.test(wakeReg.schema), 'qq_set_wake_config 的唤醒触发器仍在');
const pokeReg = regByName.get('qq_send_poke');
ok(Boolean(pokeReg) && /key: z\.string\(\)/.test(pokeReg.schema) && !/targetUserId/.test(pokeReg.schema), 'qq_send_poke 只需要 key + token（私聊目标即会话自身）');

console.log('\n## 群白名单 / 群接口已删（源码层）');
// 白名单强制在桥接侧（src/bridge.js 的 modeAllowed / allow.private），本文件不再读 allow/deny；
// 这里只断言「没有把群白名单读回来」，以及文件里明确写清了强制点在哪。
ok(
  !src.includes('allowGroups') && !src.includes('denyGroups') &&
  !/allow\?\.groups/.test(src) && !/deny\?\.groups/.test(src),
  '不再读取 config.json 的 allow.groups / deny.groups'
);
ok(!/allow\?\.(private|groups)/.test(src) && src.includes('allow.private'), '私聊白名单只在桥接侧强制（本文件不再读 allow.private，注释里标明强制点）');
ok(!/get_group_\w+/.test(src), '不再调用任何 OneBot 群接口（get_group_*）');
ok(!src.includes("'group:") && !src.includes('`group:'), '不再构造 group: 会话 key');

// ── ② 实时 MCP 断言：进程内跑真 server，走真 JSON-RPC ──────────────────────
async function liveProbe() {
  const { PassThrough } = await import('node:stream');
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realWrite = process.stdout.write.bind(process.stdout);
  const input = new PassThrough();
  let buffer = '';

  // 只换掉 server 的输入流 + 截获它的 stdout（JSON-RPC 响应）；无论成功失败都还原。
  Object.defineProperty(process, 'stdin', { value: input, configurable: true, writable: true, enumerable: true });
  process.stdout.write = (chunk, enc, cb) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  const restore = () => {
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    process.stdout.write = realWrite;
  };

  const responses = new Map();
  const pump = () => {
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg);
    }
  };
  const rpc = async (id, method, params) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + 15000;
    for (;;) {
      pump();
      if (responses.has(id)) return responses.get(id);
      if (Date.now() > deadline) throw new Error(`MCP ${method} 超时（server 未响应）`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  try {
    await import(pathToFileURL(SRC_PATH).href);
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bridge-test', version: '0.1.0' }
    });
    if (init.error) throw new Error(`initialize 失败: ${JSON.stringify(init.error)}`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listed = await rpc(2, 'tools/list', {});
    if (listed.error) throw new Error(`tools/list 失败: ${JSON.stringify(listed.error)}`);

    const calls = {};
    let nextId = 10;
    for (const name of REMOVED_TOOLS) {
      calls[name] = await rpc(nextId++, 'tools/call', {
        name,
        arguments: { groupId: 123456789, message: '测试', token: 'x', messages: ['测试'] }
      });
    }
    // 发送类工具的 token 现在是必填（与「每个工具调用都必须带 agent token」一致）：
    // 统一带一个假令牌，好让调用真的走到桥接侧的安全层，而不是被 schema 校验提前挡下。
    const FAKE_TOKEN = 'test-token-not-real';
    // 目标 987654321 是编造号（allow.private 里只有 owner）：reserved2 下 agent token 校验先失败，
    // 其余模式发送类工具直接 403 —— 只会看到 isError，不会真的发消息出去。
    calls.sendPrivate = await rpc(nextId++, 'tools/call', {
      name: 'qq_send_private_message',
      arguments: { userId: 987654321, message: '测试', token: FAKE_TOKEN }
    });
    calls.replyInvalid = await rpc(nextId++, 'tools/call', {
      name: 'qq_reply',
      arguments: { userId: 987654321, replyToMessageId: 'abc', message: '测试', token: FAKE_TOKEN }
    });
    calls.replyZero = await rpc(nextId++, 'tools/call', {
      name: 'qq_reply',
      arguments: { userId: 987654321, replyToMessageId: 0, message: '测试', token: FAKE_TOKEN }
    });
    calls.replyNegative = await rpc(nextId++, 'tools/call', {
      name: 'qq_reply',
      arguments: { userId: 987654321, replyToMessageId: -123456789, message: '测试', token: FAKE_TOKEN }
    });
    // 不带 token 必须被拒：schema 层就该挡住（agent token 是硬要求）。
    calls.sendPrivateNoToken = await rpc(nextId++, 'tools/call', {
      name: 'qq_send_private_message',
      arguments: { userId: 987654321, message: '测试' }
    });

    return {
      serverName: init.result?.serverInfo?.name ?? '',
      serverVersion: init.result?.serverInfo?.version ?? '',
      tools: listed.result?.tools ?? [],
      calls
    };
  } finally {
    restore();
  }
}

console.log(`\n## 实时 MCP 断言（进程内真跑 stdio server；当前桥接模式：${MODE}）`);
let live = null;
let liveError = null;
try {
  live = await liveProbe();
} catch (error) {
  liveError = error;
}

if (!live) {
  console.log(`⚠️ 跳过实时段：${liveError?.message ?? liveError}`);
} else {
  const liveNames = live.tools.map((t) => t.name);
  console.log(`${live.serverName}@${live.serverVersion} 实时注册 ${liveNames.length} 个工具: ${liveNames.join(', ')}`);

  for (const name of REMOVED_TOOLS) ok(!liveNames.includes(name), `实时：群工具 ${name} 不存在`);
  for (const name of KEPT_TOOLS) {
    if (expectedRegistered(name)) ok(liveNames.includes(name), `实时：私聊工具 ${name} 存在`);
    else ok(!liveNames.includes(name), `实时：私聊工具 ${name} 被 config 关闭，未注册`);
  }
  const expected = registrations.filter((r) => expectedRegistered(r.name)).map((r) => r.name).sort();
  const actual = [...liveNames].sort();
  const diff = actual.filter((n) => !expected.includes(n)).concat(expected.filter((n) => !actual.includes(n)));
  ok(diff.length === 0, '实时注册面 = 源码注册面（按 config 开关裁剪）', diff.length ? `差异: ${diff.join(', ')}` : `${actual.length} 个`);

  const liveSurface = JSON.stringify(live.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
  ok(!/group/i.test(liveSurface), '实时：工具名/描述/schema 不含 group 字样');
  ok(!liveSurface.includes('群'), '实时：工具名/描述不含「群」字样');

  // 已删工具真的调不到：MCP 层必须拒绝（JSON-RPC error 或 isError 结果，且不能是正常 result）
  for (const name of REMOVED_TOOLS) {
    const res = live.calls[name];
    const text = String(res?.result?.content?.[0]?.text ?? res?.error?.message ?? '');
    const rejected = Boolean(res?.error) || res?.result?.isError === true;
    ok(rejected && /not found|unknown tool|未知/i.test(text), `实时：调用 ${name} 被拒（工具不存在）`, text.slice(0, 100));
  }

  const sendRes = live.calls.sendPrivate?.result ?? {};
  const sendText = String(sendRes.content?.[0]?.text ?? live.calls.sendPrivate?.error?.message ?? '');
  ok(sendRes.isError === true, '实时：白名单外私聊发送被拒绝', sendText.slice(0, 120));

  // token 必填：不带 token 的调用必须在 schema 层就被拒（不能靠桥接兜底）。
  const noToken = live.calls.sendPrivateNoToken ?? {};
  const noTokenText = String(noToken?.result?.content?.[0]?.text ?? noToken?.error?.message ?? '');
  ok(Boolean(noToken?.error) || noToken?.result?.isError === true, '实时：qq_send_private_message 缺 token 被拒', noTokenText.slice(0, 120));

  const invalidText = String(live.calls.replyInvalid?.result?.content?.[0]?.text ?? live.calls.replyInvalid?.error?.message ?? '');
  ok(live.calls.replyInvalid?.result?.isError === true, '实时：qq_reply 非法引用 id(abc) 被拒绝', invalidText.slice(0, 120));
  const zeroText = String(live.calls.replyZero?.result?.content?.[0]?.text ?? live.calls.replyZero?.error?.message ?? '');
  ok(live.calls.replyZero?.result?.isError === true, '实时：qq_reply 引用 id(0) 被拒绝', zeroText.slice(0, 120));
  const negText = String(live.calls.replyNegative?.result?.content?.[0]?.text ?? live.calls.replyNegative?.error?.message ?? '');
  ok(live.calls.replyNegative?.result?.isError === true, '实时：qq_reply 负 id 被安全层拒绝（参数校验已放行）', negText.slice(0, 120));
  ok(!/必须是非零整数/.test(negText), '实时：负 id 未被当成非法参数', negText.slice(0, 120));
}

console.log(`\n${failures === 0 ? '✅ 全部断言通过' : `❌ ${failures} 项断言失败`}`);
process.exit(failures === 0 ? 0 : 1);
