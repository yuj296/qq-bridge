// 提问转发自测：「你在 DSH 界面里自己开的会话」里的提问 → 手机 QQ → 你回一句作答。
//
//   node scripts/test-question-relay.mjs          # 纯函数部分（秒级，不连 DSH、不发 QQ）
//   node scripts/test-question-relay.mjs --live   # 追加端到端：真跑一轮 agent 提问，假 OneBot 收消息
//
// 两部分：
//   A. src/question-flow.js 的纯函数：序号/原文/自定义三种回法、多问题的 | 分隔、
//      越界与空回复的提示、消息渲染（题号、来源、排队提示、脱敏回调、超长截断）。
//   B.（--live）隔离实例 + 假 OneBot + **真 DSH**：脚本自己建一个会话让 agent 提问，
//      断言隔离桥接把提问发到了假 OneBot；再灌一条「1」的私聊回复，断言桥接真的
//      回执给 DSH（我们能收到 pending/cancelled）且队列里的下一条被重推。
//
// ⚠️ --live 会真的调模型跑 agent（慢，可能一两分钟），而且只往**假号**发消息。
//    真桥接在跑时会跳过（两个实例会抢同一个提问，结果不可判），除非加 --force。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { formatQuestionMessage, parseQuestionAnswer } from '../src/question-flow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const LIVE = process.argv.includes('--live');
const FORCE = process.argv.includes('--force');

let passCount = 0;
let failCount = 0;
const ok = (name, extra = '') => { passCount += 1; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); };
const bad = (name, extra = '') => { failCount += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); };
const check = (name, cond, extra = '') => (cond ? ok(name, extra) : bad(name, extra));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A. 纯函数 ───────────────────────────────────────────────────────────────
console.log('=== A. 回答解析（序号 / 原文 / 自定义）===');
const q1 = { id: 'q1', question: '选哪个方案？', options: [{ label: '方案 A' }, { label: '方案 B' }] };
const q2 = { id: 'q2', question: '要不要顺手重构？', options: [{ label: '要' }, { label: '不要' }] };

{
  const a = parseQuestionAnswer([q1], '2');
  check('回序号 2 → 选中第二个选项', a.ok && a.answers[0].selected[0] === '方案 B' && a.answers[0].id === 'q1');

  const full = parseQuestionAnswer([q1], '２');
  check('全角序号 ２ 也认', full.ok && full.answers[0].selected[0] === '方案 B');

  const byLabel = parseQuestionAnswer([q1], '  方案 a ');
  check('回选项原文（大小写/空格不敏感）', byLabel.ok && byLabel.answers[0].selected[0] === '方案 A');

  const custom = parseQuestionAnswer([q1], '都不选，我自己写一版');
  check('回别的文字 → 自定义回答', custom.ok && custom.answers[0].custom === '都不选，我自己写一版'
    && custom.answers[0].selected.length === 0);

  const over = parseQuestionAnswer([q1], '9');
  check('序号越界给提示，而不是当成自定义答案', !over.ok && /超范围/.test(over.error), over.ok ? '' : over.error);

  const noOpt = parseQuestionAnswer([{ id: 'q', question: '随便说点' }], '1');
  check('没选项的题回数字 → 提示直接回答案', !noOpt.ok, noOpt.ok ? '' : noOpt.error);

  const empty = parseQuestionAnswer([q1], '   ');
  check('空回复被拒', !empty.ok);
}

console.log('\n=== A2. 多个问题（用 | 分隔）===');
{
  const m = parseQuestionAnswer([q1, q2], '1|不要');
  check('逐题用 | 分隔作答', m.ok && m.answers[0].selected[0] === '方案 A' && m.answers[1].selected[0] === '不要');

  const mixed = parseQuestionAnswer([q1, q2], '2|我自己决定');
  check('多题里也能混自定义', mixed.ok && mixed.answers[0].selected[0] === '方案 B'
    && mixed.answers[1].custom === '我自己决定');

  const short = parseQuestionAnswer([q1, q2], '1');
  check('少答一题 → 给出 | 格式提示', !short.ok && short.error.includes('|'), short.ok ? '' : short.error);
}

console.log('\n=== A3. 消息渲染 ===');
{
  const one = formatQuestionMessage({ questions: [q1] });
  check('单问题列出带序号的选项', one.includes('1. 方案 A') && one.includes('2. 方案 B'));
  check('单问题给出回法提示', one.includes('回 1~2'));
  check('QQ 会话自己的提问不写「来自 DSH 会话」', !one.includes('来自 DSH 会话'));

  const relayed = formatQuestionMessage({ questions: [q1, q2], origin: 'dk · D:\\dk', queueAhead: 2 });
  check('转发来的提问带会话来源', relayed.includes('来自 DSH 会话：dk · D:\\dk'));
  check('多问题带题号', relayed.includes('【1】') && relayed.includes('【2】'));
  check('多问题提示用 | 分隔', relayed.includes('|'));
  check('排队时提示前面还有几个', relayed.includes('前面还有 2 个'));
  // 桥接是入队那一刻才知道排第几，所以「前面还有几条」也会走渲染参数传进来
  // （这个形态曾经漏掉过：函数只从 entry 上读 → 队列提示永远不显示）。
  const viaOptions = formatQuestionMessage({ questions: [q1] }, { queueAhead: 1 });
  check('排队提示也能当渲染参数传（options.queueAhead）', viaOptions.includes('前面还有 1 个'));

  const secret = { id: 's', question: '密钥放哪？', options: [{ label: '写进 config' }] };
  const masked = formatQuestionMessage({ questions: [secret] }, {
    sanitize: (t) => String(t).replace(/密钥/g, '***')
  });
  check('sanitize 回调生效（非管理员会话脱敏）', !masked.includes('密钥') && masked.includes('***'));

  const long = { id: 'l', question: 'x'.repeat(400), options: [{ label: 'y'.repeat(200) }] };
  const full = formatQuestionMessage({ questions: [long] });
  check('超长题面完整发出（不截断）', full.includes('x'.repeat(400)) && !full.includes('…'));
  check('超长选项名完整发出（不截断）', full.includes('y'.repeat(200)));
  const capped = formatQuestionMessage({ questions: [long] }, { questionMax: 20, optionLabelMax: 10 });
  check('显式传长度上限时仍会截断（可配置）', capped.includes('…') && !capped.includes('y'.repeat(200)));
}

console.log('\n=== A4. 选项的具体内容（方案说明）必须写清楚 ===');
{
  const withDesc = {
    id: 'd',
    question: '走哪条路？',
    options: [
      { label: '方案 A', description: '先在本地跑通再发布；代价是多花一天。' },
      { label: '方案 B', description: '直接发布，出问题再回滚。' }
    ]
  };
  const msg = formatQuestionMessage({ questions: [withDesc] });
  check('选项的详细说明也发出来（不是只给个「方案 A」）',
    msg.includes('先在本地跑通再发布；代价是多花一天。') && msg.includes('直接发布，出问题再回滚。'));
  check('选项说明缩进在序号下面', / {2}1\. 方案 A\n {5}先在本地跑通/.test(msg));

  const noDesc = formatQuestionMessage({ questions: [{ id: 'n', question: '?', options: [{ label: '甲' }] }] });
  check('选项没有说明时不留空行', !/\n[ \t]*\n/.test(noDesc));

  const multiLine = {
    id: 'm',
    question: '先看背景：\n这事有两种做法。',
    options: [{ label: '甲', description: '好处：快\n代价：贵' }]
  };
  const msgMulti = formatQuestionMessage({ questions: [multiLine] });
  check('正文与说明保留换行（分点在手机上更好读）',
    msgMulti.includes('先看背景：\n这事有两种做法。') && msgMulti.includes('好处：快\n     代价：贵'));

  const longDesc = { id: 'ld', question: '选哪个？', options: [{ label: '甲', description: 'z'.repeat(500) }] };
  check('超长选项说明也完整发出（不截断）',
    formatQuestionMessage({ questions: [longDesc] }).includes('z'.repeat(500)));
  check('显式限制说明长度时才截断',
    !formatQuestionMessage({ questions: [longDesc] }, { optionDescMax: 50 }).includes('z'.repeat(500)));
}

// ── B. 端到端（--live）──────────────────────────────────────────────────────
if (!LIVE) {
  console.log('\n（跳过端到端部分：加 --live 才跑，会真跑一轮 agent）');
} else {
  console.log('\n=== B. 端到端：真 DSH 会话提问 → 假 OneBot ===');
  await runLive();
}

async function runLive() {
  const { NodeApiClient, unwrap, exitCleanly } = await import('../src/dsh-client.js');

  const TMP = path.join(REPO, '.question-relay-test');
  const BOT_QQ = 20003;
  const FAKE_OWNER = 10001;
  const HTTP_PORT = 3020;
  const WS_PORT = 3021;
  const CONSOLE_PORT = 3111;

  // 本机实测：fs.rmSync(recursive/force) 对「子进程刚创建的文件」会静默不删。
  const rmrf = (dir) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(dir)) return;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else { try { fs.unlinkSync(p); } catch {} }
      }
    };
    try { walk(dir); fs.rmdirSync(dir, { recursive: true }); } catch {}
  };

  /** 真桥接是否在跑（跑着就跳过：两个实例会抢答同一个提问）。 */
  const realBridgeRunning = () => {
    try {
      const pid = Number(fs.readFileSync(path.join(REPO, 'state', 'bridge.lock'), 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM'; // Windows 上对存在但无权的进程报 EPERM
    }
  };
  if (realBridgeRunning() && !FORCE) {
    console.log('  ⏭ 真桥接正在运行（state/bridge.lock 指向活进程）—— 为避免两个实例抢答同一个提问，跳过端到端。');
    console.log('     想跑：先停掉真桥接，或加 --force（自担风险）。');
    return;
  }

  // 防手滑：隔离实例用的是假号，但设置页里若改过 ownerQQ / 白名单 / SnowLuma 地址，
  // 桥接每 5s 拉一次 user 层就会把配置覆盖成真值 → 消息发到真号。先查一遍。
  const probe = new NodeApiClient(undefined, 20000);
  let userLayer = null;
  try {
    const desc = unwrap(await probe.settings.describe({}), 'settings.describe');
    userLayer = desc.namespaces.find((n) => n.ns === 'qq-mode')?.user ?? null;
  } catch (error) {
    console.log(`  ⏭ 读不到 DSH 设置命名空间（${error?.message ?? error}）—— 无法确认隔离安全，跳过端到端。`);
    return;
  }
  const risky = ['ownerQQ', 'allow', 'deny', 'snowluma', 'consolePort'].filter(
    (k) => userLayer && userLayer[k] !== undefined
  );
  if (risky.length > 0) {
    console.log(`  ⏭ 设置页里改过 ${risky.join(' / ')}：会覆盖隔离实例的假号配置（可能发到真 QQ），跳过端到端。`);
    return;
  }

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(path.join(TMP, 'state'), { recursive: true });
    fs.cpSync(path.join(REPO, 'src'), path.join(TMP, 'src'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
      ownerQQ: FAKE_OWNER,
      snowluma: { wsUrl: `ws://127.0.0.1:${WS_PORT}`, httpUrl: `http://127.0.0.1:${HTTP_PORT}` },
      allow: { private: [FAKE_OWNER] },
      sessionCwd: TMP,
      consolePort: CONSOLE_PORT,
      agentPreset: 'qq-chat'
    }, null, 2));

    // 假 OneBot：记下桥接发出去的消息
    const sends = [];
    const httpServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        sends.push({ via: 'http', action: String(req.url ?? '').replace(/^\//, ''), body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
      });
    });
    await new Promise((r) => httpServer.listen(HTTP_PORT, '127.0.0.1', r));

    let bridgeWs = null;
    const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      bridgeWs = ws;
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.echo === undefined) return;
        if (/^send_/.test(String(msg.action))) sends.push({ via: 'ws', action: msg.action, body: JSON.stringify(msg.params ?? {}) });
        const data = msg.action === 'get_login_info' ? { user_id: BOT_QQ, nickname: '小鲸鱼' }
          : (/^send_/.test(String(msg.action)) ? { message_id: 1 } : {});
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
      });
    });
    await new Promise((r) => wss.on('listening', r));
    ok(`假 OneBot 已监听（HTTP ${HTTP_PORT} / WS ${WS_PORT}）`);

    const child = spawn(process.execPath, [path.join(TMP, 'src', 'bridge.js')], {
      cwd: TMP, stdio: ['ignore', 'inherit', 'inherit']
    });
    console.log(`  · 隔离桥接已启动 pid=${child.pid}`);

    const cleanup = () => {
      try { child.kill(); } catch {}
      try { wss.close(); } catch {}
      try { httpServer.close(); } catch {}
    };

    try {
      for (let i = 0; i < 60 && !bridgeWs; i += 1) await sleep(500);
      check('隔离桥接已连上假 OneBot', !!bridgeWs);
      if (!bridgeWs) return;

      const logFile = path.join(TMP, 'state', 'bridge.log');
      const readLog = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
      const questionSends = () => sends.filter((s) => /❓/.test(s.body));
      const injectPrivate = (text) => {
        bridgeWs.send(JSON.stringify({
          post_type: 'message', message_type: 'private', sub_type: 'friend',
          message_id: Math.floor(Math.random() * 1e6), self_id: BOT_QQ,
          time: Math.floor(Date.now() / 1000), user_id: FAKE_OWNER,
          sender: { user_id: FAKE_OWNER, nickname: '主人' },
          message: [{ type: 'text', data: { text } }], raw_message: text, font: 0
        }));
      };

      // 桥接连上真 DSH
      const api = new NodeApiClient(undefined, 60000);
      const muxFrames = [];
      const abort = new AbortController();
      const muxTask = (async () => {
        for await (const envelope of api.events.mux({}, abort.signal)) muxFrames.push(envelope);
      })().catch(() => {});

      const ASK = '请调用 ask_user_question 工具问我一个问题：题目「转发测试」，两个选项分别是「方案 A」和「方案 B」，'
        + '并且每个选项都要带 description：方案 A 的说明写「A 的好处与代价」，方案 B 的说明写「B 的好处与代价」。'
        + '必须调用该工具，不要自己回答。';
      const dir = path.join(TMP, 'guitest');
      fs.mkdirSync(dir, { recursive: true });
      const created = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
      const sessionA = unwrap(await api.sessions.create({ workspaceId: created.workspace.workspaceId }), 'session.create');
      api.trackSession(sessionA.sessionId);
      await sleep(1500);
      await api.sessions.prompt({ sessionId: sessionA.sessionId, mode: 'queue', content: [{ type: 'text', text: ASK }] });
      console.log(`  · 会话 A 已投递（${sessionA.sessionId.slice(0, 8)}…），等提问…`);

      let first = null;
      for (let i = 0; i < 300; i += 1) {
        await sleep(1000);
        const list = questionSends();
        if (list.length > 0) { first = list[0]; break; }
      }
      check('DSH 界面会话的提问被转发到了手机（假 OneBot 收到 ❓ 消息）', !!first,
        first ? first.body.slice(0, 90).replace(/\s+/g, ' ') : '150s 内没等到');
      if (!first) return;
      const firstBody = first.body;
      check('转发消息里带序号选项', /1\.\s*方案 A/.test(firstBody) && /2\.\s*方案 B/.test(firstBody));
      check('选项的详细说明也被发到手机（不是只给个「方案 A」）',
        firstBody.includes('A 的好处与代价') && firstBody.includes('B 的好处与代价'));
      check('转发消息里带「来自 DSH 会话」来源', firstBody.includes('来自 DSH 会话'));
      check('转发消息里带回法提示', /回 1~2/.test(firstBody));

      // 第二个会话也提问 → 应排进队列并提示「前面还有」
      const sessionB = unwrap(await api.sessions.create({ workspaceId: created.workspace.workspaceId }), 'session.create');
      api.trackSession(sessionB.sessionId);
      await sleep(1200);
      await api.sessions.prompt({ sessionId: sessionB.sessionId, mode: 'queue', content: [{ type: 'text', text: ASK }] });
      let second = null;
      for (let i = 0; i < 300; i += 1) {
        await sleep(1000);
        const list = questionSends();
        if (list.length > 1) { second = list[1]; break; }
      }
      check('第二条提问被排进队列而不是顶掉第一条', !!second, second ? second.body.slice(0, 60).replace(/\s+/g, ' ') : '150s 内没等到');
      if (second) {
        const hasAhead = second.body.includes('前面还有 1 个');
        check('第二条提问提示「前面还有 1 个」', hasAhead, hasAhead ? '' : second.body.replace(/\s+/g, ' ').slice(0, 300));
      }

      // 回「1」→ 桥接应回执给 DSH，并把队列里的下一条重推
      const beforeReplyCount = questionSends().length;
      injectPrivate('1');
      let answered = false;
      for (let i = 0; i < 40; i += 1) {
        await sleep(1000);
        if (/已回答提问/.test(readLog())) { answered = true; break; }
      }
      check('QQ 回「1」后桥接真的回执给 DSH（日志：已回答提问）', answered);
      const cancelled = muxFrames.some((e) => e?.payload?.type === 'pending/cancelled');
      check('该提问在别处被回答（我们收到 pending/cancelled 帧）', cancelled);
      let promoted = false;
      for (let i = 0; i < 30; i += 1) {
        await sleep(1000);
        if (questionSends().length > beforeReplyCount) { promoted = true; break; }
      }
      check('答完一条后队列里的下一条被重新推给你', promoted);

      abort.abort();
      await muxTask.catch(() => {});

      // 收尾：把还挂着的提问答掉再撤。
      // 为什么必须做：DSH 侧的 waterfall 请求不挂靠在会话 follow 上，只要没人作答，
      // 真桥接下次连上 $events 时会被**重新派发** → 又往主人手机发一遍老提问
      // （2026-09-15 就这么污染过一次）。隔离实例被 kill 时来不及回执，就留成了孤儿请求。
      const forwarded = questionSends().length;
      for (let i = 0; i < forwarded + 1; i += 1) {
        const answeredCount = (readLog().match(/已回答提问/g) ?? []).length;
        if (answeredCount >= forwarded) break;
        injectPrivate('1');
        await sleep(1500);
      }
      const answeredTotal = (readLog().match(/已回答提问/g) ?? []).length;
      check('收尾：剩余挂起提问都答掉了（不给 DSH 留孤儿请求）', answeredTotal >= forwarded,
        `已答 ${answeredTotal} / 已转发 ${forwarded}`);

      try { await api.workspace.archiveSession({ sessionId: sessionA.sessionId }); } catch {}
      try { await api.workspace.archiveSession({ sessionId: sessionB.sessionId }); } catch {}
      try { await api.workspace.delete({ workspaceId: created.workspace.workspaceId }); } catch {}
      api.close();
    } finally {
      cleanup();
      await sleep(600);
      rmrf(TMP);
    }
  } catch (error) {
    bad('端到端流程抛错', String(error?.message ?? error));
  }
}

console.log(`\n===== 汇总：${passCount}/${passCount + failCount} 通过 =====`);
if (failCount > 0) process.exit(1);
console.log('✅ 提问转发的解析与渲染都符合预期');
process.exit(0);
